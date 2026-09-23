// @ts-nocheck
// Stores per-agent environment overrides encrypted at rest. Decryption is
// opt-in for callers that explicitly request it.

const db = require("./db");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_NAMES = new Set([
  "API_SERVER_ENABLED",
  "API_SERVER_HOST",
  "API_SERVER_KEY",
  "API_SERVER_PORT",
  "AWS_EC2_METADATA_DISABLED",
  "GATEWAY_HEALTH_URL",
  "HOME",
  "HERMES_HOME",
  "MESSAGING_CWD",
  "TERMINAL_CWD",
]);
const RESERVED_ENV_PREFIXES = [
  "AGENT_",
  "HEADMASTER_",
  "HERMES_DASHBOARD_BASIC_AUTH_",
  "NORA_",
  "API_SERVER_",
];

function isReservedSecretOverrideName(name) {
  return RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function assertSafeSecretOverrideNames(names = []) {
  for (const name of names) {
    if (typeof name !== "string" || !ENVIRONMENT_KEY_PATTERN.test(name)) {
      throw new TypeError("Agent secret overrides contain an invalid environment name");
    }
    if (isReservedSecretOverrideName(name)) {
      throw new TypeError("Agent secret overrides contain a Nora-reserved environment name");
    }
  }
  return names;
}

function normalizeOverrideKey(rawKey) {
  const normalized = String(rawKey || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

function normalizeOverrideValue(rawValue) {
  if (rawValue == null) return null;
  const value = String(rawValue);
  return value ? value : null;
}

/**
 * Normalize an override map into non-empty environment keys and string values,
 * dropping invalid entries before persistence or migration export.
 *
 * @param {Object} [rawEntries={}] - Candidate environment override map.
 * @returns {Object} Normalized key/value map.
 */
function normalizeOverrideEntries(rawEntries = {}) {
  const normalized = Object.create(null);
  const source = rawEntries && typeof rawEntries === "object" && !Array.isArray(rawEntries)
    ? Object.entries(rawEntries)
    : [];
  for (const [rawKey, rawValue] of source) {
    const key = normalizeOverrideKey(rawKey);
    const value = normalizeOverrideValue(rawValue);
    if (!key || value == null) continue;
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      throw new TypeError("Secret override names must be valid environment variable names");
    }
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      throw new TypeError("Agent secret override names collide after normalization");
    }
    normalized[key] = value;
  }
  assertSafeSecretOverrideNames(Object.keys(normalized));
  return normalized;
}

/**
 * List encrypted overrides for an agent, decrypting values only when explicitly requested.
 *
 * @param {string} agentId - Agent whose overrides should be loaded.
 * @param {Object} [options={}] - Whether stored values should be decrypted.
 * @returns {Promise<Object>} Environment override map.
 */
async function listAgentSecretOverrides(agentId, { decryptValues = false, queryable = db } = {}) {
  const result = await queryable.query(
    `SELECT env_key, env_value
       FROM agent_secret_overrides
      WHERE agent_id = $1
      ORDER BY env_key ASC`,
    [agentId],
  );

  return result.rows.reduce((acc, row) => {
    acc[row.env_key] = decryptValues ? decrypt(row.env_value) : row.env_value;
    return acc;
  }, Object.create(null));
}

async function getAgentSecretEnvVars(agentId) {
  return listAgentSecretOverrides(agentId, { decryptValues: true });
}

/**
 * Replace all overrides atomically, encrypting each value before persistence.
 * When a transaction client is supplied, the caller owns commit/rollback.
 *
 * @param {string} agentId - Agent whose overrides should be replaced.
 * @param {Object} [rawEntries={}] - Plaintext overrides to normalize and encrypt.
 * @returns {Promise<Object>} Normalized override map used by the migration caller.
 */
async function replaceAgentSecretOverrides(agentId, rawEntries = {}, { queryable = null } = {}) {
  const normalized = normalizeOverrideEntries(rawEntries);

  const ownsClient = !queryable;
  const client = queryable || (await db.connect());
  let transactionOpen = false;
  try {
    if (ownsClient) {
      await client.query("BEGIN");
      transactionOpen = true;
    }
    if (Object.keys(normalized).length > 0) {
      ensureEncryptionConfigured("Agent secret override storage");
    }
    await client.query("DELETE FROM agent_secret_overrides WHERE agent_id = $1", [agentId]);
    for (const [envKey, envValue] of Object.entries(normalized)) {
      await client.query(
        `INSERT INTO agent_secret_overrides(agent_id, env_key, env_value)
         VALUES($1, $2, $3)`,
        [agentId, envKey, encrypt(envValue)],
      );
    }
    if (transactionOpen) {
      await client.query("COMMIT");
      transactionOpen = false;
    }
    return { ...normalized };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

module.exports = {
  getAgentSecretEnvVars,
  listAgentSecretOverrides,
  assertSafeSecretOverrideNames,
  isReservedSecretOverrideName,
  normalizeOverrideEntries,
  replaceAgentSecretOverrides,
};
