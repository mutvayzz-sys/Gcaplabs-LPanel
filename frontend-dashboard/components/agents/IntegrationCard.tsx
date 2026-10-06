import { useState } from "react";
import {
  Puzzle,
  X,
  Loader2,
  CheckCircle,
  XCircle,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  Cpu,
} from "lucide-react";
import { buildInitialValues, partitionVisibleFields } from "./integrationFormUtils";

type IntegrationCardProps = {
  item: any;
  installed?: any;
  onConnect?: (configValues?: Record<string, any>) => Promise<any> | any;
  onDisconnect?: () => Promise<void> | void;
  onTest?: (integration: any) => Promise<any> | any;
  directConnect?: boolean;
  submitLabel?: string;
};

// Computes the redirect URI an operator must register in the provider's
// OAuth app (e.g. LinkedIn developers console, X developer portal).
function computeOAuthRedirectUri(providerId: string): string {
  if (typeof window === "undefined" || !providerId) return "";
  return `${window.location.origin}/api/integrations/${providerId}/oauth/callback`;
}

const EMAIL_PROVIDER_DEFAULTS: Record<string, Record<string, any>> = {
  gmail: {
    "imap.host": "imap.gmail.com",
    "imap.port": 993,
    "imap.secure": true,
    "smtp.host": "smtp.gmail.com",
    "smtp.port": 465,
    "smtp.secure": true,
  },
  outlook: {
    "imap.host": "outlook.office365.com",
    "imap.port": 993,
    "imap.secure": true,
    "smtp.host": "smtp.office365.com",
    "smtp.port": 587,
    "smtp.secure": false,
  },
  custom: {
    "imap.host": "",
    "imap.port": 993,
    "imap.secure": true,
    "smtp.host": "",
    "smtp.port": 465,
    "smtp.secure": true,
  },
};

const EMAIL_CONNECTION_ADVANCED_KEYS = new Set([
  "imap.host",
  "imap.port",
  "imap.secure",
  "smtp.host",
  "smtp.port",
  "smtp.secure",
]);

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

const EMAIL_CRON_KEYS = new Set(["cron.enabled", "cron.intervalMinutes", "cron.prompt"]);

export default function IntegrationCard({
  item,
  installed,
  onConnect,
  onDisconnect,
  onTest,
  directConnect = false,
  submitLabel = "Connect & Test",
}: IntegrationCardProps) {
  const [showConfig, setShowConfig] = useState(false);
  const [configValues, setConfigValues] = useState({});
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testResult, setTestResult] = useState(null); // { success, message }
  const [redirectCopied, setRedirectCopied] = useState(false);

  const name = item.name || item.catalog_name || item.provider;
  const description = item.description || item.catalog_description || "";
  const category = item.category || item.catalog_category || "";
  const configFields = item.configFields || [];
  const isInstalled = !!installed;
  const isOAuth2 = item.authType === "oauth2";
  const redirectUri = isOAuth2 ? computeOAuthRedirectUri(item.id || item.provider) : "";
  const usageHints = Array.isArray(item.usageHints) ? item.usageHints : [];
  const credentialsUrl: string = typeof item.credentialsUrl === "string" ? item.credentialsUrl : "";
  const setupSteps: string[] = Array.isArray(item.setupGuide?.steps) ? item.setupGuide.steps : [];
  const setupScopes: string[] = Array.isArray(item.setupGuide?.scopes)
    ? item.setupGuide.scopes
    : [];
  const mcpAvailable = item.mcp && item.mcp.available === true;
  const isEmailIntegration = (item?.id || item?.provider || item?.catalog_id) === "email";

  async function copyRedirectUri() {
    if (!redirectUri || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setRedirectCopied(true);
      setTimeout(() => setRedirectCopied(false), 2000);
    } catch {
      // Clipboard API blocked (insecure context, permission denied) — silent.
    }
  }

  function applyEmailPresetDefaults(values: Record<string, any>) {
    if (!isEmailIntegration) return values;
    const preset = values.providerPreset || "gmail";
    return {
      ...EMAIL_PROVIDER_DEFAULTS.gmail,
      ...values,
      ...(EMAIL_PROVIDER_DEFAULTS[preset] || {}),
      providerPreset: preset,
    };
  }

  function buildInitialConfigValues() {
    const initialValues = buildInitialValues({}, configFields);
    return applyEmailPresetDefaults(initialValues);
  }

  function updateConfigValue(fieldKey: string, value: any) {
    setConfigValues((prev) => {
      const next = { ...prev, [fieldKey]: value };

      if (fieldKey === "providerPreset" && isEmailIntegration) {
        return applyEmailPresetDefaults(next);
      }

      if (isEmailIntegration && fieldKey === "auth.username") {
        if (!prev["smtp.fromAddress"] || prev["smtp.fromAddress"] === prev["auth.username"]) {
          next["smtp.fromAddress"] = value;
        }
      }

      return next;
    });
  }

  const categoryColors = {
    "developer-tools": "bg-blue-50 text-blue-700",
    communication: "bg-purple-50 text-purple-700",
    "ai-ml": "bg-emerald-50 text-emerald-700",
    cloud: "bg-orange-50 text-orange-700",
    data: "bg-yellow-50 text-yellow-700",
    monitoring: "bg-red-50 text-red-700",
    productivity: "bg-teal-50 text-teal-700",
    crm: "bg-indigo-50 text-indigo-700",
    storage: "bg-cyan-50 text-cyan-700",
    payment: "bg-green-50 text-green-700",
    social: "bg-pink-50 text-pink-700",
    analytics: "bg-violet-50 text-violet-700",
    search: "bg-amber-50 text-amber-700",
    devops: "bg-lime-50 text-lime-700",
    automation: "bg-fuchsia-50 text-fuchsia-700",
    ecommerce: "bg-rose-50 text-rose-700",
  };

  async function handleConnectClick() {
    if (directConnect) {
      setConnecting(true);
      setTestResult(null);
      try {
        await onConnect?.();
      } finally {
        setConnecting(false);
      }
      return;
    }

    if (configFields.length > 0) {
      setConfigValues(buildInitialConfigValues());
      setShowAdvanced(false);
      setShowConfig(true);
      setTestResult(null);
    } else {
      onConnect?.();
    }
  }

  async function handleConfigSubmit() {
    setConnecting(true);
    setTestResult(null);
    try {
      const result = await onConnect?.(configValues);
      if (result?.testResult) {
        setTestResult(result.testResult);
      }
      if (result?.testResult?.success) {
        setTimeout(() => {
          setShowConfig(false);
          setConfigValues({});
        }, 1500);
      }
    } catch {
      setTestResult({ success: false, message: "Connection failed" });
    } finally {
      setConnecting(false);
    }
  }

  async function handleTest() {
    if (!installed || !onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTest(installed);
      setTestResult(result);
    } catch {
      setTestResult({ success: false, message: "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  const { basicFields, advancedFields } = partitionVisibleFields(configFields, configValues, {
    advancedKeys: isEmailIntegration ? EMAIL_CONNECTION_ADVANCED_KEYS : undefined,
  });
  const isWecomIntegration = (item?.id || item?.provider || item?.catalog_id) === "wecom";
  const installedConfig =
    item?.installed?.config && typeof item.installed.config === "object"
      ? item.installed.config
      : {};
  const wecomMode = (configValues as any).mode || (installedConfig as any).mode || "bot";
  const cronToggleField = isEmailIntegration
    ? configFields.find((field) => field.key === "cron.enabled")
    : null;
  const cronConfigFields = isEmailIntegration
    ? configFields.filter(
        (field) => field.key === "cron.intervalMinutes" || field.key === "cron.prompt",
      )
    : [];
  const cronEnabled = Boolean(configValues["cron.enabled"]);

  function renderField(field: any) {
    return (
      <div key={field.key}>
        <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest block mb-1">
          {field.label} {field.required && <span className="text-red-400">*</span>}
        </label>
        {field.description ? (
          <p className="mb-1 text-[10px] leading-relaxed text-slate-500">{field.description}</p>
        ) : null}
        {field.type === "textarea" ? (
          <textarea
            value={configValues[field.key] || ""}
            onChange={(e) => updateConfigValue(field.key, e.target.value)}
            rows={4}
            placeholder={field.placeholder || ""}
            className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        ) : field.type === "select" ? (
          <select
            value={configValues[field.key] ?? field.defaultValue ?? ""}
            onChange={(e) => updateConfigValue(field.key, e.target.value)}
            className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="">Select…</option>
            {(field.options || []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : field.type === "checkbox" ? (
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={Boolean(configValues[field.key] ?? field.defaultValue ?? false)}
              onChange={(e) => updateConfigValue(field.key, e.target.checked)}
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
            value={configValues[field.key] ?? field.defaultValue ?? ""}
            onChange={(e) =>
              updateConfigValue(
                field.key,
                field.type === "number" ? Number(e.target.value) : e.target.value,
              )
            }
            placeholder={field.placeholder || (field.type === "url" ? "https://..." : "")}
            className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}
      </div>
    );
  }

  function renderWecomModeSections(fields: any[]) {
    const { shared, bot, agent } = partitionWecomModeFields(fields);
    const shouldSeparate = wecomMode === "both" && bot.length > 0 && agent.length > 0;

    if (!shouldSeparate) {
      return <div className="space-y-3">{fields.map(renderField)}</div>;
    }

    return (
      <div className="space-y-4">
        {shared.length > 0 ? <div className="space-y-3">{shared.map(renderField)}</div> : null}

        <div className="space-y-4">
          <div className="rounded-lg border border-sky-200 bg-sky-50/70 p-3">
            <div className="mb-3">
              <div className="text-[11px] font-bold text-sky-800">Bot Configuration</div>
              <div className="mt-1 text-[10px] text-sky-900/75">
                WebSocket bot settings and credentials used for the Bot channel path.
              </div>
            </div>
            <div className="space-y-3">{bot.map(renderField)}</div>
          </div>

          <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3">
            <div className="mb-3">
              <div className="text-[11px] font-bold text-emerald-800">Agent Configuration</div>
              <div className="mt-1 text-[10px] text-emerald-900/75">
                Enterprise app credentials and callback settings used for Agent mode.
              </div>
            </div>
            <div className="space-y-3">{agent.map(renderField)}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center">
              <Puzzle size={18} className="text-slate-600" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-slate-900">{name}</h4>
              <div className="flex items-center gap-1 flex-wrap mt-0.5">
                {category && (
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${categoryColors[category] || "bg-slate-50 text-slate-500"}`}
                  >
                    {category.replace(/-/g, " ")}
                  </span>
                )}
                {mcpAvailable && (
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 inline-flex items-center gap-1"
                    title={item.mcp?.notes || "MCP server available for this provider"}
                  >
                    <Cpu size={10} />
                    MCP
                  </span>
                )}
              </div>
            </div>
          </div>
          {isInstalled ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleTest}
                disabled={testing}
                className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
                title="Test connection"
              >
                {testing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              </button>
              <button
                onClick={onDisconnect}
                className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={handleConnectClick}
              disabled={connecting}
              className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-50"
            >
              {connecting ? <Loader2 size={11} className="animate-spin" /> : "Connect"}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{description}</p>
        {item.capabilities && (
          <div className="flex gap-1 mt-2">
            {item.capabilities.map((cap) => (
              <span
                key={cap}
                className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 uppercase"
              >
                {cap}
              </span>
            ))}
          </div>
        )}
        {/* Test result badge for installed integrations */}
        {isInstalled && testResult && (
          <div
            className={`flex items-center gap-1.5 mt-2 px-2 py-1 rounded-lg text-[10px] font-medium ${testResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}
          >
            {testResult.success ? <CheckCircle size={11} /> : <XCircle size={11} />}
            {testResult.message}
          </div>
        )}
      </div>

      {/* Config Modal */}
      {showConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Configure {name}</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  Fill in the required fields to connect
                </p>
              </div>
              <button
                onClick={() => {
                  setShowConfig(false);
                  setConfigValues({});
                  setShowAdvanced(false);
                  setTestResult(null);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {(credentialsUrl || setupSteps.length > 0 || setupScopes.length > 0) && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-600">
                    Where to apply for credentials
                  </div>
                  {credentialsUrl && (
                    <a
                      href={credentialsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:text-blue-800 hover:underline break-all"
                    >
                      <ExternalLink size={11} />
                      {credentialsUrl}
                    </a>
                  )}
                  {setupSteps.length > 0 && (
                    <ol className="list-decimal pl-4 text-[11px] leading-relaxed text-slate-700 space-y-0.5">
                      {setupSteps.map((step, idx) => (
                        <li key={idx}>{step}</li>
                      ))}
                    </ol>
                  )}
                  {setupScopes.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      <span className="text-[10px] text-slate-500 font-semibold">
                        Required scopes:
                      </span>
                      {setupScopes.map((scope) => (
                        <span
                          key={scope}
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700"
                        >
                          {scope}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {item.mcp && item.mcp.available === true && (
                <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-1">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-violet-700 inline-flex items-center gap-1">
                    <Cpu size={11} />
                    MCP server available
                  </div>
                  {item.mcp.notes && (
                    <p className="text-[11px] leading-relaxed text-violet-900">{item.mcp.notes}</p>
                  )}
                  {(item.mcp.npmPackage || item.mcp.pyPackage || item.mcp.serverUrl) && (
                    <code className="block break-all rounded border border-violet-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-700">
                      {item.mcp.npmPackage || item.mcp.pyPackage || item.mcp.serverUrl}
                    </code>
                  )}
                  {item.mcp.docsUrl && (
                    <a
                      href={item.mcp.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline"
                    >
                      <ExternalLink size={10} />
                      MCP docs
                    </a>
                  )}
                </div>
              )}
              {isOAuth2 && redirectUri && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-blue-700">
                    OAuth Redirect URI
                  </div>
                  <p className="text-[11px] leading-relaxed text-blue-800">
                    Add this exact URL as an authorized redirect URI in your {name} OAuth app before
                    clicking <span className="font-semibold">{submitLabel || "Authorize"}</span>.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded border border-blue-200 bg-white px-2 py-1.5 font-mono text-[11px] text-slate-700">
                      {redirectUri}
                    </code>
                    <button
                      type="button"
                      onClick={copyRedirectUri}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-blue-700"
                      title="Copy redirect URI"
                    >
                      {redirectCopied ? (
                        <>
                          <Check size={11} />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy size={11} />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                  {usageHints.length > 0 && (
                    <ul className="list-disc pl-4 text-[11px] leading-relaxed text-blue-800/80 space-y-0.5">
                      {usageHints.slice(0, 2).map((hint, idx) => (
                        <li key={idx}>{hint}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {isWecomIntegration
                ? renderWecomModeSections(basicFields)
                : basicFields.map(renderField)}

              {(advancedFields.length > 0 ||
                (isEmailIntegration && (cronToggleField || cronConfigFields.length > 0))) && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/70">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((prev) => !prev)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left"
                  >
                    <div>
                      <div className="text-[11px] font-bold text-slate-800">
                        {isEmailIntegration
                          ? "Advanced Connection & Cron Settings"
                          : "Advanced Configuration"}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {isEmailIntegration
                          ? "Provider defaults are prefilled. Use this section for custom server overrides and the optional reminder cron."
                          : "Optional provider-specific fields live here so the main connect flow stays focused on the default setup."}
                      </div>
                    </div>
                    <span className="text-[10px] font-bold text-slate-500">
                      {showAdvanced ? "Hide" : "Show"}
                    </span>
                  </button>
                  {showAdvanced && (
                    <div className="border-t border-slate-200 p-3 space-y-3">
                      {advancedFields.length > 0 && (
                        <div className="space-y-3">
                          <div>
                            <div className="text-[11px] font-bold text-slate-800">
                              {isEmailIntegration ? "Connection Overrides" : "Advanced Fields"}
                            </div>
                            <div className="mt-1 text-[10px] text-slate-500">
                              {isEmailIntegration
                                ? "Adjust IMAP and SMTP host settings only if you need something other than the preset defaults."
                                : "These settings are optional and usually only needed for more customized provider behavior."}
                            </div>
                          </div>
                          {isWecomIntegration ? (
                            renderWecomModeSections(advancedFields)
                          ) : (
                            <div className="grid gap-3 md:grid-cols-2">
                              {advancedFields.map(renderField)}
                            </div>
                          )}
                        </div>
                      )}

                      {isEmailIntegration && (cronToggleField || cronConfigFields.length > 0) && (
                        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
                          <div>
                            <div className="text-[11px] font-bold text-slate-800">
                              Reminder Cron
                            </div>
                            <div className="mt-1 text-[10px] text-slate-500">
                              LPanel can optionally create a normal scheduled agent turn seeded from
                              this mailbox connection.
                            </div>
                          </div>

                          {cronToggleField ? renderField(cronToggleField) : null}

                          {cronEnabled ? (
                            <div className="grid gap-3 md:grid-cols-2">
                              {cronConfigFields.map(renderField)}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                              Turn on the reminder cron to choose how often it runs and what prompt
                              it should use.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* Test result banner in modal */}
            {testResult && (
              <div
                className={`mx-4 mb-2 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${testResult.success ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}
              >
                {testResult.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
                {testResult.message}
              </div>
            )}
            <div className="flex gap-2 justify-end p-4 border-t border-slate-100">
              <button
                onClick={() => {
                  setShowConfig(false);
                  setConfigValues({});
                  setShowAdvanced(false);
                  setTestResult(null);
                }}
                className="px-4 py-2 text-[10px] font-bold text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={handleConfigSubmit}
                disabled={connecting}
                className="flex items-center gap-2 px-4 py-2 text-[10px] font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {connecting && <Loader2 size={12} className="animate-spin" />}
                {submitLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
