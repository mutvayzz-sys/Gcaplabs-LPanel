import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";
import { useToast } from "../../Toast";
import { emitAgentDataChanged, subscribeToAgentDataChanged } from "../agentEvents";

function formatTimestamp(value) {
  if (!value) return "Not available yet";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function getJobId(job) {
  return String(job?.id || "");
}

function parseCronMinutes(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "* * * * *") return "1";
  const everyMinutes = trimmed.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyMinutes) return everyMinutes[1];
  return "";
}

function getScheduleMinutes(job) {
  if (Number.isFinite(Number(job?.schedule?.everyMs))) {
    return String(Math.max(1, Math.round(Number(job.schedule.everyMs) / 60000)));
  }
  if (typeof job?.schedule === "string") return parseCronMinutes(job.schedule);
  if (typeof job?.schedule?.cron === "string") return parseCronMinutes(job.schedule.cron);
  if (typeof job?.schedule?.expr === "string") return parseCronMinutes(job.schedule.expr);
  return "";
}

function formatMinutesLabel(minutesValue) {
  const minutes = Number(minutesValue);
  if (!Number.isFinite(minutes) || minutes <= 0) return "Unknown cadence";
  return minutes === 1 ? "Every 1 minute" : `Every ${minutes} minutes`;
}

function buildHermesSchedule(minutesValue) {
  const minutes = Number(minutesValue);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  return minutes === 1 ? "* * * * *" : `*/${Math.round(minutes)} * * * *`;
}

function getPromptValue(job) {
  return job?.prompt || job?.message || "";
}

export default function HermesCronPanel({ agentId }) {
  const [jobs, setJobs] = useState([]);
  const [integrationLinks, setIntegrationLinks] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [selectedJobId, setSelectedJobId] = useState("");
  const [formData, setFormData] = useState({
    name: "",
    scheduleMinutes: "60",
    prompt: "",
  });
  const [detailForm, setDetailForm] = useState({
    name: "",
    scheduleMinutes: "",
    prompt: "",
  });
  const toast = useToast();

  async function loadJobs() {
    setLoading(true);
    setError("");

    try {
      const [jobsRes, integrationsRes] = await Promise.all([
        fetchWithAuth(`/api/agents/${agentId}/hermes-ui/cron`),
        fetchWithAuth(`/api/agents/${agentId}/integrations`),
      ]);
      const data = await jobsRes.json().catch(() => ({}));
      const integrationsData = await integrationsRes.json().catch(() => []);
      if (!jobsRes.ok) {
        throw new Error(data.error || "Failed to load Headmaster cron jobs");
      }

      const nextJobs = Array.isArray(data?.jobs) ? data.jobs : [];
      const nextLinks = Array.isArray(integrationsData)
        ? integrationsData.reduce(
            (acc, integration) => {
              if (integration?.cron_job_id) acc[String(integration.cron_job_id)] = integration;
              return acc;
            },
            {} as Record<string, any>,
          )
        : {};
      setJobs(nextJobs);
      setIntegrationLinks(nextLinks);
      setSelectedJobId((current) => {
        if (!nextJobs.length) return "";
        if (current && nextJobs.some((job) => getJobId(job) === current)) return current;
        return getJobId(nextJobs[0]);
      });
    } catch (nextError) {
      setError(nextError.message || "Failed to load Headmaster cron jobs");
      setJobs([]);
      setIntegrationLinks({});
      setSelectedJobId("");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadJobs();
  }, [agentId]);

  useEffect(() => {
    return subscribeToAgentDataChanged(agentId, (detail) => {
      if (detail.scope === "integrations" || detail.scope === "all") {
        loadJobs();
      }
    });
  }, [agentId]);

  const selectedJob = useMemo(
    () => jobs.find((job) => getJobId(job) === selectedJobId) || jobs[0] || null,
    [jobs, selectedJobId],
  );

  useEffect(() => {
    if (!selectedJob) {
      setDetailForm({ name: "", scheduleMinutes: "", prompt: "" });
      return;
    }

    setDetailForm({
      name: selectedJob?.name || "",
      scheduleMinutes: getScheduleMinutes(selectedJob),
      prompt: getPromptValue(selectedJob),
    });
  }, [selectedJob]);

  async function handleCreate(event) {
    event.preventDefault();
    setCreating(true);
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          schedule: buildHermesSchedule(formData.scheduleMinutes),
          prompt: formData.prompt,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to create Headmaster cron job");
      }

      toast.success("Cron job created");
      setFormData({ name: "", scheduleMinutes: "60", prompt: "" });
      setShowForm(false);
      await loadJobs();
      emitAgentDataChanged({ agentId, scope: "cron" });
    } catch (nextError) {
      const message = nextError.message || "Failed to create Headmaster cron job";
      setError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }

  async function handleSave() {
    if (!selectedJobId) return;
    setSaving(true);
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/cron/${selectedJobId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: detailForm.name,
          schedule: buildHermesSchedule(detailForm.scheduleMinutes),
          prompt: detailForm.prompt,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to update Headmaster cron job");
      }

      toast.success("Cron job updated");
      await loadJobs();
      emitAgentDataChanged({ agentId, scope: "cron" });
    } catch (nextError) {
      const message = nextError.message || "Failed to update Headmaster cron job";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(jobId) {
    if (!jobId) return;
    setDeletingId(jobId);
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/cron/${jobId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete Headmaster cron job");
      }

      toast.success("Cron job deleted");
      await loadJobs();
      emitAgentDataChanged({ agentId, scope: "cron" });
    } catch (nextError) {
      const message = nextError.message || "Failed to delete Headmaster cron job";
      setError(message);
      toast.error(message);
    } finally {
      setDeletingId("");
    }
  }

  const lastRun =
    selectedJob?.last_run ||
    selectedJob?.lastRun ||
    selectedJob?.last_run_at ||
    selectedJob?.lastRunAt;
  const nextRun =
    selectedJob?.next_run ||
    selectedJob?.nextRun ||
    selectedJob?.next_run_at ||
    selectedJob?.nextRunAt;
  const enabled = selectedJob?.enabled !== false;
  const selectedLinkedIntegration = selectedJob
    ? integrationLinks[getJobId(selectedJob)] || null
    : null;
  const hasUnsavedChanges =
    !!selectedJob &&
    (detailForm.name !== (selectedJob?.name || "") ||
      detailForm.scheduleMinutes !== getScheduleMinutes(selectedJob) ||
      detailForm.prompt !== getPromptValue(selectedJob));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700">
            Headmaster Cron
          </p>
          <p className="mt-1 text-sm font-bold text-slate-900">
            Select a Headmaster cron job to edit its details.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Jobs are stored inside the Headmaster runtime and surfaced here through the runtime API.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadJobs}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
          <button
            onClick={() => setShowForm((current) => !current)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700"
          >
            <Plus size={12} />
            Add Job
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-600" />
          <div>
            <p className="text-sm font-bold text-rose-800">Cron request failed</p>
            <p className="mt-1 text-xs text-rose-700">{error}</p>
          </div>
        </div>
      ) : null}

      {showForm ? (
        <form
          onSubmit={handleCreate}
          className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(event) =>
                  setFormData((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Daily summary"
                required
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">
                Run Every (minutes)
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={formData.scheduleMinutes}
                onChange={(event) =>
                  setFormData((current) => ({
                    ...current,
                    scheduleMinutes: event.target.value,
                  }))
                }
                placeholder="60"
                required
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">Prompt</label>
            <textarea
              value={formData.prompt}
              onChange={(event) =>
                setFormData((current) => ({ ...current, prompt: event.target.value }))
              }
              placeholder="Generate a daily summary of the last 24 hours."
              rows={4}
              required
              className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>

          <p className="text-[11px] text-slate-500">
            Example: <span className="font-mono">60</span> runs once every hour.
          </p>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-xl px-3 py-2 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Create Job
            </button>
          </div>
        </form>
      ) : null}

      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center">
          <CalendarClock size={24} className="mx-auto text-slate-300" />
          <p className="mt-3 text-sm font-bold text-slate-600">No cron jobs configured</p>
          <p className="mt-1 text-xs text-slate-500">
            Add a recurring prompt to let Headmaster run scheduled tasks.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Scheduled Jobs</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Click a cron job to inspect and edit its schedule and prompt.
                </p>
              </div>
              <div className="rounded-full bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 shadow-sm">
                {jobs.length} jobs
              </div>
            </div>
            <div className="space-y-3">
              {jobs.map((job) => {
                const jobId = getJobId(job);
                const isEnabled = job?.enabled !== false;
                return (
                  <button
                    key={jobId}
                    type="button"
                    onClick={() => setSelectedJobId(jobId)}
                    className={`w-full rounded-xl border px-4 py-3 text-left transition-all ${
                      selectedJobId === jobId
                        ? "border-blue-300 bg-blue-50 shadow-sm"
                        : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <CheckCircle2
                            size={12}
                            className={isEnabled ? "text-emerald-500" : "text-slate-300"}
                          />
                          <span className="truncate text-sm font-bold text-slate-900">
                            {job?.name || "Unnamed job"}
                          </span>
                        </div>
                        <p className="mt-2 truncate font-mono text-xs text-blue-600">
                          {formatMinutesLabel(getScheduleMinutes(job))}
                        </p>
                        {getPromptValue(job) ? (
                          <p className="mt-1 truncate text-xs text-slate-500">
                            {getPromptValue(job)}
                          </p>
                        ) : null}
                      </div>
                      <ChevronRight size={16} className="mt-1 shrink-0 text-slate-400" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="xl:sticky xl:top-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              {selectedJob ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-slate-900">
                          {selectedJob?.name || "Unnamed job"}
                        </h3>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            enabled
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {enabled ? "Enabled" : "Paused"}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        Edit the job details, then save them back to Headmaster.
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 space-y-4">
                    <div>
                      <label className="mb-1 block text-xs font-bold text-slate-600">Name</label>
                      <input
                        type="text"
                        value={detailForm.name}
                        onChange={(event) =>
                          setDetailForm((current) => ({ ...current, name: event.target.value }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-bold text-slate-600">
                        Run Every (minutes)
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={detailForm.scheduleMinutes}
                        onChange={(event) =>
                          setDetailForm((current) => ({
                            ...current,
                            scheduleMinutes: event.target.value,
                          }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-bold text-slate-600">Prompt</label>
                      <textarea
                        value={detailForm.prompt}
                        onChange={(event) =>
                          setDetailForm((current) => ({
                            ...current,
                            prompt: event.target.value,
                          }))
                        }
                        rows={5}
                        className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      />
                    </div>
                    {selectedLinkedIntegration ? (
                      <p className="text-xs text-slate-500">
                        Linked to the active {selectedLinkedIntegration.provider} integration.
                        Deleting this job here will clear the reminder-cron link in that
                        integration.
                      </p>
                    ) : null}
                  </div>

                  <div className="mt-6 grid gap-3 md:grid-cols-2">
                    <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                        Runtime Status
                      </p>
                      <dl className="mt-3 space-y-2 text-sm">
                        <div>
                          <dt className="text-xs text-slate-500">Last Run</dt>
                          <dd className="font-medium text-slate-900">{formatTimestamp(lastRun)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-slate-500">Next Run</dt>
                          <dd className="font-medium text-slate-900">{formatTimestamp(nextRun)}</dd>
                        </div>
                        {selectedJob?.deliver ? (
                          <div>
                            <dt className="text-xs text-slate-500">Delivery</dt>
                            <dd className="font-medium text-slate-900">{selectedJob.deliver}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </section>

                    <section className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                        Actions
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handleSave}
                          disabled={saving || !hasUnsavedChanges}
                          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {saving ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Save size={12} />
                          )}
                          Save Changes
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(selectedJobId)}
                          disabled={deletingId === selectedJobId}
                          className="inline-flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-50"
                        >
                          {deletingId === selectedJobId ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                          Delete Job
                        </button>
                      </div>
                    </section>
                  </div>
                </>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-sm text-slate-500">
                  Select a cron job to edit its name, schedule, and prompt.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
