// @ts-nocheck
// Desired/applied revision boundary for Nora-managed runtime configuration.
// Secret values remain encrypted in agent_secret_overrides; this table holds
// only non-secret Headmaster integration metadata and application state.

const db = require("./db");
const {
  decrypt,
  encrypt,
  ensureEncryptionConfigured,
} = require("./crypto");
const {
  assertSafeSecretOverrideNames,
  isReservedSecretOverrideName,
  listAgentSecretOverrides,
} = require("./agentSecretOverrides");
const {
  acquireAgentProvisionLock,
  buildReplacementDeploymentJob,
} = require("./agentProvisionLock");
const { buildAgentRuntimeFields } = require("./agentRuntimeFields");

async function enqueueManagedConfigDeployment(...args) {
  return require("./redisQueue").addDeploymentJob(...args);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADMASTER_ENV_NAMES = Object.freeze([
  "HEADMASTER_OWNER_ID",
  "HEADMASTER_WORKSPACE_ID",
  "HEADMASTER_MEMORY_BANK_ID",
  "HEADMASTER_MEMORY_GATEWAY_URL",
]);
function createHttpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function parseRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createHttpError("expected_revision must be a non-negative integer", 400, "invalid_revision");
  }
  return value;
}

function normalizeSecretOverrideKey(rawKey, { allowReserved = false } = {}) {
  if (typeof rawKey !== "string" || rawKey.length === 0 || rawKey !== rawKey.trim()) {
    throw createHttpError("Secret override names must be valid environment variable names", 400, "invalid_secret_override_key");
  }
  if (!ENVIRONMENT_KEY_PATTERN.test(rawKey)) {
    throw createHttpError("Secret override names must be valid environment variable names", 400, "invalid_secret_override_key");
  }
  if (!allowReserved && isReservedSecretOverrideName(rawKey)) {
    throw createHttpError("The requested environment name is reserved by Nora", 400, "reserved_secret_override_key");
  }
  return rawKey;
}

function normalizeSecretOverridePatch(rawPatch = {}) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    throw createHttpError("Secret override patch must be an object", 400, "invalid_secret_override_patch");
  }
  if (Object.keys(rawPatch).some((key) => !["set", "delete"].includes(key))) {
    throw createHttpError("Only set and delete are accepted in a secret override patch", 400, "invalid_secret_override_patch");
  }
  const rawSet = rawPatch.set === undefined ? {} : rawPatch.set;
  const rawDelete = rawPatch.delete === undefined ? [] : rawPatch.delete;
  if (!rawSet || typeof rawSet !== "object" || Array.isArray(rawSet)) {
    throw createHttpError("set must be an object of environment names and values", 400, "invalid_secret_override_patch");
  }
  if (!Array.isArray(rawDelete)) {
    throw createHttpError("delete must be an array of environment names", 400, "invalid_secret_override_patch");
  }
  const set = Object.create(null);
  const normalizedSetNames = new Set();
  for (const [rawKey, rawValue] of Object.entries(rawSet)) {
    const key = normalizeSecretOverrideKey(rawKey);
    if (normalizedSetNames.has(key)) {
      throw createHttpError("Secret override names collide after normalization", 400, "secret_override_key_collision");
    }
    if (typeof rawValue !== "string" || rawValue.length === 0) {
      throw createHttpError("Secret override values must be non-empty strings; use delete to remove a value", 400, "invalid_secret_override_value");
    }
    if (rawValue.length > 65536) {
      throw createHttpError("Secret override values must not exceed 65536 characters", 400, "invalid_secret_override_value");
    }
    normalizedSetNames.add(key);
    set[key] = rawValue;
  }
  const deleted = [];
  const normalizedDeleteNames = new Set();
  for (const rawKey of rawDelete) {
    const key = normalizeSecretOverrideKey(rawKey, { allowReserved: true });
    if (normalizedDeleteNames.has(key)) {
      throw createHttpError("Secret override delete names must be unique", 400, "secret_override_key_collision");
    }
    if (normalizedSetNames.has(key)) {
      throw createHttpError("A secret override cannot be set and deleted in the same patch", 400, "secret_override_patch_conflict");
    }
    normalizedDeleteNames.add(key);
    deleted.push(key);
  }
  if (normalizedSetNames.size + normalizedDeleteNames.size === 0) {
    throw createHttpError("Secret override patch must set or delete at least one key", 400, "empty_secret_override_patch");
  }
  return { set, delete: deleted };
}

function canonicalBankId(ownerUuid) {
  return `hermes-u-${String(ownerUuid).replace(/-/g, "_").toLowerCase()}`;
}

function normalizeAllowedGatewayUrl(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw createHttpError(`${fieldName} is required`, 400, "invalid_headmaster_integration_config");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw createHttpError(`${fieldName} must be an absolute HTTP(S) URL`, 400, "invalid_headmaster_integration_config");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw createHttpError(`${fieldName} must be an HTTP(S) origin without credentials, path, query, or fragment`, 400, "invalid_headmaster_integration_config");
  }
  return parsed.origin;
}

function validateHeadmasterIntegrationConfig(rawConfig, {
  ownerUuid,
  workspaceUuid,
  allowedGatewayUrl = process.env.HEADMASTER_MEMORY_GATEWAY_URL,
} = {}) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw createHttpError("Headmaster integration config must be an object", 400, "invalid_headmaster_integration_config");
  }
  const allowedFields = new Set(["owner_uuid", "workspace_uuid", "memory_bank_id", "memory_gateway_url"]);
  if (Object.keys(rawConfig).some((key) => !allowedFields.has(key))) {
    throw createHttpError("Headmaster integration config contains unsupported fields", 400, "invalid_headmaster_integration_config");
  }
  if (!UUID_PATTERN.test(String(ownerUuid || "")) || !UUID_PATTERN.test(String(workspaceUuid || ""))) {
    throw createHttpError("Agent is missing its immutable Headmaster identity", 409, "headmaster_identity_missing");
  }
  const inputOwner = rawConfig.owner_uuid;
  const inputWorkspace = rawConfig.workspace_uuid;
  if (!UUID_PATTERN.test(String(inputOwner || "")) || inputOwner.toLowerCase() !== ownerUuid.toLowerCase()) {
    throw createHttpError("Headmaster owner identity cannot be changed", 409, "headmaster_identity_conflict");
  }
  if (!UUID_PATTERN.test(String(inputWorkspace || "")) || inputWorkspace.toLowerCase() !== workspaceUuid.toLowerCase()) {
    throw createHttpError("Headmaster workspace identity cannot be changed", 409, "headmaster_identity_conflict");
  }
  const bankId = rawConfig.memory_bank_id;
  if (typeof bankId !== "string" || bankId !== canonicalBankId(ownerUuid)) {
    throw createHttpError("Headmaster memory bank ID does not match the canonical owner derivation", 400, "invalid_headmaster_memory_bank");
  }
  const requestedUrl = normalizeAllowedGatewayUrl(rawConfig.memory_gateway_url, "memory_gateway_url");
  if (typeof allowedGatewayUrl !== "string" || !allowedGatewayUrl.trim()) {
    throw createHttpError("Headmaster memory gateway is not configured", 503, "headmaster_integration_unavailable");
  }
  const allowedUrl = normalizeAllowedGatewayUrl(allowedGatewayUrl, "configured memory gateway URL");
  if (requestedUrl !== allowedUrl) {
    throw createHttpError("memory_gateway_url is not an approved Headmaster integration endpoint", 400, "unapproved_headmaster_memory_gateway");
  }
  return Object.freeze({
    owner_uuid: ownerUuid.toLowerCase(),
    workspace_uuid: workspaceUuid.toLowerCase(),
    memory_bank_id: bankId,
    memory_gateway_url: allowedUrl,
  });
}

function validateHeadmasterConfigForAgent(agent, rawConfig, options = {}) {
  if (
    agent?.external_id_namespace !== "headmaster" ||
    !agent?.external_id ||
    !agent?.external_owner_id
  ) {
    throw createHttpError("Agent is not bound to an immutable Headmaster identity", 409, "headmaster_identity_missing");
  }
  return validateHeadmasterIntegrationConfig(rawConfig, {
    ownerUuid: String(agent.external_owner_id),
    workspaceUuid: String(agent.external_id),
    ...options,
  });
}

function buildHeadmasterIntegrationEnv(config) {
  if (!config) return {};
  return {
    HEADMASTER_OWNER_ID: config.owner_uuid,
    HEADMASTER_WORKSPACE_ID: config.workspace_uuid,
    HEADMASTER_MEMORY_BANK_ID: config.memory_bank_id,
    HEADMASTER_MEMORY_GATEWAY_URL: config.memory_gateway_url,
  };
}

function buildAgentManagedConfigRuntimeEnv(snapshot = {}, {
  externalIdNamespace,
  ownerUuid,
  workspaceUuid,
  allowedGatewayUrl = process.env.HEADMASTER_MEMORY_GATEWAY_URL,
} = {}) {
  const rawSecrets = snapshot.secretOverrides == null ? {} : snapshot.secretOverrides;
  if (!rawSecrets || typeof rawSecrets !== "object" || Array.isArray(rawSecrets)) {
    throw new Error("Agent managed secret overrides must be an object");
  }
  const secretOverrides = Object.fromEntries(Object.entries(rawSecrets));
  assertSafeSecretOverrideNames(Object.keys(secretOverrides));
  for (const [key, value] of Object.entries(secretOverrides)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Agent managed secret override ${key} is not a non-empty string`);
    }
  }

  const headmasterIntegrationConfig = snapshot.headmasterIntegrationConfig
    ? validateHeadmasterConfigForAgent({
        external_id_namespace: externalIdNamespace,
        external_id: workspaceUuid,
        external_owner_id: ownerUuid,
      }, snapshot.headmasterIntegrationConfig, {
        allowedGatewayUrl,
      })
    : null;
  const headmasterIntegrationEnv = buildHeadmasterIntegrationEnv(headmasterIntegrationConfig);
  const desiredRevision = Number(snapshot.desiredRevision ?? 0);
  if (!Number.isSafeInteger(desiredRevision) || desiredRevision < 0) {
    throw new Error("Agent managed configuration has an invalid desired revision");
  }
  return {
    desiredRevision,
    secretOverrides,
    headmasterIntegrationConfig,
    headmasterIntegrationEnv,
    integrationEnvNames: Object.keys(headmasterIntegrationEnv),
    env: { ...secretOverrides, ...headmasterIntegrationEnv },
  };
}

async function getAgentManagedConfigSnapshot(agentId, { queryable = db, decryptSecrets = true } = {}) {
  const result = await queryable.query(
    `SELECT desired_revision, applied_revision, headmaster_integration_config,
            last_job_id, last_error
       FROM agent_managed_config
      WHERE agent_id = $1
      LIMIT 1`,
    [agentId],
  );
  const row = result.rows[0] || {};
  const integrationConfig = row.headmaster_integration_config == null
    ? null
    : typeof row.headmaster_integration_config === "string"
      ? JSON.parse(row.headmaster_integration_config)
      : row.headmaster_integration_config;
  const secretOverrides = await listAgentSecretOverrides(agentId, {
    decryptValues: decryptSecrets,
    queryable,
  });
  assertSafeSecretOverrideNames(Object.keys(secretOverrides));
  return {
    desiredRevision: Number(row.desired_revision || 0),
    appliedRevision: Number(row.applied_revision || 0),
    headmasterIntegrationConfig: integrationConfig,
    secretOverrides,
    jobId: row.last_job_id || null,
    lastError: row.last_error || null,
  };
}

async function getAgentManagedConfigStatus(agentId, { queryable = db } = {}) {
  const snapshot = await getAgentManagedConfigSnapshot(agentId, { queryable, decryptSecrets: false });
  const result = await queryable.query(
    `SELECT status, queue_job_id
       FROM deployments
      WHERE agent_id = $1 AND queue_job_id = $2
      LIMIT 1`,
    [agentId, snapshot.jobId],
  );
  return {
    key_names: Object.keys(snapshot.secretOverrides).sort(),
    integration_key_names: snapshot.headmasterIntegrationConfig ? HEADMASTER_ENV_NAMES.slice() : [],
    desired_revision: snapshot.desiredRevision,
    applied_revision: snapshot.appliedRevision,
    job_id: snapshot.jobId,
    deployment_status: result.rows[0]?.status || null,
    last_error: snapshot.lastError,
  };
}

function makeQueueFailure() {
  return createHttpError(
    "Managed configuration was recorded but its worker job could not be published; retry the durable job",
    503,
    "managed_config_queue_failed",
  );
}

async function mutateAgentManagedConfig({
  pool = db,
  agentId,
  expectedRevision,
  secretPatch = null,
  headmasterIntegrationConfig = undefined,
  allowedGatewayUrl = process.env.HEADMASTER_MEMORY_GATEWAY_URL,
  acquireLock = acquireAgentProvisionLock,
  addDeploymentJob: queueDeployment = enqueueManagedConfigDeployment,
} = {}) {
  const expected = parseRevision(expectedRevision);
  const normalizedPatch = secretPatch == null ? null : normalizeSecretOverridePatch(secretPatch);
  if (!normalizedPatch && headmasterIntegrationConfig === undefined) {
    throw createHttpError("Managed configuration mutation is empty", 400, "empty_managed_config_mutation");
  }
  const lock = await acquireLock(agentId, { applicationName: "nora-backend-managed-config" });
  let client = null;
  let transactionOpen = false;
  let jobData = null;
  let jobId = null;
  let appliedRevision = 0;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    const agentResult = await client.query("SELECT * FROM agents WHERE id = $1 FOR UPDATE", [agentId]);
    const agent = agentResult.rows[0];
    if (!agent) throw createHttpError("Agent not found", 404, "agent_not_found");
    if (!["running", "warning"].includes(agent.status) || !agent.container_id) {
      throw createHttpError("Managed configuration updates require an active runtime", 409, "agent_runtime_not_active");
    }
    await client.query(
      `INSERT INTO agent_managed_config(agent_id)
       VALUES($1) ON CONFLICT(agent_id) DO NOTHING`,
      [agentId],
    );
    const configResult = await client.query(
      `SELECT desired_revision, applied_revision, headmaster_integration_config,
              last_job_id, last_error
         FROM agent_managed_config
        WHERE agent_id = $1
        FOR UPDATE`,
      [agentId],
    );
    const state = configResult.rows[0] || { desired_revision: 0, applied_revision: 0 };
    const currentRevision = Number(state.desired_revision || 0);
    appliedRevision = Number(state.applied_revision || 0);
    if (expected !== currentRevision) {
      throw createHttpError(
        "Managed configuration revision is stale",
        409,
        "managed_config_revision_conflict",
      );
    }
    if (normalizedPatch) {
      if (Object.keys(normalizedPatch.set).length > 0) {
        ensureEncryptionConfigured("Agent secret override storage");
      }
      for (const [key, value] of Object.entries(normalizedPatch.set)) {
        await client.query(
          `INSERT INTO agent_secret_overrides(agent_id, env_key, env_value)
           VALUES($1, $2, $3)
           ON CONFLICT(agent_id, env_key) DO UPDATE
             SET env_value = EXCLUDED.env_value, updated_at = NOW()`,
          [agentId, key, encrypt(value)],
        );
      }
      for (const key of normalizedPatch.delete) {
        await client.query(
          "DELETE FROM agent_secret_overrides WHERE agent_id = $1 AND env_key = $2",
          [agentId, key],
        );
      }
    }
    let nextIntegrationConfig = state.headmaster_integration_config || null;
    if (typeof nextIntegrationConfig === "string") {
      try { nextIntegrationConfig = JSON.parse(nextIntegrationConfig); } catch { nextIntegrationConfig = null; }
    }
    if (headmasterIntegrationConfig !== undefined) {
      nextIntegrationConfig = validateHeadmasterConfigForAgent(agent, headmasterIntegrationConfig, {
        allowedGatewayUrl,
      });
    }
    const desiredRevision = currentRevision + 1;
    jobId = `managed-config-${String(agentId).replace(/[^A-Za-z0-9_-]/g, "-")}-${desiredRevision}`;
    const runtimeFields = buildAgentRuntimeFields(agent);
    jobData = buildReplacementDeploymentJob(agent, {
      runtimeFields,
      containerName: agent.container_name,
      image: agent.image,
      extra: {
        job_type: "managed_config",
        managed_config_revision: desiredRevision,
        managed_config_job_id: jobId,
      },
    });
    const transitioned = await client.query(
      `UPDATE agents SET status = 'queued'
        WHERE id = $1 AND status = $2 AND container_id IS NOT DISTINCT FROM $3
        RETURNING id`,
      [agentId, agent.status, agent.container_id],
    );
    if (!transitioned.rows[0]) {
      throw createHttpError("Agent runtime changed while managed configuration was queued", 409, "managed_config_runtime_changed");
    }
    await client.query(
      `UPDATE agent_managed_config
          SET desired_revision = $2,
              headmaster_integration_config = $3::jsonb,
              last_job_id = $4,
              last_error = NULL,
              updated_at = NOW()
        WHERE agent_id = $1`,
      [agentId, desiredRevision, JSON.stringify(nextIntegrationConfig), jobId],
    );
    await client.query(
      `INSERT INTO deployments(agent_id, status, queue_job_id, job_payload)
       VALUES($1, 'queued', $2, $3::jsonb)`,
      [agentId, jobId, JSON.stringify(jobData)],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    client.release();
    client = null;
    try {
      await queueDeployment(jobData, { jobId });
    } catch {
      throw makeQueueFailure();
    }
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client) client.release();
    await lock.release();
  }

  const keyNames = normalizedPatch
    ? [...new Set([...Object.keys(normalizedPatch.set), ...normalizedPatch.delete])].sort()
    : HEADMASTER_ENV_NAMES.slice();
  return {
    key_names: keyNames,
    desired_revision: Number(jobData.managed_config_revision),
    applied_revision: appliedRevision,
    job_id: jobId,
  };
}

async function retryAgentManagedConfigJob(agentId, {
  pool = db,
  queueDeployment = enqueueManagedConfigDeployment,
  acquireLock = acquireAgentProvisionLock,
} = {}) {
  const lock = await acquireLock(agentId, { applicationName: "nora-backend-managed-config-retry" });
  let client = null;
  let jobId = null;
  let jobPayload = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const agentResult = await client.query("SELECT * FROM agents WHERE id = $1 FOR UPDATE", [agentId]);
    const agent = agentResult.rows[0];
    if (!agent) throw createHttpError("Agent not found", 404, "agent_not_found");
    const result = await client.query(
      `SELECT config.desired_revision, config.applied_revision, config.last_job_id,
              deployments.job_payload
         FROM agent_managed_config AS config
         JOIN deployments ON deployments.agent_id = config.agent_id
                        AND deployments.queue_job_id = config.last_job_id
        WHERE config.agent_id = $1
        FOR UPDATE OF config, deployments`,
      [agentId],
    );
    const row = result.rows[0];
    if (!row?.last_job_id || !row?.job_payload) {
      throw createHttpError("No durable managed configuration job is available to retry", 404, "managed_config_job_not_found");
    }
    if (Number(row.applied_revision || 0) >= Number(row.desired_revision || 0)) {
      throw createHttpError("The latest managed configuration revision is already applied", 409, "managed_config_already_applied");
    }
    jobId = row.last_job_id;
    const savedPayload = typeof row.job_payload === "string" ? JSON.parse(row.job_payload) : row.job_payload;
    if (!savedPayload || typeof savedPayload !== "object" || Array.isArray(savedPayload)) {
      throw createHttpError("Managed configuration deployment payload is invalid", 409, "managed_config_job_invalid");
    }
    jobPayload = buildReplacementDeploymentJob(agent, {
      runtimeFields: buildAgentRuntimeFields(agent),
      containerName: agent.container_name ?? savedPayload.container_name,
      image: agent.image ?? savedPayload.image,
      extra: {
        job_type: "managed_config",
        managed_config_revision: Number(row.desired_revision),
        managed_config_job_id: jobId,
      },
    });
    const transitioned = await client.query(
      `UPDATE agents SET status = 'queued'
        WHERE id = $1 AND status = $2
        RETURNING id`,
      [agentId, agent.status],
    );
    if (!transitioned.rows[0]) {
      throw createHttpError("Agent status changed while the managed configuration retry was queued", 409, "managed_config_runtime_changed");
    }
    const deploymentUpdate = await client.query(
      `UPDATE deployments
          SET status = 'queued', job_payload = $3::jsonb
        WHERE agent_id = $1 AND queue_job_id = $2
        RETURNING queue_job_id`,
      [agentId, jobId, JSON.stringify(jobPayload)],
    );
    if (!deploymentUpdate.rows[0]) {
      throw createHttpError("Managed configuration deployment record disappeared during retry", 404, "managed_config_job_not_found");
    }
    await client.query(
      `UPDATE agent_managed_config
          SET last_error = NULL, updated_at = NOW()
        WHERE agent_id = $1 AND last_job_id = $2`,
      [agentId, jobId],
    );
    await client.query("COMMIT");
    client.release();
    client = null;
    try {
      await queueDeployment(jobPayload, { jobId });
    } catch {
      throw makeQueueFailure();
    }
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client) client.release();
    await lock.release();
  }
  return { job_id: jobId };
}

async function markAgentManagedConfigApplied(queryable, agentId, revision) {
  const parsed = Number(revision);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return false;
  const result = await queryable.query(
    `UPDATE agent_managed_config
        SET applied_revision = $2, last_error = NULL, updated_at = NOW()
      WHERE agent_id = $1 AND desired_revision = $2`,
    [agentId, parsed],
  );
  return Number(result.rowCount || 0) === 1;
}

async function markAgentManagedConfigFailed(queryable, agentId, revision) {
  const parsed = Number(revision);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return false;
  const result = await queryable.query(
    `UPDATE agent_managed_config
        SET last_error = 'deployment_failed', updated_at = NOW()
      WHERE agent_id = $1 AND desired_revision = $2`,
    [agentId, parsed],
  );
  return Number(result.rowCount || 0) > 0;
}

module.exports = {
  HEADMASTER_ENV_NAMES,
  assertSafeSecretOverrideNames,
  buildAgentManagedConfigRuntimeEnv,
  buildHeadmasterIntegrationEnv,
  canonicalBankId,
  getAgentManagedConfigSnapshot,
  getAgentManagedConfigStatus,
  markAgentManagedConfigApplied,
  markAgentManagedConfigFailed,
  mutateAgentManagedConfig,
  normalizeSecretOverrideKey,
  normalizeSecretOverridePatch,
  parseRevision,
  retryAgentManagedConfigJob,
  validateHeadmasterConfigForAgent,
  validateHeadmasterIntegrationConfig,
};
