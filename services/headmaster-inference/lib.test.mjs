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
import { createMemoryQuotaStore } from './quota.mjs'
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
