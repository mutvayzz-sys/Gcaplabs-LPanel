import { isIP } from "node:net";

export const OWNER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Capabilities the relay's single OpenAI-compatible surface can carry: a chat
// completion turn, streamed relay of provider SSE frames, and relay of tool
// declarations/calls. `/responses` and tool *execution* are not part of this
// contract for any provider.
const CHAT_SURFACE = Object.freeze(["chat", "streaming", "tool_calls"]);

function providerCoverage(models) {
  return Object.freeze({ capabilities: CHAT_SURFACE, models: Object.freeze(models) });
}

// Per-provider relay coverage exercised by the live suite
// (provider.live.test.mjs; run status recorded in PROVIDERS.md). `models` lists
// the model ids exercised with the capabilities above. A provider is selectable
// only through an entry here, and an assigned provider's selectable models are
// derived from its configured models filtered by this entry — so adding an
// entry without a runnable live test is a false claim of support.
export const TESTED_PROVIDER_COVERAGE = Object.freeze({
  openai: providerCoverage(["gpt-5.5", "gpt-5.5-pro"]),
  groq: providerCoverage(["llama-3.3-70b-versatile"]),
  mistral: providerCoverage(["mistral-large-latest"]),
  deepseek: providerCoverage(["deepseek-chat", "deepseek-reasoner"]),
  xai: providerCoverage(["grok-4", "grok-4-0709", "grok-3", "grok-3-fast"]),
  moonshot: providerCoverage(["kimi-k2.5"]),
  zai: providerCoverage(["glm-5"]),
  nvidia: providerCoverage([
    "nvidia/moonshotai/kimi-k2.5",
    "nvidia/minimaxai/minimax-m2.5",
    "nvidia/z-ai/glm5",
  ]),
  // OpenRouter is OpenAI-compatible at the fixed https://openrouter.ai/api/v1
  // endpoint. Its model ids are open-ended, so only ids the live suite
  // (provider.live.test.mjs) exercises end to end are listed; the recorded run
  // status lives in PROVIDERS.md.
  openrouter: providerCoverage(["deepseek/deepseek-v4.1-flash"]),
});

export function testedProviderModels(provider) {
  const entry = TESTED_PROVIDER_COVERAGE[String(provider || "")];
  return entry ? [...entry.models] : [];
}

// Backwards-compatible provider→models view of the coverage table, kept for the
// relay's protocol gate. Derived so the two views cannot drift apart.
export const TESTED_MODELS = Object.freeze(
  Object.fromEntries(
    Object.entries(TESTED_PROVIDER_COVERAGE).map(([provider, entry]) => [
      provider,
      Object.freeze([...entry.models]),
    ]),
  ),
);

const PROVIDER_ENDPOINTS = Object.freeze({
  openai: { baseUrl: "https://api.openai.com/v1", hosts: ["api.openai.com"] },
  groq: { baseUrl: "https://api.groq.com/openai/v1", hosts: ["api.groq.com"] },
  mistral: { baseUrl: "https://api.mistral.ai/v1", hosts: ["api.mistral.ai"] },
  deepseek: { baseUrl: "https://api.deepseek.com", hosts: ["api.deepseek.com"] },
  xai: { baseUrl: "https://api.x.ai/v1", hosts: ["api.x.ai"] },
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", hosts: ["api.moonshot.ai"] },
  zai: { baseUrl: "https://api.z.ai/api/paas/v4", hosts: ["api.z.ai"] },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", hosts: ["integrate.api.nvidia.com"] },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", hosts: ["openrouter.ai"] },
});

const CLIENT_AUTHORITY_FIELDS = new Set([
  "account_id",
  "owner_id",
  "user_id",
  "nora_user_id",
  "provider",
  "provider_id",
  "nora_provider_id",
]);

export function parseAccountProviderMap(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("HEADMASTER_INFERENCE_ACCOUNT_MAP is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("HEADMASTER_INFERENCE_ACCOUNT_MAP must be an object");
  }
  const out = new Map();
  for (const [ownerId, value] of Object.entries(parsed)) {
    if (!OWNER_UUID.test(ownerId) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("HEADMASTER_INFERENCE_ACCOUNT_MAP has an invalid account entry");
    }
    const noraUserId = value.noraUserId;
    const providerId = value.providerId;
    const provider = value.provider;
    if (
      !OWNER_UUID.test(String(noraUserId || "")) ||
      !OWNER_UUID.test(String(providerId || "")) ||
      !Object.hasOwn(TESTED_PROVIDER_COVERAGE, provider)
    ) {
      throw new Error(
        "HEADMASTER_INFERENCE_ACCOUNT_MAP entry has invalid trusted provider identity",
      );
    }
    let models;
    if (value.models !== undefined) {
      if (
        !Array.isArray(value.models) ||
        value.models.length === 0 ||
        value.models.some(
          (model) => typeof model !== "string" || !testedProviderModels(provider).includes(model),
        )
      ) {
        throw new Error("HEADMASTER_INFERENCE_ACCOUNT_MAP entry has an invalid model allowlist");
      }
      models = [...new Set(value.models)];
    }
    const normalizedOwnerId = ownerId.toLowerCase();
    if (out.has(normalizedOwnerId))
      throw new Error("HEADMASTER_INFERENCE_ACCOUNT_MAP has duplicate account ids");
    if (
      Object.keys(value).some(
        (key) => !["noraUserId", "providerId", "provider", "models"].includes(key),
      )
    ) {
      throw new Error("HEADMASTER_INFERENCE_ACCOUNT_MAP entry has unknown fields");
    }
    out.set(
      normalizedOwnerId,
      Object.freeze({
        noraUserId: noraUserId.toLowerCase(),
        providerId: providerId.toLowerCase(),
        provider,
        ...(models ? { models: Object.freeze(models) } : {}),
      }),
    );
  }
  if (out.size === 0)
    throw new Error("HEADMASTER_INFERENCE_ACCOUNT_MAP must contain at least one account");
  return out;
}

// Selectable models for an assigned provider: the models configured on the
// provider's Nora row, intersected with the models covered for that provider
// protocol by the live suite, plus the optional per-account narrowing from the
// trusted assignment. A provider row that configures no models — OpenRouter's
// catalog list is open-ended — falls back to the covered set itself so the
// protocol stays usable without a per-account model list.
export function allowedModelsForProvider(mapping, providerMetadataModels = []) {
  if (!mapping || !Object.hasOwn(TESTED_PROVIDER_COVERAGE, mapping.provider)) return [];
  const configuredModels = Array.isArray(providerMetadataModels) ? providerMetadataModels : [];
  const configured = configuredModels.length > 0 ? new Set(configuredModels) : null;
  const perAccount = mapping.models ? new Set(mapping.models) : null;
  return testedProviderModels(mapping.provider).filter(
    (model) => (!configured || configured.has(model)) && (!perAccount || perAccount.has(model)),
  );
}

// Branded tier ids clients may name. The relay resolves a tier to the account's
// assigned backend model here, so every client (the desktop's Work engine and a
// Cloud runtime) can register the same three fixed names without knowing what
// stands behind them. All three resolve to the first allowed model until the
// operator assigns tiers to distinct backend models. Keep this list equal to
// agent-runtime/lib/headmasterInference.ts and the desktop's
// headmaster-trial-provider.ts.
export const HEADMASTER_TIER_MODELS = Object.freeze([
  "headmaster-lite",
  "headmaster-pro",
  "headmaster-max",
]);

export function resolveTierModel(model, allowedModels) {
  if (!HEADMASTER_TIER_MODELS.includes(model)) return model;
  return allowedModels[0] ?? model;
}

export function prepareChatCompletion(body, mapping, providerMetadataModels, limits = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body_invalid" };
  if (Object.keys(body).some((key) => CLIENT_AUTHORITY_FIELDS.has(key.toLowerCase()))) {
    return { error: "client_authority_field_forbidden" };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return { error: "messages_required" };
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    return { error: "stream_invalid" };
  if (typeof body.model !== "string" || !body.model) return { error: "model_required" };
  const allowedModels = allowedModelsForProvider(mapping, providerMetadataModels);
  const resolvedModel = resolveTierModel(body.model, allowedModels);
  if (!allowedModels.includes(resolvedModel)) return { error: "model_not_allowed" };

  const maxCompletionTokens =
    Number.isSafeInteger(limits.maxCompletionTokens) && limits.maxCompletionTokens > 0
      ? limits.maxCompletionTokens
      : 4096;
  const defaultCompletionTokens =
    Number.isSafeInteger(limits.defaultCompletionTokens) && limits.defaultCompletionTokens > 0
      ? Math.min(limits.defaultCompletionTokens, maxCompletionTokens)
      : Math.min(1024, maxCompletionTokens);
  const request = { ...body, model: resolvedModel };
  const supplied = ["max_completion_tokens", "max_tokens"]
    .filter((field) => body[field] !== undefined)
    .map((field) => body[field]);
  if (
    supplied.some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > maxCompletionTokens,
    )
  ) {
    return { error: "completion_token_limit_invalid" };
  }
  if (supplied.length === 0) {
    // OpenAI's current models require max_completion_tokens; the other
    // OpenAI-compatible catalogs (including OpenRouter) accept max_tokens.
    request[mapping.provider === "openai" ? "max_completion_tokens" : "max_tokens"] =
      defaultCompletionTokens;
  }
  const reserveOutputTokens = supplied.length ? Math.min(...supplied) : defaultCompletionTokens;
  return { body: request, reserveOutputTokens, allowedModels };
}

export function providerCompletionUrl(provider) {
  const fallback = PROVIDER_ENDPOINTS[provider?.provider];
  if (!fallback)
    throw Object.assign(new Error("Provider protocol is not enabled"), {
      code: "provider_protocol_unavailable",
    });
  const rawBase =
    typeof provider.baseUrl === "string" && provider.baseUrl.trim()
      ? provider.baseUrl.trim()
      : fallback.baseUrl;
  let base;
  try {
    base = new URL(rawBase);
  } catch {
    throw Object.assign(new Error("Provider endpoint is invalid"), {
      code: "provider_endpoint_unavailable",
    });
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.port ||
    base.search ||
    base.hash ||
    isIP(base.hostname) ||
    !fallback.hosts.includes(base.hostname.toLowerCase())
  ) {
    throw Object.assign(new Error("Provider endpoint is not allowlisted"), {
      code: "provider_endpoint_forbidden",
    });
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/chat/completions`;
  return base;
}

export function safeProviderError(status) {
  // Note: OpenRouter's 402 (out of credits) intentionally falls through to the
  // generic 502 provider_error — the account did not exceed its own quota, so
  // it must not be reported as provider_rate_limited (429) and invite retries.
  if (status === 429)
    return {
      status: 429,
      code: "provider_rate_limited",
      message: "The model provider is rate limiting requests.",
    };
  if (status === 400 || status === 404 || status === 422) {
    return {
      status: 400,
      code: "provider_request_rejected",
      message: "The model provider rejected this request.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      status: 502,
      code: "provider_authentication_failed",
      message: "The managed provider is not available.",
    };
  }
  return {
    status: 502,
    code: "provider_error",
    message: "The managed provider could not complete this request.",
  };
}

export function normalizeUsage(value) {
  const safe = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
  const promptTokens = safe(value?.prompt_tokens ?? value?.input_tokens);
  const completionTokens = safe(value?.completion_tokens ?? value?.output_tokens);
  const totalTokens = safe(value?.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}
