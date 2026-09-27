import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { OWNER_UUID } from './policy.mjs'

export const ASSERTION_AUDIENCE = 'headmaster-inference'
export const ASSERTION_TTL_SECONDS = 20
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NONCE = /^[A-Za-z0-9_-]{20,64}$/

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function signAssertion(claims, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('assertion_secret_invalid')
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

export function createReplayCache({ now = () => Date.now(), maxEntries = 100_000 } = {}) {
  const used = new Map()
  return {
    claim(nonce, expiresAtSeconds) {
      const nowSeconds = Math.floor(now() / 1000)
      for (const [key, exp] of used) if (exp <= nowSeconds) used.delete(key)
      if (used.has(nonce) || used.size >= maxEntries) return false
      used.set(nonce, expiresAtSeconds)
      return true
    },
    get size() { return used.size },
  }
}

export function createRedisReplayStore(redis, { prefix = 'headmaster-inference', now = () => Date.now() } = {}) {
  if (!redis || typeof redis.set !== 'function') throw new Error('replay_store_invalid')
  return {
    async claim(nonce, expiresAtSeconds) {
      if (typeof nonce !== 'string' || !NONCE.test(nonce) || !Number.isSafeInteger(expiresAtSeconds)) return false
      const ttlSeconds = Math.max(1, expiresAtSeconds - Math.floor(now() / 1000))
      const result = await redis.set(`${prefix}:replay:${nonce}`, '1', 'EX', ttlSeconds, 'NX')
      return result === 'OK'
    },
  }
}

export function verifyAssertion(token, { secret, method, path, body, now = () => Date.now() } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2 || parts.some(part => !part)) return null
  const [encoded, suppliedSignature] = parts
  const expected = createHmac('sha256', secret).update(encoded).digest()
  let received
  try { received = Buffer.from(suppliedSignature, 'base64url') } catch { return null }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null

  let claims
  try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { return null }
  const nowSeconds = Math.floor(now() / 1000)
  if (!claims || claims.v !== 1 || claims.aud !== ASSERTION_AUDIENCE
    || !OWNER_UUID.test(String(claims.sub || ''))
    || !/^\d{1,20}$/.test(String(claims.authorization_revision ?? ''))
    || !REQUEST_ID.test(String(claims.request_id || '')) || !NONCE.test(String(claims.nonce || ''))
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
    || claims.iat > nowSeconds + 5 || claims.exp <= nowSeconds
    || claims.exp <= claims.iat || claims.exp - claims.iat > 30
    || claims.method !== String(method || '').toUpperCase()
    || claims.path !== path
    || claims.body_sha256 !== sha256(body || Buffer.alloc(0))) return null
  return claims
}
