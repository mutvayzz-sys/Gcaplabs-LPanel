import type { NormalizedExternalAgentIdentity } from "./externalAgentIdentity";

type QueryResult<Row = Record<string, unknown>> = { rows: Row[] };
type TransactionClient = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
  release: () => void;
};
type PoolLike = { connect: () => Promise<TransactionClient> };
type AgentRow = Record<string, any>;
type DeploymentRow = {
  id: string;
  status: string | null;
  queue_job_id: string | null;
  job_payload: Record<string, unknown> | null;
};

export class ExternalAgentProvisioningConflict extends Error {
  statusCode = 409;
  code: string;

  constructor(message: string, code = "external_agent_conflict") {
    super(message);
    this.name = "ExternalAgentProvisioningConflict";
    this.code = code;
  }
}

export interface ExternalAgentCreateFields {
  agentId: string;
  name: string;
  node: string;
  backendType: string;
  sandboxType: string;
  vcpu: number;
  ramMb: number;
  diskGb: number;
  containerName: string;
  image: string | null;
  templatePayload: unknown;
  clawhubSkills: unknown[];
  hermesSkills: unknown[];
  runtimeFamily: string;
  deployTarget: string;
  executionTargetId: string;
  sandboxProfile: string;
  headmasterIntegrationConfig?: Record<string, string> | null;
}

export interface ExternalAgentProvisioningInput {
  pool: PoolLike;
  identity: NormalizedExternalAgentIdentity;
  requestKey: string;
  fingerprint: string;
  createIfMissing: boolean;
  createFields: ExternalAgentCreateFields;
  jobPayloadForAgent: (agent: AgentRow) => Record<string, unknown>;
}

export interface ExternalAgentProvisioningResult {
  agent: AgentRow | null;
  operation: DeploymentRow | null;
  created: boolean;
}

const CREATE_JOB_PREFIX = "headmaster-create-";

export function normalizeExternalAgentCreateRequestKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("idempotency_key must be a non-empty string");
  }
  const requestKey = value.trim();
  if (!requestKey) throw new TypeError("idempotency_key must be a non-empty string");
  if (requestKey.length > 255) {
    throw new TypeError("idempotency_key must not exceed 255 characters");
  }
  return requestKey;
}

function assertFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("External agent request fingerprint must be a SHA-256 hex digest");
  }
}

function assertAgentIdentity(agent: AgentRow, identity: NormalizedExternalAgentIdentity): void {
  if (
    agent.user_id !== identity.user_id ||
    agent.external_id_namespace !== identity.namespace ||
    agent.external_id !== identity.external_id ||
    agent.external_owner_id !== identity.owner_uuid
  ) {
    throw new ExternalAgentProvisioningConflict(
      "The idempotency key is already bound to a different external identity",
      "external_agent_idempotency_conflict",
    );
  }
}

async function acquireCreateLocks(
  client: TransactionClient,
  identity: NormalizedExternalAgentIdentity,
  requestKey: string,
): Promise<void> {
  const lockKeys = [
    JSON.stringify(["nora:external-agent:create-request", identity.user_id, requestKey]),
    JSON.stringify([
      "nora:external-agent:identity",
      identity.user_id,
      identity.namespace,
      identity.external_id,
    ]),
  ];
  for (const lockKey of lockKeys) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
  }
}

async function findRequestMapping(
  client: TransactionClient,
  identity: NormalizedExternalAgentIdentity,
  requestKey: string,
): Promise<{ agent: AgentRow; requestFingerprint: string; deploymentId: string | null } | null> {
  const result = await client.query(
    `SELECT requests.request_fingerprint AS mapped_request_fingerprint,
            requests.deployment_id AS mapped_deployment_id,
            agents.*
       FROM external_agent_create_requests AS requests
       JOIN agents ON agents.id = requests.agent_id AND agents.user_id = requests.user_id
      WHERE requests.user_id = $1 AND requests.request_key = $2
      FOR UPDATE OF requests, agents`,
    [identity.user_id, requestKey],
  );
  const row = result.rows[0] as AgentRow | undefined;
  if (!row) return null;
  return {
    agent: row,
    requestFingerprint: String(row.mapped_request_fingerprint),
    deploymentId: row.mapped_deployment_id ? String(row.mapped_deployment_id) : null,
  };
}

async function findAgentByLegacyRequestKey(
  client: TransactionClient,
  identity: NormalizedExternalAgentIdentity,
  requestKey: string,
): Promise<AgentRow | null> {
  const result = await client.query(
    `SELECT * FROM agents WHERE user_id = $1 AND create_request_key = $2 FOR UPDATE`,
    [identity.user_id, requestKey],
  );
  return (result.rows[0] as AgentRow | undefined) || null;
}

async function findAgentByExternalIdentity(
  client: TransactionClient,
  identity: NormalizedExternalAgentIdentity,
): Promise<AgentRow | null> {
  const result = await client.query(
    `SELECT * FROM agents
      WHERE user_id = $1 AND external_id_namespace = $2 AND external_id = $3
      FOR UPDATE`,
    [identity.user_id, identity.namespace, identity.external_id],
  );
  return (result.rows[0] as AgentRow | undefined) || null;
}

async function findCreateOperation(
  client: TransactionClient,
  agentId: string,
  deploymentId: string | null,
): Promise<DeploymentRow | null> {
  const result = deploymentId
    ? await client.query(
        `SELECT id, status, queue_job_id, job_payload
           FROM deployments
          WHERE id = $1 AND agent_id = $2
          FOR UPDATE`,
        [deploymentId, agentId],
      )
    : await client.query(
        `SELECT id, status, queue_job_id, job_payload
           FROM deployments
          WHERE agent_id = $1 AND queue_job_id = $2
          FOR UPDATE`,
        [agentId, `${CREATE_JOB_PREFIX}${agentId}`],
      );
  return (result.rows[0] as DeploymentRow | undefined) || null;
}

async function insertRequestMapping(
  client: TransactionClient,
  identity: NormalizedExternalAgentIdentity,
  agentId: string,
  deploymentId: string | null,
  requestKey: string,
  fingerprint: string,
): Promise<void> {
  await client.query(
    `INSERT INTO external_agent_create_requests(
       user_id, agent_id, deployment_id, request_key, request_fingerprint
     ) VALUES($1, $2, $3, $4, $5)`,
    [identity.user_id, agentId, deploymentId, requestKey, fingerprint],
  );
}

async function createDeploymentOperation(
  client: TransactionClient,
  agent: AgentRow,
  jobPayloadForAgent: (agent: AgentRow) => Record<string, unknown>,
): Promise<DeploymentRow> {
  const queueJobId = `${CREATE_JOB_PREFIX}${agent.id}`;
  const jobPayload = jobPayloadForAgent(agent);
  const result = await client.query(
    `INSERT INTO deployments(agent_id, status, queue_job_id, job_payload)
     VALUES($1, 'queued', $2, $3::jsonb)
     RETURNING id, status, queue_job_id, job_payload`,
    [agent.id, queueJobId, JSON.stringify(jobPayload)],
  );
  const operation = result.rows[0] as DeploymentRow | undefined;
  if (!operation) throw new Error("Nora did not return the external agent deployment operation");
  return operation;
}

async function seedHeadmasterIntegrationConfig(
  client: TransactionClient,
  agentId: string,
  config: Record<string, string> | null,
): Promise<void> {
  if (!config) return;
  await client.query(
    `INSERT INTO agent_managed_config(
       agent_id, desired_revision, applied_revision, headmaster_integration_config
     ) VALUES($1, 1, 0, $2::jsonb)
     ON CONFLICT(agent_id) DO NOTHING`,
    [agentId, JSON.stringify(config)],
  );
}

function conflictOnChangedRequest(): ExternalAgentProvisioningConflict {
  return new ExternalAgentProvisioningConflict(
    "The idempotency key was already used with different immutable request inputs",
    "external_agent_idempotency_conflict",
  );
}

export async function createOrReuseExternalAgent(
  input: ExternalAgentProvisioningInput,
): Promise<ExternalAgentProvisioningResult> {
  const { pool, identity, requestKey, fingerprint, createIfMissing, createFields, jobPayloadForAgent } = input;
  if (!requestKey.trim() || requestKey.length > 255) {
    throw new TypeError("idempotency_key must be a non-empty string of at most 255 characters");
  }
  assertFingerprint(fingerprint);

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await acquireCreateLocks(client, identity, requestKey);

    let mapping = await findRequestMapping(client, identity, requestKey);
    let agent: AgentRow | null = null;
    let operation: DeploymentRow | null = null;

    if (mapping) {
      agent = mapping.agent;
      if (mapping.requestFingerprint !== fingerprint) throw conflictOnChangedRequest();
      assertAgentIdentity(agent, identity);
      operation = await findCreateOperation(client, String(agent.id), mapping.deploymentId);
    } else {
      const legacyRequestAgent = await findAgentByLegacyRequestKey(client, identity, requestKey);
      if (legacyRequestAgent) {
        agent = legacyRequestAgent;
        assertAgentIdentity(agent, identity);
        if (agent.create_request_fingerprint !== fingerprint) throw conflictOnChangedRequest();
        operation = await findCreateOperation(client, String(agent.id), null);
        await insertRequestMapping(
          client,
          identity,
          String(agent.id),
          operation?.id || null,
          requestKey,
          fingerprint,
        );
      } else {
        agent = await findAgentByExternalIdentity(client, identity);
        if (agent) {
          if (agent.external_owner_id !== identity.owner_uuid) {
            throw new ExternalAgentProvisioningConflict(
              "The Headmaster workspace is already bound to a different owner",
              "external_agent_owner_conflict",
            );
          }
          // A new request key may alias an existing immutable identity. The key
          // gets its own fingerprint so later reuse with changed inputs conflicts.
          operation = await findCreateOperation(client, String(agent.id), null);
          await insertRequestMapping(
            client,
            identity,
            String(agent.id),
            operation?.id || null,
            requestKey,
            fingerprint,
          );
        } else if (createIfMissing) {
          const insertResult = await client.query(
            `INSERT INTO agents(
               id, user_id, name, status, node, backend_type, sandbox_type, vcpu, ram_mb, disk_gb,
               container_name, image, template_payload, clawhub_skills, hermes_skills, runtime_family,
               deploy_target, execution_target_id, sandbox_profile, external_id_namespace, external_id,
               external_owner_id, create_request_key, create_request_fingerprint
             ) VALUES(
               $1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
               $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22, $23
             ) RETURNING *`,
            [
              createFields.agentId,
              identity.user_id,
              createFields.name,
              createFields.node,
              createFields.backendType,
              createFields.sandboxType,
              createFields.vcpu,
              createFields.ramMb,
              createFields.diskGb,
              createFields.containerName,
              createFields.image,
              JSON.stringify(createFields.templatePayload),
              JSON.stringify(createFields.clawhubSkills),
              JSON.stringify(createFields.hermesSkills),
              createFields.runtimeFamily,
              createFields.deployTarget,
              createFields.executionTargetId,
              createFields.sandboxProfile,
              identity.namespace,
              identity.external_id,
              identity.owner_uuid,
              requestKey,
              fingerprint,
            ],
          );
          agent = (insertResult.rows[0] as AgentRow | undefined) || null;
          if (!agent) throw new Error("Nora did not return the created external agent");
          await seedHeadmasterIntegrationConfig(
            client,
            String(agent.id),
            createFields.headmasterIntegrationConfig || null,
          );
          operation = await createDeploymentOperation(client, agent, jobPayloadForAgent);
          if (createFields.headmasterIntegrationConfig) {
            await client.query(
              "UPDATE agent_managed_config SET last_job_id = $2, updated_at = NOW() WHERE agent_id = $1",
              [agent.id, operation.queue_job_id],
            );
          }
          await insertRequestMapping(
            client,
            identity,
            String(agent.id),
            operation.id,
            requestKey,
            fingerprint,
          );
          await client.query("COMMIT");
          transactionOpen = false;
          return { agent, operation, created: true };
        }
      }
    }

    if (!agent) {
      await client.query("COMMIT");
      transactionOpen = false;
      return { agent: null, operation: null, created: false };
    }

    // A preflight lookup never creates a new agent or operation. If this is an
    // already-queued external agent with no outbox row, the caller continues
    // through quota validation and retries with createIfMissing=true.
    await client.query("COMMIT");
    transactionOpen = false;
    return { agent, operation, created: false };
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface AdoptExternalAgentInput {
  pool: PoolLike;
  agentId: string;
  identity: NormalizedExternalAgentIdentity;
}

/**
 * Adopt an existing Nora agent only when Headmaster supplies its ID from a
 * verified runtime binding. Names are deliberately not part of discovery.
 * Existing identity is immutable: exact repeats are idempotent, conflicts fail.
 */
export async function adoptExternalAgent(
  input: AdoptExternalAgentInput,
): Promise<{ agent: AgentRow | null; adopted: boolean }> {
  const { pool, agentId, identity } = input;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    throw new TypeError("agentId must be a canonical UUID");
  }

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify([
        "nora:external-agent:identity",
        identity.user_id,
        identity.namespace,
        identity.external_id,
      ]),
    ]);

    const selected = await client.query(
      "SELECT * FROM agents WHERE user_id = $1 AND id = $2 FOR UPDATE",
      [identity.user_id, agentId],
    );
    const agent = (selected.rows[0] as AgentRow | undefined) || null;
    if (!agent) {
      await client.query("COMMIT");
      transactionOpen = false;
      return { agent: null, adopted: false };
    }

    const existingIdentity = await client.query(
      `SELECT id, external_owner_id FROM agents
        WHERE user_id = $1 AND external_id_namespace = $2 AND external_id = $3
        FOR UPDATE`,
      [identity.user_id, identity.namespace, identity.external_id],
    );
    const identityOwner = existingIdentity.rows[0] as
      | { id: string; external_owner_id: string }
      | undefined;
    if (identityOwner && String(identityOwner.id) !== String(agent.id)) {
      const code = identityOwner.external_owner_id === identity.owner_uuid
        ? "external_agent_identity_conflict"
        : "external_agent_owner_conflict";
      throw new ExternalAgentProvisioningConflict(
        "The Headmaster workspace is already bound to a different Nora agent",
        code,
      );
    }

    const hasIdentity = agent.external_id_namespace != null || agent.external_id != null || agent.external_owner_id != null;
    if (hasIdentity) {
      if (
        agent.external_id_namespace !== identity.namespace ||
        String(agent.external_id) !== identity.external_id ||
        String(agent.external_owner_id) !== identity.owner_uuid
      ) {
        throw new ExternalAgentProvisioningConflict(
          "The Nora agent is already bound to a different external identity",
          "external_agent_identity_conflict",
        );
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return { agent, adopted: false };
    }

    const updated = await client.query(
      `UPDATE agents
          SET external_id_namespace = $3, external_id = $4, external_owner_id = $5
        WHERE user_id = $1 AND id = $2
          AND external_id_namespace IS NULL AND external_id IS NULL AND external_owner_id IS NULL
        RETURNING *`,
      [identity.user_id, agentId, identity.namespace, identity.external_id, identity.owner_uuid],
    );
    const adoptedAgent = (updated.rows[0] as AgentRow | undefined) || null;
    if (!adoptedAgent) {
      throw new ExternalAgentProvisioningConflict(
        "The Nora agent identity changed while it was being adopted",
        "external_agent_identity_conflict",
      );
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return { agent: adoptedAgent, adopted: true };
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}
