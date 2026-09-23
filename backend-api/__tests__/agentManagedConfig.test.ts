// @ts-nocheck
const mockEncrypt = jest.fn((value) => `encrypted:${value}`);
const mockEnsureEncryptionConfigured = jest.fn();

jest.mock("../redisQueue", () => ({ addDeploymentJob: jest.fn() }));
const { addDeploymentJob: mockQueuedDeployment } = require("../redisQueue");

jest.mock("../crypto", () => ({
  encrypt: mockEncrypt,
  ensureEncryptionConfigured: mockEnsureEncryptionConfigured,
}));

const {
  buildAgentManagedConfigRuntimeEnv,
  getAgentManagedConfigStatus,
  markAgentManagedConfigApplied,
  markAgentManagedConfigFailed,
  mutateAgentManagedConfig,
  normalizeSecretOverridePatch,
  retryAgentManagedConfigJob,
  validateHeadmasterIntegrationConfig,
} = require("../agentManagedConfig");

const OWNER_ID = "f125bb2c-1ce1-4b01-9da5-9b736caf503f";
const WORKSPACE_ID = "43cce99c-8d62-43c4-ad12-8984c5505a23";
const MEMORY_URL = "http://headmaster-memory-gateway:8080";

function makeAgent(overrides = {}) {
  return {
    id: "agent-1",
    user_id: "nora-user-1",
    name: "workspace@example.test",
    status: "running",
    container_id: "container-1",
    container_name: "nora-hermes-agent-1",
    host: "172.20.0.4",
    image: "headmaster-hermes:test",
    backend_type: "docker",
    runtime_family: "hermes",
    deploy_target: "docker",
    execution_target_id: "docker",
    sandbox_profile: "standard",
    vcpu: 1,
    ram_mb: 1024,
    disk_gb: 10,
    external_id_namespace: "headmaster",
    external_id: WORKSPACE_ID,
    external_owner_id: OWNER_ID,
    ...overrides,
  };
}

function makeMutationHarness({ revision = 4, initialSecrets = {}, failOnSecretKey = null, failOnDeployment = false } = {}) {
  const agent = makeAgent();
  const state = {
    desired_revision: revision,
    applied_revision: revision - 1,
    headmaster_integration_config: null,
    last_job_id: null,
    last_error: null,
  };
  const secrets = new Map(Object.entries(initialSecrets));
  const calls = [];
  let transactionSnapshot = null;
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql, values = []) => {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (normalized === "BEGIN") {
        transactionSnapshot = {
          state: { ...state },
          secrets: new Map(secrets),
          agentStatus: agent.status,
        };
        return { rows: [] };
      }
      if (normalized === "COMMIT") {
        transactionSnapshot = null;
        return { rows: [] };
      }
      if (normalized === "ROLLBACK") {
        if (transactionSnapshot) {
          Object.assign(state, transactionSnapshot.state);
          secrets.clear();
          for (const [key, value] of transactionSnapshot.secrets) secrets.set(key, value);
          agent.status = transactionSnapshot.agentStatus;
        }
        transactionSnapshot = null;
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT * FROM agents")) return { rows: [agent], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO agent_managed_config")) return { rows: [] };
      if (normalized.startsWith("SELECT desired_revision")) return { rows: [state], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO agent_secret_overrides")) {
        const [agentId, key, value] = values;
        if (key === failOnSecretKey) throw new Error("simulated storage failure");
        secrets.set(key, value);
        return { rows: [] };
      }
      if (normalized.startsWith("DELETE FROM agent_secret_overrides")) {
        const [agentId, key] = values;
        secrets.delete(key);
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE agent_managed_config")) {
        state.desired_revision = Number(values[1]);
        state.headmaster_integration_config = values[2] ? JSON.parse(values[2]) : null;
        state.last_job_id = values[3];
        state.last_error = null;
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE agents SET status = 'queued'")) {
        agent.status = "queued";
        return { rows: [{ id: agent.id }], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO deployments")) {
        if (failOnDeployment) throw new Error("simulated durable job write failure");
        return { rows: [{ id: "deployment-1" }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${normalized}`);
    }),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client) };
  const release = jest.fn();
  const acquireLock = jest.fn().mockResolvedValue({ release });
  const addDeploymentJob = jest.fn().mockResolvedValue({ id: "queued-job" });
  return { agent, state, secrets, calls, client, pool, release, acquireLock, addDeploymentJob };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Headmaster managed configuration validation", () => {
  it("accepts only the immutable owner/workspace and their canonical bank", () => {
    expect(
      validateHeadmasterIntegrationConfig(
        {
          owner_uuid: OWNER_ID,
          workspace_uuid: WORKSPACE_ID,
          memory_bank_id: `hermes-u-${OWNER_ID.replace(/-/g, "_")}`,
          memory_gateway_url: MEMORY_URL,
        },
        { ownerUuid: OWNER_ID, workspaceUuid: WORKSPACE_ID, allowedGatewayUrl: MEMORY_URL },
      ),
    ).toEqual({
      owner_uuid: OWNER_ID,
      workspace_uuid: WORKSPACE_ID,
      memory_bank_id: `hermes-u-${OWNER_ID.replace(/-/g, "_")}`,
      memory_gateway_url: MEMORY_URL,
    });
  });

  it.each([
    ["owner mismatch", { owner_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["workspace mismatch", { workspace_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["noncanonical bank", { memory_bank_id: "hermes-u-other" }],
    ["untrusted gateway", { memory_gateway_url: "http://attacker.invalid" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      validateHeadmasterIntegrationConfig(
        {
          owner_uuid: OWNER_ID,
          workspace_uuid: WORKSPACE_ID,
          memory_bank_id: `hermes-u-${OWNER_ID.replace(/-/g, "_")}`,
          memory_gateway_url: MEMORY_URL,
          ...override,
        },
        { ownerUuid: OWNER_ID, workspaceUuid: WORKSPACE_ID, allowedGatewayUrl: MEMORY_URL },
      ),
    ).toThrow();
  });
});

describe("managed secret override validation", () => {
  it("rejects malformed names, normalization collisions, and Nora-owned keys", () => {
    expect(() => normalizeSecretOverridePatch({ set: { "A B": "x" }, delete: [] })).toThrow();
    expect(() => normalizeSecretOverridePatch({ set: { A: "1", " A ": "2" }, delete: [] })).toThrow();
    expect(() => normalizeSecretOverridePatch({ set: { API_SERVER_KEY: "override" }, delete: [] })).toThrow();
    expect(() => normalizeSecretOverridePatch({ set: { NORA_INTERNAL_TOKEN: "override" }, delete: [] })).toThrow();
  });

  it("normalizes an explicit set/delete patch without accepting overlap", () => {
    expect(
      normalizeSecretOverridePatch({ set: { OPENAI_API_KEY: "secret" }, delete: ["OLD_TOKEN"] }),
    ).toEqual({ set: { OPENAI_API_KEY: "secret" }, delete: ["OLD_TOKEN"] });
    expect(() =>
      normalizeSecretOverridePatch({ set: { OPENAI_API_KEY: "secret" }, delete: ["OPENAI_API_KEY"] }),
    ).toThrow();
  });
});

describe("managed configuration worker snapshot", () => {
  it("builds worker env from decrypted secrets and validated immutable integration metadata", () => {
    const result = buildAgentManagedConfigRuntimeEnv(
      {
        desiredRevision: 7,
        secretOverrides: { OPENAI_API_KEY: "decrypted-secret" },
        headmasterIntegrationConfig: {
          owner_uuid: OWNER_ID,
          workspace_uuid: WORKSPACE_ID,
          memory_bank_id: `hermes-u-${OWNER_ID.replace(/-/g, "_")}`,
          memory_gateway_url: MEMORY_URL,
        },
      },
      { externalIdNamespace: "headmaster", ownerUuid: OWNER_ID, workspaceUuid: WORKSPACE_ID, allowedGatewayUrl: MEMORY_URL },
    );

    expect(result.env).toEqual({
      OPENAI_API_KEY: "decrypted-secret",
      HEADMASTER_OWNER_ID: OWNER_ID,
      HEADMASTER_WORKSPACE_ID: WORKSPACE_ID,
      HEADMASTER_MEMORY_BANK_ID: `hermes-u-${OWNER_ID.replace(/-/g, "_")}`,
      HEADMASTER_MEMORY_GATEWAY_URL: MEMORY_URL,
    });
    expect(result.integrationEnvNames).toEqual([
      "HEADMASTER_OWNER_ID",
      "HEADMASTER_WORKSPACE_ID",
      "HEADMASTER_MEMORY_BANK_ID",
      "HEADMASTER_MEMORY_GATEWAY_URL",
    ]);
    expect(result.desiredRevision).toBe(7);
  });

  it("does not expose secret values in managed config status", async () => {
    const calls = [];
    const queryable = {
      query: jest.fn(async (sql, values) => {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, values });
        if (normalized.startsWith("SELECT desired_revision")) {
          return {
            rows: [{
              desired_revision: 2,
              applied_revision: 1,
              headmaster_integration_config: null,
              last_job_id: "managed-config-agent-1-2",
              last_error: null,
            }],
          };
        }
        if (normalized.startsWith("SELECT env_key, env_value")) {
          return { rows: [{ env_key: "OPENAI_API_KEY", env_value: "encrypted:sentinel" }] };
        }
        if (normalized.startsWith("SELECT status, queue_job_id")) {
          return { rows: [{ status: "deploying", queue_job_id: values[1] }] };
        }
        throw new Error(`Unexpected SQL in status test: ${normalized}`);
      }),
    };

    const status = await getAgentManagedConfigStatus("agent-1", { queryable });
    expect(status).toEqual({
      key_names: ["OPENAI_API_KEY"],
      integration_key_names: [],
      desired_revision: 2,
      applied_revision: 1,
      job_id: "managed-config-agent-1-2",
      deployment_status: "deploying",
      last_error: null,
    });
    expect(JSON.stringify(status)).not.toContain("sentinel");
    expect(calls.some(({ sql }) => sql.includes("decrypt"))).toBe(false);
  });
});

describe("mutateAgentManagedConfig", () => {
  it("atomically updates selected keys, preserves unrelated secrets, and queues a revision", async () => {
    const h = makeMutationHarness({
      initialSecrets: { KEEP_TOKEN: "encrypted:keep", OLD_TOKEN: "encrypted:old" },
    });
    h.addDeploymentJob.mockImplementation(async () => {
      expect(h.calls.find((call) => call.sql === "COMMIT")).toBeDefined();
      expect(h.release).not.toHaveBeenCalled();
      return { id: "queued-job" };
    });
    const result = await mutateAgentManagedConfig({
      pool: h.pool,
      agentId: h.agent.id,
      expectedRevision: 4,
      secretPatch: { set: { OPENAI_API_KEY: "new-secret" }, delete: ["OLD_TOKEN"] },
      acquireLock: h.acquireLock,
      addDeploymentJob: h.addDeploymentJob,
    });

    expect(result).toEqual({
      key_names: ["OLD_TOKEN", "OPENAI_API_KEY"],
      desired_revision: 5,
      applied_revision: 3,
      job_id: "managed-config-agent-1-5",
    });
    expect(h.secrets).toEqual(new Map([
      ["KEEP_TOKEN", "encrypted:keep"],
      ["OPENAI_API_KEY", "encrypted:new-secret"],
    ]));
    expect(h.agent.status).toBe("queued");
    expect(h.addDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({ managed_config_revision: 5, replace_existing_runtime: true }),
      { jobId: "managed-config-agent-1-5" },
    );
    expect(h.calls.find((call) => call.sql === "COMMIT")).toBeDefined();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("new-secret");
  });

  it("rejects a stale expected revision without changing secrets or queueing", async () => {
    const h = makeMutationHarness({ revision: 7, initialSecrets: { KEEP_TOKEN: "encrypted:keep" } });
    await expect(
      mutateAgentManagedConfig({
        pool: h.pool,
        agentId: h.agent.id,
        expectedRevision: 6,
        secretPatch: { set: { OPENAI_API_KEY: "new-secret" }, delete: [] },
        acquireLock: h.acquireLock,
        addDeploymentJob: h.addDeploymentJob,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "managed_config_revision_conflict" });
    expect(h.secrets).toEqual(new Map([["KEEP_TOKEN", "encrypted:keep"]]));
    expect(h.addDeploymentJob).not.toHaveBeenCalled();
    expect(h.calls.find((call) => call.sql === "ROLLBACK")).toBeDefined();
  });

  it("rolls back all key writes and the revision if a later encrypted write fails", async () => {
    const h = makeMutationHarness({
      revision: 2,
      initialSecrets: { KEEP_TOKEN: "encrypted:keep" },
      failOnSecretKey: "SECOND_KEY",
    });
    await expect(
      mutateAgentManagedConfig({
        pool: h.pool,
        agentId: h.agent.id,
        expectedRevision: 2,
        secretPatch: {
          set: { FIRST_KEY: "first-secret", SECOND_KEY: "second-secret" },
          delete: [],
        },
        acquireLock: h.acquireLock,
        addDeploymentJob: h.addDeploymentJob,
      }),
    ).rejects.toThrow("simulated storage failure");
    expect(h.calls.find((call) => call.sql === "ROLLBACK")).toBeDefined();
    expect(h.secrets).toEqual(new Map([["KEEP_TOKEN", "encrypted:keep"]]));
    expect(h.addDeploymentJob).not.toHaveBeenCalled();
    expect(h.state.desired_revision).toBe(2);
  });

  it("rolls back secret, revision, status, and durable job writes when the outbox insert fails", async () => {
    const h = makeMutationHarness({
      revision: 3,
      initialSecrets: { KEEP_TOKEN: "encrypted:keep", OLD_TOKEN: "encrypted:old" },
      failOnDeployment: true,
    });

    await expect(mutateAgentManagedConfig({
      pool: h.pool,
      agentId: h.agent.id,
      expectedRevision: 3,
      secretPatch: { set: { NEW_TOKEN: "new-secret" }, delete: ["OLD_TOKEN"] },
      acquireLock: h.acquireLock,
      addDeploymentJob: h.addDeploymentJob,
    })).rejects.toThrow("simulated durable job write failure");

    expect(h.calls.find((call) => call.sql === "ROLLBACK")).toBeDefined();
    expect(h.state.desired_revision).toBe(3);
    expect(h.state.last_job_id).toBeNull();
    expect(h.agent.status).toBe("running");
    expect(h.secrets).toEqual(new Map([
      ["KEEP_TOKEN", "encrypted:keep"],
      ["OLD_TOKEN", "encrypted:old"],
    ]));
    expect(h.addDeploymentJob).not.toHaveBeenCalled();
  });

  it("records a durable desired revision before reporting a queue publication failure", async () => {
    const h = makeMutationHarness({ revision: 8 });
    h.addDeploymentJob.mockRejectedValue(new Error("Redis unavailable"));

    await expect(mutateAgentManagedConfig({
      pool: h.pool,
      agentId: h.agent.id,
      expectedRevision: 8,
      secretPatch: { set: { OPENAI_API_KEY: "new-secret" }, delete: [] },
      acquireLock: h.acquireLock,
      addDeploymentJob: h.addDeploymentJob,
    })).rejects.toMatchObject({ statusCode: 503, code: "managed_config_queue_failed" });

    expect(h.state.desired_revision).toBe(9);
    expect(h.state.last_job_id).toBe("managed-config-agent-1-9");
    expect(h.agent.status).toBe("queued");
    expect(h.calls.find((call) => call.sql === "COMMIT")).toBeDefined();
    expect(h.calls.find((call) => call.sql === "ROLLBACK")).toBeUndefined();
  });

  it("rebuilds a failed retry from current runtime metadata and republishes the same revision job", async () => {
    const agent = makeAgent({
      status: "error",
      container_id: null,
      host: null,
      container_name: "nora-hermes-agent-1",
    });
    const state = { desired_revision: 5, applied_revision: 4, last_job_id: "managed-config-agent-1-5" };
    const savedPayload = {
      id: agent.id,
      managed_config_revision: 5,
      managed_config_job_id: state.last_job_id,
      replace_existing_runtime: true,
      previous_container_id: "container-old",
    };
    const calls = [];
    const client = {
      query: jest.fn(async (sql, values = []) => {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, values });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
        if (normalized.startsWith("SELECT * FROM agents")) return { rows: [agent] };
        if (normalized.startsWith("SELECT config.desired_revision")) {
          return { rows: [{ ...state, job_payload: savedPayload }] };
        }
        if (normalized.startsWith("UPDATE agents SET status = 'queued'")) {
          agent.status = "queued";
          return { rows: [{ id: agent.id }], rowCount: 1 };
        }
        if (normalized.startsWith("UPDATE deployments SET status = 'queued', job_payload")) {
          return { rows: [{ queue_job_id: state.last_job_id }], rowCount: 1 };
        }
        if (normalized.startsWith("UPDATE agent_managed_config")) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected SQL in retry test: ${normalized}`);
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    const release = jest.fn();
    const acquireLock = jest.fn().mockResolvedValue({ release });
    mockQueuedDeployment.mockResolvedValue({ id: "queued" });

    await expect(retryAgentManagedConfigJob(agent.id, { pool, acquireLock }))
      .resolves.toEqual({ job_id: state.last_job_id });

    const queuedPayload = mockQueuedDeployment.mock.calls[0][0];
    expect(queuedPayload.previous_container_id).toBeNull();
    expect(queuedPayload.previous_host).toBeNull();
    expect(queuedPayload.managed_config_revision).toBe(5);
    expect(mockQueuedDeployment).toHaveBeenCalledWith(queuedPayload, { jobId: state.last_job_id });
    expect(calls.some(({ sql, values }) => sql.startsWith("UPDATE deployments SET status = 'queued', job_payload") && JSON.parse(values[2]).previous_container_id === null)).toBe(true);
    expect(client.query.mock.calls.find(([sql]) => sql === "COMMIT")).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("managed configuration worker lifecycle", () => {
  it("only advances the applied revision when it still matches the desired revision", async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    await expect(markAgentManagedConfigApplied(queryable, "agent-1", 6)).resolves.toBe(true);
    expect(queryable.query.mock.calls[0][0]).toContain("WHERE agent_id = $1 AND desired_revision = $2");

    queryable.query.mockResolvedValueOnce({ rowCount: 0 });
    await expect(markAgentManagedConfigApplied(queryable, "agent-1", 5)).resolves.toBe(false);
  });

  it("marks only the still-desired revision as failed", async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rowCount: 0 }) };
    await expect(markAgentManagedConfigFailed(queryable, "agent-1", 5)).resolves.toBe(false);
    expect(queryable.query.mock.calls[0][0]).toContain("WHERE agent_id = $1 AND desired_revision = $2");
  });
});
