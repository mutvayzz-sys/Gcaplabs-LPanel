// Personal provider key resolution for the Headmaster inference relay.
//
// A user's own provider key is stored encrypted in Headmaster Supabase
// (public.headmaster_user_provider_keys, service role only) and is decrypted
// here, in memory, for the duration of a request. It is never logged, never
// returned, and never falls back to an operator key. Failures are never cached
// and a cached ciphertext is never served past ttlMs, so a deleted or replaced
// key stops working within that bound.
import { decryptProviderKey } from "./provider-key-crypto.mjs";
import { OWNER_UUID, isByoProvider } from "./policy.mjs";
import { validateSupabaseOrigin } from "./assignments.mjs";

export const BYO_KEY_TTL_MS = 30_000;
export const BYO_KEY_TIMEOUT_MS = 10_000;
export const BYO_KEY_MAX_BODY_BYTES = 65_536;
export const BYO_CIPHERTEXT_MAX_CHARS = 4096;
const KEYS_PATH = "/rest/v1/headmaster_user_provider_keys";
const KEYS_SELECT = "owner_id,provider,ciphertext,revision";
const MAX_CACHE_ENTRIES = 5000;
const quietLogger = { info() {}, warn() {}, error() {} };

function byoError(code) {
  return Object.assign(new Error(code), { code });
}

function abortRejection(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function readBoundedBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw byoError("own_key_unavailable");
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BYO_KEY_MAX_BODY_BYTES) throw byoError("own_key_unavailable");
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

// Returns resolveOwnKey(ownerId, provider) -> apiKey string, or null when the
// user has no key for that provider. Throws { code: "own_key_unavailable" } for
// any configuration, lookup, or decryption problem (details go to the logger as
// codes only). Never throws at construction: a missing or short secret or an
// absent Supabase configuration just makes every call unavailable, so the
// operator path keeps working.
export function createProviderKeyResolver({
  supabaseUrl,
  serviceRoleKey,
  secret,
  fetchImpl = fetch,
  now = () => Date.now(),
  ttlMs = BYO_KEY_TTL_MS,
  timeoutMs = BYO_KEY_TIMEOUT_MS,
  logger = quietLogger,
} = {}) {
  let base = null;
  try {
    base = validateSupabaseOrigin(supabaseUrl);
  } catch {
    base = null;
  }
  const serviceKey = String(serviceRoleKey ?? "").trim();
  const secretOk = typeof secret === "string" && Buffer.byteLength(secret) >= 32;
  const configured =
    Boolean(base && serviceKey && secretOk) && typeof fetchImpl === "function" && ttlMs >= 1;
  const cappedTtl = Math.min(Math.max(ttlMs, 1), BYO_KEY_TTL_MS);
  const cache = new Map();

  async function fetchRow(ownerId, provider) {
    const url = `${base}${KEYS_PATH}?owner_id=eq.${ownerId}&provider=eq.${provider}&limit=2&select=${KEYS_SELECT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(byoError("own_key_unavailable")), timeoutMs);
    timer.unref?.();
    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            apikey: serviceKey,
            authorization: `Bearer ${serviceKey}`,
            accept: "application/json",
          },
        }),
        abortRejection(controller.signal),
      ]);
      if (!response || !response.ok) throw byoError("own_key_unavailable");
      const text = await Promise.race([
        readBoundedBody(response),
        abortRejection(controller.signal),
      ]);
      const rows = JSON.parse(text);
      if (!Array.isArray(rows) || rows.length > 1) throw byoError("own_key_unavailable");
      if (rows.length === 0) return null;
      const row = rows[0];
      if (
        String(row?.owner_id ?? "").toLowerCase() !== ownerId ||
        row?.provider !== provider ||
        typeof row?.ciphertext !== "string" ||
        !row.ciphertext ||
        row.ciphertext.length > BYO_CIPHERTEXT_MAX_CHARS
      )
        throw byoError("own_key_unavailable");
      return row.ciphertext;
    } finally {
      clearTimeout(timer);
    }
  }

  return async function resolveOwnKey(rawOwnerId, provider) {
    const ownerId = String(rawOwnerId ?? "").toLowerCase();
    if (!configured || !OWNER_UUID.test(ownerId) || !isByoProvider(provider))
      throw byoError("own_key_unavailable");
    const cacheKey = `${ownerId}:${provider}`;
    let ciphertext;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.fetchedAt < cappedTtl) {
      ciphertext = cached.ciphertext;
    } else {
      cache.delete(cacheKey);
      try {
        ciphertext = await fetchRow(ownerId, provider);
      } catch (error) {
        logger.warn?.("headmaster-inference own key lookup failed", {
          provider,
          code: error?.code === "own_key_unavailable" ? "lookup_failed" : "lookup_error",
        });
        throw byoError("own_key_unavailable");
      }
      // A miss is never cached: a freshly saved key works on the next request.
      if (ciphertext === null) return null;
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const at = now();
        for (const [k, v] of cache) if (at - v.fetchedAt >= cappedTtl) cache.delete(k);
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
      }
      cache.set(cacheKey, { ciphertext, fetchedAt: now() });
    }
    try {
      return decryptProviderKey({ secret, ownerId, provider, ciphertext });
    } catch (error) {
      cache.delete(cacheKey);
      logger.warn?.("headmaster-inference own key undecryptable", {
        provider,
        code: error?.code || "provider_key_undecryptable",
      });
      throw byoError("own_key_unavailable");
    }
  };
}
