import { useEffect, useState } from "react";
import { api, type ManagerProvider, type ManagerRun, type ManagerSettings } from "../api.ts";
import { useI18n, type Key } from "../i18n.ts";
import { formatTime, localError, type Model } from "../model.ts";
import { Dialog } from "./Dialogs.tsx";
import { InfoTip } from "./Info.tsx";
import { CLI_NAME, GENERATORS, useProviders } from "./NewProject.tsx";

const ACTIONS = new Set(["reply", "choose", "allow", "wait", "resend", "close", "plan", "leave"]);

/** What the manager left for the person in its recent runs, newest first, once each. */
function leftForYou(log: ManagerRun[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const run of log) {
    for (const item of run.forYou) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out.slice(0, 12);
}

/** Header switch: hand the project to a manager CLI, e.g. for the night. */
export function ManagerSwitch({ model, onOpen, onError, onInfo }: { model: Model; onOpen: () => void; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { t } = useI18n();
  const state = model.runners?.manager;
  if (!state) return null;
  const on = state.settings.enabled;
  const waiting = leftForYou(state.log.slice(0, 5)).length;
  const toggle = async () => {
    // Turning it on goes through the dialog: the person picks the CLI and reads what it may do.
    if (!on) {
      onOpen();
      return;
    }
    try {
      await api.saveManager(model.detail.key, { enabled: false });
      onInfo(t("mgr_disabled"));
    } catch (e) {
      onError(localError((e as Error).message, t));
    }
  };
  return (
    <div className={`auto-dispatch manager-switch ${on ? "on" : ""}`} title={t("mgr_hint")}>
      <button className="switch" role="switch" aria-checked={on} onClick={() => void toggle()}>
        <span className="knob" aria-hidden="true" />
        <span>{t("mgr_switch")}</span>
      </button>
      {on && (
        <span className="small muted">{CLI_NAME[state.settings.provider] ?? state.settings.provider}</span>
      )}
      {state.running && (
        <span className="badge busy" title={t("mgr_working")}>
          <span className="pulse" aria-hidden="true" />
        </span>
      )}
      <button className="btn tiny ghost" onClick={onOpen} title={t("mgr_title")} aria-label={t("mgr_title")}>
        ⚙{waiting > 0 && <span className="count-dot">{waiting}</span>}
      </button>
    </div>
  );
}

function RunEntry({ run, lang, onOpenTask }: { run: ManagerRun; lang: string; onOpenTask?: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <div className={`mgr-run mgr-${run.state}`}>
      <div className="row small">
        <span className={`pill run-${run.state === "running" ? "running" : run.state === "done" ? "done" : "failed"}`}>
          {t(`mgr_state_${run.state}` as Key)}
        </span>
        <span className="muted">
          {formatTime(run.startedAt, lang)} · {t(run.trigger === "auto" ? "mgr_trigger_auto" : "mgr_trigger_manual")} · {CLI_NAME[run.provider] ?? run.provider}
        </span>
      </div>
      {run.summary && <div className="small">{run.summary}</div>}
      {run.error && <div className="error small">{run.error}</div>}
      {run.actions.length > 0 && (
        <ul className="mgr-actions small">
          {run.actions.map((a, i) => (
            <li key={i} className={a.ok ? "" : "muted"}>
              <span aria-hidden="true">{a.ok ? "✓" : "✕"}</span>{" "}
              <strong>{ACTIONS.has(a.type) ? t(`mgr_action_${a.type}` as Key) : a.type}</strong>{" "}
              {a.task &&
                (onOpenTask ? (
                  <button className="linklike mono" onClick={() => onOpenTask(a.task!)}>
                    {a.task}
                  </button>
                ) : (
                  <span className="mono">{a.task}</span>
                ))}{" "}
              <span className="muted">{a.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Choose the manager CLI, hand the project over or take it back, and see what it did. */
export function ManagerDialog({
  model,
  onClose,
  onInfo,
  onError,
  onOpenTask,
}: {
  model: Model;
  onClose: () => void;
  onInfo: (m: string) => void;
  onError: (m: string) => void;
  onOpenTask?: (id: string) => void;
}) {
  const { t, lang } = useI18n();
  const key = model.detail.key;
  const state = model.runners?.manager;
  const providers = useProviders();
  const installed = GENERATORS.filter((g) => providers?.some((p) => p.id === g && p.path));
  const [draft, setDraft] = useState<ManagerSettings | null>(state?.settings ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!draft && state) setDraft(state.settings);
  }, [draft, state]);
  // A CLI that is not installed is replaced by the first one that is.
  useEffect(() => {
    if (draft && providers && installed.length && !installed.includes(draft.provider)) setDraft({ ...draft, provider: installed[0]!, model: undefined });
  }, [draft, providers, installed]);
  if (!state || !draft) return null;
  const on = state.settings.enabled;
  const models = providers?.find((p) => p.id === draft.provider)?.models ?? [];
  const forYou = leftForYou(state.log);
  const manualChats = (model.detail.project?.agents ?? []).filter((a) => (model.runners?.settings.chats[a.id]?.provider ?? "manual") === "manual");

  const save = async (patch: Partial<ManagerSettings>, message?: string) => {
    setBusy(true);
    try {
      const next = await api.saveManager(key, patch);
      setDraft(next.settings);
      if (message) onInfo(message);
    } catch (e) {
      onError(localError((e as Error).message, t));
    } finally {
      setBusy(false);
    }
  };
  const settingsPatch = (): Partial<ManagerSettings> => ({
    provider: draft.provider,
    model: draft.model ?? "",
    maxRunsPerHour: draft.maxRunsPerHour,
    resumeStopped: draft.resumeStopped,
  });
  const runNow = async () => {
    setBusy(true);
    try {
      await api.runManager(key);
      onInfo(t("mgr_runStarted"));
    } catch (e) {
      onError(localError((e as Error).message, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("mgr_title")} onClose={onClose} wide>
      <p className="small">{t("mgr_hint")}</p>
      <div className="row wrap">
        <div className="field">
          <label htmlFor="mgr-cli">{t("mgr_cli")}</label>
          <select
            id="mgr-cli"
            className="input"
            value={draft.provider}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value as ManagerProvider, model: undefined })}
          >
            {(installed.length ? installed : GENERATORS).map((g) => (
              <option key={g} value={g}>
                {CLI_NAME[g]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mgr-model">{t("run_model")}</label>
          <select id="mgr-model" className="input" value={draft.model ?? ""} disabled={busy} onChange={(e) => setDraft({ ...draft, model: e.target.value || undefined })}>
            <option value="">{t("run_modelDefault")}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mgr-rate">
            {t("mgr_perHour")} <InfoTip text={t("mgr_perHourHint")} />
          </label>
          <select id="mgr-rate" className="input" value={draft.maxRunsPerHour} disabled={busy} onChange={(e) => setDraft({ ...draft, maxRunsPerHour: Number(e.target.value) })}>
            {[2, 4, 6, 10, 20].map((n) => (
              <option key={n} value={n}>
                {t("mgr_runs", { n })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={draft.resumeStopped} disabled={busy} onChange={(e) => setDraft({ ...draft, resumeStopped: e.target.checked })} />
        {t("mgr_resume")} <InfoTip text={t("mgr_resumeHint")} />
      </label>
      {providers && !installed.length && <p className="error small">{t("prop_noCli")}</p>}
      {manualChats.length > 0 && <p className="small muted">{t("mgr_manualChats", { chats: manualChats.map((a) => a.name).join(", ") })}</p>}
      <p className="small muted">{t("mgr_awake")}</p>
      <div className="row wrap">
        {on ? (
          <>
            <button className="btn primary" disabled={busy} onClick={() => void save(settingsPatch(), t("mgr_saved"))}>
              {t("save")}
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void save({ enabled: false }, t("mgr_disabled"))}>
              {t("mgr_off")}
            </button>
          </>
        ) : (
          <button
            className="btn primary"
            disabled={busy || (Boolean(providers) && !installed.length)}
            onClick={() => void save({ ...settingsPatch(), enabled: true }, t("mgr_enabled"))}
          >
            {t("mgr_on")}
          </button>
        )}
        <button className="btn" disabled={busy || state.running} onClick={() => void runNow()} title={t("mgr_runNowHint")}>
          {state.running ? t("mgr_working") : t("mgr_runNow")}
        </button>
      </div>

      {forYou.length > 0 && (
        <section className="section">
          <h3>{t("mgr_forYou")}</h3>
          <ul className="mgr-foryou">
            {forYou.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="section">
        <h3>{t("mgr_log")}</h3>
        {state.log.length === 0 ? (
          <p className="small muted">{t("mgr_logEmpty")}</p>
        ) : (
          <div className="mgr-log">
            {state.log.slice(0, 15).map((run) => (
              <RunEntry key={run.id} run={run} lang={lang} onOpenTask={onOpenTask} />
            ))}
          </div>
        )}
      </section>
    </Dialog>
  );
}
