// @ts-nocheck
const crypto = require("node:crypto");

const HEADMASTER_NAMESPACE = "headmaster";
const RUNTIME_IDENTITY_SCOPE = "headmaster:runtime_identity";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_KEY_MIN_LENGTH = 32;
const RUNTIME_KEY_MAX_LENGTH = 4096;
const LEGACY_BACKFILL_BATCH_SIZE = 100;
const LEGACY_ACTIVE_STATUSES = new Set(["running", "warning", "stopped"]);

function digestRuntimeKey(rawKey) {
  if (
    typeof rawKey !== "string" ||
    rawKey.length < RUNTIME_KEY_MIN_LENGTH ||
    rawKey.length > RUNTIME_KEY_MAX_LENGTH ||
    /\s/.test(rawKey)
  ) {
    throw new TypeError("Runtime key is not a valid high-entropy credential");
  }
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function normalizeRuntimeKeyDigest(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return value.toLowerCase();
}

function normalizeGeneration(value) {
  const generation = String(value ?? "");
  if (!/^[1-9][0-9]{0,18}$/.test(generation)) return null;
  const numeric = BigInt(generation);
  if (numeric > 9223372036854775807n) return null;
  return generation;
}

/** Look up one caller-provided digest through its unique B-tree index. */
async function lookupRuntimeIdentityByDigest(queryable, digest, { timeoutMs = 2500 } = {}) {
  const normalizedDigest = normalizeRuntimeKeyDigest(digest);
  if (!normalizedDigest) throw new TypeError("runtime key digest must be SHA-256 hex");
  const result = await queryable.query({
    text: `SELECT a.id::text AS agent_id,
                  a.external_id_namespace AS external_namespace,
                  a.external_id::text AS external_id,
                  a.external_owner_id::text AS external_owner_id,
                  c.generation::text AS credential_generation,
                  (c.credential_state = 'active'
                    AND a.status IN ('running', 'warning')) AS active
             FROM agent_runtime_credentials c
             JOIN agents a ON a.id = c.agent_id
            WHERE c.key_digest = $1
            LIMIT 1`,
    values: [normalizedDigest],
    query_timeout: timeoutMs,
  });
  const row = result.rows?.[0];
  if (
    !row ||
    row.external_namespace !== HEADMASTER_NAMESPACE ||
    !row.external_id ||
    !row.external_owner_id
  )
    return null;
  const generation = normalizeGeneration(row.credential_generation);
  if (!row.agent_id || !generation) return null;
  return {
    agent_id: String(row.agent_id),
    external_identity: {
      namespace: HEADMASTER_NAMESPACE,
      external_id: String(row.external_id).toLowerCase(),
      owner_uuid: String(row.external_owner_id).toLowerCase(),
    },
    credential_generation: generation,
    active: row.active === true,
  };
}

function credentialLifecycleError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Stage a digest without activating it. The caller must hold the agent row lock
 * and a transaction; the plaintext token is never passed to this helper.
 */
async function stageDesiredRuntimeCredential(queryable, agentId, digest) {
  const normalizedDigest = normalizeRuntimeKeyDigest(digest);
  if (!normalizedDigest) throw new TypeError("runtime key digest must be SHA-256 hex");

  const existingResult = await queryable.query(
    `SELECT agent_id::text AS agent_id, generation::text AS generation, credential_state
       FROM agent_runtime_credentials
      WHERE key_digest = $1
      FOR UPDATE`,
    [normalizedDigest],
  );
  const existing = existingResult.rows?.[0];
  if (existing) {
    if (String(existing.agent_id) !== String(agentId)) {
      throw credentialLifecycleError(
        "Runtime credential digest is already bound to another agent",
        "RUNTIME_CREDENTIAL_DIGEST_COLLISION",
      );
    }
    if (existing.credential_state === "retired") {
      throw credentialLifecycleError(
        "A retired runtime credential cannot be reactivated",
        "RUNTIME_CREDENTIAL_REUSE_REJECTED",
      );
    }
    const generation = normalizeGeneration(existing.generation);
    if (!generation || !["active", "desired"].includes(existing.credential_state)) {
      throw credentialLifecycleError(
        "Runtime credential state is invalid",
        "RUNTIME_CREDENTIAL_STATE_INVALID",
      );
    }
    await queryable.query(
      `UPDATE agent_runtime_credentials
          SET credential_state = 'retired', retired_at = NOW()
        WHERE agent_id = $1
          AND credential_state = 'desired'
          AND generation <> $2`,
      [agentId, generation],
    );
    return generation;
  }

  const maxResult = await queryable.query(
    `SELECT COALESCE(MAX(generation), 0)::text AS generation
       FROM agent_runtime_credentials
      WHERE agent_id = $1`,
    [agentId],
  );
  const priorGeneration = BigInt(maxResult.rows?.[0]?.generation || "0");
  const generation = (priorGeneration + 1n).toString();
  if (BigInt(generation) > 9223372036854775807n) {
    throw credentialLifecycleError(
      "Runtime credential generation is exhausted",
      "RUNTIME_CREDENTIAL_GENERATION_EXHAUSTED",
    );
  }

  await queryable.query(
    `UPDATE agent_runtime_credentials
        SET credential_state = 'retired', retired_at = NOW()
      WHERE agent_id = $1 AND credential_state = 'desired'`,
    [agentId],
  );
  await queryable.query(
    `INSERT INTO agent_runtime_credentials(
       agent_id, generation, key_digest, credential_state
     ) VALUES($1, $2, $3, 'desired')`,
    [agentId, generation, normalizedDigest],
  );
  return generation;
}

/** Activate one successfully deployed generation and retire every predecessor. */
async function activateRuntimeCredential(queryable, agentId, generationValue) {
  const generation = normalizeGeneration(generationValue);
  if (!generation) {
    throw credentialLifecycleError(
      "Runtime credential generation is missing",
      "RUNTIME_CREDENTIAL_GENERATION_MISSING",
    );
  }
  const desired = await queryable.query(
    `SELECT credential_state
       FROM agent_runtime_credentials
      WHERE agent_id = $1 AND generation = $2
      FOR UPDATE`,
    [agentId, generation],
  );
  const row = desired.rows?.[0];
  if (!row || !["desired", "active"].includes(row.credential_state)) {
    throw credentialLifecycleError(
      "Desired runtime credential generation is unavailable",
      "RUNTIME_CREDENTIAL_GENERATION_UNAVAILABLE",
    );
  }

  await queryable.query(
    `UPDATE agent_runtime_credentials
        SET credential_state = 'retired', retired_at = NOW()
      WHERE agent_id = $1
        AND generation <> $2
        AND credential_state IN ('active', 'desired')`,
    [agentId, generation],
  );
  await queryable.query(
    `UPDATE agent_runtime_credentials
        SET credential_state = 'active',
            activated_at = COALESCE(activated_at, NOW()),
            retired_at = NULL
      WHERE agent_id = $1 AND generation = $2`,
    [agentId, generation],
  );
}

async function backfillOneLegacyRuntimeCredential(queryable, snapshot, decryptToken) {
  const ownsClient = typeof queryable?.connect === "function";
  const client = ownsClient ? await queryable.connect() : queryable;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const currentResult = await client.query(
      `SELECT id::text AS agent_id, gateway_token, status, external_id_namespace, external_owner_id
         FROM agents
        WHERE id = $1
        FOR UPDATE`,
      [snapshot.agent_id],
    );
    const current = currentResult.rows?.[0];
    if (
      !current ||
      current.gateway_token !== snapshot.gateway_token ||
      current.external_id_namespace !== HEADMASTER_NAMESPACE ||
      !current.external_owner_id ||
      !LEGACY_ACTIVE_STATUSES.has(current.status)
    ) {
      await client.query("COMMIT");
      transactionOpen = false;
      return false;
    }

    const prior = await client.query(
      "SELECT generation FROM agent_runtime_credentials WHERE agent_id = $1 LIMIT 1",
      [snapshot.agent_id],
    );
    if (prior.rows?.length) {
      await client.query("COMMIT");
      transactionOpen = false;
      return false;
    }

    const rawKey = decryptToken(current.gateway_token);
    const digest = digestRuntimeKey(rawKey);
    const digestOwner = await client.query(
      `SELECT agent_id::text AS agent_id
         FROM agent_runtime_credentials
        WHERE key_digest = $1
        FOR UPDATE`,
      [digest],
    );
    if (digestOwner.rows?.length) {
      throw credentialLifecycleError(
        "Legacy runtime credential digest is already indexed",
        "RUNTIME_CREDENTIAL_DIGEST_COLLISION",
      );
    }
    await client.query(
      `INSERT INTO agent_runtime_credentials(
         agent_id, generation, key_digest, credential_state, activated_at
       ) VALUES($1, 1, $2, 'active', NOW())`,
      [snapshot.agent_id, digest],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return true;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (ownsClient && typeof client?.release === "function") client.release();
  }
}

/**
 * Backfill only legacy Headmaster-bound agents, decrypting inside Nora and
 * retaining no plaintext. Pagination is bounded and lookup requests never call
 * this function or enumerate agents.
 */
async function backfillLegacyRuntimeCredentials(
  queryable,
  decryptToken,
  { batchSize = LEGACY_BACKFILL_BATCH_SIZE } = {},
) {
  if (typeof decryptToken !== "function")
    throw new TypeError("Nora runtime credential decryptor is required");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new TypeError("Runtime credential backfill batch size must be between 1 and 500");
  }
  let lastAgentId = "00000000-0000-0000-0000-000000000000";
  let scanned = 0;
  let indexed = 0;
  while (true) {
    const result = await queryable.query(
      `SELECT a.id::text AS agent_id, a.gateway_token
         FROM agents a
        WHERE a.id > $1::uuid
          AND a.external_id_namespace = 'headmaster'
          AND a.external_owner_id IS NOT NULL
          AND a.gateway_token IS NOT NULL
          AND a.status IN ('running', 'warning', 'stopped')
          AND NOT EXISTS (
            SELECT 1 FROM agent_runtime_credentials c WHERE c.agent_id = a.id
          )
        ORDER BY a.id
        LIMIT $2`,
      [lastAgentId, batchSize],
    );
    const rows = result.rows || [];
    if (rows.length === 0) break;
    scanned += rows.length;
    for (const row of rows) {
      lastAgentId = String(row.agent_id);
      try {
        if (await backfillOneLegacyRuntimeCredential(queryable, row, decryptToken)) indexed += 1;
      } catch (error) {
        if (error?.code === "RUNTIME_CREDENTIAL_DIGEST_COLLISION") throw error;
        // Keep boot safe but leave this identity unresolved: lookup fails closed.
        console.error(
          `[runtime-identity] Legacy credential backfill failed for agent ${row.agent_id}`,
        );
      }
    }
    if (rows.length < batchSize) break;
  }
  return { scanned, indexed };
}

module.exports = {
  HEADMASTER_NAMESPACE,
  RUNTIME_IDENTITY_SCOPE,
  activateRuntimeCredential,
  backfillLegacyRuntimeCredentials,
  digestRuntimeKey,
  lookupRuntimeIdentityByDigest,
  normalizeRuntimeKeyDigest,
  stageDesiredRuntimeCredential,
};
