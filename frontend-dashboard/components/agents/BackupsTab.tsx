import { useCallback, useEffect, useState } from "react";
import { Archive, CalendarClock, Download, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { saveDeployDraft } from "../../lib/clawhubDeploy";
import { useToast } from "../Toast";

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatBackupStatus(status) {
  return String(status || "queued")
    .replace(/_/g, " ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function backupReady(backup) {
  return backup?.status === "ready" || backup?.status === "ready_with_warnings";
}

export default function BackupsTab({ agentId }) {
  const [loading, setLoading] = useState(true);
  const [backups, setBackups] = useState([]);
  const [entitlement, setEntitlement] = useState(null);
  const [usage, setUsage] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [busy, setBusy] = useState("");
  const toast = useToast();

  const loadBackups = useCallback(async () => {
    try {
      const [backupsRes, scheduleRes] = await Promise.all([
        fetchWithAuth(`/api/agents/${agentId}/backups`),
        fetchWithAuth(`/api/agents/${agentId}/backups/schedule`),
      ]);
      const backupsPayload = await backupsRes.json().catch(() => ({}));
      const schedulePayload = await scheduleRes.json().catch(() => ({}));
      if (!backupsRes.ok) throw new Error(backupsPayload.error || "Failed to load backups");
      setBackups(Array.isArray(backupsPayload.backups) ? backupsPayload.backups : []);
      setEntitlement(backupsPayload.entitlement || null);
      setUsage(backupsPayload.usage || null);
      if (scheduleRes.ok) setSchedule(schedulePayload.schedule || null);
    } catch (error) {
      toast.error(error.message || "Failed to load backups");
    } finally {
      setLoading(false);
    }
  }, [agentId, toast]);

  useEffect(() => {
    if (!agentId) return;
    loadBackups();
  }, [agentId, loadBackups]);

  useEffect(() => {
    if (!backups.some((backup) => ["queued", "running"].includes(backup.status))) return;
    const timer = setInterval(loadBackups, 5000);
    return () => clearInterval(timer);
  }, [backups, loadBackups]);

  async function createBackup() {
    setBusy("create");
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to queue backup");
      toast.success("Backup queued");
      await loadBackups();
    } catch (error) {
      toast.error(error.message || "Failed to queue backup");
    } finally {
      setBusy("");
    }
  }

  async function downloadBackup(backup) {
    setBusy(`download:${backup.id}`);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/backups/${backup.id}/download`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to download backup");
      }
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/i);
      const filename = match?.[1] || `${backup.name || "lpanel-backup"}.tgz`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error.message || "Failed to download backup");
    } finally {
      setBusy("");
    }
  }

  async function deleteBackup(backup) {
    if (!window.confirm(`Delete backup "${backup.name}"?`)) return;
    setBusy(`delete:${backup.id}`);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/backups/${backup.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to delete backup");
      toast.success("Backup deleted");
      await loadBackups();
    } catch (error) {
      toast.error(error.message || "Failed to delete backup");
    } finally {
      setBusy("");
    }
  }

  async function restoreAsCopy(backup) {
    setBusy(`restore:${backup.id}`);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "copy" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to prepare restore");
      saveDeployDraft(data.deployDraft);
      window.location.href = "/app/deploy";
    } catch (error) {
      toast.error(error.message || "Failed to prepare restore");
      setBusy("");
    }
  }

  async function saveSchedule(nextSchedule) {
    setBusy("schedule");
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/backups/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextSchedule),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save schedule");
      setSchedule(data.schedule);
      toast.success(
        data.schedule?.enabled ? "Backup schedule enabled" : "Backup schedule disabled",
      );
    } catch (error) {
      toast.error(error.message || "Failed to save schedule");
    } finally {
      setBusy("");
    }
  }

  const enabled = entitlement?.managed_backups_enabled;
  const limit = entitlement?.backup_limit_per_agent ?? "Unlimited";
  const storageLimit =
    entitlement?.backup_storage_mb == null ? "Unlimited" : `${entitlement.backup_storage_mb} MB`;

  if (loading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-slate-200 bg-white">
        <Loader2 className="animate-spin text-slate-400" size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <Archive size={16} className="text-blue-600" />
              Managed Backups
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              Stored backups capture this agent&apos;s files, memory, managed wiring, and supported
              secrets.
            </p>
          </div>
          <button
            onClick={createBackup}
            disabled={!enabled || !!busy}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "create" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Archive size={14} />
            )}
            Create Backup
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Access</p>
            <p className="mt-1 text-sm font-bold text-slate-900">
              {enabled ? "Enabled" : "Manual export only"}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Per Agent
            </p>
            <p className="mt-1 text-sm font-bold text-slate-900">{limit}</p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Storage
            </p>
            <p className="mt-1 text-sm font-bold text-slate-900">
              {formatBytes(usage?.backup_storage_used_bytes)} / {storageLimit}
            </p>
          </div>
        </div>

        {!enabled ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
            Stored managed backups are a paid feature on this installation. Use the Files tab export
            for a manual download.
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <CalendarClock size={16} className="text-blue-600" />
              Schedule
            </h3>
            <p className="mt-2 text-sm text-slate-500">Run managed backups automatically.</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={schedule?.enabled === true}
              disabled={!enabled || busy === "schedule"}
              onChange={(event) =>
                saveSchedule({ ...(schedule || {}), enabled: event.target.checked })
              }
            />
            Enabled
          </label>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <select
            value={schedule?.frequency || "daily"}
            disabled={!enabled || busy === "schedule"}
            onChange={(event) =>
              saveSchedule({ ...(schedule || {}), frequency: event.target.value })
            }
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none"
          >
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          <input
            type="number"
            min="0"
            max="23"
            value={schedule?.hour_utc ?? 2}
            disabled={!enabled || busy === "schedule"}
            onChange={(event) =>
              saveSchedule({ ...(schedule || {}), hour_utc: Number(event.target.value) })
            }
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none"
          />
          <select
            value={schedule?.day_of_week ?? 0}
            disabled={!enabled || busy === "schedule" || schedule?.frequency !== "weekly"}
            onChange={(event) =>
              saveSchedule({ ...(schedule || {}), day_of_week: Number(event.target.value) })
            }
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none disabled:opacity-50"
          >
            <option value={0}>Sunday</option>
            <option value={1}>Monday</option>
            <option value={2}>Tuesday</option>
            <option value={3}>Wednesday</option>
            <option value={4}>Thursday</option>
            <option value={5}>Friday</option>
            <option value={6}>Saturday</option>
          </select>
        </div>
        {schedule?.next_run_at ? (
          <p className="mt-3 text-xs font-medium text-slate-500">
            Next run: {new Date(schedule.next_run_at).toLocaleString()}
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-bold text-slate-800">History</h3>
        <div className="mt-4 divide-y divide-slate-100">
          {backups.length === 0 ? (
            <p className="py-8 text-center text-sm font-medium text-slate-400">
              No managed backups yet.
            </p>
          ) : (
            backups.map((backup) => (
              <div key={backup.id} className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-slate-900">{backup.name}</p>
                  <p className="mt-1 text-xs font-medium text-slate-500">
                    {formatBackupStatus(backup.status)} · {formatBytes(backup.size_bytes)} ·{" "}
                    {backup.created_at ? new Date(backup.created_at).toLocaleString() : "Queued"}
                  </p>
                  {backup.error ? (
                    <p className="mt-1 text-xs font-semibold text-red-600">{backup.error}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    disabled={!backupReady(backup) || !!busy}
                    onClick={() => restoreAsCopy(backup)}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {busy === `restore:${backup.id}` ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RotateCcw size={14} />
                    )}
                    Restore Copy
                  </button>
                  <button
                    disabled={!backupReady(backup) || !!busy}
                    onClick={() => downloadBackup(backup)}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {busy === `download:${backup.id}` ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    Download
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() => deleteBackup(backup)}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-100 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    {busy === `delete:${backup.id}` ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
