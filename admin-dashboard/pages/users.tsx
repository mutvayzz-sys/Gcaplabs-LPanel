import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { Loader2, RefreshCw, Search, Shield, Trash2, Users } from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import MetricCard from "../components/MetricCard";
import StatusBadge from "../components/StatusBadge";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatCount, formatDate } from "../lib/format";
import { useI18n } from "../lib/i18n";

function matchesUser(user, search) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return (
    user.email?.toLowerCase().includes(needle) ||
    user.name?.toLowerCase().includes(needle) ||
    user.id?.toLowerCase().includes(needle)
  );
}

function formatPlanLabel(plan, t) {
  const normalized = String(plan || "free")
    .trim()
    .toLowerCase();
  if (normalized === "selfhosted") return t("Self-hosted");
  if (!normalized || normalized === "free") return t("Free");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatAgentCap(user, t) {
  if (user?.is_unlimited) return t("Unlimited");
  if (Number.isInteger(user?.agent_limit)) return formatCount(user.agent_limit);
  return "—";
}

function formatAgentCapSource(source, t) {
  switch (source) {
    case "admin_override":
      return t("Admin override");
    case "admin_default_unlimited":
      return t("Admin default");
    case "default":
    default:
      return t("Default user cap");
  }
}

function formatDefaultAgentCap(user, t) {
  if (user?.role === "admin") return t("Unlimited");
  if (Number.isInteger(user?.base_agent_limit)) {
    return formatCount(user.base_agent_limit);
  }
  return "—";
}

function describeDefaultAgentCap(user, t) {
  if (user?.role === "admin") {
    return t("Leave blank to restore the admin default of unlimited.");
  }
  if (Number.isInteger(user?.base_agent_limit)) {
    return t("Leave blank to use the default cap of {count}.").replace(
      "{count}",
      formatCount(user.base_agent_limit),
    );
  }
  return t("Leave blank to use the default cap.");
}

function buildLimitDrafts(users = []) {
  return Object.fromEntries(
    users.map((user) => [
      user.id,
      user.agent_limit_override == null ? "" : String(user.agent_limit_override),
    ]),
  );
}

function buildBackupDrafts(users = []) {
  return Object.fromEntries(
    users.map((user) => [
      user.id,
      {
        enabled:
          user.managed_backups_enabled_override == null
            ? ""
            : String(user.managed_backups_enabled_override),
        count:
          user.backup_limit_per_agent_override == null
            ? ""
            : String(user.backup_limit_per_agent_override),
        storage:
          user.backup_storage_mb_override == null ? "" : String(user.backup_storage_mb_override),
        retention:
          user.backup_retention_days_override == null
            ? ""
            : String(user.backup_retention_days_override),
      },
    ]),
  );
}

function formatBackupCap(user, t) {
  if (!user?.managed_backups_enabled) return t("Disabled");
  const count = user?.backup_limit_per_agent == null ? t("Unlimited") : user.backup_limit_per_agent;
  const storage = user?.backup_storage_mb == null ? t("unlimited") : `${user.backup_storage_mb} MB`;
  const retention = user?.backup_retention_days || 0;
  return `${count} ${t("per agent")} · ${storage} · ${t("{count}d").replace("{count}", String(retention))}`;
}

export default function UsersPage() {
  const { t } = useI18n();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [roleLoadingId, setRoleLoadingId] = useState("");
  const [deleteLoadingId, setDeleteLoadingId] = useState("");
  const [limitDrafts, setLimitDrafts] = useState({});
  const [backupDrafts, setBackupDrafts] = useState({});
  const [limitLoadingId, setLimitLoadingId] = useState("");
  const [backupLoadingId, setBackupLoadingId] = useState("");
  const deferredSearch = useDeferredValue(search);
  const toast = useToast();

  const loadUsers = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/api/admin/users");
      if (!response.ok) {
        throw new Error(t("Failed to load users"));
      }

      const data = await response.json();
      const rows = Array.isArray(data) ? data : [];
      setUsers(rows);
      setLimitDrafts(buildLimitDrafts(rows));
      setBackupDrafts(buildBackupDrafts(rows));
    } catch (error) {
      console.error("Failed to load admin users:", error);
      toast.error(error.message || t("Failed to load users"));
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  async function changeRole(userId, nextRole) {
    setRoleLoadingId(userId);
    try {
      const response = await fetchWithAuth(`/api/admin/users/${userId}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || t("Failed to update role"));
      }

      setUsers((current) =>
        current.map((user) => (user.id === userId ? { ...user, role: payload.role } : user)),
      );
      toast.success(t("Role updated"));
    } catch (error) {
      console.error("Failed to update admin role:", error);
      toast.error(error.message || t("Failed to update role"));
      loadUsers();
    } finally {
      setRoleLoadingId("");
    }
  }

  async function deleteUser(user) {
    const label = user.email || user.id;
    if (
      !window.confirm(
        t("Delete {user}? This will remove the account and clean up owned agents.").replace(
          "{user}",
          label,
        ),
      )
    ) {
      return;
    }

    setDeleteLoadingId(user.id);
    try {
      const response = await fetchWithAuth(`/api/admin/users/${user.id}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || t("Failed to delete user"));
      }

      setUsers((current) => current.filter((entry) => entry.id !== user.id));
      setLimitDrafts((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
      setBackupDrafts((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
      toast.success(t("User deleted"));
    } catch (error) {
      console.error("Failed to delete admin user:", error);
      toast.error(error.message || t("Failed to delete user"));
    } finally {
      setDeleteLoadingId("");
    }
  }

  async function updateAgentLimit(user, nextOverride) {
    setLimitLoadingId(user.id);
    try {
      const response = await fetchWithAuth(`/api/admin/users/${user.id}/agent-limit`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_limit_override: nextOverride }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || t("Failed to update agent cap"));
      }

      setUsers((current) => current.map((entry) => (entry.id === user.id ? payload : entry)));
      setLimitDrafts((current) => ({
        ...current,
        [user.id]: payload.agent_limit_override == null ? "" : String(payload.agent_limit_override),
      }));
      toast.success(
        nextOverride == null ? t("Agent cap override cleared") : t("Agent cap updated"),
      );
    } catch (error) {
      console.error("Failed to update agent cap:", error);
      toast.error(error.message || t("Failed to update agent cap"));
      loadUsers();
    } finally {
      setLimitLoadingId("");
    }
  }

  async function saveAgentLimit(user) {
    const rawValue = String(limitDrafts[user.id] || "").trim();
    if (!rawValue) {
      toast.error(t("Enter an agent cap or clear the override"));
      return;
    }

    const nextOverride = Number(rawValue);
    if (!Number.isSafeInteger(nextOverride) || nextOverride < 0) {
      toast.error(t("Agent cap must be a whole number that is 0 or greater"));
      return;
    }

    await updateAgentLimit(user, nextOverride);
  }

  async function clearAgentLimit(user) {
    await updateAgentLimit(user, null);
  }

  function parseBackupOverride(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(t("Backup limits must be whole numbers that are 0 or greater"));
    }
    return parsed;
  }

  async function saveBackupLimits(user) {
    const draft = backupDrafts[user.id] || {};
    setBackupLoadingId(user.id);
    try {
      const response = await fetchWithAuth(`/api/admin/users/${user.id}/backup-limits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          managed_backups_enabled_override: draft.enabled === "" ? null : draft.enabled === "true",
          backup_limit_per_agent_override: parseBackupOverride(draft.count),
          backup_storage_mb_override: parseBackupOverride(draft.storage),
          backup_retention_days_override: parseBackupOverride(draft.retention),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t("Failed to update backup limits"));
      setUsers((current) => current.map((entry) => (entry.id === user.id ? payload : entry)));
      setBackupDrafts((current) => ({ ...current, ...buildBackupDrafts([payload]) }));
      toast.success(t("Backup limits updated"));
    } catch (error) {
      toast.error(error.message || t("Failed to update backup limits"));
      loadUsers();
    } finally {
      setBackupLoadingId("");
    }
  }

  const adminCount = users.filter((user) => user.role === "admin").length;
  const filteredUsers = users.filter((user) => {
    if (roleFilter !== "all" && user.role !== roleFilter) return false;
    return matchesUser(user, deferredSearch);
  });

  const totalAgentCount = users.reduce((sum, user) => sum + (Number(user.agentCount) || 0), 0);

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              {t("User Admin")}
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              {t("Accounts and roles")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              {t(
                "Search the user base, adjust admin privileges, and cleanly remove accounts that own agent infrastructure.",
              )}
            </p>
          </div>

          <button
            onClick={() => {
              setLoading(true);
              loadUsers();
            }}
            className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            {t("Refresh")}
          </button>
        </header>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4" data-no-translate>
          <MetricCard
            label={t("Total Users")}
            value={formatCount(users.length)}
            icon={Users}
            tone="blue"
            caption={t("All registered accounts")}
          />
          <MetricCard
            label={t("Admins")}
            value={formatCount(adminCount)}
            icon={Shield}
            tone="red"
            caption={t("Full-admin staff accounts")}
          />
          <MetricCard
            label={t("Standard Users")}
            value={formatCount(users.length - adminCount)}
            icon={Users}
            tone="emerald"
            caption={t("Non-admin customer accounts")}
          />
          <MetricCard
            label={t("Owned Agents")}
            value={formatCount(totalAgentCount)}
            icon={RefreshCw}
            tone="purple"
            caption={t("Agents attached to user accounts")}
          />
        </div>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative max-w-xl flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("Search by email, name, or user id")}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-red-200 focus:bg-white"
              />
            </div>

            <select
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 outline-none transition-colors focus:border-red-200 focus:bg-white"
            >
              <option value="all">{t("All roles")}</option>
              <option value="admin">{t("Admins")}</option>
              <option value="user">{t("Users")}</option>
            </select>
          </div>

          <div className="mt-6 overflow-x-auto">
            {loading ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 size={28} className="animate-spin text-red-500" />
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="flex h-48 items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-sm font-medium text-slate-400">
                {t("No users match the current filters.")}
              </div>
            ) : (
              <table className="min-w-full text-left">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      {t("User")}
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      {t("Role")}
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      {t("Agents")}
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      {t("Agent Cap")}
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      {t("Backups")}
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      {t("Created")}
                    </th>
                    <th className="px-2 py-3 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      {t("Actions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((user) => {
                    const isLastAdmin = user.role === "admin" && adminCount <= 1;
                    const limitDraft = String(limitDrafts[user.id] || "");
                    const currentLimitDraft =
                      user.agent_limit_override == null ? "" : String(user.agent_limit_override);
                    const limitDraftDirty = limitDraft !== currentLimitDraft;
                    const parsedLimitDraft = limitDraft.trim() === "" ? null : Number(limitDraft);
                    const canSaveLimit =
                      limitDraftDirty &&
                      limitDraft.trim() !== "" &&
                      Number.isSafeInteger(parsedLimitDraft) &&
                      parsedLimitDraft >= 0;
                    const backupDraft = backupDrafts[user.id] || {};
                    return (
                      <tr key={user.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-2 py-4">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">
                              {user.name || user.email}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">{user.email}</p>
                            <p className="mt-1 text-[11px] font-semibold text-slate-400">
                              {user.id.slice(0, 8)}
                            </p>
                          </div>
                        </td>
                        <td className="px-2 py-4">
                          <div className="flex items-center gap-3">
                            <StatusBadge status={user.role === "admin" ? "active" : "inactive"} />
                            <select
                              value={user.role}
                              disabled={roleLoadingId === user.id || isLastAdmin}
                              onChange={(event) => changeRole(user.id, event.target.value)}
                              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none transition-colors focus:border-red-200 focus:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <option value="user">{t("user")}</option>
                              <option value="admin">{t("admin")}</option>
                            </select>
                          </div>
                          {isLastAdmin ? (
                            <p className="mt-2 text-[11px] font-semibold text-orange-600">
                              {t("Last admin cannot be demoted.")}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-2 py-4">
                          <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-sm font-bold text-slate-700">
                            {formatCount(user.agentCount)}
                          </span>
                        </td>
                        <td className="px-2 py-4" data-no-translate>
                          <div className="min-w-[16rem]">
                            <p className="text-sm font-semibold text-slate-950">
                              {formatAgentCap(user, t)}
                            </p>
                            <p className="mt-1 text-[11px] font-semibold text-slate-400">
                              {formatAgentCapSource(user.agent_limit_source, t)} ·{" "}
                              {formatPlanLabel(user.plan, t)}
                            </p>
                            {user.agent_limit_source === "admin_override" ? (
                              <p className="mt-1 text-[11px] font-medium text-slate-500">
                                {t("Default cap:")} {formatDefaultAgentCap(user, t)}
                              </p>
                            ) : null}

                            <div className="mt-3 flex items-center gap-2">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={limitDraft}
                                onChange={(event) =>
                                  setLimitDrafts((current) => ({
                                    ...current,
                                    [user.id]: event.target.value,
                                  }))
                                }
                                placeholder={
                                  user.role === "admin" ? t("Unlimited default") : t("Use default")
                                }
                                className="w-28 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none transition-colors focus:border-red-200 focus:bg-white"
                              />
                              <button
                                disabled={!canSaveLimit || limitLoadingId === user.id}
                                onClick={() => saveAgentLimit(user)}
                                className="inline-flex min-w-[4.5rem] items-center justify-center rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {limitLoadingId === user.id ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  t("Save")
                                )}
                              </button>
                              {user.agent_limit_override != null ? (
                                <button
                                  disabled={limitLoadingId === user.id}
                                  onClick={() => clearAgentLimit(user)}
                                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {t("Clear")}
                                </button>
                              ) : null}
                            </div>

                            <p
                              className="mt-2 text-[11px] font-medium text-slate-500"
                              data-no-translate
                            >
                              {describeDefaultAgentCap(user, t)}
                            </p>
                          </div>
                        </td>
                        <td className="px-2 py-4">
                          <div className="min-w-[18rem]">
                            <p className="text-sm font-semibold text-slate-950" data-no-translate>
                              {formatBackupCap(user, t)}
                            </p>
                            <p className="mt-1 text-[11px] font-semibold text-slate-400">
                              {user.managed_backups_source === "admin_override"
                                ? t("Admin override")
                                : t("Plan/default")}
                            </p>
                            <div className="mt-3 grid grid-cols-2 gap-2">
                              <select
                                value={backupDraft.enabled ?? ""}
                                onChange={(event) =>
                                  setBackupDrafts((current) => ({
                                    ...current,
                                    [user.id]: {
                                      ...(current[user.id] || {}),
                                      enabled: event.target.value,
                                    },
                                  }))
                                }
                                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 outline-none"
                              >
                                <option value="">{t("Plan default")}</option>
                                <option value="true">{t("Enabled")}</option>
                                <option value="false">{t("Disabled")}</option>
                              </select>
                              <input
                                type="number"
                                min="0"
                                placeholder={t("Count")}
                                value={backupDraft.count ?? ""}
                                onChange={(event) =>
                                  setBackupDrafts((current) => ({
                                    ...current,
                                    [user.id]: {
                                      ...(current[user.id] || {}),
                                      count: event.target.value,
                                    },
                                  }))
                                }
                                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 outline-none"
                              />
                              <input
                                type="number"
                                min="0"
                                placeholder={t("Storage MB")}
                                value={backupDraft.storage ?? ""}
                                onChange={(event) =>
                                  setBackupDrafts((current) => ({
                                    ...current,
                                    [user.id]: {
                                      ...(current[user.id] || {}),
                                      storage: event.target.value,
                                    },
                                  }))
                                }
                                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 outline-none"
                              />
                              <input
                                type="number"
                                min="0"
                                placeholder={t("Retention days")}
                                value={backupDraft.retention ?? ""}
                                onChange={(event) =>
                                  setBackupDrafts((current) => ({
                                    ...current,
                                    [user.id]: {
                                      ...(current[user.id] || {}),
                                      retention: event.target.value,
                                    },
                                  }))
                                }
                                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 outline-none"
                              />
                            </div>
                            <button
                              disabled={backupLoadingId === user.id}
                              onClick={() => saveBackupLimits(user)}
                              className="mt-2 inline-flex min-w-[4.5rem] items-center justify-center rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {backupLoadingId === user.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                t("Save backups")
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="px-2 py-4 text-sm font-medium text-slate-500">
                          {formatDate(user.created_at)}
                        </td>
                        <td className="px-2 py-4 text-right">
                          <button
                            disabled={deleteLoadingId === user.id || isLastAdmin}
                            onClick={() => deleteUser(user)}
                            className="inline-flex items-center gap-2 rounded-2xl border border-red-100 px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {deleteLoadingId === user.id ? (
                              <Loader2 size={15} className="animate-spin" />
                            ) : (
                              <Trash2 size={15} />
                            )}
                            {t("Delete")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
