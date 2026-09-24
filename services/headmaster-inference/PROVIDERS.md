# Managed inference relay (S1) — provider coverage

## Audit: the provider this service must support first is OpenRouter

**Conclusion: OpenRouter must be a first-class protocol here, and OpenRouter's
absence from the relay allowlist was a real coverage gap — not a deliberate
policy.** The evidence:

- The plan names it directly: Masterplan3 M6 item 7 says "The current allowlist
  omits OpenRouter and uses a fixed tested-model matrix" and asks for the
  intended provider to be implemented and proven, not mocked.
- Nora's own catalog already ships OpenRouter as a managed provider:
  `backend-api/llmProviders.ts` (`{ id: "openrouter", name: "OpenRouter",
  envVar: "OPENROUTER_API_KEY", models: [] }`), with the same entry in
  `workers/provisioner/worker.ts`.
- Nora treats OpenRouter as a native managed provider for its runtimes, not a
  custom URL: `backend-api/authSync.ts` and the provisioner worker map it as
  `{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }`, its
  default model is `openrouter/auto`, and the Docker/K8s/Proxmox/NemoClaw
  backends all inject `OPENROUTER_API_KEY`.
- This operator's environment runs models through OpenRouter (Hermes
  `model.provider=openrouter`), so a relay that only speaks the other catalog
  providers cannot serve the intended account.
- The omission was visible in the fixed matrix: `policy.mjs` had no
  `openrouter` entry, so `parseAccountProviderMap` rejected such rows, model
  discovery returned nothing, and `provider_protocol_unavailable` failed
  closed. The plan's stated fix — implement only the required protocol(s),
  derive selectable models from the assigned provider configuration filtered by
  tested capabilities — is what this change does.

Deliberately **not** implemented: `/responses` (stays unsupported for every
provider), Anthropic/Gemini/Cohere/Microsoft Foundry/Ollama/OAuth-only providers
and the Nora demo stub (unchanged, still fail closed).

## Supported protocols

- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions` only.
- **OpenRouter** (new): fixed endpoint
  `https://openrouter.ai/api/v1/chat/completions`, bearer auth from the assigned
  provider row's decrypted key, `redirect: 'error'` (redirects never followed),
  request/response bodies relayed unchanged (messages, multimodal parts, tools,
  `tool_choice`, stream options, reasoning parameters), SSE bytes streamed
  without buffering, client disconnect/timeout aborts the upstream request, no
  fallback model and no retry.
- Endpoints stay allowlisted per provider (`policy.mjs` `PROVIDER_ENDPOINTS`):
  https only, exact host list, no port/IP/userinfo/query; a provider row's saved
  base URL can only narrow to the same host, otherwise the request fails closed
  with `provider_endpoint_forbidden`.
- Error translation (`safeProviderError`): 400/404/422 → 400
  `provider_request_rejected`; 401/403 → 502 `provider_authentication_failed`;
  429 → 429 `provider_rate_limited` (with safe `retry-after`); everything else,
  including OpenRouter's 402 (credits), → 502 `provider_error`. Provider
  response bodies are never returned to the client.

## Model derivation

Selectable models for a request are the **models configured on the assigned
provider row** (`provider.models` from Nora's resolver) intersected with the
**models this relay has actually covered** in `TESTED_PROVIDER_COVERAGE`
(`policy.mjs`), then narrowed by the optional per-account `models` list in the
trusted account map. Consequences:

- The old gate ("fixed tested-model matrix only") is gone; a configured model is
  exposed only while its provider coverage entry lists it.
- The assignment path may pass **no** per-account model list: derivation works
  from the provider row alone. A row that configures no models at all (the
  OpenRouter catalog ships `models: []`) falls back to the provider's covered
  set, so the protocol is usable without per-account lists.
- An untested model id never reaches the provider: `model_not_allowed` (400) is
  returned before any upstream call. `openrouter/auto` — a real alias Nora
  defaults to elsewhere — is deliberately withheld until a live test covers it.
- `TESTED_MODELS` is kept as a derived, frozen view of the coverage table for
  the relay's durable-assignment protocol gate (`lib.mjs`), so the two views
  cannot drift; OpenRouter is now included there as well.

## Capability table

Coverage surface = `['chat', 'streaming', 'tool_calls']` — the whole
OpenAI-compatible completion surface the relay carries; `/responses` is not part
of it. "Covered models" are the ids the live suite exercises end to end.

| Provider   | Endpoint                                   | Covered models                                                     | Live run status (this change) |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------ | ----------------------------- |
| openrouter | `https://openrouter.ai/api/v1`             | `deepseek/deepseek-v4.1-flash`                                     | protocol wiring + real auth-failure probe **run and passing**; chat/stream/tool/cancel suite ready, key-gated run **pending** (see below) |
| openai     | `https://api.openai.com/v1`                | `gpt-5.5`, `gpt-5.5-pro`                                           | pre-existing coverage, not re-run in this change |
| groq       | `https://api.groq.com/openai/v1`           | `llama-3.3-70b-versatile`                                          | pre-existing coverage, not re-run |
| mistral    | `https://api.mistral.ai/v1`                | `mistral-large-latest`                                             | pre-existing coverage, not re-run |
| deepseek   | `https://api.deepseek.com`                 | `deepseek-chat`, `deepseek-reasoner`                               | pre-existing coverage, not re-run |
| xai        | `https://api.x.ai/v1`                      | `grok-4`, `grok-4-0709`, `grok-3`, `grok-3-fast`                   | pre-existing coverage, not re-run |
| moonshot   | `https://api.moonshot.ai/v1`               | `kimi-k2.5`                                                        | pre-existing coverage, not re-run |
| zai        | `https://api.z.ai/api/paas/v4`             | `glm-5`                                                            | pre-existing coverage, not re-run |
| nvidia     | `https://integrate.api.nvidia.com/v1`      | `nvidia/moonshotai/kimi-k2.5`, `nvidia/minimaxai/minimax-m2.5`, `nvidia/z-ai/glm5` | pre-existing coverage, not re-run |

## Live-test evidence

New test file: `provider.live.test.mjs`. Run from
`services/headmaster-inference/`:

```sh
# offline + hermetic relay wiring / policy / route checks (always runs)
node --test *.test.mjs

# real-endpoint auth-failure probe for OpenRouter (deliberately invalid key)
HEADMASTER_INFERENCE_LIVE=1 node --test provider.live.test.mjs

# full real-provider suite: chat, streaming, tool calls, cancellation, errors
OPENROUTER_API_KEY=<key> node --test provider.live.test.mjs
# (optional) HEADMASTER_LIVE_MODEL=deepseek/deepseek-chat to try another id
```

Observed in this environment (2026-09-24):

- `node --test *.test.mjs` → **38 tests, 31 pass, 7 skipped, 0 fail**. The seven
  skips are the Redis-dependent quota tests (`REDIS_URL` unset) and the five
  key-gated `live:` tests (`OPENROUTER_API_KEY` unset).
- `HEADMASTER_INFERENCE_LIVE=1 node --test provider.live.test.mjs` → **5 pass,
  4 skipped, 0 fail**, including the real-endpoint probe: the relay sent a
  completion request with a deliberately invalid credential to the real
  `https://openrouter.ai/api/v1/chat/completions`, received OpenRouter's real
  `401 {"error":{"message":"User not found.","code":401}}`, and returned `502
  provider_authentication_failed` with exactly one upstream call (no retry) and
  no provider body or credential in the client response. This exercises the
  OpenRouter protocol end to end over the network up to the auth boundary and
  the error-mapping path.
- Public catalog metadata (unauthenticated
  `GET https://openrouter.ai/api/v1/models`) for the covered model:
  `deepseek/deepseek-v4.1-flash` — context 1,048,576, modalities text+image,
  `supported_parameters` include `max_tokens`, `tools`, `tool_choice`,
  `structured_outputs` (so the max_tokens default the relay injects and the
  tool-call scenario are within the model's declared surface).

**Not run in this environment:** the key-gated chat/streaming/tool-call/
cancellation scenarios. Access to `OPENROUTER_API_KEY` was denied by the
operator during this task (the extraction command was blocked, and per its
result it was not retried), so no funded live run happened here. The suite skips
cleanly without the key; the parent/operator must run the third command above
and record its outcome before declaring production support for OpenRouter. The
relay-side mechanics of those scenarios (SSE passthrough, usage-frame
accounting branch, cancellation abort/reservation release/non-retry) were
verified against a local stub upstream during development and are additionally
covered by the hermetic tests — that is harness verification, **not** provider
evidence, and must not be cited as such.

## Relationship to the rest of M6

- `lib.mjs` (durable assignment path) can carry a mapping with no `provider`
  field; the protocol is taken from the provider row and gated through the
  derived `TESTED_MODELS` view. Because OpenRouter is now in the coverage table,
  OpenRouter provider rows pass that gate.
- The relay still never receives prompts from Nora's cloud runtime, never runs
  tools, and keeps a single completion surface; provider secrets stay in the
  private relay and are sent only as upstream bearer auth.
