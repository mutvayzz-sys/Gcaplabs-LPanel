#!/usr/bin/env node
// One-time (re-runnable) migration of the legacy relay env account map into
// durable Headmaster Supabase assignments.
//
//   HEADMASTER_INFERENCE_SUPABASE_URL=https://<ref>.supabase.co \
//   HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY=... \
//   HEADMASTER_INFERENCE_ACCOUNT_MAP='{"<owner-uuid>":{"noraUserId":"...","providerId":"...","provider":"openai"}}' \
//   node services/headmaster-inference/scripts/migrate-account-map.mjs --actor <admin-auth-users-uuid>
//
// The script reads the current assignment revision per owner and calls the
// admin RPC with that revision fence, so a re-run of an already-migrated map
// reports "unchanged" without a revision bump. Every write is audited with
// change_source='env_map_migration'. It prints identifiers and result codes
// only; no credential is ever printed.
//
// Options:
//   --actor <uuid>    required; an auth.users row whose raw_app_meta_data role is admin
//   --map-file <path> read the legacy map JSON from a file instead of the env var
//   --reason <text>   audit reason (default: "Migrated from HEADMASTER_INFERENCE_ACCOUNT_MAP")
//   --dry-run         validate and print planned writes without calling the RPC
//   --help
import { readFile } from 'node:fs/promises'
import { OWNER_UUID, parseAccountProviderMap } from '../policy.mjs'
import { ASSIGNMENT_SELECT, validateSupabaseOrigin } from '../assignments.mjs'

const ASSIGNMENT_TABLE = 'headmaster_inference_assignments'
const ADMIN_RPC = 'headmaster_admin_set_inference_assignment'
const KNOWN_RESULTS = new Set(['created', 'changed', 'unchanged', 'revision_conflict', 'actor_not_admin', 'owner_not_found'])
const DEFAULT_REASON = 'Migrated from HEADMASTER_INFERENCE_ACCOUNT_MAP'
const TIMEOUT_MS = 15_000

function fail(message) {
  console.error(`migrate-account-map: ${message}`)
  process.exitCode = 2
  const error = new Error(message)
  error.silent = true
  throw error
}

function printUsage() {
  console.log(`usage: node services/headmaster-inference/scripts/migrate-account-map.mjs --actor <admin-uuid> [--map-file <path>] [--reason <text>] [--dry-run]

Reads the legacy HEADMASTER_INFERENCE_ACCOUNT_MAP (or --map-file) and writes
revision-fenced durable assignments to Headmaster Supabase with
change_source='env_map_migration'. Requires HEADMASTER_INFERENCE_SUPABASE_URL
and HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY. Re-running is safe:
already-migrated accounts report "unchanged".`)
}

function parseArgs(argv) {
  const options = { actor: null, mapFile: null, reason: DEFAULT_REASON, dryRun: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (!next) fail(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--actor') options.actor = value()
    else if (arg.startsWith('--actor=')) options.actor = arg.slice('--actor='.length)
    else if (arg === '--map-file') options.mapFile = value()
    else if (arg.startsWith('--map-file=')) options.mapFile = arg.slice('--map-file='.length)
    else if (arg === '--reason') options.reason = value()
    else if (arg.startsWith('--reason=')) options.reason = arg.slice('--reason='.length)
    else fail(`unknown argument ${arg} (see --help)`)
  }
  return options
}

function headers(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    accept: 'application/json',
  }
}

async function requestJson(url, { serviceRoleKey, method = 'GET', body } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timer.unref?.()
  let response
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        ...headers(serviceRoleKey),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new Error(`request to ${url} failed: ${error?.name === 'AbortError' ? 'timed out' : error?.message || 'network error'}`)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.text()).slice(0, 500) } catch { /* body unavailable */ }
    throw new Error(`request to ${url} returned ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  try { return await response.json() } catch { throw new Error(`request to ${url} returned an invalid JSON body`) }
}

async function readCurrentRevision(base, serviceRoleKey, ownerId) {
  const url = `${base}/rest/v1/${ASSIGNMENT_TABLE}?owner_id=eq.${ownerId}&limit=1&select=${ASSIGNMENT_SELECT}`
  const rows = await requestJson(url, { serviceRoleKey })
  if (!Array.isArray(rows)) throw new Error(`assignment read for ${ownerId} returned an invalid body`)
  if (rows.length === 0) return null
  if (!Number.isSafeInteger(rows[0]?.revision) || rows[0].revision < 1) {
    throw new Error(`assignment read for ${ownerId} returned an invalid revision`)
  }
  return rows[0].revision
}

async function applyAssignment(base, serviceRoleKey, { ownerId, entry, expectedRevision, actor, reason }) {
  const url = `${base}/rest/v1/rpc/${ADMIN_RPC}`
  const body = {
    p_owner_id: ownerId,
    p_nora_user_id: entry.noraUserId,
    p_provider_id: entry.providerId,
    p_enabled: true,
    p_expected_revision: expectedRevision,
    p_actor_id: actor,
    p_reason: reason,
    p_change_source: 'env_map_migration',
  }
  const result = await requestJson(url, { serviceRoleKey, method: 'POST', body })
  const row = Array.isArray(result) ? result[0] : result
  if (!row || typeof row.result_code !== 'string' || !KNOWN_RESULTS.has(row.result_code)) {
    throw new Error(`admin RPC for ${ownerId} returned an unexpected result`)
  }
  return row
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printUsage()
  if (!OWNER_UUID.test(String(options.actor || ''))) fail('--actor must be an auth.users UUID of an admin account')

  const supabaseUrl = String(process.env.HEADMASTER_INFERENCE_SUPABASE_URL || '').trim()
  const serviceRoleKey = String(process.env.HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!supabaseUrl || !serviceRoleKey) {
    fail('HEADMASTER_INFERENCE_SUPABASE_URL and HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY are required')
  }
  const base = validateSupabaseOrigin(supabaseUrl)

  const rawMap = options.mapFile
    ? await readFile(options.mapFile, 'utf8').catch(error => fail(`cannot read --map-file: ${error.message}`))
    : process.env.HEADMASTER_INFERENCE_ACCOUNT_MAP
  if (!String(rawMap || '').trim()) {
    fail('no legacy map provided: set HEADMASTER_INFERENCE_ACCOUNT_MAP or pass --map-file')
  }
  const map = parseAccountProviderMap(rawMap)

  console.log(`migrating ${map.size} account(s) to ${base} (${options.dryRun ? 'dry run' : 'write'})`)
  const summary = new Map()
  const transitions = new Map()
  const bump = (map, code) => map.set(code, (map.get(code) || 0) + 1)
  let failures = 0

  for (const [ownerId, entry] of map) {
    try {
      const currentRevision = await readCurrentRevision(base, serviceRoleKey, ownerId)
      const expectedRevision = currentRevision ?? 0
      if (options.dryRun) {
        console.log(`owner_id=${ownerId} planned p_expected_revision=${expectedRevision} (${currentRevision ? 'update' : 'create'})`)
        bump(summary, 'planned')
        continue
      }
      const row = await applyAssignment(base, serviceRoleKey, {
        ownerId,
        entry,
        expectedRevision,
        actor: options.actor,
        reason: options.reason,
      })
      bump(summary, row.result_code)
      if (row.event_type) bump(transitions, row.event_type)
      const event = row.event_type ? ` event=${row.event_type}` : ''
      console.log(`owner_id=${ownerId} result=${row.result_code} revision=${row.revision}${event}`)
    } catch (error) {
      failures += 1
      bump(summary, 'failed')
      console.error(`owner_id=${ownerId} failed: ${error.message}`)
    }
  }

  console.log('summary:')
  for (const [code, count] of [...summary.entries()].sort()) console.log(`  ${code}: ${count}`)
  if (transitions.size) {
    console.log('transitions:')
    for (const [code, count] of [...transitions.entries()].sort()) console.log(`  ${code}: ${count}`)
  }
  console.log('  total:', map.size)
  if (!options.dryRun && (summary.get('created') || summary.get('changed'))) {
    console.log('Wrote durable assignments with change_source=env_map_migration and revision fencing.')
  }
  if (!options.dryRun && transitions.get('reinstated')) {
    console.log('WARNING: reinstated rows were previously disabled by an admin; review those assignments before removing the env map.')
  }
  if (summary.get('revision_conflict')) {
    console.log('revision_conflict means state changed concurrently; re-run once the writer is idle.')
  }
  if (!options.dryRun) {
    console.log('Next: deploy the relay with HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE=supabase, verify, then remove HEADMASTER_INFERENCE_ACCOUNT_MAP.')
  }
  process.exitCode = failures || summary.get('revision_conflict') || summary.get('actor_not_admin') || summary.get('owner_not_found') ? 1 : 0
}

main().catch(error => {
  if (!error?.silent) console.error(`migrate-account-map: ${error?.message || 'migration failed'}`)
  process.exitCode ||= 1
})