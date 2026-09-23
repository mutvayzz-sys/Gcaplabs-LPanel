// @ts-nocheck
const express = require("express");
const request = require("supertest");
const crypto = require("node:crypto");

const mockDbQuery = jest.fn();
jest.mock("../db", () => ({ query: mockDbQuery }));

const { authenticateToken } = require("../middleware/auth");
const identityRoute = require("../routes/headmasterRuntimeIdentity");
const runtimeIdentity = require("../runtimeIdentity");

const SERVICE_TOKEN = "headmaster-runtime-identity-service-token-0123456789abcdef";
const OWNER_A_AGENT = "11111111-1111-4111-8111-111111111111";
const OWNER_B_AGENT = "22222222-2222-4222-8222-222222222222";
const OWNER_A_EXTERNAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B_EXTERNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_B_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const previousServiceToken = process.env.NORA_HEADMASTER_RUNTIME_IDENTITY_TOKEN;

const app = express();
app.use(express.json());
app.use(authenticateToken);
app.use("/integrations/headmaster", identityRoute);
app.use("/api/integrations/headmaster", identityRoute);
app.get("/agents", (_req, res) => res.json({ listed: true }));
app.get("/agents/secrets", (_req, res) => res.json({ secrets: ["must-not-be-returned"] }));
app.post("/agents", (_req, res) => res.json({ mutated: true }));

function keyDigest(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function requestLookup(
  digest,
  token = SERVICE_TOKEN,
  path = "/integrations/headmaster/runtime-identity",
) {
  return request(app)
    .post(path)
    .set("Authorization", `Bearer ${token}`)
    .send({ runtime_key_sha256: digest });
}

beforeAll(() => {
  process.env.NORA_HEADMASTER_RUNTIME_IDENTITY_TOKEN = SERVICE_TOKEN;
});

afterAll(() => {
  if (previousServiceToken === undefined) delete process.env.NORA_HEADMASTER_RUNTIME_IDENTITY_TOKEN;
  else process.env.NORA_HEADMASTER_RUNTIME_IDENTITY_TOKEN = previousServiceToken;
});

beforeEach(() => {
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe("Headmaster runtime identity endpoint", () => {
  it("resolves two owners independently through the presented digest", async () => {
    const ownerAKey = "A".repeat(64);
    const ownerBKey = "B".repeat(64);
    const records = new Map([
      [
        keyDigest(ownerAKey),
        {
          agent_id: OWNER_A_AGENT,
          external_namespace: "headmaster",
          external_id: OWNER_A_EXTERNAL,
          external_owner_id: OWNER_A_UUID,
          credential_generation: "4",
          active: true,
        },
      ],
      [
        keyDigest(ownerBKey),
        {
          agent_id: "33333333-3333-4333-8333-333333333333",
          external_namespace: "headmaster",
          external_id: OWNER_B_EXTERNAL,
          external_owner_id: OWNER_B_UUID,
          credential_generation: "2",
          active: true,
        },
      ],
    ]);
    mockDbQuery.mockImplementation(async ({ values }) => ({
      rows: records.has(values[0]) ? [records.get(values[0])] : [],
    }));

    const [ownerA, ownerB] = await Promise.all([
      requestLookup(keyDigest(ownerAKey)),
      requestLookup(
        keyDigest(ownerBKey),
        SERVICE_TOKEN,
        "/api/integrations/headmaster/runtime-identity",
      ),
    ]);

    expect(ownerA.status).toBe(200);
    expect(ownerA.headers["cache-control"]).toBe("no-store");
    expect(ownerA.body).toEqual({
      agent_id: OWNER_A_AGENT,
      external_identity: {
        namespace: "headmaster",
        external_id: OWNER_A_EXTERNAL,
        owner_uuid: OWNER_A_UUID,
      },
      credential_generation: "4",
      active: true,
    });
    expect(ownerB.status).toBe(200);
    expect(ownerB.body.external_identity).toEqual({
      namespace: "headmaster",
      external_id: OWNER_B_EXTERNAL,
      owner_uuid: OWNER_B_UUID,
    });
    expect(ownerB.body.credential_generation).toBe("2");
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    expect(mockDbQuery.mock.calls[0][0].query_timeout).toBe(2500);
    for (const [{ text, values }] of mockDbQuery.mock.calls) {
      expect(text).toContain("WHERE c.key_digest = $1");
      const projection = text.slice(text.indexOf("SELECT"), text.indexOf("FROM"));
      expect(projection).not.toMatch(/gateway_token|SELECT\s+\*/i);
      expect(text).not.toMatch(/ORDER BY/i);
      expect(values).toHaveLength(1);
    }
  });

  it("reports rotated generations as inactive and the replacement as active", async () => {
    const oldDigest = keyDigest("old-runtime-key-".padEnd(64, "x"));
    const newDigest = keyDigest("new-runtime-key-".padEnd(64, "y"));
    const records = new Map([
      [
        oldDigest,
        {
          agent_id: OWNER_A_AGENT,
          external_namespace: "headmaster",
          external_id: OWNER_A_EXTERNAL,
          external_owner_id: OWNER_A_UUID,
          credential_generation: "8",
          active: false,
        },
      ],
      [
        newDigest,
        {
          agent_id: OWNER_A_AGENT,
          external_namespace: "headmaster",
          external_id: OWNER_A_EXTERNAL,
          external_owner_id: OWNER_A_UUID,
          credential_generation: "9",
          active: true,
        },
      ],
    ]);
    mockDbQuery.mockImplementation(async ({ values }) => ({
      rows: [records.get(values[0])].filter(Boolean),
    }));

    const [oldKey, newKey] = await Promise.all([
      requestLookup(oldDigest),
      requestLookup(newDigest),
    ]);
    expect(oldKey.status).toBe(200);
    expect(oldKey.body).toMatchObject({ credential_generation: "8", active: false });
    expect(newKey.status).toBe(200);
    expect(newKey.body).toMatchObject({ credential_generation: "9", active: true });
  });

  it("rejects unknown digests through one indexed equality lookup, not a fleet scan", async () => {
    const digests = Array.from({ length: 80 }, () =>
      keyDigest(crypto.randomBytes(32).toString("hex")),
    );
    const responses = await Promise.all(digests.map((digest) => requestLookup(digest)));

    expect(responses.every((response) => response.status === 404)).toBe(true);
    expect(mockDbQuery).toHaveBeenCalledTimes(digests.length);
    for (const [{ text, values }] of mockDbQuery.mock.calls) {
      expect(text).toContain("WHERE c.key_digest = $1");
      const projection = text.slice(text.indexOf("SELECT"), text.indexOf("FROM"));
      expect(projection).not.toMatch(/gateway_token|SELECT\s+\*/i);
      expect(text).not.toMatch(/NOT EXISTS|ORDER BY/i);
      expect(values).toHaveLength(1);
      expect(values[0]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rate-limits runtime identity lookups per source IP", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousWorkerId = process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = "production";
    delete process.env.JEST_WORKER_ID;
    try {
      const responses = await Promise.all(
        Array.from({ length: 61 }, (_, index) =>
          requestLookup(keyDigest(`rate-test-${index}`.padEnd(64, "r"))),
        ),
      );
      expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
      expect(mockDbQuery).toHaveBeenCalledTimes(60);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousWorkerId === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previousWorkerId;
    }
  });

  it("rejects malformed digests and caller-supplied identity fields before querying", async () => {
    const malformed = await requestLookup("not-a-digest");
    const enumeration = await request(app)
      .post("/integrations/headmaster/runtime-identity")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ runtime_key_sha256: "a".repeat(64), agent_id: OWNER_A_AGENT });

    expect(malformed.status).toBe(400);
    expect(enumeration.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("does not return secrets or the lookup digest", async () => {
    const rawKey = "secret-runtime-key-".padEnd(64, "k");
    const digest = keyDigest(rawKey);
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          agent_id: OWNER_A_AGENT,
          external_namespace: "headmaster",
          external_id: OWNER_A_EXTERNAL,
          external_owner_id: OWNER_A_UUID,
          credential_generation: "1",
          active: true,
          gateway_token: rawKey,
        },
      ],
    });

    const response = await requestLookup(digest);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      "active",
      "agent_id",
      "credential_generation",
      "external_identity",
    ]);
    expect(JSON.stringify(response.body)).not.toContain(rawKey);
    expect(JSON.stringify(response.body)).not.toContain(digest);
  });

  it("requires the scoped service bearer and never accepts operator cookies or service-token access elsewhere", async () => {
    const noBearer = await request(app)
      .post("/api/integrations/headmaster/runtime-identity")
      .set("Cookie", "nora_session=operator-session")
      .send({ runtime_key_sha256: "a".repeat(64) });
    const wrongBearer = await requestLookup("a".repeat(64), "wrong-service-token");
    const serviceList = await request(app)
      .get("/agents")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    const serviceSecrets = await request(app)
      .get("/agents/secrets")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    const serviceMutation = await request(app)
      .post("/agents")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);

    expect(noBearer.status).toBe(401);
    expect(wrongBearer.status).toBe(401);
    expect(serviceList.status).toBe(401);
    expect(serviceSecrets.status).toBe(401);
    expect(serviceMutation.status).toBe(401);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("fails closed with a generic 503 when Nora lookup is unavailable", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("secret-bearing database diagnostic"));
    const response = await requestLookup("c".repeat(64));
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Runtime identity lookup unavailable" });
    expect(JSON.stringify(response.body)).not.toContain("secret-bearing");
  });
});

describe("runtime credential digest", () => {
  it("uses the exact SHA-256 of a generated Hermes API_SERVER_KEY", () => {
    const apiServerKey = crypto.randomBytes(32).toString("hex");
    expect(runtimeIdentity.digestRuntimeKey(apiServerKey)).toBe(keyDigest(apiServerKey));
    expect(runtimeIdentity.digestRuntimeKey(apiServerKey)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["too-short", "x".repeat(32) + " whitespace"])(
    "rejects malformed runtime keys (%j)",
    (key) => expect(() => runtimeIdentity.digestRuntimeKey(key)).toThrow(TypeError),
  );
});

describe("runtime credential generation lifecycle", () => {
  function createCredentialStore() {
    const rows = [];
    return {
      rows,
      async query(query, params = []) {
        const sql = String(typeof query === "string" ? query : query.text)
          .replace(/\s+/g, " ")
          .trim();
        if (sql.includes("WHERE key_digest = $1")) {
          const row = rows.find((entry) => entry.key_digest === params[0]);
          return {
            rows: row
              ? [
                  {
                    agent_id: row.agent_id,
                    generation: String(row.generation),
                    credential_state: row.credential_state,
                  },
                ]
              : [],
          };
        }
        if (sql.includes("COALESCE(MAX(generation), 0)")) {
          const max = rows
            .filter((entry) => entry.agent_id === params[0])
            .reduce((value, entry) => Math.max(value, entry.generation), 0);
          return { rows: [{ generation: String(max) }] };
        }
        if (sql.includes("SELECT credential_state") && sql.includes("generation = $2")) {
          const row = rows.find(
            (entry) => entry.agent_id === params[0] && entry.generation === Number(params[1]),
          );
          return { rows: row ? [{ credential_state: row.credential_state }] : [] };
        }
        if (
          sql.startsWith("UPDATE agent_runtime_credentials") &&
          sql.includes("credential_state = 'retired'")
        ) {
          const [agentId, generation] = params;
          const statesToRetire = sql.includes("credential_state IN ('active', 'desired')")
            ? new Set(["active", "desired"])
            : sql.includes("credential_state = 'desired'")
              ? new Set(["desired"])
              : null;
          for (const row of rows) {
            const shouldRetire =
              row.agent_id === agentId &&
              statesToRetire?.has(row.credential_state) &&
              (sql.includes("generation <> $2") ? row.generation !== Number(generation) : true);
            if (shouldRetire) row.credential_state = "retired";
          }
          return { rows: [] };
        }
        if (
          sql.startsWith("UPDATE agent_runtime_credentials") &&
          sql.includes("credential_state = 'active'")
        ) {
          const [agentId, generation] = params;
          const row = rows.find(
            (entry) => entry.agent_id === agentId && entry.generation === Number(generation),
          );
          if (row) row.credential_state = "active";
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO agent_runtime_credentials")) {
          rows.push({
            agent_id: params[0],
            generation: Number(params[1]),
            key_digest: params[2],
            credential_state: "desired",
          });
          return { rows: [] };
        }
        throw new Error(`Unexpected runtime-credential SQL: ${sql}`);
      },
    };
  }

  it("keeps the new key desired until activation, then retires the prior generation", async () => {
    const store = createCredentialStore();
    const oldDigest = keyDigest("runtime-key-old-".padEnd(64, "o"));
    const nextDigest = keyDigest("runtime-key-next-".padEnd(64, "n"));

    const firstGeneration = await runtimeIdentity.stageDesiredRuntimeCredential(
      store,
      OWNER_A_AGENT,
      oldDigest,
    );
    expect(firstGeneration).toBe("1");
    expect(store.rows[0].credential_state).toBe("desired");
    await runtimeIdentity.activateRuntimeCredential(store, OWNER_A_AGENT, firstGeneration);
    expect(store.rows[0].credential_state).toBe("active");

    const nextGeneration = await runtimeIdentity.stageDesiredRuntimeCredential(
      store,
      OWNER_A_AGENT,
      nextDigest,
    );
    expect(nextGeneration).toBe("2");
    expect(store.rows.map((entry) => entry.credential_state)).toEqual(["active", "desired"]);
    const retriedGeneration = await runtimeIdentity.stageDesiredRuntimeCredential(
      store,
      OWNER_A_AGENT,
      nextDigest,
    );
    expect(retriedGeneration).toBe(nextGeneration);
    expect(store.rows.map((entry) => entry.credential_state)).toEqual(["active", "desired"]);
    await runtimeIdentity.activateRuntimeCredential(store, OWNER_A_AGENT, nextGeneration);
    expect(store.rows.map((entry) => entry.credential_state)).toEqual(["retired", "active"]);
    await expect(
      runtimeIdentity.stageDesiredRuntimeCredential(store, OWNER_A_AGENT, oldDigest),
    ).rejects.toMatchObject({
      code: "RUNTIME_CREDENTIAL_REUSE_REJECTED",
    });
  });

  it("fails closed when a digest is already bound to another agent", async () => {
    const store = createCredentialStore();
    const digest = keyDigest("runtime-key-global-".padEnd(64, "g"));
    await runtimeIdentity.stageDesiredRuntimeCredential(store, OWNER_A_AGENT, digest);
    await expect(
      runtimeIdentity.stageDesiredRuntimeCredential(store, OWNER_B_AGENT, digest),
    ).rejects.toMatchObject({
      code: "RUNTIME_CREDENTIAL_DIGEST_COLLISION",
    });
  });

  it("backfills only Nora-decrypted legacy Headmaster keys as generation one", async () => {
    const rawKey = "legacy-runtime-key-".padEnd(64, "L");
    const encryptedKey = `enc(${rawKey})`;
    const statements = [];
    const queryable = {
      async query(query, params = []) {
        const sql = String(typeof query === "string" ? query : query.text)
          .replace(/\s+/g, " ")
          .trim();
        statements.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("FROM agents a") && sql.includes("NOT EXISTS")) {
          return { rows: [{ agent_id: OWNER_A_AGENT, gateway_token: encryptedKey }] };
        }
        if (sql.includes("SELECT id::text AS agent_id, gateway_token")) {
          return {
            rows: [
              {
                agent_id: OWNER_A_AGENT,
                gateway_token: encryptedKey,
                status: "running",
                external_id_namespace: "headmaster",
                external_owner_id: OWNER_A_UUID,
              },
            ],
          };
        }
        if (sql.includes("SELECT generation FROM agent_runtime_credentials")) return { rows: [] };
        if (sql.includes("WHERE key_digest = $1")) return { rows: [] };
        if (sql.startsWith("INSERT INTO agent_runtime_credentials")) return { rows: [] };
        throw new Error(`Unexpected backfill SQL: ${sql}`);
      },
    };

    const result = await runtimeIdentity.backfillLegacyRuntimeCredentials(
      queryable,
      (ciphertext) => {
        expect(ciphertext).toBe(encryptedKey);
        return rawKey;
      },
      { batchSize: 2 },
    );

    expect(result).toEqual({ scanned: 1, indexed: 1 });
    const insert = statements.find(({ sql }) =>
      sql.startsWith("INSERT INTO agent_runtime_credentials"),
    );
    expect(insert.params).toEqual([OWNER_A_AGENT, runtimeIdentity.digestRuntimeKey(rawKey)]);
    expect(insert.sql).toContain("'active', NOW()");
    expect(JSON.stringify(statements)).not.toContain(rawKey);
  });

  it("fails closed when legacy backfill encounters a digest already owned by another agent", async () => {
    const rawKey = "duplicate-legacy-runtime-key-".padEnd(64, "D");
    const statements = [];
    const queryable = {
      async query(query, params = []) {
        const sql = String(typeof query === "string" ? query : query.text)
          .replace(/\s+/g, " ")
          .trim();
        statements.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("FROM agents a") && sql.includes("NOT EXISTS")) {
          return { rows: [{ agent_id: OWNER_A_AGENT, gateway_token: "encrypted-legacy-key" }] };
        }
        if (sql.includes("SELECT id::text AS agent_id, gateway_token")) {
          return {
            rows: [
              {
                agent_id: OWNER_A_AGENT,
                gateway_token: "encrypted-legacy-key",
                status: "running",
                external_id_namespace: "headmaster",
                external_owner_id: OWNER_A_UUID,
              },
            ],
          };
        }
        if (sql.includes("SELECT generation FROM agent_runtime_credentials")) return { rows: [] };
        if (sql.includes("WHERE key_digest = $1")) {
          return { rows: [{ agent_id: OWNER_B_AGENT }] };
        }
        if (sql.startsWith("INSERT INTO agent_runtime_credentials")) return { rows: [] };
        throw new Error(`Unexpected backfill SQL: ${sql}`);
      },
    };

    await expect(
      runtimeIdentity.backfillLegacyRuntimeCredentials(queryable, () => rawKey, { batchSize: 2 }),
    ).rejects.toMatchObject({ code: "RUNTIME_CREDENTIAL_DIGEST_COLLISION" });
    expect(
      statements.some(({ sql }) => sql.startsWith("INSERT INTO agent_runtime_credentials")),
    ).toBe(false);
    expect(JSON.stringify(statements)).not.toContain(rawKey);
  });
});
