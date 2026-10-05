import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, Search, Shield, Users } from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import { fetchWithAuth } from "../lib/api";
import { useI18n } from "../lib/i18n";

interface WorkspaceRow {
  id: string;
  name: string;
  creatorUserId: string | null;
  creatorEmail: string | null;
  creatorName: string | null;
  createdAt: string;
  memberCounts: { owner: number; admin: number; editor: number; viewer: number; total: number };
  agentCount: number;
}

interface MemberRow {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  platformRole: string | null;
  role: "owner" | "admin" | "editor" | "viewer";
  invitedBy: string | null;
  invitedByEmail: string | null;
  joinedAt: string;
}

interface UserSummary {
  userId: string;
  email: string;
  name: string | null;
  platformRole: string | null;
  workspaceCount: number;
  topRole: "owner" | "admin" | "editor" | "viewer" | null;
}

const ROLE_BADGES: Record<MemberRow["role"], string> = {
  owner: "bg-amber-50 text-amber-700 border-amber-200",
  admin: "bg-violet-50 text-violet-700 border-violet-200",
  editor: "bg-blue-50 text-blue-700 border-blue-200",
  viewer: "bg-slate-50 text-slate-600 border-slate-200",
};

type ViewMode = "members" | "workspaces" | "users";

export default function AdminMembersPage() {
  const { t } = useI18n();
  const [view, setView] = useState<ViewMode>("members");
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (workspaceFilter) params.set("workspaceId", workspaceFilter);
      if (roleFilter) params.set("role", roleFilter);

      const [wsResponse, memberResponse, summaryResponse] = await Promise.all([
        fetchWithAuth("/api/admin/workspaces"),
        fetchWithAuth(`/api/admin/members${params.toString() ? `?${params.toString()}` : ""}`),
        fetchWithAuth("/api/admin/members/summary"),
      ]);
      if (!wsResponse.ok) throw new Error(`Workspace fetch failed (${wsResponse.status})`);
      if (!memberResponse.ok) throw new Error(`Member fetch failed (${memberResponse.status})`);
      if (!summaryResponse.ok) throw new Error(`Summary fetch failed (${summaryResponse.status})`);
      setWorkspaces(await wsResponse.json());
      setMembers(await memberResponse.json());
      setUsers(await summaryResponse.json());
    } catch (err: any) {
      setError(err?.message || "Failed to load admin RBAC data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [workspaceFilter, roleFilter]);

  const totalMembers = useMemo(
    () => workspaces.reduce((sum, w) => sum + w.memberCounts.total, 0),
    [workspaces],
  );

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
              <Shield size={24} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-950">
                {t("Multi-tenant RBAC")}
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                {t(
                  "Read-only god view of every workspace, member, and role on this Headmaster Control installation.",
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t("Refresh")}
          </button>
        </header>

        <div className="grid gap-4 sm:grid-cols-3">
          <SummaryCard label={t("Workspaces")} value={workspaces.length} />
          <SummaryCard label={t("Membership rows")} value={totalMembers} />
          <SummaryCard label={t("Distinct users")} value={users.length} />
        </div>

        <div className="flex flex-wrap gap-2">
          {(["members", "workspaces", "users"] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={`rounded-2xl px-4 py-2 text-sm font-bold ${
                view === mode
                  ? "bg-violet-600 text-white shadow"
                  : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {mode === "members" && t("Members")}
              {mode === "workspaces" && t("Workspaces")}
              {mode === "users" && t("Users")}
            </button>
          ))}
        </div>

        {view === "members" && (
          <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2">
                <Search size={14} className="text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") reload();
                  }}
                  placeholder={t("Search by user, email, or workspace…")}
                  className="flex-1 bg-transparent text-sm font-medium text-slate-900 outline-none"
                />
              </div>
              <select
                value={workspaceFilter}
                onChange={(e) => setWorkspaceFilter(e.target.value)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-900 outline-none"
              >
                <option value="">{t("All workspaces")}</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-900 outline-none"
              >
                <option value="">{t("All roles")}</option>
                <option value="owner">{t("Owner")}</option>
                <option value="admin">{t("Admin")}</option>
                <option value="editor">{t("Editor")}</option>
                <option value="viewer">{t("Viewer")}</option>
              </select>
            </div>

            {error && (
              <div className="m-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {error}
              </div>
            )}

            <MemberTable rows={members} loading={loading} t={t} />
          </section>
        )}

        {view === "workspaces" && (
          <section className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <WorkspaceTable rows={workspaces} loading={loading} t={t} />
          </section>
        )}

        {view === "users" && (
          <section className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <UserSummaryTable rows={users} loading={loading} t={t} />
          </section>
        )}
      </div>
    </AdminLayout>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-black text-slate-950">{value}</p>
    </div>
  );
}

function MemberTable({
  rows,
  loading,
  t,
}: {
  rows: MemberRow[];
  loading: boolean;
  t: (key: string) => string;
}) {
  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center text-slate-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="py-12 text-center text-sm text-slate-500">{t("No members match.")}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
          <tr>
            <th className="px-4 py-3 text-left">{t("Workspace")}</th>
            <th className="px-4 py-3 text-left">{t("User")}</th>
            <th className="px-4 py-3 text-left">{t("Role")}</th>
            <th className="px-4 py-3 text-left">{t("Joined")}</th>
            <th className="px-4 py-3 text-right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={`${row.workspaceId}:${row.userId}`}>
              <td className="px-4 py-3">
                <div className="font-bold text-slate-900">{row.workspaceName}</div>
                <code className="text-[10px] text-slate-400">{row.workspaceId}</code>
              </td>
              <td className="px-4 py-3">
                <div className="font-bold text-slate-900">{row.userName || row.userEmail}</div>
                <div className="text-xs text-slate-500">{row.userEmail}</div>
                {row.platformRole === "admin" && (
                  <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-red-700">
                    <Shield size={10} />
                    {t("Platform admin")}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <span
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-black uppercase tracking-widest ${ROLE_BADGES[row.role]}`}
                >
                  {row.role}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-slate-500">
                {new Date(row.joinedAt).toLocaleDateString()}
                {row.invitedByEmail && (
                  <div className="text-[10px] text-slate-400">
                    {t("by")} {row.invitedByEmail}
                  </div>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <a
                  href={`/app/workspaces/${row.workspaceId}/members`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  {t("Manage")}
                  <ExternalLink size={12} />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkspaceTable({
  rows,
  loading,
  t,
}: {
  rows: WorkspaceRow[];
  loading: boolean;
  t: (key: string) => string;
}) {
  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center text-slate-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
          <tr>
            <th className="px-4 py-3 text-left">{t("Workspace")}</th>
            <th className="px-4 py-3 text-left">{t("Creator")}</th>
            <th className="px-4 py-3 text-left">{t("Members")}</th>
            <th className="px-4 py-3 text-left">{t("Agents")}</th>
            <th className="px-4 py-3 text-left">{t("Created")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3">
                <div className="font-bold text-slate-900">{row.name}</div>
                <code className="text-[10px] text-slate-400">{row.id}</code>
              </td>
              <td className="px-4 py-3">
                <div className="text-sm font-bold text-slate-900">
                  {row.creatorName || row.creatorEmail || "—"}
                </div>
                <div className="text-xs text-slate-500">{row.creatorEmail || ""}</div>
              </td>
              <td className="px-4 py-3 text-xs text-slate-700">
                {row.memberCounts.total}{" "}
                <span className="text-slate-400">
                  ({row.memberCounts.owner}/{row.memberCounts.admin}/{row.memberCounts.editor}/
                  {row.memberCounts.viewer})
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-slate-700">{row.agentCount}</td>
              <td className="px-4 py-3 text-xs text-slate-500">
                {new Date(row.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserSummaryTable({
  rows,
  loading,
  t,
}: {
  rows: UserSummary[];
  loading: boolean;
  t: (key: string) => string;
}) {
  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center text-slate-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
          <tr>
            <th className="px-4 py-3 text-left">{t("User")}</th>
            <th className="px-4 py-3 text-left">{t("Workspaces")}</th>
            <th className="px-4 py-3 text-left">{t("Top role")}</th>
            <th className="px-4 py-3 text-left">{t("Platform role")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.userId}>
              <td className="px-4 py-3">
                <div className="font-bold text-slate-900">{row.name || row.email}</div>
                <div className="text-xs text-slate-500">{row.email}</div>
              </td>
              <td className="px-4 py-3 text-sm font-bold text-slate-700">
                <Users size={14} className="mr-1 inline text-slate-400" />
                {row.workspaceCount}
              </td>
              <td className="px-4 py-3">
                {row.topRole ? (
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-black uppercase tracking-widest ${ROLE_BADGES[row.topRole]}`}
                  >
                    {row.topRole}
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                {row.platformRole === "admin" ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-red-700">
                    <Shield size={10} />
                    {t("admin")}
                  </span>
                ) : (
                  <span className="text-xs text-slate-500">{row.platformRole || "user"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
