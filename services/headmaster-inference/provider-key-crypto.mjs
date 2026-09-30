import { createCipheriv, createDecipheriv, hkdfSync, randomBytes as nodeRandomBytes } from 'node:crypto'

// Shared by services/admission (webapp repo) and services/headmaster-inference
// (Nora repo). Keep the two copies byte-identical.
const INFO = 'headmaster-user-provider-key-v1'
const OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROVIDER = /^[a-z][a-z0-9_-]{1,31}$/

function fail(code) {
  return Object.assign(new Error(code), { code })
}

function derive(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw fail('provider_key_secret_invalid')
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), INFO, 32))
}

function aad(ownerId, provider) {
  if (typeof ownerId !== 'string' || !OWNER.test(ownerId) || typeof provider !== 'string' || !PROVIDER.test(provider)) {
    throw fail('provider_key_scope_invalid')
  }
  return Buffer.from(`${ownerId.toLowerCase()}:${provider}`)
}

export function encryptProviderKey({ secret, ownerId, provider, apiKey, randomBytes = nodeRandomBytes }) {
  if (typeof apiKey !== 'string' || !apiKey) throw fail('provider_key_invalid')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv)
  cipher.setAAD(aad(ownerId, provider))
  const body = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
}

export function decryptProviderKey({ secret, ownerId, provider, ciphertext }) {
  try {
    const parts = typeof ciphertext === 'string' ? ciphertext.split('.') : []
    if (parts.length !== 4 || parts[0] !== 'v1') throw fail('provider_key_undecryptable')
    const [, iv, tag, body] = parts.map((part, index) => (index === 0 ? part : Buffer.from(part, 'base64url')))
    if (iv.length !== 12 || tag.length !== 16) throw fail('provider_key_undecryptable')
    const decipher = createDecipheriv('aes-256-gcm', derive(secret), iv)
    decipher.setAAD(aad(ownerId, provider))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch (error) {
    if (error?.code === 'provider_key_secret_invalid' || error?.code === 'provider_key_scope_invalid') throw error
    throw fail('provider_key_undecryptable')
  }
}
