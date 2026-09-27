# Headmaster managed configuration

The bridge adopts an agent's immutable external identity before configuring its
owner, workspace, memory bank and memory gateway. The agent must use the
Headmaster runtime family. These routes inherit agent/workspace authorization;
GET needs viewer access and mutations need editor access.

- `GET /api/agents/:id/managed-config` returns `integration_key_names`,
  `desired_revision`, `applied_revision`, and `deployment_status`. No values or
  runtime credentials are returned.
- `PATCH /api/agents/:id/integrations/headmaster` accepts `expected_revision`,
  `owner_uuid`, `workspace_uuid`, `memory_bank_id`, and `memory_gateway_url`.
  Identity must match the adopted binding. The bank is `hermes-u-` followed by
  the owner UUID with underscores replacing hyphens. Gateway URLs must use HTTP
  or HTTPS and contain no credentials, query or fragment.
- `POST /api/agents/:id/managed-config/retry` reapplies saved desired state without
  increasing its revision. An unconfigured agent returns 400.

Changed stale requests return 409. An identical already-applied PATCH is a true
no-op, even when it carries the earlier revision. Duplicate retries are also
no-ops once applied. The existing account provider lock serializes persistence,
full environment reconciliation, restart, readiness, and revision acknowledgement.

The four values are appended to the existing full environment aggregator, after
generic integrations, channels and providers. Generic integrations cannot inject
reserved Headmaster values. Persistence read errors fail closed. The managed
name allowlist includes the four names for this runtime family, including the
Kubernetes reconciliation path. Other runtime families retain their existing
allowlist.

Application failure returns HTTP 200 with `deployment_status: "failed"` and an
unacknowledged desired revision. A successful call must return an explicit
non-staged sync result after readiness; an empty, skipped, failed or merely staged
result is not success. If auth reconciliation quarantined and stopped the runtime,
retry uses the existing safe offline-stage/start/readiness lifecycle. An agent
stopped by its user is not automatically started. `pending` is retryable after an
interrupted API process, so it cannot strand the bridge in an in-progress state.

## Validation and deployment

Run the backend typecheck and the `headmasterConfig`, `authSync`, `agents`,
`llmProviders` and `openapi` Jest suites on Linux Node 24. The auth-sync suite
executes `/bin/sh` and therefore needs Linux.

`backend-api/scripts/headmaster-managed-config-live.ts` is a fixture-only harness.
It requires `DB_NAME=hm_managed_config_test`, a fresh disposable PostgreSQL
database, a disposable Redis service, `NORA_AGENT_NETWORK=hm-managed-config-test`,
Docker access, and `HEADMASTER_TEST_IMAGE` pointing at a cached real runtime image.
Use an isolated Docker daemon; do not give it production database credentials.
It generates synthetic credentials in memory, makes no inference calls, applies
and replays migrations, then exercises the authenticated routes, actual restart,
process environment preservation, no-op replay, provider rotation, and recovery
from a stopped auth-quarantined state. Process environment is inspected as the
runtime service user because Docker root without ptrace capability cannot read
that user's `/proc/*/environ`. Only assertions/pass markers are printed. Runtime
containers are stopped and retained, never deleted.

The seven new columns use append-only startup migrations, mirrored in
`db_schema.sql`. Release only from a merged commit after live fixture validation.
Production migration and Nora deployment require separate owner approval; an
alpha merge does not authorize deployment. Kubernetes live acceptance requires a
Kubernetes fixture and remains distinct from unit coverage of its allowlist.
