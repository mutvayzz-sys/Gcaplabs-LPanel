// Real-PostgreSQL integration test for M2.7 (Masterplan3): revision-conflict
// races and concurrent secret patches against a real disposable Postgres,
// using the real pg_try_advisory_lock provision lock — not the mocked pool
// the sibling agentManagedConfig.test.ts uses.
import { Pool } from "pg";
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mutateAgentManagedConfig, getAgentManagedConfigSnapshot } = require("../agentManagedConfig");

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.ENCRYPTION_KEY ? describe : describe.skip;

jest.setTimeout(30000);

describeIfDb("mutateAgentManagedConfig against real Postgres", () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { __test } = require("../server");
    await __test.migrateDB(pool, process.env);
    userId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@pg-test.invalid`],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertRunningAgent() {
    const agentId = randomUUID();
    await pool.query(
      `INSERT INTO agents(id, user_id, name, status, container_id, container_name, backend_type)
       VALUES ($1, $2, $3, 'running', 'container-x', $3, 'docker')`,
      [agentId, userId, `pg-test-${agentId}`],
    );
    return agentId;
  }

  test("a stale expectedRevision is rejected as a revision conflict, not silently applied", async () => {
    const agentId = await insertRunningAgent();

    const first = await mutateAgentManagedConfig({
      pool,
      agentId,
      expectedRevision: 0,
      secretPatch: { set: { FOO: "bar" } },
      addDeploymentJob: async () => {},
    });
    expect(first.desired_revision).toBe(1);

    // A successful mutation transitions the agent to 'queued' for its own
    // redeploy; simulate that redeploy completing and the runtime returning
    // to 'running' on revision 1, while a stale caller still believes the
    // revision is 0 — the actual scenario the revision check exists to catch.
    await pool.query("UPDATE agents SET status = 'running' WHERE id = $1", [agentId]);

    await expect(
      mutateAgentManagedConfig({
        pool,
        agentId,
        // Stale: the real current desired_revision is now 1.
        expectedRevision: 0,
        secretPatch: { set: { FOO: "baz" } },
        addDeploymentJob: async () => {},
      }),
    ).rejects.toMatchObject({ code: "managed_config_revision_conflict" });

    const snapshot = await getAgentManagedConfigSnapshot(agentId, { queryable: pool, decryptSecrets: false });
    expect(snapshot.desiredRevision).toBe(1);
  });

  test("two concurrent patches for the same agent serialize through the advisory lock: one applies, the revision never double-increments or is lost", async () => {
    const agentId = await insertRunningAgent();

    const attempt = (value: string) =>
      mutateAgentManagedConfig({
        pool,
        agentId,
        expectedRevision: 0,
        secretPatch: { set: { RACE_KEY: value } },
        addDeploymentJob: async () => {},
      });

    const results = await Promise.allSettled([attempt("first"), attempt("second")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // The advisory lock serializes the two writers; the winner's own mutation
    // transitions the agent out of 'running' as its redeploy-queued side
    // effect, so the loser (running strictly after the winner commits) sees
    // 'agent_runtime_not_active', not a revision mismatch — the race is
    // resolved by the status transition, not the revision number alone.
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "agent_runtime_not_active",
    });

    const snapshot = await getAgentManagedConfigSnapshot(agentId, { queryable: pool, decryptSecrets: false });
    // Exactly one increment happened — not zero (lost update) and not two
    // (double-applied racing writers).
    expect(snapshot.desiredRevision).toBe(1);
  });

  test("a queue failure after the DB commit surfaces as an error but the durable config/deployment row already committed (outbox survives the failure)", async () => {
    const agentId = await insertRunningAgent();

    await expect(
      mutateAgentManagedConfig({
        pool,
        agentId,
        expectedRevision: 0,
        secretPatch: { set: { WILL_STILL_PERSIST: "yes" } },
        addDeploymentJob: async () => {
          throw new Error("simulated queue outage");
        },
      }),
    ).rejects.toThrow();

    // The transaction committed the config/deployment rows BEFORE the queue
    // call; a broker outage after that point must not roll back the durable
    // record of what was requested.
    const snapshot = await getAgentManagedConfigSnapshot(agentId, { queryable: pool, decryptSecrets: false });
    expect(snapshot.desiredRevision).toBe(1);
    const { rows } = await pool.query(
      "SELECT status FROM deployments WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1",
      [agentId],
    );
    expect(rows[0].status).toBe("queued");
  });

  test("managed config updates are refused for an agent with no active runtime container", async () => {
    const agentId = randomUUID();
    await pool.query(
      `INSERT INTO agents(id, user_id, name, status, container_id, backend_type)
       VALUES ($1, $2, $3, 'stopped', NULL, 'docker')`,
      [agentId, userId, `pg-test-${agentId}`],
    );

    await expect(
      mutateAgentManagedConfig({
        pool,
        agentId,
        expectedRevision: 0,
        secretPatch: { set: { FOO: "bar" } },
        addDeploymentJob: async () => {},
      }),
    ).rejects.toMatchObject({ code: "agent_runtime_not_active" });
  });

  test("a mutation for a missing agent is rejected, not silently a no-op", async () => {
    await expect(
      mutateAgentManagedConfig({
        pool,
        agentId: randomUUID(),
        expectedRevision: 0,
        secretPatch: { set: { FOO: "bar" } },
        addDeploymentJob: async () => {},
      }),
    ).rejects.toMatchObject({ code: "agent_not_found" });
  });

  // M2.3 (Masterplan3/PlanAlpha A2): partial update, explicit removal, and
  // reserved-key rejection were only unit-tested against normalizeSecretOverridePatch
  // with a mocked pool (agentManagedConfig.test.ts). These exercise the same
  // semantics end to end against real Postgres and real encrypted storage.
  test("a partial patch sets one key without touching an existing sibling key", async () => {
    const agentId = await insertRunningAgent();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { listAgentSecretOverrides } = require("../agentSecretOverrides");

    const first = await mutateAgentManagedConfig({
      pool,
      agentId,
      expectedRevision: 0,
      secretPatch: { set: { EXISTING_KEY: "untouched-value" } },
      addDeploymentJob: async () => {},
    });
    expect(first.desired_revision).toBe(1);

    // The winning mutation's own redeploy side effect moved the agent out of
    // 'running' (see the concurrent-patch test above); restore it so the
    // second mutation is accepted on its own merits.
    await pool.query("UPDATE agents SET status = 'running' WHERE id = $1", [agentId]);

    const second = await mutateAgentManagedConfig({
      pool,
      agentId,
      expectedRevision: 1,
      secretPatch: { set: { NEW_KEY: "new-value" } },
      addDeploymentJob: async () => {},
    });
    expect(second.desired_revision).toBe(2);

    const overrides = await listAgentSecretOverrides(agentId, { decryptValues: true, queryable: pool });
    expect(overrides).toEqual({ EXISTING_KEY: "untouched-value", NEW_KEY: "new-value" });
  });

  test("an explicit delete removes the key from encrypted storage, not just from the response", async () => {
    const agentId = await insertRunningAgent();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { listAgentSecretOverrides } = require("../agentSecretOverrides");

    await mutateAgentManagedConfig({
      pool,
      agentId,
      expectedRevision: 0,
      secretPatch: { set: { KEEP_KEY: "keep", REMOVE_KEY: "remove-me" } },
      addDeploymentJob: async () => {},
    });
    await pool.query("UPDATE agents SET status = 'running' WHERE id = $1", [agentId]);

    const result = await mutateAgentManagedConfig({
      pool,
      agentId,
      expectedRevision: 1,
      secretPatch: { delete: ["REMOVE_KEY"] },
      addDeploymentJob: async () => {},
    });
    expect(result.desired_revision).toBe(2);
    // key_names on the mutation response is the set of keys THIS patch touched
    // (set ∪ delete), not the full current key list — that full list is what
    // listAgentSecretOverrides below actually verifies.
    expect(result.key_names).toEqual(["REMOVE_KEY"]);

    const overrides = await listAgentSecretOverrides(agentId, { decryptValues: true, queryable: pool });
    expect(overrides).toEqual({ KEEP_KEY: "keep" });
    expect(overrides).not.toHaveProperty("REMOVE_KEY");
    const { rows } = await pool.query(
      "SELECT env_key FROM agent_secret_overrides WHERE agent_id = $1 AND env_key = $2",
      [agentId, "REMOVE_KEY"],
    );
    expect(rows).toHaveLength(0);
  });

  test("a patch that tries to set a Nora-reserved key is rejected before any row is mutated", async () => {
    const agentId = await insertRunningAgent();

    await expect(
      mutateAgentManagedConfig({
        pool,
        agentId,
        expectedRevision: 0,
        secretPatch: { set: { NORA_INTERNAL_TOKEN: "should-never-land" } },
        addDeploymentJob: async () => {},
      }),
    ).rejects.toMatchObject({ code: "reserved_secret_override_key" });

    // Validation runs before the lock/transaction is even opened — the
    // revision must not have advanced and no override row exists.
    const snapshot = await getAgentManagedConfigSnapshot(agentId, { queryable: pool, decryptSecrets: false });
    expect(snapshot.desiredRevision).toBe(0);
    const { rows } = await pool.query(
      "SELECT env_key FROM agent_secret_overrides WHERE agent_id = $1",
      [agentId],
    );
    expect(rows).toHaveLength(0);
  });
});
