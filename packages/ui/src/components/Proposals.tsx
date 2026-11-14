import type { IntegrationPlan, Proposal } from "@aitrack/core";
import { useEffect, useRef, useState } from "react";
import { api, type GenerateJob, type ManagerProvider } from "../api.ts";
import { useI18n } from "../i18n.ts";
import { agentName, formatDuration, localError, notesOf, openProposals, type Model } from "../model.ts";
import { Dialog } from "./Dialogs.tsx";
import { InfoTip, useNow } from "./Info.tsx";
import { CLI_NAME, GENERATORS, useProviders } from "./NewProject.tsx";

/** Open notes of every task, for the count. */
function openNotesCount(model: Model): number {
  let n = 0;
  for (const s of model.snap.values()) n += notesOf(s).length;
  return n;
}

/** A line above the board when chats left work for later. */
export function ProposalsStrip({ model, onOpen }: { model: Model; onOpen: () => void }) {
  const { t } = useI18n();
  const open = openProposals(model);
  if (!open.length) return null;
  return (
    <div className="proposals-strip" role="status">
      <span className="proposals-icon" aria-hidden="true">
        ＋
      </span>
      <span className="grow">
        <strong>{t("prop_strip", { n: open.length })}</strong>{" "}
        <span className="muted small ellipsis">{open.slice(0, 3).map((p) => p.title).join(" · ")}</span>
      </span>
      <button className="btn small primary" onClick={onOpen}>
        {t("prop_review")}
      </button>
    </div>
  );
}

/** One proposed task: who left it, for which chat, and what to do with it. */
function ProposalRow({
  model,
  proposal,
  busy,
  onAdd,
  onIgnore,
  onOpenTask,
}: {
  model: Model;
  proposal: Proposal;
  busy: boolean;
  onAdd: (agent: string) => void;
  onIgnore: () => void;
  onOpenTask?: (id: string) => void;
}) {
  const { t } = useI18n();
  const agents = model.detail.project?.agents ?? [];
  const fallback = model.task.get(proposal.from)?.agent ?? agents[0]?.id ?? "";
  const [agent, setAgent] = useState(proposal.agent && model.agent.has(proposal.agent) ? proposal.agent : fallback);
  return (
    <div className="proposal">
      <div className="proposal-main">
        <div className="proposal-title">{proposal.title}</div>
        {proposal.detail && <div className="small muted proposal-detail">{proposal.detail}</div>}
        <div className="small muted row wrap">
          {onOpenTask ? (
            <button className="linklike" onClick={() => onOpenTask(proposal.from)}>
              {t("prop_from", { task: proposal.from })}
            </button>
          ) : (
            <span>{t("prop_from", { task: proposal.from })}</span>
          )}
          {proposal.by && <span>· {agentName(model, proposal.by)}</span>}
          {proposal.after.length > 0 && <span>· {t("prop_after", { tasks: proposal.after.join(", ") })}</span>}
        </div>
      </div>
      <div className="proposal-actions">
        <select className="input tiny" aria-label={t("prop_for")} value={agent} onChange={(e) => setAgent(e.target.value)} disabled={busy}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button className="btn small primary" disabled={busy || !agent} onClick={() => onAdd(agent)}>
          {t("prop_add")}
        </button>
        <button className="btn small ghost" disabled={busy} onClick={onIgnore}>
          {t("prop_ignore")}
        </button>
      </div>
    </div>
  );
}

/** What a CLI's plan would change, before it is written. */
function PlanPreview({ model, plan, dropped }: { model: Model; plan: IntegrationPlan; dropped: string[] }) {
  const { t } = useI18n();
  const proposals = new Map((model.detail.board?.proposals ?? []).map((p) => [p.id, p]));
  const title = (id: string) => proposals.get(id)?.title ?? id;
  return (
    <div className="integrate-preview">
      {plan.summary && <p className="small">{plan.summary}</p>}
      {plan.tasks.length > 0 && (
        <>
          <h4>{t("prop_newTasks", { n: plan.tasks.length })}</h4>
          <ul className="plan-list">
            {plan.tasks.map((task) => (
              <li key={task.id}>
                <span className="mono">{task.id}</span> <strong>{task.title}</strong>{" "}
                <span className="pill">{agentName(model, task.agent)}</span>
                {task.dependsOn?.length ? <span className="small muted"> · {t("prop_waitsFor", { tasks: task.dependsOn.join(", ") })}</span> : null}
                {task.instructions && <div className="small muted clamp-2">{task.instructions}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.links.length > 0 && (
        <>
          <h4>{t("prop_links", { n: plan.links.reduce((n, l) => n + l.proposals.length, 0) })}</h4>
          <ul className="plan-list">
            {plan.links.map((l) => (
              <li key={l.task}>
                <span className="mono">{l.task}</span> ← {l.proposals.map(title).join(" · ")}
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.ignore.length > 0 && (
        <>
          <h4>{t("prop_dropping", { n: plan.ignore.length })}</h4>
          <ul className="plan-list muted">
            {plan.ignore.map((id) => (
              <li key={id}>{title(id)}</li>
            ))}
          </ul>
        </>
      )}
      {dropped.length > 0 && (
        <details className="small muted">
          <summary>{t("prop_dropped")}</summary>
          <ul>
            {dropped.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </details>
      )}
      {!plan.tasks.length && !plan.links.length && !plan.ignore.length && <p className="muted">{t("prop_nothing")}</p>}
    </div>
  );
}

/** Proposed tasks: add or ignore each, or let a CLI fold them all into the plan. */
export function ProposalsDialog({
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
  const { t } = useI18n();
  const key = model.detail.key;
  const all = model.detail.board?.proposals ?? [];
  const open = all.filter((p) => p.state === "open");
  const ignored = all.filter((p) => p.state === "ignored");
  const notes = openNotesCount(model);
  const providers = useProviders();
  const installed = GENERATORS.filter((g) => providers?.some((p) => p.id === g && p.path));
  const preferred = model.runners?.manager?.settings.provider;
  const [provider, setProvider] = useState<ManagerProvider | "">("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<GenerateJob | null>(null);
  const [preview, setPreview] = useState<{ plan: IntegrationPlan; dropped: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const running = job?.state === "running";
  const now = useNow(running);

  useEffect(() => {
    if (!provider && installed.length) setProvider(preferred && installed.includes(preferred) ? preferred : installed[0]!);
  }, [provider, installed, preferred]);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      onInfo(await work());
    } catch (e) {
      onError(localError((e as Error).message, t));
    } finally {
      setBusy(false);
    }
  };

  const integrate = async () => {
    if (!provider) return;
    setError(null);
    setPreview(null);
    try {
      let current = await api.integrateProposals(key, provider, modelId || undefined);
      setJob(current);
      while (current.state === "running") {
        await new Promise((r) => window.setTimeout(r, 1000));
        if (!alive.current) return;
        current = await api.generateStatus(current.id);
        setJob(current);
      }
      if (current.state === "done" && current.answer) setPreview(await api.previewPlan(key, current.answer));
      else if (current.state === "failed") setError(current.error ?? t("np_aiFailed"));
    } catch (e) {
      setError(localError((e as Error).message, t));
    }
  };

  const write = () =>
    act(async () => {
      const result = await api.applyPlan(key, preview!.plan);
      setPreview(null);
      setJob(null);
      if (result.errors.length) onError(result.errors.join("\n"));
      return t("prop_written", { n: result.created.length });
    });

  const models = providers?.find((p) => p.id === provider)?.models ?? [];

  return (
    <Dialog title={t("prop_title")} onClose={onClose} wide>
      <p className="small muted">
        {t("prop_hint")} <InfoTip text={t("prop_integrateHint")} />
      </p>
      {open.length === 0 && !preview && <p className="muted">{t("prop_none")}</p>}
      {!preview && (
        <div className="proposal-list">
          {open.map((p) => (
            <ProposalRow
              key={p.id}
              model={model}
              proposal={p}
              busy={busy || running}
              onOpenTask={onOpenTask}
              onAdd={(agent) =>
                void act(async () => {
                  const r = await api.addProposal(key, p.id, agent);
                  return t("prop_added", { task: r.created[0] ?? "" });
                })
              }
              onIgnore={() =>
                void act(async () => {
                  await api.setProposals(key, [p.id], "ignored");
                  return t("prop_ignoredToast", { title: p.title });
                })
              }
            />
          ))}
        </div>
      )}

      {(open.length > 0 || notes > 0) && (
        <section className="section integrate">
          <div className="row">
            <h3 style={{ margin: 0 }}>{t("prop_integrate")}</h3>
            <InfoTip text={t("prop_integrateHint")} />
          </div>
          {providers && !installed.length ? (
            <p className="small muted">{t("prop_noCli")}</p>
          ) : running ? (
            <div className="gen-progress">
              <div className="row">
                <span className="pulse" aria-hidden="true" />
                <strong>{t("prop_working", { cli: CLI_NAME[job!.provider] ?? job!.provider })}</strong>
                <span className="mono muted">{formatDuration(now - Date.parse(job!.startedAt))}</span>
                <span className="spacer" />
                <button className="btn small" onClick={() => void api.stopGenerate(job!.id).then(setJob)}>
                  {t("run_stop")}
                </button>
              </div>
              <div className="gen-activity mono small">
                {(job!.activity.length ? job!.activity.slice(-4) : [t("np_aiStarting")]).map((line, i) => (
                  <div key={i} className="ellipsis">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          ) : preview ? (
            <>
              <h4>{t("prop_preview")}</h4>
              <PlanPreview model={model} plan={preview.plan} dropped={preview.dropped} />
              <div className="row">
                <button
                  className="btn primary"
                  disabled={busy || (!preview.plan.tasks.length && !preview.plan.links.length && !preview.plan.ignore.length)}
                  onClick={() => void write()}
                >
                  {t("prop_write")}
                </button>
                <button className="btn" disabled={busy} onClick={() => void integrate()}>
                  {t("np_aiAgain")}
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => setPreview(null)}>
                  {t("cancel")}
                </button>
              </div>
            </>
          ) : (
            <div className="row wrap">
              <select className="input" aria-label={t("np_cli")} value={provider} onChange={(e) => setProvider(e.target.value as ManagerProvider)}>
                {installed.map((g) => (
                  <option key={g} value={g}>
                    {CLI_NAME[g]}
                  </option>
                ))}
              </select>
              <select className="input" aria-label={t("run_model")} value={modelId} onChange={(e) => setModelId(e.target.value)}>
                <option value="">{t("run_modelDefault")}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={!provider || busy} onClick={() => void integrate()}>
                {t("prop_integrateWith", { cli: CLI_NAME[provider] ?? "" })}
              </button>
              {notes > 0 && <span className="small muted">{t("prop_withNotes", { n: notes })}</span>}
            </div>
          )}
          {error && <div className="error small">{error}</div>}
        </section>
      )}

      {ignored.length > 0 && (
        <details className="closed-problems">
          <summary className="small muted">{t("prop_ignored", { n: ignored.length })}</summary>
          {ignored.map((p) => (
            <div className="closed-problem" key={p.id}>
              <span className="grow ellipsis" title={p.detail ?? p.title}>
                {p.title} <span className="muted small">· {p.from}</span>
              </span>
              <button
                className="btn small ghost"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.setProposals(key, [p.id], "open");
                    return t("prop_restored", { title: p.title });
                  })
                }
              >
                {t("prop_restore")}
              </button>
            </div>
          ))}
        </details>
      )}
    </Dialog>
  );
}
