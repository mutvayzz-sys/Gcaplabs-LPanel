// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { buildRouter } = require("../routes/internalAccountDeletion");

const SECRET = "s".repeat(40);
const AGENT = "11111111-2222-3333-4444-555555555555";
const OWNER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function app(opts) {
  const a = express();
  a.use("/internal", buildRouter({ env: { HEADMASTER_ACCOUNT_DELETION_SECRET: SECRET, HINDSIGHT_API_URL: "http://hindsight.test" }, ...opts }));
  return a;
}

function deps(agent) {
  const calls = [];
  return {
    calls,
    db: { query: jest.fn(async (sql) => { calls.push(sql.split(" ")[0]); return { rows: agent ? [agent] : [] }; }) },
    containerManager: { canDestroy: () => true, destroy: jest.fn(async () => calls.push("destroy")) },
    acquireLock: jest.fn(async () => ({ release: async () => calls.push("release") })),
    releasePort: jest.fn(async () => {}),
    cancelJobs: jest.fn(async () => calls.push("cancel")),
  };
}

describe("internal account deletion", () => {
  test("rejects without the secret", async () => {
    await request(app({ deps: deps(null) })).post("/internal/relay-usage").send({ ownerId: OWNER }).expect(401);
  });

  test("503 when the secret is not configured", async () => {
    const a = express(); a.use("/internal", buildRouter({ env: {} }));
    await request(a).post("/internal/relay-usage").set("x-headmaster-internal-secret", SECRET).expect(503);
  });

  test("cloud runtime: destroys container then deletes the agent row", async () => {
    const d = deps({ id: AGENT });
    const res = await request(app({ deps: d })).post("/internal/cloud-runtime")
      .set("x-headmaster-internal-secret", SECRET).send({ agentId: AGENT }).expect(200);
    expect(res.body).toEqual({ done: true, existed: true });
    expect(d.calls).toEqual(["SELECT", "cancel", "destroy", "DELETE", "release"]);
  });

  test("cloud runtime: missing agent is done", async () => {
    const res = await request(app({ deps: deps(null) })).post("/internal/cloud-runtime")
      .set("x-headmaster-internal-secret", SECRET).send({ agentId: AGENT }).expect(200);
    expect(res.body.existed).toBe(false);
  });

  test("memory bank: DELETE on Hindsight, 404 counts as done", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 404 }));
    const res = await request(app({ deps: deps(null), fetchImpl })).post("/internal/memory-bank")
      .set("x-headmaster-internal-secret", SECRET).send({ bankId: "hm-bank_1" }).expect(200);
    expect(res.body.done).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://hindsight.test/v1/default/banks/hm-bank_1");
    expect(fetchImpl.mock.calls[0][1].method).toBe("DELETE");
  });

  test("relay usage: SCANs both prefixes and deletes owner keys", async () => {
    const redis = {
      scan: jest.fn(async (_c, _m, pattern) => ["0", pattern.startsWith("headmaster-inference:") ? [`headmaster-inference:${OWNER}:day`] : []]),
      del: jest.fn(async (...keys) => keys.length),
    };
    const res = await request(app({ deps: deps(null), redisFactory: () => redis })).post("/internal/relay-usage")
      .set("x-headmaster-internal-secret", SECRET).send({ ownerId: OWNER }).expect(200);
    expect(res.body).toEqual({ done: true, removed: 1 });
    expect(redis.scan.mock.calls.map((c) => c[2])).toEqual([`headmaster-inference:${OWNER}:*`, `headmaster-inference-byo:${OWNER}:*`]);
  });

  test("bad ids are 400", async () => {
    await request(app({ deps: deps(null) })).post("/internal/relay-usage")
      .set("x-headmaster-internal-secret", SECRET).send({ ownerId: "x" }).expect(400);
  });
});
