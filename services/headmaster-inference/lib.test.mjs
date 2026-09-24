import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  ASSERTION_AUDIENCE,
  createReplayCache,
  createRedisReplayStore,
  sha256,
  signAssertion,
  verifyAssertion,
} from './assertion.mjs'
import { createInferenceService } from './lib.mjs'
import { createMemoryQuotaStore, createRedisQuotaStore } from './quota.mjs'
import { parseAccountProviderMap, providerCompletionUrl } from './policy.mjs'

const SECRET = 's'.repeat(48)
const OWNER_A = '11111111-1111-4111-8111-111111111111'
const OWNER_B = '22222222-2222-4222-8222-222222222222'
const NORA_USER_A = '33333333-3333-4333-8333-333333333333'
const PROVIDER_A = '44444444-4444-4444-8444-444444444444'
const NOW = 1_800_000_000_000

function makeToken({ method, path, body = Buffer.alloc(0), owner = OWNER_A, revision = '7' }) {
  const iat = Math.floor(NOW / 1000)
  return signAssertion({
    v: 1,
    aud: ASSERTION_AUDIENCE,
    sub: owner,
    authorization_revision: revision,
    method,
    path,
    body_sha256: sha256(body),
    request_id: randomUUID(),
    nonce: randomBytes(16).toString('base64url'),
    iat,
    exp: iat + 20,
  }, SECRET)
}

function policyMap(owner = OWNER_A, provider = 'openai', providerId = PROVIDER_A) {
  return new Map([[owner, { noraUserId: NORA_USER_A, providerId, provider, models: ['gpt-5.5'] }]])
}

function provider() {
  return {
    id: PROVIDER_A,
    provider: 'openai',
    apiKey: 'provider-key-never-return-this',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.5', 'gpt-5.5-pro'],
  }
}

async function startService(t, overrides = {}) {
  const quota = overrides.quotaStore || createMemoryQuotaStore({ now: () => NOW })
  const service = createInferenceService({
    assertionSecret: SECRET,
    accountProviderMap: policyMap(),
    resolveProvider: async () => provider(),
    quotaStore: quota,
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  })
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  const origin = `http://127.0.0.1:${service.server.address().port}`
  t.after(() => new Promise(resolve => service.server.close(resolve)))
  return { ...service, origin, quota }
}

async function getModels(origin, token) {
  return fetch(`${origin}/v1/models`, { headers: { 'x-headmaster-inference-assertion': token } })
}

async function postCompletion(origin, body, token, signal) {
  return fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-headmaster-inference-assertion': token },
    body,
    signal,
  })
}

// Real Redis coverage: skipped unless REDIS_URL points at a running server.
async function openRedisQuota(t, options = {}) {
  const url = process.env.REDIS_URL
  if (!url) return null
  const { default: Redis } = await import('ioredis')
  const redis = new Redis(url, { maxRetriesPerRequest: 1 })
  t.after(() => redis.quit())
  const prefix = 'headmaster-inference-test'
  const ownerId = randomUUID()
  return {
    redis,
    ownerId,
    key: suffix => `${prefix}:${ownerId}:${suffix}`,
    quota: createRedisQuotaStore(redis, { prefix, ...options }),
  }
}

test('assertions bind audience, owner, revision, method, exact path, body and short expiry', () => {
  const payload = Buffer.from('{"model":"gpt-5.5"}')
  const token = makeToken({ method: 'POST', path: '/v1/chat/completions', body: payload })
  const claims = verifyAssertion(token, {
    secret: SECRET, method: 'POST', path: '/v1/chat/completions', body: payload, now: () => NOW,
  })
  assert.equal(claims.sub, OWNER_A)
  assert.equal(claims.authorization_revision, '7')
  assert.equal(verifyAssertion(token, {
    secret: SECRET, method: 'GET', path: '/v1/chat/completions', body: payload, now: () => NOW,
  }), null)
  assert.equal(verifyAssertion(token, {
    secret: SECRET, method: 'POST', path: '/v1/chat/completions', body: Buffer.from('{}'), now: () => NOW,
  }), null)
  assert.equal(verifyAssertion(token, {
    secret: 'x'.repeat(48), method: 'POST', path: '/v1/chat/completions', body: payload, now: () => NOW,
  }), null)
  assert.equal(verifyAssertion(token, {
    secret: SECRET, method: 'POST', path: '/v1/chat/completions', body: payload, now: () => NOW + 21_000,
  }), null)

  const replay = createReplayCache({ now: () => NOW })
  assert.equal(replay.claim(claims.nonce, claims.exp), true)
  assert.equal(replay.claim(claims.nonce, claims.exp), false)
})

test('trusted account map validates identities and narrows model access', () => {
  const map = parseAccountProviderMap(JSON.stringify({
    [OWNER_A]: { noraUserId: NORA_USER_A, providerId: PROVIDER_A, provider: 'openai', models: ['gpt-5.5'] },
  }))
  assert.deepEqual(map.get(OWNER_A), {
    noraUserId: NORA_USER_A, providerId: PROVIDER_A, provider: 'openai', models: ['gpt-5.5'],
  })
  assert.throws(() => parseAccountProviderMap(JSON.stringify({
    [OWNER_A]: { noraUserId: NORA_USER_A, providerId: PROVIDER_A, provider: 'openai', models: ['claude-sonnet-4-5'] },
  })))
  assert.throws(() => parseAccountProviderMap(JSON.stringify({
    [OWNER_A]: { noraUserId: NORA_USER_A, providerId: PROVIDER_A, provider: 'openai', extra: 'client-controlled' },
  })))
  const ownerWithLetters = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  assert.throws(() => parseAccountProviderMap(JSON.stringify({
    [ownerWithLetters]: { noraUserId: NORA_USER_A, providerId: PROVIDER_A, provider: 'openai' },
    [ownerWithLetters.toUpperCase()]: { noraUserId: NORA_USER_A, providerId: PROVIDER_A, provider: 'openai' },
  })))
  assert.throws(() => parseAccountProviderMap(JSON.stringify({
    [OWNER_A]: { noraUserId: NORA_USER_A, providerId: 'not-a-uuid', provider: 'openai' },
  })))
  assert.throws(() => providerCompletionUrl({ provider: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' }))
  assert.throws(() => providerCompletionUrl({ provider: 'openai', baseUrl: 'https://api.openai.com:8443/v1' }))
  assert.throws(() => providerCompletionUrl({ provider: 'openai', baseUrl: 'https://evil.example/v1' }))
})

test('models are owner-scoped and chat streams tool-call frames and usage unchanged', async t => {
  const upstreamCalls = []
  const encoder = new TextEncoder()
  const upstreamFrames = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":2,"total_tokens":15}}\n\n',
    'data: [DONE]\n\n',
  ]
  const fetchImpl = async (url, options) => {
    upstreamCalls.push({ url: String(url), options, parsed: JSON.parse(options.body) })
    return new Response(new ReadableStream({
      start(controller) { for (const frame of upstreamFrames) controller.enqueue(encoder.encode(frame)); controller.close() },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const f = await startService(t, { fetchImpl })

  const modelsToken = makeToken({ method: 'GET', path: '/v1/models' })
  const modelsResponse = await getModels(f.origin, modelsToken)
  assert.equal(modelsResponse.status, 200)
  const models = await modelsResponse.json()
  assert.deepEqual(models.data.map(row => row.id), ['gpt-5.5'])
  assert.equal(JSON.stringify(models).includes(PROVIDER_A), false)
  assert.equal(JSON.stringify(models).includes('provider-key-never-return-this'), false)

  const request = {
    model: 'gpt-5.5',
    stream: true,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'inspect this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ] }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    reasoning_effort: 'medium',
    stream_options: { include_usage: true },
  }
  const body = Buffer.from(JSON.stringify(request))
  const token = makeToken({ method: 'POST', path: '/v1/chat/completions', body })
  const response = await postCompletion(f.origin, body, token)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const raw = await response.text()
  assert.equal(raw, upstreamFrames.join(''))
  assert.equal(upstreamCalls.length, 1)
  assert.equal(upstreamCalls[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(upstreamCalls[0].options.headers.authorization, 'Bearer provider-key-never-return-this')
  assert.deepEqual(upstreamCalls[0].parsed.messages, request.messages)
  assert.deepEqual(upstreamCalls[0].parsed.tools, request.tools)
  assert.equal(upstreamCalls[0].parsed.reasoning_effort, 'medium')
  assert.deepEqual(upstreamCalls[0].parsed.stream_options, { include_usage: true })
  assert.equal(upstreamCalls[0].parsed.max_completion_tokens, 1024)
  assert.equal(f.quota.inspect(OWNER_A).used, 2)
  assert.equal(f.quota.inspect(OWNER_A).usage.promptTokens, 13)
})

test('assertion replay, request-selected provider and unlisted models fail closed', async t => {
  const fetchCalls = []
  const f = await startService(t, { fetchImpl: async () => { fetchCalls.push(1); return new Response('{}') } })
  const token = makeToken({ method: 'GET', path: '/v1/models' })
  assert.equal((await getModels(f.origin, token)).status, 200)
  const replay = await getModels(f.origin, token)
  assert.equal(replay.status, 401)
  assert.equal((await replay.json()).error.code, 'assertion_replayed')

  const bodyWithProvider = Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }], provider_id: PROVIDER_A }))
  const providerToken = makeToken({ method: 'POST', path: '/v1/chat/completions', body: bodyWithProvider })
  const providerResponse = await postCompletion(f.origin, bodyWithProvider, providerToken)
  assert.equal(providerResponse.status, 400)
  assert.equal((await providerResponse.json()).error.code, 'client_authority_field_forbidden')

  const unsupported = Buffer.from(JSON.stringify({ model: 'not-allowlisted', messages: [{ role: 'user', content: 'x' }] }))
  const unsupportedToken = makeToken({ method: 'POST', path: '/v1/chat/completions', body: unsupported })
  const unsupportedResponse = await postCompletion(f.origin, unsupported, unsupportedToken)
  assert.equal(unsupportedResponse.status, 400)
  assert.equal((await unsupportedResponse.json()).error.code, 'model_not_allowed')
  assert.deepEqual(fetchCalls, [])
})

test('replay-store outage fails closed as a temporary service error', async t => {
  const fetchCalls = []
  const f = await startService(t, {
    replayStore: { claim: async () => { throw Object.assign(new Error('redis offline'), { code: 'ECONNREFUSED' }) } },
    fetchImpl: async () => { fetchCalls.push(1); return new Response('{}') },
  })
  const response = await getModels(f.origin, makeToken({ method: 'GET', path: '/v1/models' }))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'replay_store_unavailable')
  assert.equal(f.server.requestTimeout, 120_000)
  assert.deepEqual(fetchCalls, [])
})

test('provider rate limits expose a safe retry-after without leaking the provider body', async t => {
  const f = await startService(t, {
    fetchImpl: async () => new Response('private upstream diagnostic', {
      status: 429,
      headers: { 'retry-after': '9', 'content-type': 'text/plain' },
    }),
  })
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'wait' }] }))
  const token = makeToken({ method: 'POST', path: '/v1/chat/completions', body })
  const response = await postCompletion(f.origin, body, token)
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '9')
  const result = await response.text()
  assert.equal(result.includes('private upstream diagnostic'), false)
  assert.equal(JSON.parse(result).error.code, 'provider_rate_limited')
})

test('Redis replay store atomically consumes a nonce once across relay instances', async () => {
  const seen = new Set()
  const calls = []
  const redis = {
    async set(...args) {
      calls.push(args)
      if (seen.has(args[0])) return null
      seen.add(args[0])
      return 'OK'
    },
  }
  const replay = createRedisReplayStore(redis, { now: () => NOW })
  const nonce = randomBytes(18).toString('base64url')
  const exp = Math.floor(NOW / 1000) + 20
  assert.equal(await replay.claim(nonce, exp), true)
  assert.equal(await replay.claim(nonce, exp), false)
  assert.deepEqual(calls[0], [`headmaster-inference:replay:${nonce}`, '1', 'EX', 20, 'NX'])
})

test('quota reservations isolate accounts and enforce concurrency and daily output budget', async () => {
  const quota = createMemoryQuotaStore({ maxConcurrentPerAccount: 1, maxRequestsPerHour: 10, maxCompletionTokensPerDay: 10, now: () => NOW })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'a1', reserveOutputTokens: 8 }), { allowed: true, reason: 'ok', day: Math.floor(NOW / 86_400_000) })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'a2', reserveOutputTokens: 1 }), { allowed: false, reason: 'concurrency' })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_B, requestId: 'b1', reserveOutputTokens: 8 }), { allowed: true, reason: 'ok', day: Math.floor(NOW / 86_400_000) })
  await quota.finish({ ownerId: OWNER_A, requestId: 'a1', promptTokens: 4, completionTokens: 6, totalTokens: 10 })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'a3', reserveOutputTokens: 5 }), { allowed: false, reason: 'token_budget' })
  assert.equal(quota.inspect(OWNER_A).active, 0)
  assert.equal(quota.inspect(OWNER_A).used, 6)
})

test('client abort cancels provider fetch and releases the account reservation', async t => {
  let upstreamSignal
  let resolveCancelled
  const cancelled = new Promise(resolve => { resolveCancelled = resolve })
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const f = await startService(t, {
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      upstreamSignal = options.signal
      startedResolve()
      options.signal.addEventListener('abort', () => {
        resolveCancelled()
        reject(options.signal.reason)
      }, { once: true })
    }),
  })
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'wait' }], max_completion_tokens: 4 }))
  const token = makeToken({ method: 'POST', path: '/v1/chat/completions', body })
  const abort = new AbortController()
  const request = postCompletion(f.origin, body, token, abort.signal).catch(() => null)
  await started
  abort.abort()
  await request
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream cancellation timed out')), 1000))])
  assert.equal(upstreamSignal.aborted, true)
  assert.equal(f.quota.inspect(OWNER_A).active, 0)
})

test('duplicate settlement applies usage once and cannot double-spend the daily budget', async () => {
  const day = Math.floor(NOW / 86_400_000)
  const quota = createMemoryQuotaStore({ maxCompletionTokensPerDay: 100, now: () => NOW })
  const settle = { ownerId: OWNER_A, requestId: 'settle-1', quotaDay: day, promptTokens: 4, completionTokens: 6, totalTokens: 10 }
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'settle-1', reserveOutputTokens: 6 }), { allowed: true, reason: 'ok', day })
  assert.deepEqual(await quota.finish(settle), [6, 6])
  assert.deepEqual(await quota.finish(settle), [0, 0])
  assert.deepEqual(await quota.finish(settle), [0, 0])
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 0, reserved: 0, used: 6,
    usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
  })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'settle-2', reserveOutputTokens: 94 }), { allowed: true, reason: 'ok', day })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'settle-3', reserveOutputTokens: 1 }), { allowed: false, reason: 'token_budget' })
})

test('a settlement without provider usage charges exactly the conservative reservation', async () => {
  const day = Math.floor(NOW / 86_400_000)
  const quota = createMemoryQuotaStore({ maxCompletionTokensPerDay: 100, now: () => NOW })
  const settle = { ownerId: OWNER_A, requestId: 'stream-1', quotaDay: day, promptTokens: 0, completionTokens: 40, totalTokens: 40 }
  await quota.acquire({ ownerId: OWNER_A, requestId: 'stream-1', reserveOutputTokens: 40 })
  assert.deepEqual(await quota.finish(settle), [40, 40])
  assert.deepEqual(await quota.finish(settle), [0, 0])
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 0, reserved: 0, used: 40,
    usage: { promptTokens: 0, completionTokens: 40, totalTokens: 40 },
  })
})

test('concurrency survives a midnight boundary and a cross-midnight settlement releases the acquire-day reservation', async () => {
  const boundary = 20_000 * 86_400_000
  let clock = boundary - 60_000
  const quota = createMemoryQuotaStore({ maxConcurrentPerAccount: 1, maxCompletionTokensPerDay: 100, now: () => clock })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'pre-midnight', reserveOutputTokens: 80 }), { allowed: true, reason: 'ok', day: 19_999 })
  clock = boundary + 60_000
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'post-midnight', reserveOutputTokens: 5 }), { allowed: false, reason: 'concurrency' })
  assert.deepEqual(await quota.finish({ ownerId: OWNER_A, requestId: 'pre-midnight', quotaDay: 19_999, promptTokens: 1, completionTokens: 4, totalTokens: 5 }), [80, 4])
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 0, reserved: 0, used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'post-midnight', reserveOutputTokens: 5 }), { allowed: true, reason: 'ok', day: 20_000 })
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 1, reserved: 5, used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })
})

test('a crashed request is reclaimed after the active timeout without exhausting the budget', async () => {
  const day = Math.floor(NOW / 86_400_000)
  let clock = NOW
  const quota = createMemoryQuotaStore({ maxConcurrentPerAccount: 2, maxCompletionTokensPerDay: 100, now: () => clock })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'crashed', reserveOutputTokens: 80 }), { allowed: true, reason: 'ok', day })
  clock = NOW + 16 * 60_000
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'after-crash', reserveOutputTokens: 80 }), { allowed: true, reason: 'ok', day })
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 1, reserved: 80, used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'over-budget', reserveOutputTokens: 21 }), { allowed: false, reason: 'token_budget' })
})

test('a crashed request cannot let a new day exceed the daily token budget', async () => {
  const boundary = 21_000 * 86_400_000
  let clock = boundary - 30_000
  const quota = createMemoryQuotaStore({ maxCompletionTokensPerDay: 100, now: () => clock })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'crashed', reserveOutputTokens: 100 }), { allowed: true, reason: 'ok', day: 20_999 })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'same-day-over', reserveOutputTokens: 1 }), { allowed: false, reason: 'token_budget' })
  clock = boundary + 30_000
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'new-day', reserveOutputTokens: 100 }), { allowed: true, reason: 'ok', day: 21_000 })
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'new-day-over', reserveOutputTokens: 1 }), { allowed: false, reason: 'token_budget' })
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 2, reserved: 100, used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })
  clock = boundary + 900_000
  assert.deepEqual(await quota.acquire({ ownerId: OWNER_A, requestId: 'reclaim', reserveOutputTokens: 1 }), { allowed: false, reason: 'token_budget' })
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 1, reserved: 100, used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })
})

test('Redis quota store settles distinct prompt/completion/total values exactly once', async t => {
  const f = await openRedisQuota(t, { maxCompletionTokensPerDay: 100, now: () => NOW })
  if (!f) return t.skip('REDIS_URL is not set')
  const { redis, ownerId, key, quota } = f
  const day = Math.floor(NOW / 86_400_000)
  const settle = { ownerId, requestId: 'redis-1', quotaDay: day, promptTokens: 11, completionTokens: 22, totalTokens: 33 }
  assert.deepEqual(await quota.acquire({ ownerId, requestId: 'redis-1', reserveOutputTokens: 33 }), { allowed: true, reason: 'ok', day })
  assert.deepEqual(await quota.finish(settle), [33, 22])
  assert.deepEqual(await redis.hgetall(key(`usage:${day}`)), { prompt_tokens: '11', completion_tokens: '22', total_tokens: '33' })
  assert.equal(await redis.get(key(`output:${day}`)), '22')
  assert.equal(await redis.get(key(`reserved:${day}`)), '0')
  assert.equal(await redis.zcard(key('active')), 0)
  assert.deepEqual(await quota.finish(settle), [0, 0])
  assert.deepEqual(await redis.hgetall(key(`usage:${day}`)), { prompt_tokens: '11', completion_tokens: '22', total_tokens: '33' })
  assert.equal(await redis.get(key(`output:${day}`)), '22')
  const remaining = await quota.acquire({ ownerId, requestId: 'redis-2', reserveOutputTokens: 78 })
  assert.equal(remaining.allowed, true)
  assert.equal(remaining.reason, 'ok')
  const over = await quota.acquire({ ownerId, requestId: 'redis-3', reserveOutputTokens: 1 })
  assert.equal(over.allowed, false)
  assert.equal(over.reason, 'token_budget')
})

test('Redis quota store keeps concurrency across midnight, releases cross-midnight and reclaims crashed reservations', async t => {
  const boundary = 22_000 * 86_400_000
  let clock = boundary - 60_000
  const f = await openRedisQuota(t, { maxConcurrentPerAccount: 1, maxCompletionTokensPerDay: 100, activeTimeoutMs: 5 * 60_000, now: () => clock })
  if (!f) return t.skip('REDIS_URL is not set')
  const { redis, ownerId, key, quota } = f

  const pre = await quota.acquire({ ownerId, requestId: 'pre-midnight', reserveOutputTokens: 80 })
  assert.equal(pre.allowed, true)
  assert.equal(pre.day, 21_999)
  assert.equal(await redis.zcard(key('active')), 1)

  clock = boundary + 60_000
  const blocked = await quota.acquire({ ownerId, requestId: 'post-midnight', reserveOutputTokens: 5 })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'concurrency')

  assert.deepEqual(await quota.finish({ ownerId, requestId: 'pre-midnight', quotaDay: 21_999, promptTokens: 1, completionTokens: 4, totalTokens: 5 }), [80, 4])
  assert.equal(await redis.zcard(key('active')), 0)
  assert.equal(await redis.get(key('reserved:21999')), '0')
  assert.deepEqual(await redis.hgetall(key('usage:21999')), { prompt_tokens: '1', completion_tokens: '4', total_tokens: '5' })
  assert.equal(await redis.get(key('output:22000')), null)

  const post = await quota.acquire({ ownerId, requestId: 'post-midnight', reserveOutputTokens: 5 })
  assert.equal(post.allowed, true)
  assert.equal(post.day, 22_000)
  assert.deepEqual(await quota.finish({ ownerId, requestId: 'post-midnight', quotaDay: 22_000, promptTokens: 0, completionTokens: 5, totalTokens: 5 }), [5, 5])
  assert.equal(await redis.get(key('reserved:22000')), '0')

  clock = boundary + 120_000
  const crashed = await quota.acquire({ ownerId, requestId: 'crashed', reserveOutputTokens: 90 })
  assert.equal(crashed.allowed, true)
  clock = boundary + 120_000 + 330_000
  const recovered = await quota.acquire({ ownerId, requestId: 'recovered', reserveOutputTokens: 90 })
  assert.equal(recovered.allowed, true)
  assert.equal(await redis.zcard(key('active')), 1)
  assert.equal(await redis.get(key('reserved:22000')), '90')
  assert.equal(await redis.hget(key('reservations:22000'), 'crashed'), null)
  assert.equal(await redis.hget(key('reservations:22000'), 'recovered'), '90')
  const blockedAgain = await quota.acquire({ ownerId, requestId: 'recovered-2', reserveOutputTokens: 1 })
  assert.equal(blockedAgain.allowed, false)
  assert.equal(blockedAgain.reason, 'concurrency')
})
