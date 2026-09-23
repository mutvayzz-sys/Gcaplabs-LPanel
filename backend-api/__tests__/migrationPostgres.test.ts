// @ts-nocheck

const fs = require("fs");
const path = require("path");
const { Client, Pool } = require("pg");
const { randomUUID } = require("node:crypto");
const { createOrReuseExternalAgent } = require("../externalAgentProvisioning");
const {
  fingerprintExternalAgentIdentity,
  normalizeExternalAgentIdentity,
  stableJson,
} = require("../externalAgentIdentity");

const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const describeWithPostgres = TEST_POSTGRES_URL ? describe : describe.skip;

describeWithPostgres("PostgreSQL legacy migration gate", () => {
  jest.setTimeout(120_000);

  let adminClient;
  let adminConnected = false;
  let migrationPool;
  let schemaName;
  let migrateDB;
  let userId;
  let workspaceId;

  beforeAll(async () => {
    schemaName = `nora_migration_${process.pid}_${Date.now()}`;
    adminClient = new Client({ connectionString: TEST_POSTGRES_URL });
    await adminClient.connect();
    adminConnected = true;
    await adminClient.query(`CREATE SCHEMA ${schemaName}`);

    migrationPool = new Pool({
      connectionString: TEST_POSTGRES_URL,
      options: `-c search_path=${schemaName},public`,
    });

    const schemaSql = fs.readFileSync(path.join(__dirname, "..", "db_schema.sql"), "utf8");
    await migrationPool.query(schemaSql);

    // Recreate representative pre-ledger states that historically blocked a
    // strict all-or-nothing migration: stale backup kinds, duplicate Agent Hub
    // slugs, and duplicate workspace assignments.
    await migrationPool.query(`
      ALTER TABLE backups DROP CONSTRAINT IF EXISTS backups_kind_check;
      ALTER TABLE backup_schedules DROP CONSTRAINT IF EXISTS backup_schedules_kind_check;
      DROP INDEX IF EXISTS idx_agent_hub_listings_slug_unique;
      ALTER TABLE workspace_agents
        DROP CONSTRAINT IF EXISTS workspace_agents_workspace_id_agent_id_key;
      DROP INDEX IF EXISTS idx_workspace_agents_unique;
      CREATE TABLE llm_providers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(30) NOT NULL,
        api_key TEXT,
        model VARCHAR(100),
        config JSONB DEFAULT '{}',
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const userResult = await migrationPool.query(
      `INSERT INTO users(email, role, name)
       VALUES($1, 'admin', 'Migration Test') RETURNING id`,
      [`migration-${Date.now()}@example.test`],
    );
    userId = userResult.rows[0].id;
    const agentResult = await migrationPool.query(
      `INSERT INTO agents(user_id, name) VALUES($1, 'Legacy agent') RETURNING id`,
      [userId],
    );
    const agentId = agentResult.rows[0].id;
    const workspaceResult = await migrationPool.query(
      `INSERT INTO workspaces(user_id, name) VALUES($1, 'Legacy workspace') RETURNING id`,
      [userId],
    );
    workspaceId = workspaceResult.rows[0].id;

    await migrationPool.query(
      `INSERT INTO workspace_agents(workspace_id, agent_id, role)
       VALUES($1, $2, 'member'), ($1, $2, 'member')`,
      [workspaceId, agentId],
    );
    await migrationPool.query(
      `INSERT INTO backups(user_id, agent_id, kind, name, scope)
       VALUES
         ($1, NULL, 'legacy-full', 'Legacy installation', '{"installation": true}'::jsonb),
         ($1, $2, 'legacy-runtime', 'Legacy agent', '{}'::jsonb)`,
      [userId, agentId],
    );
    await migrationPool.query(
      `INSERT INTO backup_schedules(schedule_key, kind, user_id, agent_id)
       VALUES
         ('installation', 'legacy-full', $1, NULL),
         ('legacy-agent', 'legacy-runtime', $1, $2)`,
      [userId, agentId],
    );
    await migrationPool.query(
      `INSERT INTO llm_providers(user_id, provider, api_key, model, is_default)
       VALUES
         ($1, 'demo', 'legacy-demo', 'nora-demo-1', false),
         ($1, 'openai', 'legacy-openai', 'gpt-5.5', false)`,
      [userId],
    );

    const snapshots = await migrationPool.query(
      `INSERT INTO snapshots(name, config)
       VALUES('Legacy listing A', '{}'::jsonb), ('Legacy listing B', '{}'::jsonb)
       RETURNING id`,
    );
    await migrationPool.query(
      `INSERT INTO agent_hub_listings(snapshot_id, name, slug)
       VALUES($1, 'Legacy listing A', 'duplicate-slug'),
             ($2, 'Legacy listing B', 'duplicate-slug')`,
      [snapshots.rows[0].id, snapshots.rows[1].id],
    );

    process.env.ENCRYPTION_KEY ||= "a".repeat(64);
    ({ migrateDB } = require("../server").__test);
  });

  afterAll(async () => {
    await migrationPool?.end();
    if (adminConnected && schemaName) {
      await adminClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
    if (adminConnected) await adminClient.end();
  });

  it("repairs a pre-ledger schema and is idempotent on a second real PostgreSQL run", async () => {
    const firstRun = await migrateDB(migrationPool, {
      DB_MIGRATION_LOCK_TIMEOUT_MS: "10000",
      DB_MIGRATION_STATEMENT_TIMEOUT_MS: "60000",
    });

    expect(firstRun.total).toBeGreaterThan(100);
    expect(firstRun.applied).toBe(firstRun.total);

    const identityColumns = await migrationPool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'agents'
          AND column_name = ANY($2::text[])
        ORDER BY column_name`,
      [
        schemaName,
        [
          "create_request_fingerprint",
          "create_request_key",
          "external_id",
          "external_id_namespace",
          "external_owner_id",
        ],
      ],
    );
    expect(identityColumns.rows).toEqual([
      { column_name: "create_request_fingerprint", data_type: "text" },
      { column_name: "create_request_key", data_type: "text" },
      { column_name: "external_id", data_type: "uuid" },
      { column_name: "external_id_namespace", data_type: "text" },
      { column_name: "external_owner_id", data_type: "uuid" },
    ]);

    const identityIndexes = await migrationPool.query(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = $1
          AND tablename = 'agents'
          AND indexname IN (
            'agents_external_identity_unique_idx',
            'agents_create_request_key_unique_idx'
          )`,
      [schemaName],
    );
    const externalIdentityIndex = identityIndexes.rows.find(
      (row) => row.indexname === "agents_external_identity_unique_idx",
    );
    const createRequestKeyIndex = identityIndexes.rows.find(
      (row) => row.indexname === "agents_create_request_key_unique_idx",
    );
    expect(externalIdentityIndex?.indexdef).toMatch(/UNIQUE INDEX.*\(user_id, external_id_namespace, external_id\)/i);
    expect(externalIdentityIndex?.indexdef).not.toMatch(/status/i);
    expect(createRequestKeyIndex?.indexdef).toMatch(/UNIQUE INDEX.*\(user_id, create_request_key\)/i);

    const identityConstraints = await migrationPool.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = to_regclass('agents')
          AND contype = 'c'`,
    );
    const constraintNames = new Set(identityConstraints.rows.map((row) => row.conname));
    expect(constraintNames.has("agents_external_identity_complete_check")).toBe(true);
    expect(constraintNames.has("agents_external_namespace_headmaster_check")).toBe(true);
    expect(constraintNames.has("agents_create_request_pair_check")).toBe(true);
    expect(constraintNames.has("agents_create_request_key_nonempty_check")).toBe(true);
    expect(constraintNames.has("agents_create_request_fingerprint_sha256_check")).toBe(true);

    const outboxColumns = await migrationPool.query(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = $1
          AND ((table_name = 'deployments' AND column_name IN ('queue_job_id', 'job_payload'))
            OR (table_name = 'external_agent_create_requests'
                AND column_name IN ('user_id', 'agent_id', 'deployment_id', 'request_key', 'request_fingerprint')))
        ORDER BY table_name, column_name`,
      [schemaName],
    );
    expect(outboxColumns.rows).toEqual([
      { table_name: "deployments", column_name: "job_payload", data_type: "jsonb" },
      { table_name: "deployments", column_name: "queue_job_id", data_type: "text" },
      { table_name: "external_agent_create_requests", column_name: "agent_id", data_type: "uuid" },
      { table_name: "external_agent_create_requests", column_name: "deployment_id", data_type: "uuid" },
      { table_name: "external_agent_create_requests", column_name: "request_fingerprint", data_type: "text" },
      { table_name: "external_agent_create_requests", column_name: "request_key", data_type: "text" },
      { table_name: "external_agent_create_requests", column_name: "user_id", data_type: "uuid" },
    ]);

    const outboxIndexes = await migrationPool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'external_agent_create_requests'`,
      [schemaName],
    );
    expect(outboxIndexes.rows.map((row) => row.indexname)).toContain(
      "external_agent_create_requests_agent_idx",
    );

    const externalOwnerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const insertExternalAgent = ({
      ownerUserId = userId,
      externalId = workspaceId,
      requestKey = "create-key-a",
      fingerprint = "a".repeat(64),
      status = "queued",
    } = {}) =>
      migrationPool.query(
        `INSERT INTO agents(
           user_id, name, status, external_id_namespace, external_id, external_owner_id,
           create_request_key, create_request_fingerprint
         ) VALUES($1, 'External identity test', $2, 'headmaster', $3, $4, $5, $6)
         RETURNING id`,
        [ownerUserId, status, externalId, externalOwnerId, requestKey, fingerprint],
      );

    await insertExternalAgent();
    await expect(
      insertExternalAgent({ status: "deleted", requestKey: "create-key-b", fingerprint: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      insertExternalAgent({
        externalId: "22222222-2222-4222-8222-222222222222",
        fingerprint: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "23505" });

    const secondUser = await migrationPool.query(
      `INSERT INTO users(email, role, name)
       VALUES($1, 'user', 'Second migration user') RETURNING id`,
      [`second-migration-${Date.now()}@example.test`],
    );
    await expect(
      insertExternalAgent({ ownerUserId: secondUser.rows[0].id, requestKey: "second-account-key" }),
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      migrationPool.query(
        `INSERT INTO agents(user_id, external_id_namespace)
         VALUES($1, 'headmaster')`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      migrationPool.query(
        `INSERT INTO agents(user_id, create_request_key)
         VALUES($1, 'missing-fingerprint')`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      migrationPool.query(
        `INSERT INTO agents(user_id, create_request_key, create_request_fingerprint)
         VALUES($1, 'invalid-fingerprint', 'not-a-sha256')`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      migrationPool.query(
        `INSERT INTO agents(
           user_id, external_id_namespace, external_id, external_owner_id
         ) VALUES($1, 'other', $2, $3)`,
        [userId, "33333333-3333-4333-8333-333333333333", externalOwnerId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      migrationPool.query(
        `INSERT INTO agents(user_id, create_request_key, create_request_fingerprint)
         VALUES($1, '   ', $2)`,
        [userId, "d".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const backupKinds = await migrationPool.query(
      `SELECT name, kind FROM backups WHERE name LIKE 'Legacy %' ORDER BY name`,
    );
    expect(backupKinds.rows).toEqual([
      { name: "Legacy agent", kind: "agent" },
      { name: "Legacy installation", kind: "installation" },
    ]);

    const scheduleKinds = await migrationPool.query(
      `SELECT schedule_key, kind FROM backup_schedules
       WHERE schedule_key IN ('installation', 'legacy-agent') ORDER BY schedule_key`,
    );
    expect(scheduleKinds.rows).toEqual([
      { schedule_key: "installation", kind: "installation" },
      { schedule_key: "legacy-agent", kind: "agent" },
    ]);

    const duplicateAssignments = await migrationPool.query(
      `SELECT workspace_id, agent_id, COUNT(*)::int AS count
         FROM workspace_agents
        GROUP BY workspace_id, agent_id
       HAVING COUNT(*) > 1`,
    );
    expect(duplicateAssignments.rows).toEqual([]);

    const duplicateSlugs = await migrationPool.query(
      `SELECT slug, COUNT(*)::int AS count
         FROM agent_hub_listings
        WHERE slug IS NOT NULL
        GROUP BY slug
       HAVING COUNT(*) > 1`,
    );
    expect(duplicateSlugs.rows).toEqual([]);

    const providerDefaults = await migrationPool.query(
      `SELECT provider, is_default
         FROM llm_providers
        WHERE user_id = $1
        ORDER BY provider`,
      [userId],
    );
    expect(providerDefaults.rows).toEqual([
      { provider: "demo", is_default: false },
      { provider: "openai", is_default: true },
    ]);

    const ledger = await migrationPool.query(
      "SELECT COUNT(*)::int AS count FROM schema_migrations",
    );
    expect(ledger.rows[0].count).toBe(firstRun.total);

    await expect(
      migrateDB(migrationPool, {
        DB_MIGRATION_LOCK_TIMEOUT_MS: "10000",
        DB_MIGRATION_STATEMENT_TIMEOUT_MS: "60000",
      }),
    ).resolves.toEqual({ total: firstRun.total, applied: 0 });
  });

  it("serializes concurrent external creates and maps new keys to the same durable operation", async () => {
    const ownerUuid = randomUUID();
    const externalId = randomUUID();
    const identity = normalizeExternalAgentIdentity(
      {
        namespace: "headmaster",
        external_id: externalId,
        owner_uuid: ownerUuid,
        runtime_family: "hermes",
        runtime_target: stableJson({
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
          sandbox_profile: "standard",
        }),
      },
      { managementUserId: userId, ownerUuid },
    );
    const fingerprint = fingerprintExternalAgentIdentity(identity);
    const requestKey = `postgres-create-${randomUUID()}`;
    const makeInput = (key, agentId, requestFingerprint = fingerprint) => ({
      pool: migrationPool,
      identity,
      requestKey: key,
      fingerprint: requestFingerprint,
      createIfMissing: true,
      createFields: {
        agentId,
        name: "integration@example.test",
        node: "docker",
        backendType: "docker",
        sandboxType: "standard",
        vcpu: 1,
        ramMb: 1024,
        diskGb: 10,
        containerName: `nora-hermes-${agentId}`,
        image: null,
        templatePayload: {},
        clawhubSkills: [],
        hermesSkills: [],
        runtimeFamily: "hermes",
        deployTarget: "docker",
        executionTargetId: "docker",
        sandboxProfile: "standard",
      },
      jobPayloadForAgent: (agent) => ({
        id: agent.id,
        name: agent.name,
        container_name: agent.container_name,
      }),
    });

    const concurrent = await Promise.all([
      createOrReuseExternalAgent(makeInput(requestKey, randomUUID())),
      createOrReuseExternalAgent(makeInput(requestKey, randomUUID())),
    ]);
    expect(concurrent[0].created).not.toBe(concurrent[1].created);
    expect(concurrent[0].agent.id).toBe(concurrent[1].agent.id);
    expect(concurrent[0].operation.id).toBe(concurrent[1].operation.id);
    expect(concurrent[0].operation.queue_job_id).toBe(concurrent[1].operation.queue_job_id);

    const aliasKey = `postgres-alias-${randomUUID()}`;
    const alias = await createOrReuseExternalAgent(
      makeInput(aliasKey, randomUUID(), "b".repeat(64)),
    );
    expect(alias.created).toBe(false);
    expect(alias.agent.id).toBe(concurrent[0].agent.id);
    expect(alias.operation.id).toBe(concurrent[0].operation.id);

    await expect(
      createOrReuseExternalAgent(makeInput(aliasKey, randomUUID(), "c".repeat(64))),
    ).rejects.toMatchObject({ statusCode: 409, code: "external_agent_idempotency_conflict" });

    const counts = await migrationPool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM agents
           WHERE user_id = $1 AND external_id_namespace = 'headmaster' AND external_id = $2) AS agents,
         (SELECT COUNT(*)::int FROM deployments
           WHERE agent_id = $3 AND queue_job_id = $4) AS operations,
         (SELECT COUNT(*)::int FROM external_agent_create_requests
           WHERE user_id = $1 AND request_key = ANY($5::text[])) AS request_keys`,
      [
        userId,
        externalId,
        concurrent[0].agent.id,
        concurrent[0].operation.queue_job_id,
        [requestKey, aliasKey],
      ],
    );
    expect(counts.rows[0]).toEqual({ agents: 1, operations: 1, request_keys: 2 });
  });
});
