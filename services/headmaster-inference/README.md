# Headmaster managed inference relay (S1)

This is a provider relay, not an agent runtime. It accepts only the private
Headmaster assertion contract and the OpenAI-compatible `GET /v1/models` and
`POST /v1/chat/completions` operations. It never receives a prompt from Nora's
cloud Hermes runtime and never runs tools. The container has no Docker socket,
Docker CLI, runtime API, or agent execution dependencies. Build it with the Nora
repository root as context:

```sh
docker build -f services/headmaster-inference/Dockerfile -t headmaster-inference:<commit> .
```

Run it only on a private service network shared with admission. Do not publish
port 8781 to the host or internet. Give its DB role `SELECT` only on the
existing `llm_providers` rows/columns required by the resolver and its Redis
ACL only on the `headmaster-inference:*` key prefix. It requires the existing
Nora `ENCRYPTION_KEY` to decrypt provider rows; it creates no provider table,
vault, or credential catalog.

## Trusted mapping and secrets

Assignments are resolved at request time from Headmaster's Supabase project;
the relay holds no assignment copy and no provider secret.
`public.headmaster_inference_assignments` (migration
`20260924110000_headmaster_inference_assignments`) maps an owner
(`auth.users.id`) to a Nora user UUID and an existing `llm_providers` row UUID,
plus `enabled` and a monotonic `revision`. The table is reference-only: it
stores identifiers, never secrets. Provider keys stay encrypted in Nora
(`ENCRYPTION_KEY`) and are decrypted only by `resolveInferenceProvider` for the
referenced row; the relay does not scan users or enumerate provider keys.

`HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE` selects the assignment source:

- `auto` (default): Supabase when both `HEADMASTER_INFERENCE_SUPABASE_URL` and
  `HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY` are set, otherwise the
  legacy env map.
- `supabase`: durable Supabase assignments only; required before removing the
  env map.
- `env`: the LEGACY `HEADMASTER_INFERENCE_ACCOUNT_MAP` compatibility mode; an
  explicit selection logs a LEGACY-mode warning at startup.

Required private settings:

- `HEADMASTER_INFERENCE_ASSERTION_SECRET`: at least 32 random bytes, shared
  only with admission.
- Existing Nora Postgres connection settings plus `ENCRYPTION_KEY`; use a
  dedicated read-only DB principal, not the backend operator's write role.
- Existing Redis connection settings; use a dedicated ACL/user restricted to
  this service's key prefix.
- `HEADMASTER_INFERENCE_SUPABASE_URL`: the Headmaster project origin
  (`https://<ref>.supabase.co`; no credentials, path, or query).
- `HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY`: server-only credential used
  for the single-row assignment read (and, by the migration script only, the
  admin RPC). Never ship it to clients.
- `HEADMASTER_INFERENCE_ASSIGNMENT_TTL_MS`: optional assignment cache lifetime
  in milliseconds, default 30000, clamped to 1000..300000.

TTL and revocation semantics:

- The relay caches the last successful assignment read per owner for at most
  the TTL (default 30 seconds), so replacement, revocation
  (`enabled = false`), and reapproval take effect within that bounded window.
  An entry is never served beyond its TTL and a failed lookup is never cached.
- A revoked assignment is logged distinctly server-side
  (`headmaster-inference assignment revoked`) so an operator can tell a
  disabled owner apart from one who never had an assignment.
- Absence of a row denies access (`provider_mapping_unavailable`); assignment
  rows are never auto-created per auth user. Any lookup failure (network,
  non-2xx, malformed or duplicate rows, timeout) also denies — no stale or
  negative fallback is served.
- The lookup deadline (`HEADMASTER_INFERENCE_ASSIGNMENT_TIMEOUT_MS`, default
  10s) stays active through response body consumption, not just until headers
  arrive — a connection that stalls mid-body fails closed within the deadline
  instead of hanging. The body is also read through a capped streaming reader
  (64 KiB) rather than buffered unconditionally, so an oversized or runaway
  response body cannot be used to exhaust relay memory.
- The Supabase tables are read-only to `service_role`; every mutation goes
  through the admin-gated, revision-fenced
  `headmaster_admin_set_inference_assignment` RPC, which appends an audit row to
  `headmaster_inference_assignment_events` and returns `created` / `changed` /
  `unchanged` / `revision_conflict` / `actor_not_admin` / `owner_not_found`.

Least access: use a dedicated Supabase credential for the relay where the
project supports one, keep it in the relay's secret store rather than in image
config, and treat it as read-only in operational practice — the relay itself
only ever issues one bounded `SELECT` (at most two rows, to detect an ambiguous
row) and never writes. Rotate the credential if the relay host is compromised.

Legacy env map: `HEADMASTER_INFERENCE_ACCOUNT_MAP` is a server-only JSON object
keyed by the Headmaster Supabase owner UUID. Each value is `{ "noraUserId":
"<Nora UUID>", "providerId": "<existing llm_providers UUID>", "provider":
"openai" }`, with an optional narrower `models` array. This bootstrap policy is
never accepted from a request and is only consulted when the assignment source
is `env`. Accounts without a mapping fail closed with
`provider_mapping_unavailable`.

### Migrating from the env map

1. Apply `20260924110000_headmaster_inference_assignments` in Headmaster
   Supabase.
2. While the running relay still reads `HEADMASTER_INFERENCE_ACCOUNT_MAP`, run
   `node services/headmaster-inference/scripts/migrate-account-map.mjs --actor
   <admin-auth-users-uuid>` with `HEADMASTER_INFERENCE_SUPABASE_URL` and
   `HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY` set (or pass `--map-file`).
   The script validates the map, writes revision-fenced rows with
   `change_source='env_map_migration'`, and is idempotent: already-migrated
   accounts report `unchanged` without a revision bump. `--dry-run` prints the
   planned writes.
3. Deploy the relay with `HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE=supabase` (or
   `auto`) and verify that a migrated account succeeds while an account without
   a row is denied with `provider_mapping_unavailable`.
4. Remove `HEADMASTER_INFERENCE_ACCOUNT_MAP` from the relay environment.

### Rollback

- Redeploy the previous relay image, or set
  `HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE=env` and restore
  `HEADMASTER_INFERENCE_ACCOUNT_MAP`. Migrated rows stay inert until a Supabase
  source is used again; no rollback migration is required.
- To cut an account off immediately, disable or replace its assignment through
  the admin RPC (audited); the relay honors it within the bounded TTL window.

The assertion is `base64url(JSON claims).base64url(HMAC-SHA256(encoded claims))`.
Claims are version 1 with `aud=headmaster-inference`, `sub=<Headmaster owner
UUID>`, decimal `authorization_revision`, uppercase HTTP method, exact path,
SHA-256 body digest, request UUID, random nonce, `iat`, and `exp` (20 seconds).
The relay validates all claims and consumes each nonce once. Admission strips
caller-supplied identity/assertion headers and signs only after authenticating
the bearer token and checking current account entitlement.

## Model names

Clients may name a Headmaster tier (`headmaster-lite`, `headmaster-pro`,
`headmaster-max`). The relay resolves a tier to the account's first allowed model
before the provider call, so a tier never widens the allowlist: an account with
no allowed model gets `model_not_allowed`. All three tiers use the same backend
model until the operator assigns distinct ones. `GET /v1/models` still lists the
real allowed models; the desktop and Cloud runtimes register the tier names
themselves. The list lives in `policy.mjs`, `agent-runtime/lib/headmasterInference.ts`
and the desktop's `headmaster-trial-provider.ts`; keep them equal.

## Limits and behavior

- Only allowlisted provider/model pairs are returned. The allowed models are
  intersected with Nora's existing provider metadata and optional per-account
  policy list. Unimplemented provider protocols fail closed.
- Model requests are sent directly to their fixed HTTPS provider endpoint;
  client-selected provider IDs, endpoint URLs, redirects, and custom hosts are
  not accepted. Provider keys are sent only as upstream bearer auth.
- Messages, multimodal payloads, tool declarations/calls, reasoning parameters,
  stream usage options, and other OpenAI-compatible request fields are relayed
  without tool execution. No fallback model or retry is performed.
- Provider SSE bytes are streamed without buffering; disconnect/timeout aborts
  the upstream request. Both admission and relay bound incoming header/body
  receipt to 120 seconds. Request bodies are capped at 36 MiB, provider responses
  at 32 MiB, completion output at 4096 tokens by default, and request time at
  120 seconds by default.
- Redis enforces per-account in-flight requests, hourly request count, and a
  daily completion-token budget using reservations. Provider usage is recorded
  as token counts only; prompts and completions are not logged. When a provider
  omits usage, the reserved output limit is charged conservatively.
- The **code default** for the hourly request budget
  (`HEADMASTER_INFERENCE_REQUESTS_PER_HOUR`, `server.ts`) is **120 requests/hour**
  per account. The **production value** is set separately in the deployed
  `inference.env` file on the relay host and may differ from the code default;
  read it from the running container by variable name only (never print the
  full env dump), e.g. `docker inspect headmaster-inference --format
  '{{range .Config.Env}}{{println .}}{{end}}' | grep REQUESTS_PER_HOUR`.
- A quota-exhausted request fails with HTTP 429 and a stable `error.code`:
  `request_budget_exceeded` (hourly request count) or
  `completion_budget_exceeded` (daily completion-token budget). These are the
  exact names the Headmaster desktop client's trial-limit banner matches on;
  a test in `lib.test.mjs` pins them.
- Provider failures are mapped to stable safe error codes; provider response
  bodies are not returned on errors. Client cancellation is not retried.

Initial protocol coverage is limited to the current Nora OpenAI-compatible
catalog entries for OpenAI, Groq, Mistral, DeepSeek, xAI, Moonshot, Z.AI, and
NVIDIA. Anthropic, Gemini, Cohere, custom URLs, Microsoft Foundry, Ollama,
OAuth-only providers, and the Nora demo stub are intentionally unavailable
until individually adapted and tested. This does not claim the pinned Hermes
0.21.4 desktop client is integrated; that requires the D4 loopback adapter.

## B2-A integration required before deployment

Admission must use Supabase Auth to resolve the bearer token to `auth.users.id`,
then read `headmaster_account_entitlements(owner_id, entitlement,
authorization_revision)` on every new request. Only `entitlement='approved'`
passes. Missing revision, DB/network failure, or an absent row fails closed.
During a stream admission rechecks that authority at most every 30 seconds and
cancels the relay when entitlement or revision changes. The account identity is
independent of workspace/runtime readiness, so Work inference remains available
when Nora's customer agent is stopped.

B2-A has not landed in the companion site/admission integration at this commit.
The current draft table has only `owner_id`, `entitlement`, and `updated_at`;
its read-only entitlement route and `authorization_revision` migration are still
required. The fixed public admission origin also must be provisioned and returned
by account capabilities/status. Do not deploy this service until those contracts,
the assignment migration above is applied, secret distribution, Redis/DB ACLs,
and TLS/private routing are in place.
