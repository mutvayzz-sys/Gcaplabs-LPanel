import { createHash } from "node:crypto";

const EXTERNAL_AGENT_NAMESPACE = "headmaster" as const;
const MAX_NAMESPACE_LENGTH = 64;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AuthenticatedIntegrationPrincipal {
  readonly managementUserId: string;
  readonly ownerUuid: string;
}

export interface ExternalAgentIdentityInput {
  readonly user_id?: unknown;
  readonly namespace?: unknown;
  readonly external_id: unknown;
  readonly owner_uuid?: unknown;
  readonly runtime_family: unknown;
  readonly runtime_target: unknown;
  readonly [key: string]: unknown;
}

export interface NormalizedExternalAgentIdentity {
  readonly user_id: string;
  readonly namespace: typeof EXTERNAL_AGENT_NAMESPACE;
  readonly external_id: string;
  readonly owner_uuid: string;
  readonly runtime_family: string;
  readonly runtime_target: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireCanonicalUuid(value: unknown, field: string): string {
  const uuid = requireNonEmptyString(value, field);
  if (!CANONICAL_UUID_PATTERN.test(uuid)) {
    throw new TypeError(`${field} must be a canonical UUID`);
  }
  return uuid;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value is not JSON-serializable");
  return encoded;
}

export function normalizeExternalAgentIdentity(
  input: ExternalAgentIdentityInput,
  principal: AuthenticatedIntegrationPrincipal,
): NormalizedExternalAgentIdentity {
  if (typeof input.namespace !== "string" || input.namespace.length === 0) {
    throw new TypeError("External agent namespace is required");
  }
  if (input.namespace.length > MAX_NAMESPACE_LENGTH) {
    throw new TypeError(`External agent namespace must not exceed ${MAX_NAMESPACE_LENGTH} characters`);
  }
  if (input.namespace !== EXTERNAL_AGENT_NAMESPACE) {
    throw new TypeError(`External agent namespace must be '${EXTERNAL_AGENT_NAMESPACE}'`);
  }

  const managementUserId = requireCanonicalUuid(
    principal.managementUserId,
    "Authenticated Nora management user UUID",
  );
  if (input.user_id !== undefined && input.user_id !== managementUserId) {
    throw new TypeError("Caller-supplied Nora management user ID does not match the authenticated principal");
  }

  const ownerUuid = requireCanonicalUuid(principal.ownerUuid, "Authenticated principal owner UUID");
  if (input.owner_uuid !== undefined && input.owner_uuid !== ownerUuid) {
    throw new TypeError("Caller-supplied owner UUID does not match the authenticated integration principal");
  }

  return Object.freeze({
    user_id: managementUserId,
    namespace: EXTERNAL_AGENT_NAMESPACE,
    external_id: requireCanonicalUuid(input.external_id, "External agent external ID"),
    owner_uuid: ownerUuid,
    runtime_family: requireNonEmptyString(input.runtime_family, "runtime_family"),
    runtime_target: requireNonEmptyString(input.runtime_target, "runtime_target"),
  });
}

export function fingerprintExternalAgentIdentity(
  identity: NormalizedExternalAgentIdentity,
): string {
  const fingerprintPayload = {
    user_id: identity.user_id,
    namespace: identity.namespace,
    external_id: identity.external_id,
    owner_uuid: identity.owner_uuid,
    runtime_family: identity.runtime_family,
    runtime_target: identity.runtime_target,
  };
  return createHash("sha256").update(stableJson(fingerprintPayload)).digest("hex");
}
