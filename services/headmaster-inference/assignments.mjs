// Durable assignment resolution for the Headmaster managed-inference relay.
//
// Assignments live in Headmaster Supabase (public.headmaster_inference_assignments,
// reference-only: identifiers, never provider secrets) and are read over
// PostgREST with a server-only credential. Absence of a row denies access and
// no lookup failure may ever be replaced by cached or stale data: failures are
// neither cached nor served past the configured TTL.
import { OWNER_UUID, parseAccountProviderMap } from './policy.mjs'

export const DEFAULT_ASSIGNMENT_TTL_MS = 30_000
export const ASSIGNMENT_TTL_MIN_MS = 1_000
export const ASSIGNMENT_TTL_MAX_MS = 300_000
export const DEFAULT_ASSIGNMENT_TIMEOUT_MS = 10_000
export const ASSIGNMENT_SELECT = 'owner_id,nora_user_id,provider_id,enabled,revision'
const ASSIGNMENT_PATH = '/rest/v1/headmaster_inference_assignments'
const quietLogger = { info() {}, warn() {}, error() {} }

function assignmentError(message, code) {
  return Object.assign(new Error(message), { code })
}

export function clampAssignmentTtl(raw, fallback = DEFAULT_ASSIGNMENT_TTL_MS) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(Math.max(parsed, ASSIGNMENT_TTL_MIN_MS), ASSIGNMENT_TTL_MAX_MS)
}

// Mirror the Hindsight tenant extension's validation: require an https origin
// with no embedded credentials, path, query, or fragment.
export function validateSupabaseOrigin(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  let url
  try { url = new URL(value) } catch { throw assignmentError('headmaster Supabase URL is invalid', 'assignment_config_invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw assignmentError('headmaster Supabase URL must be a bare https origin', 'assignment_config_invalid')
  }
  return url.origin
}

function normalizeAssignmentRow(row, ownerId) {
  const rowOwnerId = String(row?.owner_id ?? '').toLowerCase()
  const noraUserId = String(row?.nora_user_id ?? '').toLowerCase()
  const providerId = String(row?.provider_id ?? '').toLowerCase()
  if (!OWNER_UUID.test(rowOwnerId) || rowOwnerId !== ownerId
    || !OWNER_UUID.test(noraUserId) || !OWNER_UUID.test(providerId)
    || typeof row?.enabled !== 'boolean'
    || typeof row?.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw assignmentError('headmaster inference assignment row is malformed', 'assignment_lookup_invalid')
  }
  return Object.freeze({ ownerId: rowOwnerId, noraUserId, providerId, enabled: row.enabled, revision: row.revision })
}

export function createSupabaseAssignmentResolver({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
  now = () => Date.now(),
  ttlMs = DEFAULT_ASSIGNMENT_TTL_MS,
  timeoutMs = DEFAULT_ASSIGNMENT_TIMEOUT_MS,
  logger = quietLogger,
} = {}) {
  const base = validateSupabaseOrigin(supabaseUrl)
  const key = String(serviceRoleKey ?? '').trim()
  if (!key) throw assignmentError('headmaster Supabase service credential is required', 'assignment_config_invalid')
  if (typeof fetchImpl !== 'function') throw assignmentError('headmaster Supabase fetch implementation is invalid', 'assignment_config_invalid')
  // The factory honors the explicit ttlMs it is given; the env setting
  // HEADMASTER_INFERENCE_ASSIGNMENT_TTL_MS is clamped to 1000..300000 by
  // resolveAssignmentConfiguration before it reaches this constructor.
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw assignmentError('headmaster inference assignment TTL is invalid', 'assignment_config_invalid')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw assignmentError('headmaster inference assignment timeout is out of range', 'assignment_config_invalid')
  }

  const cache = new Map()

  async function fetchAssignmentRow(ownerId) {
    const url = `${base}${ASSIGNMENT_PATH}?owner_id=eq.${ownerId}&limit=2&select=${ASSIGNMENT_SELECT}`
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(assignmentError('headmaster inference assignment lookup timed out', 'assignment_lookup_timeout')),
      timeoutMs,
    )
    timer.unref?.()
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          accept: 'application/json',
        },
      })
    } catch (error) {
      if (error?.code === 'assignment_lookup_timeout') throw error
      throw assignmentError('headmaster inference assignment lookup failed', 'assignment_lookup_failed')
    } finally {
      clearTimeout(timer)
    }
    if (!response || !response.ok) {
      throw assignmentError('headmaster inference assignment lookup failed', 'assignment_lookup_failed')
    }
    let rows
    try { rows = await response.json() } catch {
      throw assignmentError('headmaster inference assignment lookup returned an invalid body', 'assignment_lookup_invalid')
    }
    if (!Array.isArray(rows)) {
      throw assignmentError('headmaster inference assignment lookup returned an invalid body', 'assignment_lookup_invalid')
    }
    if (rows.length > 1) {
      // More than one row for a primary key means a broken read surface; fail closed.
      throw assignmentError('headmaster inference assignment lookup is ambiguous', 'assignment_lookup_anomaly')
    }
    if (rows.length === 0) return null
    return normalizeAssignmentRow(rows[0], ownerId)
  }

  // Successful lookups (present or absent) are cached for at most ttlMs. Errors
  // never write the cache and an expired entry is never served: a revoked,
  // replaced, or reapproved assignment is honored within the bounded TTL.
  function applyRow(ownerId, row) {
    if (!row) return null
    if (!row.enabled) {
      logger.warn?.('headmaster-inference assignment revoked', { ownerId, revision: row.revision })
      return null
    }
    return Object.freeze({ noraUserId: row.noraUserId, providerId: row.providerId })
  }

  async function resolveAssignment(rawOwnerId) {
    const ownerId = String(rawOwnerId ?? '').toLowerCase()
    if (!OWNER_UUID.test(ownerId)) {
      throw assignmentError('headmaster inference assignment owner id is invalid', 'assignment_owner_invalid')
    }
    const cached = cache.get(ownerId)
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return applyRow(ownerId, cached.row)
    }
    const row = await fetchAssignmentRow(ownerId)
    cache.set(ownerId, { row, fetchedAt: now() })
    return applyRow(ownerId, row)
  }

  return { resolveAssignment }
}

// Resolve the relay's assignment source from its environment. "auto" prefers
// durable Supabase assignments whenever Supabase settings are present and
// otherwise falls back to the legacy env map (which is reported so the caller
// can log a LEGACY-mode warning).
export function resolveAssignmentConfiguration(env = process.env, options = {}) {
  const source = String(env.HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE || 'auto').trim().toLowerCase()
  if (!['auto', 'supabase', 'env'].includes(source)) {
    throw assignmentError('HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE must be auto, supabase, or env', 'assignment_config_invalid')
  }
  const supabaseUrl = String(env.HEADMASTER_INFERENCE_SUPABASE_URL || '').trim()
  const serviceRoleKey = String(env.HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const hasSupabase = Boolean(supabaseUrl && serviceRoleKey)
  if (source === 'supabase' && !hasSupabase) {
    throw assignmentError(
      'HEADMASTER_INFERENCE_SUPABASE_URL and HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY are required when the assignment source is supabase',
      'assignment_config_invalid',
    )
  }

  const mode = source === 'auto' ? (hasSupabase ? 'supabase' : 'env') : source
  if (mode === 'supabase') {
    const resolver = createSupabaseAssignmentResolver({
      supabaseUrl,
      serviceRoleKey,
      ttlMs: clampAssignmentTtl(env.HEADMASTER_INFERENCE_ASSIGNMENT_TTL_MS),
      ...options,
    })
    return { mode, resolveAssignment: resolver.resolveAssignment }
  }

  const rawMap = env.HEADMASTER_INFERENCE_ACCOUNT_MAP
  if (!String(rawMap || '').trim()) {
    throw assignmentError(
      'HEADMASTER_INFERENCE_ACCOUNT_MAP is required when the assignment source is env',
      'assignment_config_invalid',
    )
  }
  return {
    mode: 'env',
    accountProviderMap: parseAccountProviderMap(rawMap),
    warning: source === 'env'
      ? 'HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE=env is a LEGACY compatibility mode; back durable assignments with Headmaster Supabase'
      : 'HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE=auto resolved to the LEGACY env account map (no Supabase URL/service credential configured)',
  }
}