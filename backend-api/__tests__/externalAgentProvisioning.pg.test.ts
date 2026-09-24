// Real-PostgreSQL integration test for M2.7 (Masterplan3): duplicate create
// under concurrency, idempotency-key conflict, and revision-conflict races
// against a real disposable Postgres, not the mocked pool the sibling
// externalAgentProvisioning.test.ts uses. Requires a running Postgres 15
// reachable at DATABASE_URL (a disposable local/CI container — never a
// shared or production database).
import { Pool } from "pg";
import { randomUUID } from "crypto";

import {
  createOrReuseExternalAgent,
  ExternalAgentProvisioningConflict,
} from "../externalAgentProvisioning";
import { normalizeExternalAgentIdentity } from "../externalAgentIdentity";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(30000);

describeIfDb("createOrReuseExternalAgent against real Postgres", () => {
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

  function createFields(agentId: string) {
    return {
      agentId,
      name: `pg-test-${agentId}`,
      node: "test-node",
      backendType: "docker",
      sandboxType: "standard",
      vcpu: 1,
      ramMb: 512,
      diskGb: 5,
      containerName: `pg-test-${agentId}`,
      image: null,
      templatePayload: {},
      clawhubSkills: [],
      hermesSkills: [],
      runtimeFamily: "openclaw",
      deployTarget: "docker",
      executionTargetId: "docker",
      sandboxProfile: "standard",
    };
  }

  const principalFor = (uid: string) => ({ managementUserId: uid, ownerUuid: uid });

  test("concurrent creates with the SAME idempotency key produce exactly one agent", async () => {
    const workspaceUuid = randomUUID();
    const identity = normalizeExternalAgentIdentity(
      {
        namespace: "headmaster",
        external_id: workspaceUuid,
        runtime_family: "openclaw",
        runtime_target: "docker",
      },
      principalFor(userId),
    );
    const requestKey = `concurrent-same-key-${workspaceUuid}`;
    const fingerprint = "a".repeat(64);

    const attempt = () =>
      createOrReuseExternalAgent({
        pool,
        identity,
        requestKey,
        fingerprint,
        createIfMissing: true,
        createFields: createFields(randomUUID()),
        jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
      });

    const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
    const agentIds = new Set(results.map((r) => r.agent?.id));
    expect(agentIds.size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM agents WHERE external_id_namespace = 'headmaster' AND external_id = $1",
      [workspaceUuid],
    );
    expect(rows[0].n).toBe(1);
  });

  test("a DIFFERENT idempotency key aliasing the same external identity resolves to the SAME agent, never a second one", async () => {
    // Documented design (externalAgentProvisioning.ts): "A new request key may
    // alias an existing immutable identity" — the identity, not the request
    // key, is the durable dedup boundary. A conflict is for a key REUSED
    // against a different identity/fingerprint, not this case.
    const workspaceUuid = randomUUID();
    const identity = normalizeExternalAgentIdentity(
      {
        namespace: "headmaster",
        external_id: workspaceUuid,
        runtime_family: "openclaw",
        runtime_target: "docker",
      },
      principalFor(userId),
    );
    const fingerprint = "b".repeat(64);

    const first = await createOrReuseExternalAgent({
      pool,
      identity,
      requestKey: `first-key-${workspaceUuid}`,
      fingerprint,
      createIfMissing: true,
      createFields: createFields(randomUUID()),
      jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
    });

    const second = await createOrReuseExternalAgent({
      pool,
      identity,
      requestKey: `second-key-${workspaceUuid}`,
      fingerprint,
      createIfMissing: true,
      createFields: createFields(randomUUID()),
      jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
    });

    expect(second.agent?.id).toBe(first.agent?.id);
    expect(second.created).toBe(false);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM agents WHERE external_id_namespace = 'headmaster' AND external_id = $1",
      [workspaceUuid],
    );
    expect(rows[0].n).toBe(1);
  });

  test("a request whose identity claims a different owner than the existing agent's is rejected as an owner conflict", async () => {
    // Same Nora management principal (the (user_id, namespace, external_id)
    // unique index is scoped by user_id), but a different claimed owner_uuid
    // for the SAME external_id — this is the actual collision
    // assertAgentIdentity/the owner_uuid check in createOrReuseExternalAgent
    // exists to catch, independent of which management account is calling.
    const workspaceUuid = randomUUID();
    const otherOwner = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [otherOwner, `${otherOwner}@pg-test.invalid`],
    );

    await createOrReuseExternalAgent({
      pool,
      identity: normalizeExternalAgentIdentity(
        {
          namespace: "headmaster",
          external_id: workspaceUuid,
          runtime_family: "openclaw",
          runtime_target: "docker",
        },
        principalFor(userId),
      ),
      requestKey: `owner-conflict-owner-${workspaceUuid}`,
      fingerprint: "b".repeat(64),
      createIfMissing: true,
      createFields: createFields(randomUUID()),
      jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
    });

    await expect(
      createOrReuseExternalAgent({
        pool,
        identity: normalizeExternalAgentIdentity(
          {
            namespace: "headmaster",
            external_id: workspaceUuid,
            runtime_family: "openclaw",
            runtime_target: "docker",
          },
          { managementUserId: userId, ownerUuid: otherOwner },
        ),
        requestKey: `owner-conflict-attempt-${workspaceUuid}`,
        fingerprint: "b".repeat(64),
        createIfMissing: true,
        createFields: createFields(randomUUID()),
        jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
      }),
    ).rejects.toMatchObject({ code: "external_agent_owner_conflict" });
  });

  test("the SAME idempotency key reused with a DIFFERENT external identity is rejected, not silently rebound", async () => {
    const requestKey = `reuse-key-${randomUUID()}`;
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const fingerprint = "c".repeat(64);

    const identityA = normalizeExternalAgentIdentity(
      {
        namespace: "headmaster",
        external_id: workspaceA,
        runtime_family: "openclaw",
        runtime_target: "docker",
      },
      principalFor(userId),
    );
    const identityB = normalizeExternalAgentIdentity(
      {
        namespace: "headmaster",
        external_id: workspaceB,
        runtime_family: "openclaw",
        runtime_target: "docker",
      },
      principalFor(userId),
    );

    await createOrReuseExternalAgent({
      pool,
      identity: identityA,
      requestKey,
      fingerprint,
      createIfMissing: true,
      createFields: createFields(randomUUID()),
      jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
    });

    await expect(
      createOrReuseExternalAgent({
        pool,
        identity: identityB,
        requestKey,
        fingerprint,
        createIfMissing: true,
        createFields: createFields(randomUUID()),
        jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
      }),
    ).rejects.toBeInstanceOf(ExternalAgentProvisioningConflict);
  });

  test("two different owners creating concurrently under distinct identities never collide", async () => {
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'user'), ($3, $4, 'x', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [ownerA, `${ownerA}@pg-test.invalid`, ownerB, `${ownerB}@pg-test.invalid`],
    );
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();

    const [resultA, resultB] = await Promise.all([
      createOrReuseExternalAgent({
        pool,
        identity: normalizeExternalAgentIdentity(
          {
            namespace: "headmaster",
            external_id: workspaceA,
            runtime_family: "openclaw",
            runtime_target: "docker",
          },
          principalFor(ownerA),
        ),
        requestKey: `owner-a-${workspaceA}`,
        fingerprint: "d".repeat(64),
        createIfMissing: true,
        createFields: createFields(randomUUID()),
        jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
      }),
      createOrReuseExternalAgent({
        pool,
        identity: normalizeExternalAgentIdentity(
          {
            namespace: "headmaster",
            external_id: workspaceB,
            runtime_family: "openclaw",
            runtime_target: "docker",
          },
          principalFor(ownerB),
        ),
        requestKey: `owner-b-${workspaceB}`,
        fingerprint: "e".repeat(64),
        createIfMissing: true,
        createFields: createFields(randomUUID()),
        jobPayloadForAgent: (agent) => ({ agentId: agent.id }),
      }),
    ]);

    expect(resultA.agent?.id).not.toBe(resultB.agent?.id);
    expect(resultA.agent?.user_id).toBe(ownerA);
    expect(resultB.agent?.user_id).toBe(ownerB);
  });
});
