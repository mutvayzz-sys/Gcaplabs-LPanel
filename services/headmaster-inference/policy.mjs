import { isIP } from 'node:net'

export const OWNER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Only model/provider combinations explicitly covered by the OpenAI-compatible
// relay contract are exposed. Intersect this list with Nora's existing
// encrypted-provider catalog metadata before returning it to a client.
export const TESTED_MODELS = Object.freeze({
  openai: ['gpt-5.5', 'gpt-5.5-pro'],
  groq: ['llama-3.3-70b-versatile'],
  mistral: ['mistral-large-latest'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  xai: ['grok-4', 'grok-4-0709', 'grok-3', 'grok-3-fast'],
  moonshot: ['kimi-k2.5'],
  zai: ['glm-5'],
  nvidia: [
    'nvidia/moonshotai/kimi-k2.5',
    'nvidia/minimaxai/minimax-m2.5',
    'nvidia/z-ai/glm5',
  ],
})

const PROVIDER_ENDPOINTS = Object.freeze({
  openai: { baseUrl: 'https://api.openai.com/v1', hosts: ['api.openai.com'] },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', hosts: ['api.groq.com'] },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', hosts: ['api.mistral.ai'] },
  deepseek: { baseUrl: 'https://api.deepseek.com', hosts: ['api.deepseek.com'] },
  xai: { baseUrl: 'https://api.x.ai/v1', hosts: ['api.x.ai'] },
  moonshot: { baseUrl: 'https://api.moonshot.ai/v1', hosts: ['api.moonshot.ai'] },
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', hosts: ['api.z.ai'] },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', hosts: ['integrate.api.nvidia.com'] },
})

const CLIENT_AUTHORITY_FIELDS = new Set([
  'account_id', 'owner_id', 'user_id', 'nora_user_id', 'provider', 'provider_id', 'nora_provider_id',
])

export function parseAccountProviderMap(raw) {
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    throw new Error('HEADMASTER_INFERENCE_ACCOUNT_MAP is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HEADMASTER_INFERENCE_ACCOUNT_MAP must be an object')
  }
  const out = new Map()
  for (const [ownerId, value] of Object.entries(parsed)) {
    if (!OWNER_UUID.test(ownerId) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('HEADMASTER_INFERENCE_ACCOUNT_MAP has an invalid account entry')
    }
    const noraUserId = value.noraUserId
    const providerId = value.providerId
    const provider = value.provider
    if (!OWNER_UUID.test(String(noraUserId || '')) || !OWNER_UUID.test(String(providerId || ''))
      || !Object.hasOwn(TESTED_MODELS, provider)) {
      throw new Error('HEADMASTER_INFERENCE_ACCOUNT_MAP entry has invalid trusted provider identity')
    }
    let models
    if (value.models !== undefined) {
      if (!Array.isArray(value.models) || value.models.length === 0
        || value.models.some(model => typeof model !== 'string' || !TESTED_MODELS[provider].includes(model))) {
        throw new Error('HEADMASTER_INFERENCE_ACCOUNT_MAP entry has an invalid model allowlist')
      }
      models = [...new Set(value.models)]
    }
    const normalizedOwnerId = ownerId.toLowerCase()
    if (out.has(normalizedOwnerId)) throw new Error('HEADMASTER_INFERENCE_ACCOUNT_MAP has duplicate account ids')
    if (Object.keys(value).some(key => !['noraUserId', 'providerId', 'provider', 'models'].includes(key))) {
      throw new Error('HEADMASTER_INFERENCE_ACCOUNT_MAP entry has unknown fields')
    }
    out.set(normalizedOwnerId, Object.freeze({
      noraUserId: noraUserId.toLowerCase(),
      providerId: providerId.toLowerCase(),
      provider,
      ...(models ? { models: Object.freeze(models) } : {}),
    }))
  }
  if (out.size === 0) throw new Error('HEADMASTER_INFERENCE_ACCOUNT_MAP must contain at least one account')
  return out
}

export function allowedModelsForProvider(mapping, providerMetadataModels = []) {
  if (!mapping || !Object.hasOwn(TESTED_MODELS, mapping.provider)) return []
  const tested = new Set(TESTED_MODELS[mapping.provider])
  const metadata = new Set(Array.isArray(providerMetadataModels) ? providerMetadataModels : [])
  const configured = mapping.models ? new Set(mapping.models) : null
  return [...tested].filter(model => metadata.has(model) && (!configured || configured.has(model)))
}

export function prepareChatCompletion(body, mapping, providerMetadataModels, limits = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body_invalid' }
  if (Object.keys(body).some(key => CLIENT_AUTHORITY_FIELDS.has(key.toLowerCase()))) {
    return { error: 'client_authority_field_forbidden' }
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { error: 'messages_required' }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return { error: 'stream_invalid' }
  if (typeof body.model !== 'string' || !body.model) return { error: 'model_required' }
  const allowedModels = allowedModelsForProvider(mapping, providerMetadataModels)
  if (!allowedModels.includes(body.model)) return { error: 'model_not_allowed' }

  const maxCompletionTokens = Number.isSafeInteger(limits.maxCompletionTokens) && limits.maxCompletionTokens > 0
    ? limits.maxCompletionTokens : 4096
  const defaultCompletionTokens = Number.isSafeInteger(limits.defaultCompletionTokens) && limits.defaultCompletionTokens > 0
    ? Math.min(limits.defaultCompletionTokens, maxCompletionTokens) : Math.min(1024, maxCompletionTokens)
  const request = { ...body }
  const supplied = ['max_completion_tokens', 'max_tokens']
    .filter(field => body[field] !== undefined)
    .map(field => body[field])
  if (supplied.some(value => !Number.isSafeInteger(value) || value < 1 || value > maxCompletionTokens)) {
    return { error: 'completion_token_limit_invalid' }
  }
  if (supplied.length === 0) {
    request[mapping.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = defaultCompletionTokens
  }
  const reserveOutputTokens = supplied.length ? Math.min(...supplied) : defaultCompletionTokens
  return { body: request, reserveOutputTokens, allowedModels }
}

export function providerCompletionUrl(provider) {
  const fallback = PROVIDER_ENDPOINTS[provider?.provider]
  if (!fallback) throw Object.assign(new Error('Provider protocol is not enabled'), { code: 'provider_protocol_unavailable' })
  const rawBase = typeof provider.baseUrl === 'string' && provider.baseUrl.trim()
    ? provider.baseUrl.trim()
    : fallback.baseUrl
  let base
  try { base = new URL(rawBase) } catch {
    throw Object.assign(new Error('Provider endpoint is invalid'), { code: 'provider_endpoint_unavailable' })
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.port || base.search || base.hash
    || isIP(base.hostname) || !fallback.hosts.includes(base.hostname.toLowerCase())) {
    throw Object.assign(new Error('Provider endpoint is not allowlisted'), { code: 'provider_endpoint_forbidden' })
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/chat/completions`
  return base
}

export function safeProviderError(status) {
  if (status === 429) return { status: 429, code: 'provider_rate_limited', message: 'The model provider is rate limiting requests.' }
  if (status === 400 || status === 404 || status === 422) {
    return { status: 400, code: 'provider_request_rejected', message: 'The model provider rejected this request.' }
  }
  if (status === 401 || status === 403) {
    return { status: 502, code: 'provider_authentication_failed', message: 'The managed provider is not available.' }
  }
  return { status: 502, code: 'provider_error', message: 'The managed provider could not complete this request.' }
}

export function normalizeUsage(value) {
  const safe = n => Number.isSafeInteger(n) && n >= 0 ? n : 0
  const promptTokens = safe(value?.prompt_tokens ?? value?.input_tokens)
  const completionTokens = safe(value?.completion_tokens ?? value?.output_tokens)
  const totalTokens = safe(value?.total_tokens) || promptTokens + completionTokens
  return { promptTokens, completionTokens, totalTokens }
}
