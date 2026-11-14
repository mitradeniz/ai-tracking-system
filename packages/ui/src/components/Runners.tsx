import { useEffect, useRef, useState } from "react";
import { api, copyText, desktop, type ChatRunner, type DetectedProvider, type RunLogEvent, type RunnerProvider, type RunSummary } from "../api.ts";
import { RUNLOG_EVENT } from "../hooks.ts";
import { useI18n, type Key, type T } from "../i18n.ts";
import { activeRun, agentName, INSTALL, PROVIDER_LABEL, runnerOf, type Model } from "../model.ts";
import { Dialog } from "./Dialogs.tsx";
import { InfoTip } from "./Info.tsx";

const PROVIDERS: RunnerProvider[] = ["manual", "codex", "claude", "copilot", "gemini", "custom"];
const RESUME: Record<string, string> = {
  codex: "codex resume {id}",
  claude: "claude --resume {id}",
  copilot: "copilot --resume {id}",
  gemini: "gemini --resume {id}",
};

const shellQuote = (s: string) => (/^[\w./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn tiny"
      onClick={async () => {
        await copyText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? `✓ ${t("copied")}` : (label ?? t("copy"))}
    </button>
  );
}

/** Settings for how one chat runs on this computer: which CLI, folder, access and session. */
export function RunnerDialog({
  model,
  agentId,
  onClose,
  onSaved,
  onSwitch,
}: {
  model: Model;
  agentId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  /** Shows another chat's settings. */
  onSwitch?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const key = model.detail.key;
  const initial = model.runners?.settings.chats[agentId];
  const [form, setForm] = useState<ChatRunner>(
    initial ?? { provider: "manual", access: "edit", session: "keep", unattended: false, network: false },
  );
  const [providers, setProviders] = useState<DetectedProvider[] | null>(null);
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ChatRunner>) => setForm((f) => ({ ...f, ...patch }));

  const detect = (refresh = false) =>
    api.providers(refresh).then(setProviders, () => setProviders([]));
  useEffect(() => {
    void detect();
    void api.control().then(setHasToken);
  }, []);

  const p = form.provider;
  const found = providers?.find((x) => x.id === p);
  const defaultWorkdir = model.runners?.defaultWorkdir ?? "";
  const workdir = form.workdir || defaultWorkdir;
  const resume = form.sessionId && RESUME[p] ? `cd ${shellQuote(workdir)} && ${RESUME[p]!.replace("{id}", form.sessionId)}` : null;
  const hooks = model.runners?.hooks;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveRunner(key, agentId, {
        ...form,
        workdir: form.workdir ?? "",
        model: form.model ?? "",
        effort: form.effort ?? "",
        sessionId: form.sessionId ?? "",
        allowedTools: form.allowedTools ?? "",
        extraDirs: form.extraDirs ?? "",
        extraArgs: form.extraArgs ?? "",
        binary: form.binary ?? "",
        command: form.command ?? "",
      });
      onSaved(t("run_saved", { agent: agentName(model, agentId) }));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const providerName = (id: RunnerProvider) =>
    id === "manual" ? t("run_manual") : id === "custom" ? t("run_custom") : (providers?.find((x) => x.id === id)?.name ?? PROVIDER_LABEL[id]);

  return (
    <Dialog title={t("run_title", { agent: agentName(model, agentId) })} onClose={onClose}>
      <div className="small muted">{t("run_setupHint")}</div>
      {onSwitch && (model.detail.project?.agents.length ?? 0) > 1 && (
        <div className="segmented" role="tablist" aria-label={t("chat")}>
          {model.detail.project!.agents.map((a) => (
            <button key={a.id} role="tab" aria-checked={a.id === agentId} onClick={() => a.id !== agentId && onSwitch(a.id)}>
              {runnerOf(model, a.id) && <span className="dot ok" aria-hidden="true" />}
              {a.name}
            </button>
          ))}
        </div>
      )}
      <div className="field">
        <label>
          {t("run_provider")} <InfoTip text={t("info_provider")} />
        </label>
        <div className="segmented" role="radiogroup" aria-label={t("run_provider")}>
          {PROVIDERS.map((id) => (
            <button key={id} role="radio" aria-checked={p === id} onClick={() => set({ provider: id })}>
              {id !== "manual" && id !== "custom" && providers && (
                <span className={`dot ${providers.find((x) => x.id === id)?.path ? "ok" : "off"}`} aria-hidden="true" />
              )}
              {providerName(id)}
            </button>
          ))}
        </div>
        {p !== "manual" && p !== "custom" && providers && (
          <div className="small muted row">
            <span className="grow">
              {form.binary
                ? t("run_found", { path: form.binary })
                : found?.path
                  ? t("run_found", { path: `${found.path}${found.version ? ` · ${found.version}` : ""}` })
                  : t("run_notFound")}
            </span>
            <button className="btn tiny ghost" onClick={() => void detect(true)}>
              {t("run_test")}
            </button>
          </div>
        )}
        {p !== "manual" && p !== "custom" && providers && !form.binary && !found?.path && INSTALL[p] && (
          <div className="install-box small">
            <span>{t("run_installHow")}</span>
            <code className="mono">{INSTALL[p]!.install}</code>
            <span>{t("run_installLogin", { login: INSTALL[p]!.login })}</span>
            <div className="row">
              <button className="btn tiny" onClick={() => void copyText(INSTALL[p]!.install)}>
                {t("run_installCopy")}
              </button>
              <span className="muted">{t("run_installAfter")}</span>
            </div>
          </div>
        )}
      </div>

      {p !== "manual" && (
        <>
          {p === "custom" && (
            <div className="field">
              <label htmlFor="run-command">{t("run_command")}</label>
              <input
                id="run-command"
                className="input mono"
                value={form.command ?? ""}
                placeholder="cursor-agent -p --output-format text {{prompt}}"
                onChange={(e) => set({ command: e.target.value })}
              />
              <span className="small muted">{t("run_commandHint")}</span>
            </div>
          )}
          <div className="field">
            <label htmlFor="run-workdir">
              {t("run_workdir")} <InfoTip text={t("info_workdir")} />
            </label>
            <div className="row">
              <input
                id="run-workdir"
                className="input mono"
                value={form.workdir ?? ""}
                placeholder={defaultWorkdir}
                onChange={(e) => set({ workdir: e.target.value })}
              />
              {desktop?.chooseFolder && (
                <button
                  className="btn"
                  onClick={async () => {
                    const picked = await desktop!.chooseFolder!(form.workdir || model.runners?.planFolder || undefined);
                    if (picked) set({ workdir: picked });
                  }}
                >
                  {t("browse")}
                </button>
              )}
            </div>
            {!form.workdir && model.runners?.defaultWorkdirExists === false ? (
              <div className="warn-box small">
                <span>{t("run_workdirMissing", { path: defaultWorkdir })}</span>
                {model.runners.planFolder && (
                  <button className="btn small" onClick={() => set({ workdir: model.runners!.planFolder! })}>
                    {t("run_workdirUse", { path: model.runners.planFolder })}
                  </button>
                )}
              </div>
            ) : (
              <span className="small muted">{t("run_workdirHint", { path: defaultWorkdir })}</span>
            )}
          </div>
          {p !== "custom" && (
            <div className="field">
              <label>
                {t("run_access")} <InfoTip text={t("info_access")} />
              </label>
              <div className="segmented" role="radiogroup" aria-label={t("run_access")}>
                {(["readonly", "edit", "full"] as const).map((a) => (
                  <button key={a} role="radio" aria-checked={form.access === a} onClick={() => set({ access: a })}>
                    {t(`run_access_${a}` as Key)}
                  </button>
                ))}
              </div>
              {form.access === "full" && <div className="warn small">{t("run_accessFullWarn")}</div>}
              {p === "codex" && form.access === "edit" && (
                <label className="check plain">
                  <input type="checkbox" checked={form.network} onChange={(e) => set({ network: e.target.checked })} />
                  {t("run_network")}
                </label>
              )}
              {p === "claude" && form.access === "edit" && (
                <label className="check plain">
                  <input type="checkbox" checked={form.autoPermissions !== false} onChange={(e) => set({ autoPermissions: e.target.checked })} />
                  <span>
                    {t("run_autoPermissions")}
                    <span className="small muted block">{found?.autoMode === false ? t("run_autoPermissionsOld") : t("run_autoPermissionsHint")}</span>
                  </span>
                </label>
              )}
              {p === "claude" && form.access === "edit" && (
                <label className="check plain">
                  <input type="checkbox" checked={form.workCommands !== false} onChange={(e) => set({ workCommands: e.target.checked })} />
                  <span>
                    {t("run_workCommands")}
                    <span className="small muted block">{t("run_workCommandsHint")}</span>
                  </span>
                </label>
              )}
            </div>
          )}
          {p !== "custom" && <ModelPicker provider={found} fallback={p} form={form} set={set} />}
          <div className="field">
            <label>
              {t("run_session")} <InfoTip text={t("info_session")} />
            </label>
            <div className="segmented" role="radiogroup" aria-label={t("run_session")}>
              {(["keep", "perTask"] as const).map((m) => (
                <button key={m} role="radio" aria-checked={form.session === m} onClick={() => set({ session: m })}>
                  {t(`run_session_${m}` as Key)}
                </button>
              ))}
            </div>
          </div>
          {form.session === "keep" && (
            <div className="field">
              <label htmlFor="run-session">{t("run_sessionId")}</label>
              <div className="row">
                <input
                  id="run-session"
                  className="input mono"
                  value={form.sessionId ?? ""}
                  placeholder="—"
                  onChange={(e) => set({ sessionId: e.target.value.trim() })}
                />
                {form.sessionId && (
                  <button className="btn small ghost" onClick={() => set({ sessionId: "" })}>
                    {t("run_sessionReset")}
                  </button>
                )}
              </div>
              <span className="small muted">{t("run_sessionIdHint")}</span>
              {resume && (
                <div className="small muted row">
                  <span>{t("run_resumeHint")}</span>
                  <code className="grow ellipsis">{resume}</code>
                  <CopyButton text={resume} />
                </div>
              )}
            </div>
          )}
          <label className="check plain">
            <input type="checkbox" checked={form.unattended} onChange={(e) => set({ unattended: e.target.checked })} />
            <span>
              {t("run_unattended")}
              <span className="small muted block">{t("run_unattendedHint")}</span>
            </span>
          </label>
          <details className="more">
            <summary>{t("details")}</summary>
            {(p === "claude" || p === "copilot") && (
              <div className="field">
                <label htmlFor="run-tools">{t("run_allowedTools")}</label>
                <textarea
                  id="run-tools"
                  className="input mono"
                  style={{ minHeight: 56 }}
                  value={form.allowedTools ?? ""}
                  onChange={(e) => set({ allowedTools: e.target.value })}
                />
                <span className="small muted">{t("run_allowedToolsHint")}</span>
              </div>
            )}
            {p === "claude" && (
              <div className="field">
                <label htmlFor="run-dirs">{t("run_extraDirs")}</label>
                <textarea
                  id="run-dirs"
                  className="input mono"
                  style={{ minHeight: 44 }}
                  value={form.extraDirs ?? ""}
                  placeholder="/Users/you/other-repo"
                  onChange={(e) => set({ extraDirs: e.target.value })}
                />
                <span className="small muted">{t("run_extraDirsHint")}</span>
              </div>
            )}
            <div className="field">
              <label htmlFor="run-extra">{t("run_extraArgs")}</label>
              <input id="run-extra" className="input mono" value={form.extraArgs ?? ""} onChange={(e) => set({ extraArgs: e.target.value })} />
            </div>
            {p !== "custom" && (
              <div className="field">
                <label htmlFor="run-binary">{t("run_binary")}</label>
                <input
                  id="run-binary"
                  className="input mono"
                  value={form.binary ?? ""}
                  placeholder={found?.path ?? `/usr/local/bin/${p}`}
                  onChange={(e) => set({ binary: e.target.value })}
                />
              </div>
            )}
          </details>
        </>
      )}

      {hooks && (
        <details className="more">
          <summary>{t("run_hooks")}</summary>
          <div className="small muted">{t("run_hooksHint")}</div>
          <div className="field">
            <div className="row">
              <label className="grow">{t("run_hooksClaude")}</label>
              <CopyButton text={hooks.claude} />
            </div>
            <pre className="prompt small-pre">{hooks.claude}</pre>
          </div>
          <div className="field">
            <div className="row">
              <label className="grow">{t("run_hooksCodex")}</label>
              <CopyButton text={hooks.codex} />
            </div>
            <pre className="prompt small-pre">{hooks.codex}</pre>
          </div>
        </details>
      )}

      <div className="small muted">{t("run_safety")}</div>
      {hasToken === false && <div className="warn small">{t("run_noToken")}</div>}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="btn primary"
          disabled={busy || hasToken === false || (p === "custom" && !form.command?.trim()) || (Boolean(form.model) && !MODEL_ID.test(form.model!))}
          onClick={save}
        >
          {t("save")}
        </button>
      </div>
    </Dialog>
  );
}

const MODEL_ID = /^[\w.:@/[\]-]+$/;
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const OTHER = "__other__";

/** Model and reasoning effort, from the CLI's own list when it has one. */
function ModelPicker({
  provider,
  fallback,
  form,
  set,
}: {
  provider: DetectedProvider | undefined;
  fallback: RunnerProvider;
  form: ChatRunner;
  set: (patch: Partial<ChatRunner>) => void;
}) {
  const { t } = useI18n();
  const models = provider?.models ?? [];
  const model = form.model ?? "";
  const known = models.find((m) => m.id === model);
  const [other, setOther] = useState(Boolean(model) && !known);
  const efforts = (known?.efforts?.length ? known.efforts : (provider?.efforts ?? [])).slice().sort(
    (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
  );
  const invalid = Boolean(model) && !MODEL_ID.test(model);
  const effortLabel = (e: string) => (EFFORT_ORDER.includes(e) ? t(`effort_${e}` as Key) : e);
  const value = other ? OTHER : model;
  return (
    <div className="row wrap">
      <div className="field grow">
        <label htmlFor="run-model">{t("run_model")}</label>
        <select
          id="run-model"
          className="input"
          value={value}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setOther(true);
              return;
            }
            setOther(false);
            const next = models.find((m) => m.id === e.target.value);
            set({ model: e.target.value, effort: next?.efforts && form.effort && !next.efforts.includes(form.effort) ? "" : form.effort });
          }}
        >
          <option value="">{t("run_modelDefault")}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.label !== m.id ? ` (${m.id})` : ""}
            </option>
          ))}
          <option value={OTHER}>{t("run_modelOther")}</option>
        </select>
        {other && (
          <input
            className="input mono"
            value={model}
            placeholder={fallback === "claude" ? "claude-opus-5-5" : fallback === "codex" ? "gpt-6-sol" : "model-id"}
            aria-label={t("run_modelOther")}
            autoFocus
            onChange={(e) => set({ model: e.target.value.trim() })}
          />
        )}
        {invalid ? (
          <span className="error small">{t("run_modelInvalid")}</span>
        ) : (
          fallback === "claude" && !other && <span className="small muted">{t("run_modelAliasHint")}</span>
        )}
      </div>
      {efforts.length > 0 && (
        <div className="field">
          <label htmlFor="run-effort">
            {t("run_effort")} <InfoTip text={t("info_effort")} align="end" />
          </label>
          <select id="run-effort" className="input" value={form.effort ?? ""} onChange={(e) => set({ effort: e.target.value })}>
            <option value="">
              {t("run_modelDefault")}
              {known?.defaultEffort ? ` · ${effortLabel(known.defaultEffort)}` : ""}
            </option>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {effortLabel(e)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/** A run's output, live while it runs. */
export function RunLog({ run }: { run: RunSummary }) {
  const { t } = useI18n();
  const [lines, setLines] = useState<string[]>([]);
  const next = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let alive = true;
    next.current = 0;
    setLines([]);
    api
      .runLog(run.id)
      .then((r) => {
        if (!alive) return;
        setLines(r.lines);
        next.current = r.next;
      })
      .catch(() => undefined);
    const onLog = (e: Event) => {
      const data = (e as CustomEvent<RunLogEvent>).detail;
      if (data.runId !== run.id) return;
      // Skip lines the first load already returned.
      const fresh = data.lines.slice(Math.max(0, next.current - data.from));
      if (fresh.length === 0) return;
      next.current = data.from + data.lines.length;
      setLines((l) => [...l, ...fresh].slice(-1500));
    };
    window.addEventListener(RUNLOG_EVENT, onLog);
    return () => {
      alive = false;
      window.removeEventListener(RUNLOG_EVENT, onLog);
    };
  }, [run.id]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <pre
      className="runlog"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length ? lines.join("\n") : t("run_noLog")}
    </pre>
  );
}

/** Header switch: send ready tasks to free chats automatically. */
export function AutoDispatch({
  model,
  onSetup,
  onError,
  onInfo,
}: {
  model: Model;
  onSetup: () => void;
  onError: (m: string) => void;
  onInfo?: (m: string) => void;
}) {
  const { t } = useI18n();
  const settings = model.runners?.settings;
  if (!settings) return null;
  const runnable = (model.detail.project?.agents ?? []).filter((a) => runnerOf(model, a.id));
  const running = model.runners?.runs.filter((r) => r.state === "running").length ?? 0;
  const toggle = async () => {
    if (!settings.autoDispatch && runnable.length === 0) {
      onSetup();
      return;
    }
    try {
      await api.saveRunnerProject(model.detail.key, { autoDispatch: !settings.autoDispatch });
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div data-tour="autodispatch" className={`auto-dispatch ${settings.autoDispatch ? "on" : ""}`} title={runnable.length ? t("run_autoHint") : t("run_autoNone")}>
      <button className="switch" role="switch" aria-checked={settings.autoDispatch} onClick={toggle}>
        <span className="knob" aria-hidden="true" />
        <span>{t("run_auto")}</span>
      </button>
      <InfoTip text={runnable.length ? t("run_autoHint") : `${t("run_autoHint")} ${t("run_autoNone")}`} align="end" />
      {settings.autoDispatch && (
        <label className="small muted">
          {t("run_maxConcurrent")}
          <InfoTip text={t("info_maxConcurrent")} align="end" />
          <select
            className="input tiny"
            value={settings.maxConcurrent}
            onChange={(e) =>
              void api.saveRunnerProject(model.detail.key, { maxConcurrent: Number(e.target.value) }).catch((err: Error) => onError(err.message))
            }
          >
            {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      {running > 0 && (
        <span className="badge busy">
          <span className="pulse" aria-hidden="true" />
          {running}
        </span>
      )}
      {running > 0 && (
        <StopButton
          label={`■ ${t("run_stopAll")}`}
          confirmLabel={t("run_stopAllConfirm", { n: running })}
          title={t("run_stopAllHint")}
          onStop={() =>
            void api
              .stopAll(model.detail.key)
              .then((r) => onInfo?.(t("run_stoppedAll", { n: r.stopped })))
              .catch((e: Error) => onError(e.message))
          }
        />
      )}
    </div>
  );
}

/**
 * A stop button that asks once more before it stops: the first click arms it for three seconds,
 * the second stops. Small buttons on busy screens are easy to hit by mistake.
 */
export function StopButton({
  onStop,
  label,
  confirmLabel,
  title,
  tiny,
}: {
  onStop: () => void;
  label: string;
  confirmLabel: string;
  title: string;
  tiny?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      className={`btn ${tiny ? "tiny" : "small"} stop-btn ${armed ? "armed" : ""}`}
      title={title}
      aria-label={armed ? confirmLabel : title}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) return setArmed(true);
        setArmed(false);
        onStop();
      }}
    >
      {armed ? `■ ${confirmLabel}` : label}
    </button>
  );
}

/** Stops a run and says what happens next. */
export async function stopRun(model: Model, run: RunSummary, t: T): Promise<string> {
  await api.stopRun(run.id);
  return t("run_stoppedToast", { task: run.task, agent: agentName(model, run.agent) });
}

/** Small lane badge: which CLI runs the chat and whether it is running now. */
export function RunnerBadge({ model, agentId, onClick }: { model: Model; agentId: string; onClick: () => void }) {
  const { t } = useI18n();
  const runner = runnerOf(model, agentId);
  const run = activeRun(model, agentId);
  const error = model.runners?.errors[agentId];
  if (!model.runners) return null;
  return (
    <button
      data-tour="runner"
      className={`runner-badge ${runner ? "on" : ""} ${run ? "running" : ""} ${error ? "error" : ""}`}
      title={error ?? (runner ? `${t("run_setup")} · ${PROVIDER_LABEL[runner.provider]}` : t("run_setup"))}
      aria-label={`${t("run_setup")}: ${agentName(model, agentId)}`}
      onClick={onClick}
    >
      {run ? <span className="pulse" aria-hidden="true" /> : <span aria-hidden="true">{runner ? "▶" : "⚙"}</span>}
      {runner ? PROVIDER_LABEL[runner.provider] : t("run_badgeManual")}
    </button>
  );
}
