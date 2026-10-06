import { useEffect, useMemo, useState } from "react";
import {
  Mail,
  Shield,
  Clock,
  ChevronDown,
  RefreshCw,
  Save,
  Unplug,
  Link2,
  Loader2,
} from "lucide-react";
import {
  buildInitialValues,
  normalizeFieldValue,
  partitionVisibleFields,
  readFieldValue,
} from "./integrationFormUtils";

const REDACTED_SECRET = "[REDACTED]";
const EMAIL_CONNECTION_ADVANCED_KEYS = new Set([
  "imap.host",
  "imap.port",
  "imap.secure",
  "smtp.host",
  "smtp.port",
  "smtp.secure",
]);
const DEFAULT_WECOM_AGENT_CALLBACK_PATH = "/plugins/wecom/agent/default";

function connectionStatusLabel(integration: any) {
  return integration?.status || "active";
}

function authModeLabel(config: any) {
  return config?.auth?.mode || "unknown";
}

function providerPresetLabel(config: any, provider: string) {
  return config?.providerPreset || provider || "custom";
}

function formatVerificationTimestamp(value: any) {
  if (!value) return "Not yet verified";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "Not yet verified";
  }
}

function isWecomBotField(field: any) {
  return typeof field?.key === "string" && field.key.startsWith("defaultAccount.bot.");
}

function isWecomAgentField(field: any) {
  return typeof field?.key === "string" && field.key.startsWith("defaultAccount.agent.");
}

function partitionWecomModeFields(fields: any[]) {
  const shared: any[] = [];
  const bot: any[] = [];
  const agent: any[] = [];

  for (const field of fields || []) {
    if (isWecomBotField(field)) {
      bot.push(field);
      continue;
    }
    if (isWecomAgentField(field)) {
      agent.push(field);
      continue;
    }
    shared.push(field);
  }

  return { shared, bot, agent };
}

export default function IntegrationDetailPanel({
  integration,
  catalogItem,
  onTest,
  onDisconnect,
  onSave,
  saving,
}: any) {
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [configExpanded, setConfigExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const configFields = useMemo(
    () => integration?.configFields || catalogItem?.configFields || [],
    [integration, catalogItem],
  );

  useEffect(() => {
    if (!integration) {
      setFormValues({});
      return;
    }
    setFormValues(buildInitialValues(integration?.config || {}, configFields));
    setConfigExpanded(false);
    setAdvancedExpanded(false);
  }, [integration, configFields]);

  if (!integration) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-sm text-slate-500">
        Select an active integration to inspect and edit its configuration.
      </div>
    );
  }

  const name = integration.name || integration.catalog_name || integration.provider;
  const config = integration.config || {};
  const isEmailIntegration = integration.provider === "email";
  const isWecomIntegration = integration.provider === "wecom";
  const emailVerification = config?.verification || {};
  const emailReadiness =
    emailVerification?.lastSuccess === true
      ? "ready"
      : emailVerification?.lastSuccess === false
        ? "error"
        : "pending_verification";
  const emailReadinessLabel =
    emailReadiness === "ready"
      ? "Verified"
      : emailReadiness === "error"
        ? "Failed"
        : "Not yet verified";
  const emailReadinessClass =
    emailReadiness === "ready"
      ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
      : emailReadiness === "error"
        ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
        : "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  const wecomMode = config?.mode || "bot";
  const wecomActivation = config?.activation || {};
  const wecomReadiness = wecomActivation?.readiness || "pending_activation";
  const wecomReadinessLabel =
    wecomReadiness === "ready" ? "Ready" : wecomReadiness === "error" ? "Error" : "Pending";
  const wecomReadinessClass =
    wecomReadiness === "ready"
      ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
      : wecomReadiness === "error"
        ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
        : "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  const wecomCallbackPath =
    config?.defaultAccount?.agent?.callbackPath || DEFAULT_WECOM_AGENT_CALLBACK_PATH;
  const wecomCallbackUrl = useMemo(() => {
    if (typeof window === "undefined" || !wecomCallbackPath) return "";
    try {
      return new URL(wecomCallbackPath, window.location.origin).toString();
    } catch {
      return wecomCallbackPath;
    }
  }, [wecomCallbackPath]);
  const { basicFields, advancedFields } = partitionVisibleFields(configFields, formValues, {
    advancedKeys: isEmailIntegration ? EMAIL_CONNECTION_ADVANCED_KEYS : undefined,
  });
  const cronToggleField = isEmailIntegration
    ? configFields.find((field: any) => field.key === "cron.enabled")
    : null;
  const cronConfigFields = isEmailIntegration
    ? configFields.filter(
        (field: any) => field.key === "cron.intervalMinutes" || field.key === "cron.prompt",
      )
    : [];
  const hasCronAssociation = Boolean(integration?.cron_job_id);
  const cronEnabled = Boolean(formValues["cron.enabled"]);

  const hasUnsavedChanges = configFields.some((field: any) => {
    const original = normalizeFieldValue(field, readFieldValue(config, field.key));
    const current = formValues[field.key];
    return JSON.stringify(original) !== JSON.stringify(current);
  });

  function updateFieldValue(field: any, value: any) {
    setFormValues((current) => ({ ...current, [field.key]: value }));
  }

  async function handleSave() {
    const nextConfig = (configFields || []).reduce(
      (acc, field) => {
        const value = formValues[field.key];
        if (field.type === "password") {
          if (typeof value === "string" && value.trim()) {
            acc[field.key] = value;
          }
          return acc;
        }
        acc[field.key] = value;
        return acc;
      },
      {} as Record<string, any>,
    );
    await onSave?.(integration, nextConfig);
  }

  function renderField(field: any) {
    const value = formValues[field.key];
    const existingValue = readFieldValue(config, field.key);
    const hasStoredSecret =
      field.type === "password" &&
      existingValue != null &&
      existingValue !== "" &&
      existingValue !== REDACTED_SECRET;

    return (
      <div key={field.key}>
        <label className="mb-1 block text-xs font-bold text-slate-600">
          {field.label} {field.required ? <span className="text-rose-500">*</span> : null}
        </label>
        {field.description ? (
          <p className="mb-1 text-xs leading-relaxed text-slate-500">{field.description}</p>
        ) : null}
        {field.type === "textarea" ? (
          <textarea
            value={value ?? ""}
            onChange={(event) => updateFieldValue(field, event.target.value)}
            rows={4}
            placeholder={field.placeholder || ""}
            className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        ) : field.type === "select" ? (
          <select
            value={value ?? field.defaultValue ?? ""}
            onChange={(event) => updateFieldValue(field, event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          >
            <option value="">Select…</option>
            {(field.options || []).map((option: any) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : field.type === "checkbox" ? (
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(event) => updateFieldValue(field, event.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            Enable
          </label>
        ) : (
          <input
            type={
              field.type === "password"
                ? "password"
                : field.type === "number"
                  ? "number"
                  : field.type === "email"
                    ? "email"
                    : field.type === "url"
                      ? "url"
                      : "text"
            }
            value={value ?? ""}
            onChange={(event) =>
              updateFieldValue(
                field,
                field.type === "number"
                  ? event.target.value === ""
                    ? ""
                    : Number(event.target.value)
                  : event.target.value,
              )
            }
            placeholder={
              field.type === "password" && (existingValue === REDACTED_SECRET || hasStoredSecret)
                ? "Leave blank to keep current secret"
                : field.placeholder || (field.type === "url" ? "https://..." : "")
            }
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        )}
      </div>
    );
  }

  function renderWecomModeSections(fields: any[]) {
    const { shared, bot, agent } = partitionWecomModeFields(fields);
    const shouldSeparate = wecomMode === "both" && bot.length > 0 && agent.length > 0;

    if (!shouldSeparate) {
      return <div className="grid gap-3 md:grid-cols-2">{fields.map(renderField)}</div>;
    }

    return (
      <div className="space-y-4">
        {shared.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">{shared.map(renderField)}</div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-4">
            <div className="mb-3">
              <div className="text-xs font-bold uppercase tracking-wide text-sky-700">
                Bot Configuration
              </div>
              <p className="mt-1 text-xs text-sky-900/75">
                WebSocket bot credentials used for the Bot connection path.
              </p>
            </div>
            <div className="space-y-3">{bot.map(renderField)}</div>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4">
            <div className="mb-3">
              <div className="text-xs font-bold uppercase tracking-wide text-emerald-700">
                Agent Configuration
              </div>
              <p className="mt-1 text-xs text-emerald-900/75">
                Enterprise app credentials and callback settings used for Agent mode.
              </p>
            </div>
            <div className="space-y-3">{agent.map(renderField)}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-slate-900">{name}</h3>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              {providerPresetLabel(config, integration.provider)}
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Update the connected integration and save the new config back to LPanel.
          </p>
        </div>
        <span className="rounded-full bg-slate-900 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
          {connectionStatusLabel(integration)}
        </span>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {isEmailIntegration ? (
          <>
            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Mail size={12} />
                Mailbox Summary
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">Mailbox Identity</dt>
                  <dd className="font-medium text-slate-900">
                    {config?.auth?.username || config?.smtp?.fromAddress || "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">From Address</dt>
                  <dd className="font-medium text-slate-900">
                    {config?.smtp?.fromAddress || config?.from_address || "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Auth Mode</dt>
                  <dd className="font-medium capitalize text-slate-900">{authModeLabel(config)}</dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Clock size={12} />
                Status
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">State</dt>
                  <dd className="font-medium text-slate-900">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${emailReadinessClass}`}
                    >
                      {emailReadinessLabel}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Last Verified</dt>
                  <dd className="font-medium text-slate-900">
                    {formatVerificationTimestamp(emailVerification?.lastTestAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Verification Result</dt>
                  <dd className="font-medium text-slate-900">
                    {emailVerification?.lastSuccess === true
                      ? "Connection verified"
                      : emailVerification?.lastSuccess === false
                        ? emailVerification?.lastError || "Connection test failed"
                        : "Run Test to verify this mailbox connection."}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Clock size={12} />
                Cron Setup
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">Reminder Cron Enabled</dt>
                  <dd className="font-medium text-slate-900">
                    {config?.cron?.enabled ? "Yes" : "No"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Interval</dt>
                  <dd className="font-medium text-slate-900">
                    {config?.cron?.enabled
                      ? config?.cron?.intervalMinutes
                        ? `${config.cron.intervalMinutes} minutes`
                        : "Not configured"
                      : "Disabled"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Prompt</dt>
                  <dd className="font-medium text-slate-900">
                    {config?.cron?.enabled ? config?.cron?.prompt || "Not configured" : "Disabled"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4 md:col-span-2">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Shield size={12} />
                Operator Guidance
              </div>
              <div className="mt-3 space-y-2 text-sm text-slate-700">
                {emailVerification?.lastSuccess === false ? (
                  <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                    {emailVerification?.lastError || "The last mailbox verification failed."}
                  </p>
                ) : null}
                {emailVerification?.lastSuccess === null ||
                typeof emailVerification?.lastSuccess !== "boolean" ? (
                  <p>
                    Run <span className="font-medium">Test</span> after saving to verify IMAP and
                    SMTP access.
                  </p>
                ) : null}
                {emailVerification?.lastSuccess === true ? (
                  <p>Re-run Test after any credential or server setting change.</p>
                ) : null}
              </div>
            </section>
          </>
        ) : isWecomIntegration ? (
          <>
            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Mail size={12} />
                WeCom Summary
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">Mode</dt>
                  <dd className="font-medium capitalize text-slate-900">
                    {config?.mode || "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Default Account</dt>
                  <dd className="font-medium text-slate-900">
                    {config?.defaultAccount?.label || "Default"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Extra Accounts</dt>
                  <dd className="font-medium text-slate-900">
                    {Array.isArray(config?.accounts) ? config.accounts.length : 0}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Clock size={12} />
                Status
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">State</dt>
                  <dd className="font-medium text-slate-900">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${wecomReadinessClass}`}
                    >
                      {wecomReadinessLabel}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Lifecycle</dt>
                  <dd className="font-medium text-slate-900">
                    {wecomActivation?.lifecycleStatus || "saved"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Last Verified</dt>
                  <dd className="font-medium text-slate-900">
                    {wecomActivation?.lastVerifiedAt
                      ? new Date(wecomActivation.lastVerifiedAt).toLocaleString()
                      : "Not yet verified"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Result</dt>
                  <dd className="font-medium text-slate-900">
                    {wecomActivation?.lastError
                      ? wecomActivation.lastError
                      : wecomReadiness === "ready"
                        ? "Runtime activation verified"
                        : wecomReadiness === "pending_activation"
                          ? "Start the agent and run Test to verify activation."
                          : "Run Test to verify the current runtime state."}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Link2 size={12} />
                Runtime Details
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">Callback Path</dt>
                  <dd className="font-medium text-slate-900">
                    {wecomCallbackPath || "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Browser-Resolved Callback URL</dt>
                  <dd className="break-all font-medium text-slate-900">
                    {wecomCallbackUrl || "Not available in this browser context"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4 md:col-span-2">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Shield size={12} />
                Operator Guidance
              </div>
              <div className="mt-3 space-y-2 text-sm text-slate-700">
                {wecomActivation?.lastError ? (
                  <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                    {wecomActivation.lastError}
                  </p>
                ) : null}
                {wecomActivation?.readiness === "pending_activation" ? (
                  <p>
                    Start the OpenClaw agent, then run <span className="font-medium">Test</span> to
                    finish plugin verification and refresh the saved activation state.
                  </p>
                ) : null}
                {wecomMode === "agent" || wecomMode === "both" ? (
                  <p>
                    Agent mode still needs the WeCom admin console callback setup to use your public
                    LPanel/OpenClaw host with this path:{" "}
                    <span className="font-mono text-xs">{wecomCallbackPath}</span>.
                  </p>
                ) : null}
                {(wecomMode === "agent" || wecomMode === "both") && wecomCallbackUrl ? (
                  <p className="text-xs text-slate-500">
                    The browser-resolved URL above is only a preview based on the host you are
                    currently using to access LPanel. If WeCom reaches LPanel through a tunnel or public
                    domain, use that public base URL instead.
                  </p>
                ) : null}
                {wecomActivation?.readiness === "ready" ? (
                  <p>
                    Runtime activation looks healthy. Re-run Test after any config change to confirm
                    the gateway picked it up.
                  </p>
                ) : null}
              </div>
            </section>
          </>
        ) : (
          <section className="rounded-xl border border-slate-100 bg-slate-50 p-4 md:col-span-2">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
              <Mail size={12} />
              Integration Summary
            </div>
            <dl className="mt-3 grid gap-3 text-sm md:grid-cols-3">
              <div>
                <dt className="text-xs text-slate-500">Provider</dt>
                <dd className="font-medium text-slate-900">{integration.provider}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Status</dt>
                <dd className="font-medium text-slate-900">{connectionStatusLabel(integration)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Preset</dt>
                <dd className="font-medium text-slate-900">
                  {providerPresetLabel(config, integration.provider)}
                </dd>
              </div>
            </dl>
          </section>
        )}

        <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            <Link2 size={12} />
            Actions
          </div>
          {hasCronAssociation ? (
            <p className="mt-3 text-xs text-slate-500">
              This integration manages cron job{" "}
              <span className="font-mono">{integration.cron_job_id}</span>.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !hasUnsavedChanges || configFields.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save Changes
            </button>
            <button
              type="button"
              onClick={() => onTest?.(integration)}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-800"
            >
              <RefreshCw size={12} />
              Retest
            </button>
            <button
              type="button"
              onClick={() => onDisconnect?.()}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100"
            >
              <Unplug size={12} />
              Disconnect
            </button>
          </div>
        </section>
      </div>

      {configFields.length > 0 ? (
        <div className="mt-6 space-y-4">
          <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
            <button
              type="button"
              onClick={() => setConfigExpanded((current) => !current)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Shield size={12} />
                Configuration
              </div>
              <ChevronDown
                size={14}
                className={`text-slate-400 transition-transform ${configExpanded ? "rotate-180" : ""}`}
              />
            </button>
            {configExpanded ? (
              <div className="mt-3">
                {isWecomIntegration ? (
                  renderWecomModeSections(basicFields)
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">{basicFields.map(renderField)}</div>
                )}
              </div>
            ) : null}
          </section>

          {advancedFields.length > 0 ||
          (isEmailIntegration && (cronToggleField || cronConfigFields.length > 0)) ? (
            <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <button
                type="button"
                onClick={() => setAdvancedExpanded((current) => !current)}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                  <Shield size={12} />
                  Advanced
                </div>
                <ChevronDown
                  size={14}
                  className={`text-slate-400 transition-transform ${advancedExpanded ? "rotate-180" : ""}`}
                />
              </button>
              {advancedExpanded ? (
                <div className="mt-3 space-y-4">
                  {advancedFields.length > 0 ? (
                    <div className="space-y-3">
                      <div>
                        <div className="text-xs font-bold uppercase tracking-wide text-slate-500">
                          {isEmailIntegration ? "Connection Overrides" : "Advanced Fields"}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {isEmailIntegration
                            ? "Adjust IMAP and SMTP server settings only if you need something other than the provider preset defaults."
                            : "Optional provider-specific fields that are usually only needed for a more customized setup."}
                        </p>
                      </div>
                      {isWecomIntegration ? (
                        renderWecomModeSections(advancedFields)
                      ) : (
                        <div className="grid gap-3 md:grid-cols-2">
                          {advancedFields.map(renderField)}
                        </div>
                      )}
                    </div>
                  ) : null}

                  {cronToggleField || cronConfigFields.length > 0 ? (
                    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
                      <div>
                        <div className="text-xs font-bold uppercase tracking-wide text-slate-500">
                          Reminder Cron
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          Create a normal scheduled agent turn seeded from this mailbox connection.
                        </p>
                      </div>

                      {cronToggleField ? renderField(cronToggleField) : null}

                      {cronEnabled ? (
                        <div className="grid gap-3 md:grid-cols-2">
                          {cronConfigFields.map(renderField)}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                          Turn on the reminder cron to choose how often it runs and what prompt it
                          should use.
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          This integration does not expose editable fields in the current catalog.
        </div>
      )}
    </div>
  );
}
