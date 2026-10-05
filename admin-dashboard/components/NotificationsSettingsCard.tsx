import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Mail, RefreshCw, Save, Send, AlertCircle } from "lucide-react";
import { fetchWithAuth } from "../lib/api";
import { useToast } from "./Toast";
import { useI18n } from "../lib/i18n";

interface SmtpSettings {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpFromAddress: string;
  smtpFromName: string;
  smtpPasswordMasked: string;
  smtpConfigured: boolean;
}

const EMPTY: SmtpSettings = {
  smtpHost: "",
  smtpPort: 587,
  smtpSecure: false,
  smtpUsername: "",
  smtpFromAddress: "",
  smtpFromName: "Headmaster",
  smtpPasswordMasked: "",
  smtpConfigured: false,
};

export default function NotificationsSettingsCard() {
  const { t } = useI18n();
  const toast = useToast();
  const [settings, setSettings] = useState<SmtpSettings>(EMPTY);
  const [form, setForm] = useState<
    Partial<SmtpSettings & { smtpPassword: string; clearSmtpPassword: boolean }>
  >({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetchWithAuth("/api/admin/settings/notifications");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const payload = (await res.json()) as SmtpSettings;
      setSettings(payload);
      setForm({});
    } catch (err: any) {
      toast.error(err?.message || t("Failed to load SMTP settings"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const body = {
        smtpHost: form.smtpHost ?? settings.smtpHost,
        smtpPort: form.smtpPort ?? settings.smtpPort,
        smtpSecure: form.smtpSecure ?? settings.smtpSecure,
        smtpUsername: form.smtpUsername ?? settings.smtpUsername,
        smtpFromAddress: form.smtpFromAddress ?? settings.smtpFromAddress,
        smtpFromName: form.smtpFromName ?? settings.smtpFromName,
        smtpPassword: form.smtpPassword,
        clearSmtpPassword: Boolean(form.clearSmtpPassword),
      };
      const res = await fetchWithAuth("/api/admin/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || `Save failed (${res.status})`);
      }
      const updated = (await res.json()) as SmtpSettings;
      setSettings(updated);
      setForm({});
      toast.success(t("SMTP settings saved"));
    } catch (err: any) {
      toast.error(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetchWithAuth("/api/admin/settings/notifications/test", {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok && payload.delivered) {
        toast.success(t("Test email sent"));
      } else {
        toast.error(payload.error || t("Test email failed"));
      }
    } catch (err: any) {
      toast.error(err?.message || "Test email failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex items-center gap-3 mb-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
          <Mail size={22} />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-black tracking-tight text-slate-950">
            {t("Notifications (SMTP)")}
          </h2>
          <p className="text-xs text-slate-500">
            {t(
              "One platform-wide SMTP config drives invitation emails and the email channel for alert rules.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      <div className="mb-4">
        {settings.smtpConfigured ? (
          <span className="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-black uppercase tracking-widest text-emerald-700">
            <CheckCircle2 size={12} />
            {t("Configured")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-black uppercase tracking-widest text-slate-500">
            <AlertCircle size={12} />
            {t("Not configured")}
          </span>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label={t("SMTP host")}
            value={form.smtpHost ?? settings.smtpHost}
            onChange={(v) => update("smtpHost", v)}
            placeholder="smtp.example.com"
          />
          <Field
            label={t("Port")}
            type="number"
            value={String(form.smtpPort ?? settings.smtpPort)}
            onChange={(v) => update("smtpPort", Number(v))}
            placeholder="587"
          />
          <Field
            label={t("Username")}
            value={form.smtpUsername ?? settings.smtpUsername}
            onChange={(v) => update("smtpUsername", v)}
            placeholder="apikey"
          />
          <Field
            label={t("Password")}
            type="password"
            value={form.smtpPassword ?? ""}
            onChange={(v) => update("smtpPassword", v)}
            placeholder={settings.smtpPasswordMasked || t("Leave blank to keep")}
            autoComplete="new-password"
          />
          <Field
            label={t("From address")}
            type="email"
            value={form.smtpFromAddress ?? settings.smtpFromAddress}
            onChange={(v) => update("smtpFromAddress", v)}
            placeholder="alerts@example.com"
          />
          <Field
            label={t("From name")}
            value={form.smtpFromName ?? settings.smtpFromName}
            onChange={(v) => update("smtpFromName", v)}
            placeholder="Headmaster"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.smtpSecure ?? settings.smtpSecure}
            onChange={(e) => update("smtpSecure", e.target.checked)}
          />
          {t("Use TLS (auto-on for port 465)")}
        </label>

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {t("Save SMTP settings")}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || !settings.smtpConfigured}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title={settings.smtpConfigured ? "" : t("Save SMTP settings first")}
          >
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {t("Send test email to me")}
          </button>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-blue-300"
      />
    </label>
  );
}
