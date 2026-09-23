// @ts-nocheck
const {
  adoptExternalAgent,
  createOrReuseExternalAgent,
  ExternalAgentProvisioningConflict,
} = require("../externalAgentProvisioning");

const identity = {
  user_id: "11111111-1111-4111-8111-111111111111",
  namespace: "headmaster",
  external_id: "22222222-2222-4222-8222-222222222222",
  owner_uuid: "33333333-3333-4333-8333-333333333333",
  runtime_family: "hermes",
  runtime_target: "docker",
};
const fingerprint = "a".repeat(64);
const agent = {
  id: "44444444-4444-4444-8444-444444444444",
  user_id: identity.user_id,
  name: "owner@example.test",
  status: "queued",
  external_id_namespace: identity.namespace,
  external_id: identity.external_id,
  external_owner_id: identity.owner_uuid,
  create_request_fingerprint: fingerprint,
};
const operation = {
  id: "55555555-5555-4555-8555-555555555555",
  status: "queued",
  queue_job_id: `headmaster-create-${agent.id}`,
  job_payload: { id: agent.id, name: agent.name },
};
const createFields = {
  name: agent.name,
  node: "docker",
  backendType: "docker",
  sandboxType: "standard",
  vcpu: 1,
  ramMb: 1024,
  diskGb: 10,
  containerName: `headmaster-${agent.id}`,
  image: "nora/hermes:stable",
  templatePayload: {},
  clawhubSkills: [],
  hermesSkills: [],
  runtimeFamily: "hermes",
  deployTarget: "docker",
  executionTargetId: "docker",
  sandboxProfile: "standard",
};

function makePool(responses) {
  const client = {
    query: jest.fn(async (sql) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(String(sql).trim())) return { rows: [] };
      if (String(sql).includes("pg_advisory_xact_lock")) return { rows: [] };
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error(`Unexpected query: ${sql}`);
      return next;
    }),
    release: jest.fn(),
  };
  return { pool: { connect: jest.fn().mockResolvedValue(client) }, client };
}

const input = (pool, overrides = {}) => ({
  pool,
  identity,
  requestKey: "create-request-a",
  fingerprint,
  createIfMissing: true,
  createFields,
  jobPayloadForAgent: jest.fn((row) => ({ id: row.id, name: row.name, backend: "docker" })),
  ...overrides,
});

describe("external agent provisioning transaction", () => {
  it("creates the agent, durable deployment outbox, and request mapping before one commit", async () => {
    const { pool, client } = makePool([
      { rows: [] }, // idempotency mapping
      { rows: [] }, // legacy direct mapping
      { rows: [] }, // external identity
      { rows: [agent] }, // agent insert
      { rows: [operation] }, // deployment/outbox insert
      { rows: [{ request_key: "create-request-a" }] }, // request mapping insert
    ]);

    const result = await createOrReuseExternalAgent(input(pool));
    const sql = client.query.mock.calls.map(([statement]) => statement);
    const agentInsert = sql.findIndex((statement) => statement.includes("INSERT INTO agents("));
    const operationInsert = sql.findIndex((statement) => statement.includes("INSERT INTO deployments("));
    const requestInsert = sql.findIndex((statement) => statement.includes("INSERT INTO external_agent_create_requests"));
    const commit = sql.indexOf("COMMIT");

    expect(result).toEqual({ agent, operation, created: true });
    expect(agentInsert).toBeGreaterThan(-1);
    expect(operationInsert).toBeGreaterThan(agentInsert);
    expect(requestInsert).toBeGreaterThan(operationInsert);
    expect(commit).toBeGreaterThan(requestInsert);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.filter((statement) => statement.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    expect(sql).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns the original agent and operation for an identical retry", async () => {
    const { pool, client } = makePool([
      {
        rows: [
          {
            ...agent,
            mapped_request_fingerprint: fingerprint,
            mapped_deployment_id: operation.id,
          },
        ],
      },
      { rows: [operation] },
    ]);

    await expect(createOrReuseExternalAgent(input(pool))).resolves.toEqual({
      agent: expect.objectContaining({ id: agent.id }),
      operation,
      created: false,
    });
    expect(client.query.mock.calls.some(([statement]) => statement.includes("INSERT INTO agents("))).toBe(false);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("rejects a reused idempotency key with a changed fingerprint without mutation", async () => {
    const { pool, client } = makePool([
      {
        rows: [
          {
            ...agent,
            mapped_request_fingerprint: "b".repeat(64),
            mapped_deployment_id: operation.id,
          },
        ],
      },
    ]);

    await expect(createOrReuseExternalAgent(input(pool))).rejects.toMatchObject({
      name: "ExternalAgentProvisioningConflict",
      statusCode: 409,
      code: "external_agent_idempotency_conflict",
    });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query.mock.calls.some(([statement]) => statement.includes("INSERT INTO agents("))).toBe(false);
  });

  it("maps a new key for an existing identity to the same agent and operation", async () => {
    const { pool, client } = makePool([
      { rows: [] }, // idempotency mapping
      { rows: [] }, // legacy direct mapping
      { rows: [agent] }, // external identity
      { rows: [operation] }, // existing create operation
      { rows: [{ request_key: "create-request-b" }] }, // new alias
    ]);

    const result = await createOrReuseExternalAgent(
      input(pool, { requestKey: "create-request-b", fingerprint: "c".repeat(64) }),
    );
    expect(result).toEqual({ agent, operation, created: false });
    expect(client.query.mock.calls.some(([statement]) => statement.includes("INSERT INTO agents("))).toBe(false);
    expect(client.query.mock.calls.some(([statement]) => statement.includes("INSERT INTO deployments("))).toBe(false);
    expect(client.query.mock.calls.some(([statement]) => statement.includes("INSERT INTO external_agent_create_requests"))).toBe(true);
  });

  it("fails closed when an existing workspace identity belongs to another owner", async () => {
    const { pool, client } = makePool([
      { rows: [] },
      { rows: [] },
      { rows: [{ ...agent, external_owner_id: "99999999-9999-4999-8999-999999999999" }] },
    ]);

    await expect(createOrReuseExternalAgent(input(pool))).rejects.toMatchObject({
      statusCode: 409,
      code: "external_agent_owner_conflict",
    });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query.mock.calls.some(([statement]) => statement.includes("INSERT INTO external_agent_create_requests"))).toBe(false);
  });

  it("rolls back the agent insert if persisting the operation fails", async () => {
    const operationError = new Error("outbox write failed");
    const { pool, client } = makePool([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [agent] },
      operationError,
    ]);

    await expect(createOrReuseExternalAgent(input(pool))).rejects.toBe(operationError);
    const sql = client.query.mock.calls.map(([statement]) => statement);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
  });

  it("adopts an existing agent by immutable Nora ID and commits the external identity", async () => {
    const legacyAgent = {
      id: agent.id,
      user_id: identity.user_id,
      name: "Legacy label",
      external_id_namespace: null,
      external_id: null,
      external_owner_id: null,
    };
    const adoptedAgent = {
      ...legacyAgent,
      external_id_namespace: identity.namespace,
      external_id: identity.external_id,
      external_owner_id: identity.owner_uuid,
    };
    const { pool, client } = makePool([
      { rows: [legacyAgent] },
      { rows: [] },
      { rows: [adoptedAgent] },
    ]);

    await expect(adoptExternalAgent({ pool, agentId: agent.id, identity })).resolves.toEqual({
      agent: adoptedAgent,
      adopted: true,
    });
    const sql = client.query.mock.calls.map(([statement]) => String(statement).trim());
    const update = sql.findIndex((statement) => statement.startsWith("UPDATE agents"));
    expect(sql[0]).toBe("BEGIN");
    expect(sql.some((statement) => statement.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(update).toBeGreaterThan(-1);
    expect(sql.indexOf("COMMIT")).toBeGreaterThan(update);
    expect(client.query.mock.calls[4][1]).toEqual([
      identity.user_id,
      agent.id,
      identity.namespace,
      identity.external_id,
      identity.owner_uuid,
    ]);
  });

  it("treats an identical adoption as idempotent and refuses an identity already bound elsewhere", async () => {
    const adoptedAgent = {
      ...agent,
      external_id_namespace: identity.namespace,
      external_id: identity.external_id,
      external_owner_id: identity.owner_uuid,
    };
    const repeated = makePool([
      { rows: [adoptedAgent] },
      { rows: [{ id: agent.id, external_owner_id: identity.owner_uuid }] },
    ]);
    await expect(
      adoptExternalAgent({ pool: repeated.pool, agentId: agent.id, identity }),
    ).resolves.toEqual({ agent: adoptedAgent, adopted: false });

    const conflict = makePool([
      { rows: [{ id: agent.id, user_id: identity.user_id, external_id_namespace: null, external_id: null, external_owner_id: null }] },
      { rows: [{ id: "77777777-7777-4777-8777-777777777777", external_owner_id: identity.owner_uuid }] },
    ]);
    await expect(
      adoptExternalAgent({ pool: conflict.pool, agentId: agent.id, identity }),
    ).rejects.toMatchObject({ statusCode: 409, code: "external_agent_identity_conflict" });
    expect(conflict.client.query.mock.calls.some(([statement]) => String(statement).startsWith("UPDATE agents"))).toBe(false);
    expect(conflict.client.query).toHaveBeenCalledWith("ROLLBACK");
  });
});