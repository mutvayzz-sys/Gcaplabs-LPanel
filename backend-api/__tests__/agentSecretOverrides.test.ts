// @ts-nocheck
let mockClient;
const mockEncrypt = jest.fn((value) => `encrypted:${value}`);
const mockDecrypt = jest.fn((value) => String(value).replace(/^encrypted:/, ""));
const mockEnsureEncryptionConfigured = jest.fn();
const mockDb = {
  connect: jest.fn(async () => mockClient),
};

jest.mock("../db", () => mockDb);
jest.mock("../crypto", () => ({
  decrypt: mockDecrypt,
  encrypt: mockEncrypt,
  ensureEncryptionConfigured: mockEnsureEncryptionConfigured,
}));

const {
  normalizeOverrideEntries,
  replaceAgentSecretOverrides,
} = require("../agentSecretOverrides");

function makeClient({ failOnKey = null } = {}) {
  const calls = [];
  const query = jest.fn(async (sql, values = []) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, values });
    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [] };
    }
    if (normalized.startsWith("DELETE FROM agent_secret_overrides")) {
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO agent_secret_overrides")) {
      if (values[1] === failOnKey) throw new Error("write failed");
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  });
  return { calls, query, release: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClient = makeClient();
  mockDb.connect.mockResolvedValue(mockClient);
});

test("import normalization rejects names that collapse to the same environment key", () => {
  expect(() => normalizeOverrideEntries({ "MY KEY": "first", MY_KEY: "second" }))
    .toThrow("collide after normalization");
  expect(mockDb.connect).not.toHaveBeenCalled();
});

test("import replacement rejects invalid and Nora-reserved environment names before opening a transaction", async () => {
  expect(() => normalizeOverrideEntries({ "OPENAI.KEY": "secret" }))
    .toThrow("valid environment variable names");
  await expect(replaceAgentSecretOverrides("agent-1", { HEADMASTER_OWNER_ID: "spoofed" }))
    .rejects.toThrow("Nora-reserved");
  expect(mockDb.connect).not.toHaveBeenCalled();
});

test("full import replacement deletes and writes under one transaction", async () => {
  await replaceAgentSecretOverrides("agent-1", {
    OPENAI_API_KEY: "new-openai-secret",
    ANTHROPIC_API_KEY: "new-anthropic-secret",
  });

  expect(mockClient.calls.map((call) => call.sql)).toEqual([
    "BEGIN",
    "DELETE FROM agent_secret_overrides WHERE agent_id = $1",
    expect.stringContaining("INSERT INTO agent_secret_overrides"),
    expect.stringContaining("INSERT INTO agent_secret_overrides"),
    "COMMIT",
  ]);
  expect(mockClient.calls.find((call) => call.sql === "COMMIT")).toBeDefined();
  expect(mockClient.release).toHaveBeenCalledTimes(1);
  expect(mockEncrypt).toHaveBeenCalledWith("new-openai-secret");
  expect(mockEncrypt).toHaveBeenCalledWith("new-anthropic-secret");
});

test("a failed import write rolls back the delete and every earlier insert", async () => {
  mockClient = makeClient({ failOnKey: "SECOND_KEY" });
  mockDb.connect.mockResolvedValue(mockClient);

  await expect(replaceAgentSecretOverrides("agent-1", {
    FIRST_KEY: "first-secret",
    SECOND_KEY: "second-secret",
  })).rejects.toThrow("write failed");

  expect(mockClient.calls.map((call) => call.sql)).toEqual([
    "BEGIN",
    "DELETE FROM agent_secret_overrides WHERE agent_id = $1",
    expect.stringContaining("INSERT INTO agent_secret_overrides"),
    expect.stringContaining("INSERT INTO agent_secret_overrides"),
    "ROLLBACK",
  ]);
  expect(mockClient.calls.some((call) => call.sql === "COMMIT")).toBe(false);
  expect(mockClient.release).toHaveBeenCalledTimes(1);
});

test("a caller-supplied transaction client is not independently committed", async () => {
  const transactionClient = makeClient();
  await replaceAgentSecretOverrides("agent-1", { OPENAI_API_KEY: "new-secret" }, {
    queryable: transactionClient,
  });

  expect(transactionClient.calls[0].sql).toBe("DELETE FROM agent_secret_overrides WHERE agent_id = $1");
  expect(transactionClient.calls.some((call) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql))).toBe(false);
  expect(transactionClient.release).not.toHaveBeenCalled();
});
