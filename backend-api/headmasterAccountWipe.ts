// @ts-nocheck
// Internal account-deletion steps (decision 31) that need the platform:
// wipe the Cloud runtime (container + home volume + agent row), delete the
// Hindsight memory bank, and clear managed-inference relay usage in Redis.
// Called only by the Headmaster account API (gcaplabs-site delete-account
// route) with the shared internal secret. Every step is idempotent: a missing
// agent, bank or key counts as done.

const crypto = require("crypto");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANK_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
// Both managed-inference stores (services/headmaster-inference/quota.mjs).
const RELAY_PREFIXES = ["headmaster-inference", "headmaster-inference-byo"];

function secretMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || expected.length < 32) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** @param deps { db, containerManager, acquireLock, releasePort, cancelJobs } */
async function wipeCloudRuntime(agentId, deps) {
  if (!UUID_RE.test(String(agentId || ""))) throw Object.assign(new Error("agent_invalid"), { statusCode: 400 });
  const lock = await deps.acquireLock(agentId, { applicationName: "headmaster-account-deletion" });
  try {
    const { rows } = await deps.db.query("SELECT * FROM agents WHERE id = $1", [agentId]);
    const agent = rows[0];
    if (!agent) return { done: true, existed: false };
    await deps.cancelJobs(agent.id);
    // destroy() removes the container and its volumes (the runtime home dir).
    if (deps.containerManager.canDestroy(agent)) await deps.containerManager.destroy(agent);
    await deps.releasePort(agent.id).catch(() => {});
    await deps.db.query("DELETE FROM agents WHERE id = $1", [agent.id]);
    return { done: true, existed: true };
  } finally {
    await lock.release();
  }
}

/** DELETE the bank on the Hindsight API (HINDSIGHT_API_URL, optional HINDSIGHT_API_KEY). */
async function deleteMemoryBank(bankId, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!BANK_RE.test(String(bankId || ""))) throw Object.assign(new Error("bank_invalid"), { statusCode: 400 });
  const base = String(env.HINDSIGHT_API_URL || "").replace(/\/+$/, "");
  if (!base) throw Object.assign(new Error("hindsight_not_configured"), { statusCode: 503 });
  const headers = env.HINDSIGHT_API_KEY ? { authorization: `Bearer ${env.HINDSIGHT_API_KEY}` } : {};
  const res = await fetchImpl(`${base}/v1/default/banks/${encodeURIComponent(bankId)}`, { method: "DELETE", headers });
  if (res.ok || res.status === 404) return { done: true, existed: res.status !== 404 };
  throw Object.assign(new Error("hindsight_delete_failed"), { statusCode: 502 });
}

/** Deletes every relay usage/quota key for the owner. SCAN, never KEYS. */
async function clearRelayUsage(ownerId, redis) {
  if (!UUID_RE.test(String(ownerId || ""))) throw Object.assign(new Error("owner_invalid"), { statusCode: 400 });
  let removed = 0;
  for (const prefix of RELAY_PREFIXES) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:${ownerId}:*`, "COUNT", 200);
      cursor = next;
      if (keys.length) removed += await redis.del(...keys);
    } while (cursor !== "0");
  }
  return { done: true, removed };
}

module.exports = { secretMatches, wipeCloudRuntime, deleteMemoryBank, clearRelayUsage, RELAY_PREFIXES };
