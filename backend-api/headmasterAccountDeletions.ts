// @ts-nocheck
// Headmaster account deletions (decision 31), for the admin "Account deletions"
// tab. Reads and writes the Headmaster Supabase project through its REST and
// auth admin APIs with the service-role key from env. Nothing is hard-coded:
//   HEADMASTER_SUPABASE_URL, HEADMASTER_SUPABASE_SERVICE_ROLE_KEY
// The table is created by gcaplabs-site migration
// 20261006121000_headmaster_account_deletion_requests.sql (owner applies it).

const TABLE = "headmaster_account_deletion_requests";
const OPERATOR_STEPS = ["cloud_runtime", "memory_bank", "relay_usage"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function config(env = process.env) {
  const url = String(env.HEADMASTER_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.HEADMASTER_SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) return null;
  return { url, key };
}

function createDeletionClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = config(env);
  if (!cfg) return null;
  const headers = { apikey: cfg.key, authorization: `Bearer ${cfg.key}`, "content-type": "application/json" };
  const rest = (path, init = {}) => fetchImpl(`${cfg.url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });

  async function list() {
    const res = await rest(`${TABLE}?select=id,owner_id,email,source,status,steps,requested_at,completed_at,completed_by&order=requested_at.desc&limit=200`);
    if (!res.ok) throw new Error("deletions_unavailable");
    return res.json();
  }

  async function get(id) {
    const res = await rest(`${TABLE}?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!res.ok) throw new Error("deletions_unavailable");
    const rows = await res.json();
    return rows[0] || null;
  }

  async function patch(id, body) {
    const res = await rest(`${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
    if (!res.ok) throw new Error("deletion_update_failed");
  }

  /** Operator marks a server-side step done; the request completes when none are left. */
  async function completeStep(id, step, actor) {
    if (!OPERATOR_STEPS.includes(step)) throw new Error("step_invalid");
    const row = await get(id);
    if (!row) throw new Error("not_found");
    const steps = { ...(row.steps || {}), [step]: "done" };
    const left = OPERATOR_STEPS.some((s) => steps[s] === "pending_operator");
    const allDone = !left && Object.values(steps).every((v) => v === "done");
    const update = { steps, status: allDone ? "completed" : row.status };
    if (allDone) Object.assign(update, { completed_at: new Date().toISOString(), completed_by: String(actor || "admin") });
    await patch(id, update);
    return { ...row, ...update };
  }

  /**
   * Admin-initiated deletion of an account (support request, abuse). Same
   * order as the in-app route: record, revoke sessions, remove push devices,
   * then delete the auth user only if sessions were revoked.
   */
  async function deleteAccount(ownerId, actor) {
    if (!UUID_RE.test(String(ownerId || ""))) throw new Error("owner_invalid");
    const steps = {};
    const created = await rest(TABLE, {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ owner_id: ownerId, source: "admin", status: "running", steps }),
    });
    if (!created.ok) throw new Error("deletion_record_failed");
    const [row] = await created.json();

    const revoke = await rest("rpc/headmaster_bump_account_revocation", { method: "POST", body: JSON.stringify({ p_owner_id: ownerId }) });
    steps.revoke_sessions = revoke.ok ? "done" : "failed";
    const push = await rest(`headmaster_push_registrations?owner_id=eq.${ownerId}`, { method: "DELETE" });
    steps.push_registrations = push.ok || push.status === 404 ? "done" : "failed";
    for (const s of OPERATOR_STEPS) steps[s] = "pending_operator";
    if (steps.revoke_sessions === "done") {
      const del = await fetchImpl(`${cfg.url}/auth/v1/admin/users/${ownerId}`, { method: "DELETE", headers });
      steps.auth_user = del.ok ? "done" : "failed";
    } else {
      steps.auth_user = "skipped";
    }
    const failed = Object.values(steps).some((v) => v === "failed" || v === "skipped");
    const status = failed ? "failed" : "needs_operator";
    await patch(row.id, { steps, status, completed_by: String(actor || "admin") });
    return { ...row, steps, status };
  }

  return { list, completeStep, deleteAccount };
}

module.exports = { createDeletionClient, OPERATOR_STEPS };
