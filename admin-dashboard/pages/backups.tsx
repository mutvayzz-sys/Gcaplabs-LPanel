import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  CalendarClock,
  Download,
  Loader2,
  RefreshCw,
  Save,
  Server,
  SlidersHorizontal,
  Trash2,
  RotateCcw,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import MetricCard from "../components/MetricCard";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatCount, formatDateTime } from "../lib/format";

const DEFAULT_FORM = {
  storageBackend: "local",
  localPath: "/var/lib/nora-backups",
  s3Bucket: "",
  s3Region: "us-east-1",
  s3Endpoint: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  sshHost: "",
  sshPort: 22,
  sshUsername: "",
  sshRemotePath: "/backups/nora",
  sshPrivateKey: "",
  sshPassword: "",
  installationScheduleEnabled: false,
  installationScheduleFrequency: "daily",
  installationScheduleHourUtc: 2,
  installationScheduleDayOfWeek: 0,
};
type BackupPlanKey = "free" | "pro" | "enterprise";
type BackupPlanLimitFormRow = {
  managed_backups_enabled: boolean;
  backup_limit_per_agent: string;
  backup_storage_mb: string;
  backup_retention_days: string;
};
type BackupPlanLimitPayloadRow = {
  managed_backups_enabled?: boolean;
  backup_limit_per_agent?: number | string;
  backup_storage_mb?: number | string;
  backup_retention_days?: number | string;
};
type BackupPlanLimitPayload = {
  plans?: Partial<Record<BackupPlanKey, BackupPlanLimitPayloadRow>>;
  billingEnabled?: boolean;
  platformMode?: string;
} & Partial<Record<BackupPlanKey, BackupPlanLimitPayloadRow>>;

const PLAN_KEYS: BackupPlanKey[] = ["free", "pro", "enterprise"];
const PLAN_LABELS: Record<BackupPlanKey, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};
const DEFAULT_PLAN_LIMITS: Record<BackupPlanKey, BackupPlanLimitFormRow> = {
  free: {
    managed_backups_enabled: false,
    backup_limit_per_agent: "0",
    backup_storage_mb: "0",
    backup_retention_days: "0",
  },
  pro: {
    managed_backups_enabled: true,
    backup_limit_per_agent: "5",
    backup_storage_mb: "5120",
    backup_retention_days: "30",
  },
  enterprise: {
    managed_backups_enabled: true,
    backup_limit_per_agent: "30",
    backup_storage_mb: "102400",
    backup_retention_days: "180",
  },
};

type BackupSettingsPayload = Partial<typeof DEFAULT_FORM> & {
  s3AccessKeyConfigured?: boolean;
  s3SecretConfigured?: boolean;
  sshPrivateKeyConfigured?: boolean;
  sshPasswordConfigured?: boolean;
  installationSchedule?: {
    next_run_at?: string | null;
  } | null;
};

type BackupRow = {
  id: string;
  name?: string | null;
  kind?: string | null;
  status?: string | null;
  storage_backend?: string | null;
  size_bytes?: number | string | null;
  created_at?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  owner_email?: string | null;
};

function buildPlanLimitForm(payload: BackupPlanLimitPayload = {}) {
  const plans = (payload.plans || payload || {}) as Partial<
    Record<BackupPlanKey, BackupPlanLimitPayloadRow>
  >;
  return PLAN_KEYS.reduce<Record<BackupPlanKey, BackupPlanLimitFormRow>>(
    (form, plan) => {
      const source = plans[plan] || DEFAULT_PLAN_LIMITS[plan];
      form[plan] = {
        managed_backups_enabled: source.managed_backups_enabled === true,
        backup_limit_per_agent: String(
          source.backup_limit_per_agent ?? DEFAULT_PLAN_LIMITS[plan].backup_limit_per_agent,
        ),
        backup_storage_mb: String(
          source.backup_storage_mb ?? DEFAULT_PLAN_LIMITS[plan].backup_storage_mb,
        ),
        backup_retention_days: String(
          source.backup_retention_days ?? DEFAULT_PLAN_LIMITS[plan].backup_retention_days,
        ),
      };
      return form;
    },
    {} as Record<BackupPlanKey, BackupPlanLimitFormRow>,
  );
}

function serializePlanLimitForm(form: Record<BackupPlanKey, BackupPlanLimitFormRow>) {
  return {
    plans: PLAN_KEYS.reduce<Record<BackupPlanKey, BackupPlanLimitPayloadRow>>(
      (plans, plan) => {
        const source = form[plan] || DEFAULT_PLAN_LIMITS[plan];
        plans[plan] = {
          managed_backups_enabled: source.managed_backups_enabled === true,
          backup_limit_per_agent: Number(source.backup_limit_per_agent),
          backup_storage_mb: Number(source.backup_storage_mb),
          backup_retention_days: Number(source.backup_retention_days),
        };
        return plans;
      },
      {} as Record<BackupPlanKey, BackupPlanLimitPayloadRow>,
    ),
  };
}

function buildForm(settings: BackupSettingsPayload = {}) {
  return {
    ...DEFAULT_FORM,
    storageBackend: settings.storageBackend || DEFAULT_FORM.storageBackend,
    localPath: settings.localPath || DEFAULT_FORM.localPath,
    s3Bucket: settings.s3Bucket || "",
    s3Region: settings.s3Region || DEFAULT_FORM.s3Region,
    s3Endpoint: settings.s3Endpoint || "",
    sshHost: settings.sshHost || "",
    sshPort: settings.sshPort || DEFAULT_FORM.sshPort,
    sshUsername: settings.sshUsername || "",
    sshRemotePath: settings.sshRemotePath || DEFAULT_FORM.sshRemotePath,
    installationScheduleEnabled: settings.installationScheduleEnabled === true,
    installationScheduleFrequency:
      settings.installationScheduleFrequency || DEFAULT_FORM.installationScheduleFrequency,
    installationScheduleHourUtc:
      settings.installationScheduleHourUtc ?? DEFAULT_FORM.installationScheduleHourUtc,
    installationScheduleDayOfWeek:
      settings.installationScheduleDayOfWeek ?? DEFAULT_FORM.installationScheduleDayOfWeek,
  };
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatStatus(status) {
  return String(status || "queued").replace(/_/g, " ");
}

export default function BackupsAdminPage() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [planLimitSettings, setPlanLimitSettings] = useState(null);
  const [planLimitForm, setPlanLimitForm] = useState(buildPlanLimitForm());
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [planLimitSaving, setPlanLimitSaving] = useState(false);
  const [busy, setBusy] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [settingsRes, backupsRes, planLimitsRes] = await Promise.all([
        fetchWithAuth("/api/admin/settings/backups"),
        fetchWithAuth("/api/admin/backups"),
        fetchWithAuth("/api/admin/settings/backup-plan-limits"),
      ]);
      const settingsPayload = await settingsRes.json().catch(() => ({}));
      const backupsPayload = await backupsRes.json().catch(() => []);
      const planLimitsPayload = await planLimitsRes.json().catch(() => ({}));
      if (!settingsRes.ok) throw new Error(settingsPayload.error || "Failed to load settings");
      if (!backupsRes.ok) throw new Error("Failed to load backups");
      if (!planLimitsRes.ok) {
        throw new Error(planLimitsPayload.error || "Failed to load backup plan limits");
      }
      setSettings(settingsPayload);
      setForm(buildForm(settingsPayload));
      setPlanLimitSettings(planLimitsPayload);
      setPlanLimitForm(buildPlanLimitForm(planLimitsPayload));
      setBackups(Array.isArray(backupsPayload) ? backupsPayload : []);
    } catch (error) {
      toast.error(error.message || "Failed to load backups");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!backups.some((backup) => ["queued", "running"].includes(backup.status))) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [backups, load]);

  function updateField(key, value) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (
        key === "storageBackend" &&
        value === "r2" &&
        (!current.s3Region || current.s3Region === DEFAULT_FORM.s3Region)
      ) {
        next.s3Region = "auto";
      }
      if (key === "storageBackend" && value === "s3" && current.s3Region === "auto") {
        next.s3Region = DEFAULT_FORM.s3Region;
      }
      return next;
    });
  }

  function updatePlanLimitField(plan, key, value) {
    setPlanLimitForm((current) => ({
      ...current,
      [plan]: {
        ...(current[plan] || DEFAULT_PLAN_LIMITS[plan]),
        [key]: value,
      },
    }));
  }

  async function saveSettings() {
    setSaving(true);
    try {
      const response = await fetchWithAuth("/api/admin/settings/backups", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          sshPort: Number(form.sshPort),
          installationScheduleHourUtc: Number(form.installationScheduleHourUtc),
          installationScheduleDayOfWeek: Number(form.installationScheduleDayOfWeek),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to save backup settings");
      setSettings(payload);
      setForm(buildForm(payload));
      toast.success("Backup settings saved");
    } catch (error) {
      toast.error(error.message || "Failed to save backup settings");
    } finally {
      setSaving(false);
    }
  }

  async function savePlanLimits() {
    setPlanLimitSaving(true);
    try {
      const response = await fetchWithAuth("/api/admin/settings/backup-plan-limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serializePlanLimitForm(planLimitForm)),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to save backup plan limits");
      setPlanLimitSettings(payload);
      setPlanLimitForm(buildPlanLimitForm(payload));
      toast.success("Backup plan limits saved");
    } catch (error) {
      toast.error(error.message || "Failed to save backup plan limits");
    } finally {
      setPlanLimitSaving(false);
    }
  }

  async function createInstallationBackup() {
    setBusy("create-installation");
    try {
      const response = await fetchWithAuth("/api/admin/backups/installation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to queue installation backup");
      toast.success("Installation backup queued");
      await load();
    } catch (error) {
      toast.error(error.message || "Failed to queue installation backup");
    } finally {
      setBusy("");
    }
  }

  async function downloadBackup(backup) {
    setBusy(`download:${backup.id}`);
    try {
      const response = await fetchWithAuth(`/api/admin/backups/${backup.id}/download`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to download backup");
      }
      const disposition = response.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/i);
      const filename = match?.[1] || `${backup.name || "lpanel-backup"}.tgz`;
      const blob = await response.blob();
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
      const response = await fetchWithAuth(`/api/admin/backups/${backup.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to delete backup");
      toast.success("Backup deleted");
      await load();
    } catch (error) {
      toast.error(error.message || "Failed to delete backup");
    } finally {
      setBusy("");
    }
  }

  async function restoreBackup(backup) {
    const expectedName = backup.agent_name || "";
    const confirmed = window.prompt(
      `Type the target agent name to restore this backup in place:${expectedName ? ` ${expectedName}` : ""}`,
    );
    if (!confirmed) return;
    setBusy(`restore:${backup.id}`);
    try {
      const response = await fetchWithAuth(`/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_agent_id: backup.agent_id,
          confirm_agent_name: confirmed,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to restore backup");
      toast.success("Restore queued");
      await load();
    } catch (error) {
      toast.error(error.message || "Failed to restore backup");
    } finally {
      setBusy("");
    }
  }

  const readyCount = backups.filter((backup) =>
    ["ready", "ready_with_warnings"].includes(backup.status),
  ).length;
  const installationCount = backups.filter((backup) => backup.kind === "installation").length;

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              Backup Admin
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              Backups and storage
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              Configure local, S3, Cloudflare R2, or SSH backup storage and run scheduled
              installation backups.
            </p>
          </div>
          <button
            onClick={load}
            className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:bg-slate-50"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        <div className="grid gap-5 sm:grid-cols-3">
          <MetricCard
            label="Backups"
            value={formatCount(backups.length)}
            icon={Archive}
            tone="blue"
          />
          <MetricCard
            label="Ready"
            value={formatCount(readyCount)}
            icon={Download}
            tone="emerald"
          />
          <MetricCard
            label="Installation"
            value={formatCount(installationCount)}
            icon={Server}
            tone="purple"
          />
        </div>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-black text-slate-950">
                <SlidersHorizontal size={18} className="text-red-600" />
                Plan backup limits
              </h2>
              <p className="mt-1 text-sm font-medium text-slate-500">
                Billing-off installations use the self-hosted backup defaults. These tier defaults
                apply when PaaS billing is enabled.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-slate-100 px-3 py-2 text-xs font-black uppercase tracking-[0.16em] text-slate-600">
                {planLimitSettings?.billingEnabled ? "Billing on" : "Billing off"}
              </span>
              <button
                onClick={savePlanLimits}
                disabled={planLimitSaving}
                className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white transition-all hover:bg-red-700 disabled:opacity-60"
              >
                {planLimitSaving ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Save size={16} />
                )}
                Save limits
              </button>
            </div>
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[840px] text-left">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Tier
                  </th>
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Managed backups
                  </th>
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Backups per agent
                  </th>
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Storage MB
                  </th>
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Retention days
                  </th>
                </tr>
              </thead>
              <tbody>
                {PLAN_KEYS.map((plan) => {
                  const values = planLimitForm[plan] || DEFAULT_PLAN_LIMITS[plan];
                  return (
                    <tr key={plan} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-2 py-4 text-sm font-black text-slate-950">
                        {PLAN_LABELS[plan]}
                      </td>
                      <td className="px-2 py-4">
                        <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
                          <input
                            type="checkbox"
                            checked={values.managed_backups_enabled}
                            onChange={(event) =>
                              updatePlanLimitField(
                                plan,
                                "managed_backups_enabled",
                                event.target.checked,
                              )
                            }
                          />
                          Enabled
                        </label>
                      </td>
                      <td className="px-2 py-4">
                        <input
                          type="number"
                          min="0"
                          value={values.backup_limit_per_agent}
                          onChange={(event) =>
                            updatePlanLimitField(plan, "backup_limit_per_agent", event.target.value)
                          }
                          className="w-36 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold outline-none"
                        />
                      </td>
                      <td className="px-2 py-4">
                        <input
                          type="number"
                          min="0"
                          value={values.backup_storage_mb}
                          onChange={(event) =>
                            updatePlanLimitField(plan, "backup_storage_mb", event.target.value)
                          }
                          className="w-36 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold outline-none"
                        />
                      </td>
                      <td className="px-2 py-4">
                        <input
                          type="number"
                          min="0"
                          value={values.backup_retention_days}
                          onChange={(event) =>
                            updatePlanLimitField(plan, "backup_retention_days", event.target.value)
                          }
                          className="w-36 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold outline-none"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-black text-slate-950">Storage destination</h2>
              <p className="mt-1 text-sm font-medium text-slate-500">
                R2 uses the S3-compatible endpoint and credentials.
              </p>
            </div>
            <button
              onClick={saveSettings}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white transition-all hover:bg-red-700 disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              Save settings
            </button>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                Backend
              </span>
              <select
                value={form.storageBackend}
                onChange={(event) => updateField("storageBackend", event.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800 outline-none"
              >
                <option value="local">Local volume</option>
                <option value="s3">Amazon S3</option>
                <option value="r2">Cloudflare R2</option>
                <option value="ssh">SSH remote path</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                Local path
              </span>
              <input
                value={form.localPath}
                onChange={(event) => updateField("localPath", event.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800 outline-none"
              />
            </label>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <input
              placeholder="S3/R2 bucket"
              value={form.s3Bucket}
              onChange={(event) => updateField("s3Bucket", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <input
              placeholder="Region"
              value={form.s3Region}
              onChange={(event) => updateField("s3Region", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <input
              placeholder="Endpoint URL for R2 or S3-compatible storage"
              value={form.s3Endpoint}
              onChange={(event) => updateField("s3Endpoint", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <input
              placeholder={
                settings?.s3AccessKeyConfigured ? "Access key configured" : "Access key ID"
              }
              value={form.s3AccessKeyId}
              onChange={(event) => updateField("s3AccessKeyId", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <input
              type="password"
              placeholder={settings?.s3SecretConfigured ? "Secret configured" : "Secret access key"}
              value={form.s3SecretAccessKey}
              onChange={(event) => updateField("s3SecretAccessKey", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <input
              placeholder="SSH host"
              value={form.sshHost}
              onChange={(event) => updateField("sshHost", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <input
              type="number"
              placeholder="Port"
              value={form.sshPort}
              onChange={(event) => updateField("sshPort", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <input
              placeholder="SSH username"
              value={form.sshUsername}
              onChange={(event) => updateField("sshUsername", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <input
              placeholder="Remote path"
              value={form.sshRemotePath}
              onChange={(event) => updateField("sshRemotePath", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <input
              type="password"
              placeholder={
                settings?.sshPasswordConfigured ? "SSH password configured" : "SSH password"
              }
              value={form.sshPassword}
              onChange={(event) => updateField("sshPassword", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
          </div>
          <textarea
            placeholder={
              settings?.sshPrivateKeyConfigured ? "SSH private key configured" : "SSH private key"
            }
            value={form.sshPrivateKey}
            onChange={(event) => updateField("sshPrivateKey", event.target.value)}
            rows={4}
            className="mt-4 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-xs font-semibold outline-none"
          />
        </section>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-black text-slate-950">
                <CalendarClock size={18} className="text-red-600" />
                Installation schedule
              </h2>
              <p className="mt-1 text-sm font-medium text-slate-500">
                Runs a full installation backup through the backup worker.
              </p>
            </div>
            <button
              onClick={createInstallationBackup}
              disabled={busy === "create-installation"}
              className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition-all hover:bg-slate-800 disabled:opacity-60"
            >
              {busy === "create-installation" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Archive size={16} />
              )}
              Run now
            </button>
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-4">
            <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
              <input
                type="checkbox"
                checked={form.installationScheduleEnabled}
                onChange={(event) =>
                  updateField("installationScheduleEnabled", event.target.checked)
                }
              />
              Enabled
            </label>
            <select
              value={form.installationScheduleFrequency}
              onChange={(event) => updateField("installationScheduleFrequency", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            >
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
            <input
              type="number"
              min="0"
              max="23"
              value={form.installationScheduleHourUtc}
              onChange={(event) => updateField("installationScheduleHourUtc", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
            />
            <select
              value={form.installationScheduleDayOfWeek}
              disabled={form.installationScheduleFrequency !== "weekly"}
              onChange={(event) => updateField("installationScheduleDayOfWeek", event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none disabled:opacity-50"
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
          {settings?.installationSchedule?.next_run_at ? (
            <p className="mt-3 text-xs font-semibold text-slate-500">
              Next run: {formatDateTime(settings.installationSchedule.next_run_at)}
            </p>
          ) : null}
        </section>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-black text-slate-950">Backup inventory</h2>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Name
                  </th>
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Kind
                  </th>
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Status
                  </th>
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Size
                  </th>
                  <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Created
                  </th>
                  <th className="px-2 py-3 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => {
                  const ready =
                    backup.status === "ready" || backup.status === "ready_with_warnings";
                  return (
                    <tr key={backup.id} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-2 py-4">
                        <p className="text-sm font-semibold text-slate-950">{backup.name}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {backup.agent_name || backup.owner_email || backup.id.slice(0, 8)}
                        </p>
                      </td>
                      <td className="px-2 py-4 text-sm font-semibold text-slate-700">
                        {backup.kind}
                        {backup.storage_backend ? (
                          <span className="ml-2 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-slate-500">
                            {backup.storage_backend}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-4 text-sm font-semibold text-slate-700">
                        {formatStatus(backup.status)}
                      </td>
                      <td className="px-2 py-4 text-sm font-semibold text-slate-700">
                        {formatBytes(backup.size_bytes)}
                      </td>
                      <td className="px-2 py-4 text-sm font-medium text-slate-500">
                        {formatDateTime(backup.created_at)}
                      </td>
                      <td className="px-2 py-4">
                        <div className="flex justify-end gap-2">
                          <button
                            disabled={!ready || !!busy}
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
                          {backup.kind === "agent" ? (
                            <button
                              disabled={!ready || !!busy}
                              onClick={() => restoreBackup(backup)}
                              className="inline-flex items-center gap-2 rounded-xl border border-amber-200 px-3 py-2 text-xs font-bold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                            >
                              {busy === `restore:${backup.id}` ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <RotateCcw size={14} />
                              )}
                              Restore
                            </button>
                          ) : null}
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
                      </td>
                    </tr>
                  );
                })}
                {backups.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-2 py-12 text-center text-sm font-semibold text-slate-400"
                    >
                      No backups found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
