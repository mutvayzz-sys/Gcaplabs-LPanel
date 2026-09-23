const ACQUIRE_SCRIPT = `
local requestCount = tonumber(redis.call('GET', KEYS[1]) or '0')
if requestCount >= tonumber(ARGV[4]) then return {0, 'request_budget'} end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[2]))
for _, requestId in ipairs(expired) do
  local staleReservation = tonumber(redis.call('HGET', KEYS[5], requestId) or '0')
  if staleReservation > 0 then
    redis.call('HDEL', KEYS[5], requestId)
    local reservedTotal = tonumber(redis.call('GET', KEYS[3]) or '0')
    if reservedTotal >= staleReservation then
      redis.call('DECRBY', KEYS[3], staleReservation)
    else
      redis.call('SET', KEYS[3], '0')
    end
  end
  redis.call('ZREM', KEYS[2], requestId)
end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return {0, 'concurrency'} end
local used = tonumber(redis.call('GET', KEYS[4]) or '0')
local reserved = tonumber(redis.call('GET', KEYS[3]) or '0')
local reserve = tonumber(ARGV[5])
if used + reserved + reserve > tonumber(ARGV[6]) then return {0, 'token_budget'} end
redis.call('INCR', KEYS[1])
if requestCount == 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[8])) end
redis.call('ZADD', KEYS[2], tonumber(ARGV[1]), ARGV[7])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[9]))
redis.call('HSET', KEYS[5], ARGV[7], reserve)
redis.call('INCRBY', KEYS[3], reserve)
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[9]))
redis.call('EXPIRE', KEYS[5], tonumber(ARGV[9]))
return {1, 'ok'}
`

const FINISH_SCRIPT = `
local reserved = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
if reserved > 0 then
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('DECRBY', KEYS[3], reserved)
end
redis.call('ZREM', KEYS[1], ARGV[1])
local output = tonumber(ARGV[2])
local prompt = tonumber(ARGV[3])
local total = tonumber(ARGV[4])
if output > 0 then redis.call('INCRBY', KEYS[4], output) end
if prompt > 0 then redis.call('HINCRBY', KEYS[5], 'prompt_tokens', prompt) end
if output > 0 then redis.call('HINCRBY', KEYS[5], 'completion_tokens', output) end
if total > 0 then redis.call('HINCRBY', KEYS[5], 'total_tokens', total) end
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[5], tonumber(ARGV[5]))
return {reserved, output}
`

export function createRedisQuotaStore(redis, {
  prefix = 'headmaster-inference',
  maxConcurrentPerAccount = 3,
  maxRequestsPerHour = 120,
  maxCompletionTokensPerDay = 120_000,
  activeTimeoutMs = 15 * 60_000,
  usageTtlSeconds = 90 * 24 * 60 * 60,
  now = () => Date.now(),
} = {}) {
  const key = (ownerId, suffix) => `${prefix}:${ownerId}:${suffix}`
  return {
    async acquire({ ownerId, requestId, reserveOutputTokens }) {
      const at = now()
      const hour = Math.floor(at / 3_600_000)
      const day = Math.floor(at / 86_400_000)
      const activeKey = key(ownerId, `active:${day}`)
      const result = await redis.eval(ACQUIRE_SCRIPT, 5,
        key(ownerId, `requests:${hour}`), activeKey,
        key(ownerId, `reserved:${day}`), key(ownerId, `output:${day}`),
        key(ownerId, `reservations:${day}`),
        at, at - activeTimeoutMs, maxConcurrentPerAccount, maxRequestsPerHour,
        reserveOutputTokens, maxCompletionTokensPerDay, requestId,
        3_700, Math.ceil(activeTimeoutMs / 1000) + 60)
      return { allowed: Number(result?.[0]) === 1, reason: String(result?.[1] || 'quota_unavailable'), day }
    },
    async finish({ ownerId, requestId, quotaDay, promptTokens = 0, completionTokens = 0, totalTokens = 0 }) {
      const day = Number.isSafeInteger(quotaDay) ? quotaDay : Math.floor(now() / 86_400_000)
      return redis.eval(FINISH_SCRIPT, 5,
        key(ownerId, `active:${day}`), key(ownerId, `reservations:${day}`),
        key(ownerId, `reserved:${day}`), key(ownerId, `output:${day}`),
        key(ownerId, `usage:${day}`), requestId, promptTokens, completionTokens,
        totalTokens, usageTtlSeconds)
    },
  }
}

export function createMemoryQuotaStore({
  maxConcurrentPerAccount = 3,
  maxRequestsPerHour = 120,
  maxCompletionTokensPerDay = 120_000,
  now = () => Date.now(),
} = {}) {
  const accounts = new Map()
  const get = ownerId => {
    if (!accounts.has(ownerId)) accounts.set(ownerId, {
      active: new Map(), reservations: new Map(), requests: [], day: -1, reserved: 0, used: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    })
    return accounts.get(ownerId)
  }
  return {
    async acquire({ ownerId, requestId, reserveOutputTokens }) {
      const at = now()
      const account = get(ownerId)
      const hour = Math.floor(at / 3_600_000)
      const day = Math.floor(at / 86_400_000)
      if (account.day !== day && account.active.size === 0) {
        account.day = day
        account.reserved = 0
        account.used = 0
      }
      account.requests = account.requests.filter(bucket => bucket.hour === hour)
      for (const [id, started] of account.active) if (started < at - 15 * 60_000) account.active.delete(id)
      if (account.requests.length >= maxRequestsPerHour) return { allowed: false, reason: 'request_budget' }
      if (account.active.size >= maxConcurrentPerAccount) return { allowed: false, reason: 'concurrency' }
      if (account.used + account.reserved + reserveOutputTokens > maxCompletionTokensPerDay) return { allowed: false, reason: 'token_budget' }
      account.requests.push({ hour })
      account.active.set(requestId, at)
      account.reservations.set(requestId, reserveOutputTokens)
      account.reserved += reserveOutputTokens
      return { allowed: true, reason: 'ok', day }
    },
    async finish({ ownerId, requestId, promptTokens = 0, completionTokens = 0, totalTokens = 0 }) {
      const account = get(ownerId)
      const reserve = account.reservations.get(requestId) || 0
      account.reservations.delete(requestId)
      account.active.delete(requestId)
      account.reserved = Math.max(0, account.reserved - reserve)
      account.used += completionTokens
      account.usage.promptTokens += promptTokens
      account.usage.completionTokens += completionTokens
      account.usage.totalTokens += totalTokens
    },
    inspect(ownerId) {
      const account = get(ownerId)
      return { active: account.active.size, reserved: account.reserved, used: account.used, usage: { ...account.usage } }
    },
  }
}
