// @ts-nocheck
/**
 * __tests__/headmasterRuntimeIdentity.test.ts — the N3 runtime-identity
 * resolver consumed by the Headmaster memory gateway
 * (gcaplabs-webapp services/admission/nora-runtime-identity.mjs). Mocks db so
 * the SQL surface is pinned without needing Postgres.
 */

const request = require("supertest");
const express = require("express");
const crypto = require("crypto");

const SERVICE_TOKEN = "n3-service-token-at-least-32-characters-long";
process.env.HEADMASTER_RUNTIME_IDENTITY_SERVICE_TOKEN = SERVICE_TOKEN;
delete process.env.ENCRYPTION_KEY;

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const router = require("../routes/headmasterRuntimeIdentity");
const {
  deriveHeadmasterInferenceKey,
} = require("../../agent-runtime/lib/headmasterInference");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/integrations/headmaster", router);
  return app;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const OWNER_UUID = "11111111-2222-3333-4444-555555555555";
const EXTERNAL_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const RUNTIME_KEY = "hermes-runtime-key-abc123";

beforeEach(() => {
  mockDb.query.mockReset();
});

describe("POST /integrations/headmaster/runtime-identity", () => {
  test("404s entirely when the service token is not configured", async () => {
    delete process.env.HEADMASTER_RUNTIME_IDENTITY_SERVICE_TOKEN;
    jest.resetModules();
    mockDb.query.mockReset();
    jest.doMock("../db", () => mockDb);
    const disabledRouter = require("../routes/headmasterRuntimeIdentity");
    const app = express();
    app.use(express.json());
    app.use("/integrations/headmaster", disabledRouter);

    const res = await request(app)
      .post("/integrations/headmaster/runtime-identity")
      .send({ runtime_key_sha256: sha256Hex(RUNTIME_KEY) });

    expect(res.status).toBe(404);
    process.env.HEADMASTER_RUNTIME_IDENTITY_SERVICE_TOKEN = SERVICE_TOKEN;
    jest.resetModules();
  });

  test("rejects a missing or wrong bearer token", async () => {
    const app = buildApp();
    const digest = sha256Hex(RUNTIME_KEY);

    const noAuth = await request(app)
      .post("/integrations/headmaster/runtime-identity")
      .send({ runtime_key_sha256: digest });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await request(app)
      .post("/integrations/headmaster/runtime-identity")
      .set("authorization", "Bearer wrong-token")
      .send({ runtime_key_sha256: digest });
    expect(wrongAuth.status).toBe(401);

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test("rejects a malformed digest before touching the database", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/integrations/headmaster/runtime-identity")
      .set("authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ runtime_key_sha256: "not-a-digest" });

    expect(res.status).toBe(400);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test("resolves the matching Headmaster-adopted agent by runtime key digest", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          gateway_token: RUNTIME_KEY,
          external_id: EXTERNAL_ID,
          external_owner_uuid: OWNER_UUID,
        },
        {
          id: "agent-2",
          gateway_token: "some-other-runtime-key",
          external_id: "cccccccc-dddd-eeee-ffff-000000000000",
          external_owner_uuid: OWNER_UUID,
        },
      ],
    });

    const app = buildApp();
    const res = await request(app)
      .post("/integrations/headmaster/runtime-identity")
      .set("authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ runtime_key_sha256: sha256Hex(RUNTIME_KEY) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agent_id: "agent-1",
      external_identity: {
        namespace: "headmaster",
        external_id: EXTERNAL_ID,
        owner_uuid: OWNER_UUID,
      },
      credential_generation: "1",
      active: true,
    });
  });

  describe("runtime_key_kind inference", () => {
    const inferenceKey = deriveHeadmasterInferenceKey(RUNTIME_KEY);
    const agentRows = () => ({
      rows: [
        {
          id: "agent-1",
          gateway_token: RUNTIME_KEY,
          external_id: EXTERNAL_ID,
          external_owner_uuid: OWNER_UUID,
        },
      ],
    });

    test("resolves the agent whose derived inference key matches", async () => {
      mockDb.query.mockResolvedValueOnce(agentRows());
      const res = await request(buildApp())
        .post("/integrations/headmaster/runtime-identity")
        .set("authorization", `Bearer ${SERVICE_TOKEN}`)
        .send({ runtime_key_sha256: sha256Hex(inferenceKey), runtime_key_kind: "inference" });

      expect(res.status).toBe(200);
      expect(res.body.agent_id).toBe("agent-1");
      expect(res.body.external_identity.owner_uuid).toBe(OWNER_UUID);
    });

    test("the gateway key digest does not resolve as an inference credential", async () => {
      mockDb.query.mockResolvedValueOnce(agentRows());
      const res = await request(buildApp())
        .post("/integrations/headmaster/runtime-identity")
        .set("authorization", `Bearer ${SERVICE_TOKEN}`)
        .send({ runtime_key_sha256: sha256Hex(RUNTIME_KEY), runtime_key_kind: "inference" });

      expect(res.status).toBe(404);
    });

    test("the inference key digest does not resolve as a gateway credential", async () => {
      mockDb.query.mockResolvedValueOnce(agentRows());
      const res = await request(buildApp())
        .post("/integrations/headmaster/runtime-identity")
        .set("authorization", `Bearer ${SERVICE_TOKEN}`)
        .send({ runtime_key_sha256: sha256Hex(inferenceKey) });

      expect(res.status).toBe(404);
    });

    test("rejects an unknown key kind before touching the database", async () => {
      const res = await request(buildApp())
        .post("/integrations/headmaster/runtime-identity")
        .set("authorization", `Bearer ${SERVICE_TOKEN}`)
        .send({ runtime_key_sha256: sha256Hex(inferenceKey), runtime_key_kind: "admin" });

      expect(res.status).toBe(400);
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  test("404s when no agent's runtime key matches the digest", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          gateway_token: "some-other-runtime-key",
          external_id: EXTERNAL_ID,
          external_owner_uuid: OWNER_UUID,
        },
      ],
    });

    const app = buildApp();
    const res = await request(app)
      .post("/integrations/headmaster/runtime-identity")
      .set("authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ runtime_key_sha256: sha256Hex(RUNTIME_KEY) });

    expect(res.status).toBe(404);
  });

  test("skips a row whose stored token fails to decrypt instead of 500ing", async () => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    process.env.HEADMASTER_RUNTIME_IDENTITY_SERVICE_TOKEN = SERVICE_TOKEN;
    const freshDb = { query: jest.fn() };
    jest.doMock("../db", () => freshDb);
    const { encrypt } = require("../crypto");
    const freshRouter = require("../routes/headmasterRuntimeIdentity");

    freshDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          // Shaped like ciphertext (iv:authTag:data) but tampered, so
          // decrypt() throws DecryptionError instead of returning plaintext.
          gateway_token: "00".repeat(16) + ":" + "11".repeat(16) + ":" + "22".repeat(8),
          external_id: EXTERNAL_ID,
          external_owner_uuid: OWNER_UUID,
        },
        {
          id: "agent-2",
          gateway_token: encrypt(RUNTIME_KEY),
          external_id: "cccccccc-dddd-eeee-ffff-000000000000",
          external_owner_uuid: OWNER_UUID,
        },
      ],
    });

    const app = express();
    app.use(express.json());
    app.use("/integrations/headmaster", freshRouter);

    const res = await request(app)
      .post("/integrations/headmaster/runtime-identity")
      .set("authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ runtime_key_sha256: sha256Hex(RUNTIME_KEY) });

    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe("agent-2");

    delete process.env.ENCRYPTION_KEY;
    jest.resetModules();
  });
});
