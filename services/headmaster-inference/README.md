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

`HEADMASTER_INFERENCE_ACCOUNT_MAP` is a server-only JSON object keyed by the
Headmaster Supabase owner UUID. Each value is `{ "noraUserId": "<Nora UUID>",
"providerId": "<existing llm_providers UUID>", "provider": "openai" }`, with an
optional narrower `models` array. This bootstrap policy is never accepted from
a request. Provider IDs and Nora user IDs are checked against existing owned
rows by `resolveInferenceProvider`; only that row's encrypted key is decrypted.
The relay does not scan users or enumerate provider keys.

The map is an interim trusted integration input until B2-A provides the
account-to-provider policy as a server-side data contract. Populate it from the
Headmaster account authority; never copy IDs from client fields. Accounts
without a mapping fail closed with `provider_mapping_unavailable`.

Required private settings:

- `HEADMASTER_INFERENCE_ASSERTION_SECRET`: at least 32 random bytes, shared
  only with admission.
- Existing Nora Postgres connection settings plus `ENCRYPTION_KEY`; use a
  dedicated read-only DB principal, not the backend operator's write role.
- Existing Redis connection settings; use a dedicated ACL/user restricted to
  this service's key prefix.
- `HEADMASTER_INFERENCE_ACCOUNT_MAP` as above.

The assertion is `base64url(JSON claims).base64url(HMAC-SHA256(encoded claims))`.
Claims are version 1 with `aud=headmaster-inference`, `sub=<Headmaster owner
UUID>`, decimal `authorization_revision`, uppercase HTTP method, exact path,
SHA-256 body digest, request UUID, random nonce, `iat`, and `exp` (20 seconds).
The relay validates all claims and consumes each nonce once. Admission strips
caller-supplied identity/assertion headers and signs only after authenticating
the bearer token and checking current account entitlement.

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
the provider mapping, secret distribution, Redis/DB ACLs, and TLS/private routing
are in place.
