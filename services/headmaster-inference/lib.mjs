import http from 'node:http'
import { createReplayCache, verifyAssertion } from './assertion.mjs'
import {
  allowedModelsForProvider,
  normalizeUsage,
  prepareChatCompletion,
  providerCompletionUrl,
  safeProviderError,
} from './policy.mjs'

export const MAX_REQUEST_BYTES = 36 * 1024 * 1024
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MODEL_PATH = '/v1/models'
const COMPLETION_PATH = '/v1/chat/completions'
const quietLogger = { info() {}, warn() {}, error() {} }

function sendJson(res, status, body, requestId, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
    ...extraHeaders,
    ...(requestId ? { 'x-request-id': requestId } : {}),
  })
  res.end(payload)
}

async function readBody(req, cap) {
  const declared = Number(req.headers['content-length'] || 0)
  if (Number.isFinite(declared) && declared > cap) throw Object.assign(new Error('payload_too_large'), { statusCode: 413 })
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > cap) throw Object.assign(new Error('payload_too_large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeError(res, status, code, message, requestId, extraHeaders = {}) {
  return sendJson(res, status, { error: { message, type: 'inference_error', code }, request_id: requestId }, requestId, extraHeaders)
}

function jsonUsage(buffer) {
  try {
    const usage = JSON.parse(buffer.toString('utf8'))?.usage
    return usage && typeof usage === 'object' ? normalizeUsage(usage) : null
  } catch { return null }
}

function createSseUsageParser() {
  let pending = ''
  let eventData = []
  let usage = null
  const decoder = new TextDecoder()
  const flushEvent = () => {
    if (eventData.length) {
      const data = eventData.join('\n')
      if (data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data)
          if (parsed?.usage && typeof parsed.usage === 'object') usage = normalizeUsage(parsed.usage)
        } catch { /* non-JSON SSE event; forwarded unchanged */ }
      }
    }
    eventData = []
  }
  const consumeLine = line => {
    if (line === '') return flushEvent()
    if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''))
  }
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) consumeLine(line)
      if (pending.length > 1024 * 1024) pending = pending.slice(-1024 * 1024)
    },
    end() {
      pending += decoder.decode()
      if (pending) consumeLine(pending)
      flushEvent()
      return usage
    },
    get usage() { return usage },
  }
}

function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error('aborted'))
    if (res.destroyed || res.writableEnded) return reject(new Error('downstream_closed'))
    const cleanup = () => {
      res.removeListener('drain', onDrain)
      res.removeListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); reject(new Error('downstream_closed')) }
    const onAbort = () => { cleanup(); reject(signal.reason || new Error('aborted')) }
    res.once('drain', onDrain)
    res.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function copyStreamingResponse(response, res, signal, requestId, maxResponseBytes) {
  const contentType = response.headers.get('content-type') || 'text/event-stream; charset=utf-8'
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache, no-store',
    'x-request-id': requestId,
    'x-accel-buffering': 'no',
  })
  const parser = createSseUsageParser()
  let sentBytes = 0
  if (!response.body) {
    res.end()
    return null
  }
  for await (const chunk of response.body) {
    sentBytes += chunk.byteLength
    if (sentBytes > maxResponseBytes) throw Object.assign(new Error('provider_response_too_large'), { code: 'provider_response_too_large' })
    parser.push(chunk)
    if (!res.write(chunk)) await waitForDrain(res, signal)
  }
  if (!res.writableEnded) res.end()
  return parser.end()
}

async function readProviderResponse(response, cap) {
  const chunks = []
  let total = 0
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > cap) throw Object.assign(new Error('provider_response_too_large'), { code: 'provider_response_too_large' })
      chunks.push(Buffer.from(chunk))
    }
  }
  return Buffer.concat(chunks)
}

function modelList(models, requestId) {
  return {
    object: 'list',
    data: models.map(id => ({ id, object: 'model', owned_by: 'headmaster' })),
    request_id: requestId,
  }
}

export function createInferenceService({
  assertionSecret,
  accountProviderMap,
  resolveProvider,
  quotaStore,
  fetchImpl = fetch,
  now = () => Date.now(),
  logger = quietLogger,
  maxRequestBytes = MAX_REQUEST_BYTES,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxCompletionTokens = 4096,
  defaultCompletionTokens = 1024,
  requestTimeoutMs = 120_000,
  replayStore = null,
} = {}) {
  if (typeof assertionSecret !== 'string' || Buffer.byteLength(assertionSecret) < 32) throw new Error('assertion_secret_invalid')
  if (!(accountProviderMap instanceof Map) || typeof resolveProvider !== 'function' || !quotaStore) {
    throw new Error('inference_service_dependencies_invalid')
  }
  const replay = replayStore || createReplayCache({ now })

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://inference.internal')
    if (req.method === 'GET' && url.pathname === '/healthz' && !url.search) {
      return sendJson(res, 200, { data: { ok: true } })
    }
    if (url.search || !((req.method === 'GET' && url.pathname === MODEL_PATH)
      || (req.method === 'POST' && url.pathname === COMPLETION_PATH))) {
      return safeError(res, 404, 'not_found', 'Route not found.', null)
    }
    let body
    try { body = await readBody(req, maxRequestBytes) } catch (error) {
      return safeError(res, error.statusCode === 413 ? 413 : 400,
        error.statusCode === 413 ? 'payload_too_large' : 'body_invalid',
        error.statusCode === 413 ? 'Request body is too large.' : 'Request body could not be read.', null)
    }
    if (req.method === 'GET' && body.length > 0) return safeError(res, 400, 'body_not_allowed', 'GET requests cannot contain a body.', null)

    const claims = verifyAssertion(req.headers['x-headmaster-inference-assertion'], {
      secret: assertionSecret,
      method: req.method,
      path: url.pathname,
      body,
      now,
    })
    if (!claims) return safeError(res, 401, 'assertion_invalid', 'Private inference assertion is invalid.', null)
    let replayClaimed
    try {
      replayClaimed = await replay.claim(claims.nonce, claims.exp)
    } catch (error) {
      logger.warn?.('headmaster-inference replay store unavailable', {
        requestId: claims.request_id,
        code: error?.code || 'replay_store_unavailable',
      })
      return safeError(res, 503, 'replay_store_unavailable', 'Managed inference is temporarily unavailable.', claims.request_id)
    }
    if (!replayClaimed) return safeError(res, 401, 'assertion_replayed', 'Private inference assertion was already used.', claims.request_id)
    const mapping = accountProviderMap.get(claims.sub.toLowerCase())
    if (!mapping) return safeError(res, 503, 'provider_mapping_unavailable', 'Managed inference is not configured for this account.', claims.request_id)

    let provider
    try { provider = await resolveProvider(mapping.noraUserId, mapping.providerId) } catch (error) {
      logger.warn?.('headmaster-inference provider lookup failed', { requestId: claims.request_id, code: error?.code || 'provider_lookup_failed' })
      return safeError(res, 503, 'provider_unavailable', 'Managed inference is not available.', claims.request_id)
    }
    if (!provider || provider.id !== mapping.providerId || provider.provider !== mapping.provider || !provider.apiKey) {
      return safeError(res, 503, 'provider_unavailable', 'Managed inference is not available.', claims.request_id)
    }

    if (req.method === 'GET') {
      const models = allowedModelsForProvider(mapping, provider.models)
      if (models.length === 0) return safeError(res, 503, 'models_unavailable', 'No compatible models are enabled for this account.', claims.request_id)
      return sendJson(res, 200, modelList(models, claims.request_id), claims.request_id)
    }

    let parsed
    try { parsed = JSON.parse(body.toString('utf8')) } catch {
      return safeError(res, 400, 'body_invalid', 'Request body must be valid JSON.', claims.request_id)
    }
    const prepared = prepareChatCompletion(parsed, mapping, provider.models, { maxCompletionTokens, defaultCompletionTokens })
    if (prepared.error) {
      return safeError(res, 400, prepared.error, 'The request is not supported by the managed inference contract.', claims.request_id)
    }

    let target
    try { target = providerCompletionUrl(provider) } catch (error) {
      return safeError(res, 503, error?.code || 'provider_endpoint_unavailable', 'The configured provider endpoint is not supported.', claims.request_id)
    }
    const reservation = await quotaStore.acquire({
      ownerId: claims.sub,
      requestId: claims.request_id,
      reserveOutputTokens: prepared.reserveOutputTokens,
    }).catch(error => {
      logger.error?.('headmaster-inference quota lookup failed', { requestId: claims.request_id, code: error?.code || 'quota_store_unavailable' })
      return null
    })
    if (!reservation) return safeError(res, 503, 'quota_unavailable', 'Managed inference is temporarily unavailable.', claims.request_id)
    if (!reservation.allowed) {
      const code = reservation.reason === 'concurrency'
        ? 'too_many_concurrent_requests'
        : reservation.reason === 'token_budget' ? 'completion_budget_exceeded' : 'request_budget_exceeded'
      return safeError(res, 429, code, 'This account has reached its managed inference limit.', claims.request_id)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('provider_timeout'), { code: 'provider_timeout' })), requestTimeoutMs)
    timeout.unref?.()
    const onAborted = () => controller.abort(new Error('client_cancelled'))
    const onClose = () => { if (!res.writableFinished) controller.abort(new Error('client_cancelled')) }
    const onSocketClose = () => { if (!res.writableFinished) controller.abort(new Error('client_cancelled')) }
    req.once('aborted', onAborted)
    req.socket?.once('close', onSocketClose)
    res.once('close', onClose)

    let providerSucceeded = false
    let observedUsage = null
    try {
      const upstream = await fetchImpl(target, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json',
          accept: prepared.body.stream === true ? 'text/event-stream' : 'application/json',
          'x-request-id': claims.request_id,
        },
        body: JSON.stringify(prepared.body),
      })
      if (!upstream.ok) {
        const failure = safeProviderError(upstream.status)
        await upstream.body?.cancel().catch(() => {})
        const retryAfter = upstream.headers.get('retry-after')
        const retryHeaders = retryAfter && /^\d{1,6}$/.test(retryAfter) ? { 'retry-after': retryAfter } : {}
        return safeError(res, failure.status, failure.code, failure.message, claims.request_id, retryHeaders)
      }
      providerSucceeded = true
      if (prepared.body.stream === true) {
        observedUsage = await copyStreamingResponse(upstream, res, controller.signal, claims.request_id, maxResponseBytes)
      } else {
        const responseBody = await readProviderResponse(upstream, maxResponseBytes)
        observedUsage = jsonUsage(responseBody)
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-request-id': claims.request_id,
        })
        res.end(responseBody)
      }
      const loggedUsage = observedUsage || { promptTokens: 0, completionTokens: prepared.reserveOutputTokens }
      logger.info?.('headmaster-inference completed', {
        requestId: claims.request_id,
        model: parsed.model,
        inputTokens: loggedUsage.promptTokens,
        outputTokens: loggedUsage.completionTokens,
      })
    } catch (error) {
      const disconnected = controller.signal.aborted && controller.signal.reason?.message === 'client_cancelled'
      if (disconnected) {
        logger.info?.('headmaster-inference cancelled', { requestId: claims.request_id, model: parsed.model })
      } else if (res.headersSent) {
        res.destroy()
      } else if (controller.signal.aborted || error?.code === 'provider_timeout') {
        safeError(res, 504, 'provider_timeout', 'The model provider timed out.', claims.request_id)
      } else if (error?.code === 'provider_response_too_large') {
        safeError(res, 502, 'provider_response_too_large', 'The model provider returned an oversized response.', claims.request_id)
      } else {
        logger.warn?.('headmaster-inference provider request failed', { requestId: claims.request_id, code: error?.code || 'provider_unavailable' })
        safeError(res, 503, 'provider_unavailable', 'The model provider is temporarily unavailable.', claims.request_id)
      }
    } finally {
      clearTimeout(timeout)
      req.removeListener('aborted', onAborted)
      req.socket?.removeListener('close', onSocketClose)
      res.removeListener('close', onClose)
      const usage = observedUsage || (providerSucceeded
        ? { promptTokens: 0, completionTokens: prepared.reserveOutputTokens, totalTokens: prepared.reserveOutputTokens }
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
      await quotaStore.finish({
        ownerId: claims.sub,
        requestId: claims.request_id,
        quotaDay: reservation.day,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      }).catch(error => logger.error?.('headmaster-inference usage accounting failed', {
        requestId: claims.request_id,
        code: error?.code || 'quota_store_unavailable',
      }))
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      logger.error?.('headmaster-inference request failed', { code: error?.code || 'request_failed' })
      if (!res.headersSent) safeError(res, 500, 'inference_error', 'Managed inference failed.', null)
      else res.destroy()
    })
  })
  // Bound the time spent receiving request headers/body before handle() can
  // start the provider timeout. This also protects the relay from slow uploads.
  server.requestTimeout = 120_000
  return { server, handle, replay }
}
