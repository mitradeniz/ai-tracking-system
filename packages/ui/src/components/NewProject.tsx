import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  copyText,
  desktop,
  type AuthoringChat,
  type AuthoringCheck,
  type AuthoringInput,
  type DetectedProvider,
  type FolderInfo,
  type GenerateJob,
} from "../api.ts";
import { useI18n, type Lang } from "../i18n.ts";
import { agentIdFromName, formatDuration, type Model } from "../model.ts";
import { Dialog } from "./Dialogs.tsx";
import { InfoTip, useNow } from "./Info.tsx";
import { Segmented } from "./Settings.tsx";

/*
 * Creating a project: a three-step wizard (project, chats, plan). The plan is written by an AI CLI
 * installed on this computer, by any other AI (copy the instructions, paste the answer), or left
 * empty to be filled in the app.
 */

const TOOLS = ["claude", "codex", "copilot", "gemini", "cursor", "other"] as const;
const TOOL_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  gemini: "Gemini",
  cursor: "Cursor",
  other: "Chat",
};
export const GENERATORS = ["claude", "codex", "gemini", "copilot"] as const;
type Generator = (typeof GENERATORS)[number];
export const CLI_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI", copilot: "Copilot CLI" };

interface ChatDraft extends AuthoringChat {
  key: string;
}

const slug = (text: string) => {
  const id = agentIdFromName(text, []);
  return text.trim() ? id : "";
};

function joinPath(folder: string, file: string): string {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${file}`;
}

/** "Claude A", then "Claude B" … for the next chat of a tool. */
function nextChatName(tool: string, chats: ChatDraft[]): string {
  const base = TOOL_LABEL[tool] ?? "Chat";
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const name = `${base} ${letter}`;
    if (!chats.some((c) => c.name.toLowerCase() === name.toLowerCase())) return name;
  }
  return `${base} ${chats.length + 1}`;
}

function withIds(chats: ChatDraft[]): ChatDraft[] {
  const taken: string[] = [];
  return chats.map((c) => {
    const id = agentIdFromName(c.name || TOOL_LABEL[c.tool ?? "other"] || "chat", taken);
    taken.push(id);
    return { ...c, id };
  });
}

let draftCounter = 0;
const draft = (tool: string, chats: ChatDraft[]): ChatDraft => ({ key: `c${(draftCounter += 1)}`, id: "", name: nextChatName(tool, chats), tool, role: "" });

/** Installed CLIs, once per window. */
let providersPromise: Promise<DetectedProvider[]> | null = null;
export function useProviders(): DetectedProvider[] | null {
  const [list, setList] = useState<DetectedProvider[] | null>(null);
  useEffect(() => {
    providersPromise ??= api.providers().catch(() => []);
    let alive = true;
    void providersPromise.then((p) => alive && setList(p));
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

export function NewProjectWizard({
  onClose,
  onCreated,
  onOpenFile,
}: {
  onClose: () => void;
  onCreated: (key: string, message: string) => void;
  onOpenFile: () => void;
}) {
  const { t, lang } = useI18n();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [folder, setFolder] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileTouched, setFileTouched] = useState(false);
  const [language, setLanguage] = useState<Lang>(lang);
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const providers = useProviders();
  const [chats, setChats] = useState<ChatDraft[]>([]);
  const [chatsTouched, setChatsTouched] = useState(false);
  const [runThemselves, setRunThemselves] = useState(false);
  const [source, setSource] = useState<"ai" | "other" | "empty">("empty");
  const [sourceTouched, setSourceTouched] = useState(false);
  const [plan, setPlan] = useState("");
  const [result, setResult] = useState<AuthoringCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = idTouched ? id : slug(name);
  const file = fileTouched ? fileName : projectId ? `${projectId}.aitrack` : "";
  const filePath = folder.trim() && file ? joinPath(folder.trim(), file.endsWith(".aitrack") ? file : `${file}.aitrack`) : "";
  const installed = useMemo(() => new Set((providers ?? []).filter((p) => p.path).map((p) => p.id as string)), [providers]);
  const generators = GENERATORS.filter((g) => installed.has(g));

  // What is in the folder: a git repository, project files that are already there.
  useEffect(() => {
    const dir = folder.trim();
    if (!dir) {
      setInfo(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void api.folder(dir).then(
        (i) => alive && setInfo(i),
        () => alive && setInfo(null),
      );
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [folder]);

  // Suggested chats: one for each AI CLI found on this computer (Claude Code and Codex first).
  useEffect(() => {
    if (!providers || chatsTouched) return;
    const order = ["claude", "codex", "copilot", "gemini"].filter((p) => installed.has(p));
    const picked = order.filter((p) => p === "claude" || p === "codex");
    const tools = picked.length ? picked : order.slice(0, 1);
    const list: ChatDraft[] = [];
    for (const tool of tools) list.push(draft(tool, list));
    setChats(list);
  }, [providers, installed, chatsTouched]);

  // Default plan source: an installed CLI when there is one.
  useEffect(() => {
    if (!sourceTouched && providers) setSource(generators.length ? "ai" : "other");
  }, [providers, generators.length, sourceTouched]);

  const named = withIds(chats.filter((c) => c.name.trim()));
  const input: Omit<AuthoringInput, "plan"> = {
    projectId,
    projectName: name.trim(),
    language,
    chats: named.map(({ id: chatId, name: chatName, tool, role }) => ({ id: chatId, name: chatName.trim(), tool, role: role?.trim() || undefined })),
  };
  const inputKey = JSON.stringify(input);
  useEffect(() => setResult(null), [inputKey]);

  const existing = info?.projectFiles ?? [];
  const fileTaken = Boolean(file && existing.includes(file.endsWith(".aitrack") ? file : `${file}.aitrack`));
  const step0ok = Boolean(name.trim() && projectId && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId) && filePath && !fileTaken && !(info?.exists && !info.isDir));
  const canCreate = source === "empty" || Boolean(result?.text && result.errors.length === 0);

  const chooseFolder = async () => {
    const picked = await desktop?.chooseFolder?.(folder || undefined);
    if (picked) setFolder(picked);
  };

  const openExisting = async (fileOf: string) => {
    if (!info) return;
    setBusy(true);
    try {
      const res = await api.addProject(joinPath(info.path, fileOf));
      onCreated(res.key, t("np_opened", { name: res.name }));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res =
        source === "empty"
          ? await api.createProject({ filePath, id: projectId, name: name.trim(), language, agents: input.chats })
          : await api.createProject({ filePath, text: result!.text! });
      if (runThemselves) {
        const finalChats = source === "empty" ? input.chats : (result?.summary?.chats ?? []).map((c) => ({ id: c.id, name: c.name, tool: c.tool ?? undefined }));
        for (const c of finalChats) {
          if (c.tool && installed.has(c.tool)) {
            await api.saveRunner(res.key, c.id, { provider: c.tool as GenerateJob["provider"] }).catch(() => undefined);
          }
        }
      }
      onCreated(res.key, source === "empty" ? t("np_createdEmpty", { name: res.name }) : t("np_created", { name: res.name, n: result?.summary?.tasks.length ?? 0 }));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const steps = [t("np_step_project"), t("np_step_chats"), t("np_step_plan")];

  return (
    <Dialog title={t("newProject")} onClose={onClose} wide>
      <ol className="wizard-steps">
        {steps.map((s, i) => (
          <li key={s} className={i === step ? "current" : i < step ? "done" : ""}>
            <span className="wizard-n">{i < step ? "✓" : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {/* 1. Project */}
      <div hidden={step !== 0} className="wizard-body">
        <div className="field">
          <label htmlFor="np-name">{t("projectName")}</label>
          <input id="np-name" className="input" value={name} autoFocus placeholder={t("np_namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="np-folder">
            {t("np_folder")} <InfoTip text={t("np_folderHint")} />
          </label>
          <div className="row">
            <input
              id="np-folder"
              className="input mono"
              value={folder}
              placeholder={desktop ? t("np_folderPlaceholderDesktop") : "/Users/me/projects/app"}
              onChange={(e) => setFolder(e.target.value)}
            />
            {desktop?.chooseFolder && (
              <button className="btn" onClick={() => void chooseFolder()}>
                {t("browse")}
              </button>
            )}
          </div>
          {info && folder.trim() && (
            <div className="small folder-info">
              {!info.path ? (
                <span className="warn-text">{t("np_folderAbsolute")}</span>
              ) : !info.exists ? (
                <span className="muted">{t("np_folderNew")}</span>
              ) : !info.isDir ? (
                <span className="warn-text">{t("np_folderNotDir")}</span>
              ) : (
                <span className="muted">{info.isGit ? t("np_folderGit") : t("np_folderPlain")}</span>
              )}
              {existing.length > 0 && (
                <span className="folder-existing">
                  {t("np_folderHas")}{" "}
                  {existing.map((f) => (
                    <button key={f} className="link" disabled={busy} onClick={() => void openExisting(f)} title={t("np_openIt")}>
                      {f}
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="field">
          <label>
            {t("np_language")} <InfoTip text={t("np_languageHint")} />
          </label>
          <Segmented
            value={language}
            label={t("np_language")}
            options={[
              { value: "en", label: "English" },
              { value: "tr", label: "Türkçe" },
            ]}
            onChange={setLanguage}
          />
        </div>
        <details className="advanced">
          <summary>{t("np_advanced")}</summary>
          <div className="row wrap">
            <div className="field grow">
              <label htmlFor="np-id">{t("projectId")}</label>
              <input
                id="np-id"
                className="input mono"
                value={projectId}
                onChange={(e) => {
                  setIdTouched(true);
                  setId(e.target.value);
                }}
              />
            </div>
            <div className="field grow">
              <label htmlFor="np-file">{t("np_fileName")}</label>
              <input
                id="np-file"
                className="input mono"
                value={file}
                onChange={(e) => {
                  setFileTouched(true);
                  setFileName(e.target.value);
                }}
              />
            </div>
          </div>
        </details>
        {filePath && (
          <div className="small muted">
            {t("np_willWrite")} <span className="mono">{filePath}</span>
          </div>
        )}
        {fileTaken && <div className="error">{t("np_fileTaken")}</div>}
      </div>

      {/* 2. Chats */}
      <div hidden={step !== 1} className="wizard-body">
        <p className="small muted wizard-lead">{t("np_chatsLead")}</p>
        <div className="cli-found">
          {providers === null ? (
            <span className="small muted">{t("np_lookingForCli")}</span>
          ) : (
            ["claude", "codex", "copilot", "gemini"].map((p) => {
              const found = (providers ?? []).find((x) => x.id === p && x.path);
              return (
                <span key={p} className={`badge ${found ? "found" : "missing"}`} title={found?.path ?? t("np_cliMissing")}>
                  {found ? "✓" : "–"} {CLI_NAME[p]}
                  {found?.version ? <span className="muted"> {found.version.split(/\s+/)[0]}</span> : null}
                </span>
              );
            })
          )}
        </div>
        {chats.length === 0 && <div className="lane-empty small muted">{t("np_noChats")}</div>}
        <div className="chat-drafts">
          {chats.map((c, i) => (
            <div key={c.key} className="chat-draft">
              <input
                className="input"
                value={c.name}
                aria-label={t("agentName")}
                onChange={(e) => {
                  setChatsTouched(true);
                  setChats(chats.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)));
                }}
              />
              <select
                className="input"
                value={c.tool}
                aria-label={t("agentTool")}
                onChange={(e) => {
                  setChatsTouched(true);
                  setChats(chats.map((x, j) => (j === i ? { ...x, tool: e.target.value } : x)));
                }}
              >
                {TOOLS.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool === "other" ? t("agentToolOther") : TOOL_LABEL[tool]}
                  </option>
                ))}
              </select>
              <input
                className="input"
                value={c.role}
                placeholder={t("np_rolePlaceholder")}
                aria-label={t("agentRole")}
                onChange={(e) => {
                  setChatsTouched(true);
                  setChats(chats.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)));
                }}
              />
              <button
                className="icon-btn"
                aria-label={t("np_removeChat")}
                title={t("np_removeChat")}
                onClick={() => {
                  setChatsTouched(true);
                  setChats(chats.filter((_, j) => j !== i));
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="row wrap">
          {TOOLS.map((tool) => (
            <button
              key={tool}
              className="btn small"
              onClick={() => {
                setChatsTouched(true);
                setChats([...chats, draft(tool, chats)]);
              }}
            >
              + {tool === "other" ? t("agentToolOther") : TOOL_LABEL[tool]}
            </button>
          ))}
        </div>
        {chats.some((c) => c.tool && installed.has(c.tool)) && (
          <label className="check wide-check">
            <input type="checkbox" checked={runThemselves} onChange={(e) => setRunThemselves(e.target.checked)} />
            {t("np_runThemselves")}
            <InfoTip text={t("np_runThemselvesHint")} />
          </label>
        )}
        <div className="small muted">{t("np_chatsLater")}</div>
      </div>

      {/* 3. Plan */}
      <div hidden={step !== 2} className="wizard-body">
        <div className="source-cards" role="radiogroup" aria-label={t("np_step_plan")}>
          {(
            [
              ["ai", t("np_src_ai"), generators.length ? t("np_src_aiHint", { cli: generators.map((g) => CLI_NAME[g]).join(" / ") }) : t("np_src_aiNone")],
              ["other", t("np_src_other"), t("np_src_otherHint")],
              ["empty", t("np_src_empty"), t("np_src_emptyHint")],
            ] as const
          ).map(([value, title, hint]) => (
            <button
              key={value}
              role="radio"
              aria-checked={source === value}
              className="source-card"
              disabled={value === "ai" && generators.length === 0}
              onClick={() => {
                setSourceTouched(true);
                setSource(value);
              }}
            >
              <strong>{title}</strong>
              <span className="small muted">{hint}</span>
            </button>
          ))}
        </div>
        {source !== "empty" && (
          <PlanSource
            mode={source}
            input={input}
            plan={plan}
            onPlan={setPlan}
            cwd={info?.exists && info.isDir ? info.path : folder.trim()}
            folderReadable={Boolean(info?.exists && info.isDir)}
            providers={providers ?? []}
            onResult={setResult}
            result={result}
          />
        )}
        {source === "empty" && (
          <div className="small muted">{input.chats.length ? t("np_emptyNext") : t("np_emptyNextNoChats")}</div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      <div className="row">
        {step === 0 ? (
          <button className="btn ghost small" onClick={onOpenFile}>
            {t("np_haveFile")}
          </button>
        ) : (
          <button className="btn ghost" onClick={() => setStep(step - 1)}>
            ← {t("np_back")}
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        {step < 2 ? (
          <button className="btn primary" disabled={step === 0 && !step0ok} onClick={() => setStep(step + 1)}>
            {t("np_next")} →
          </button>
        ) : (
          <button className="btn primary" disabled={busy || !canCreate || !step0ok} onClick={() => void create()}>
            {busy ? t("np_creating") : t("np_create")}
          </button>
        )}
      </div>
    </Dialog>
  );
}

/** Writing the plan with an AI: with a CLI on this computer, or with any other AI by copy and paste. */
export function PlanSource({
  mode,
  input,
  plan,
  onPlan,
  cwd,
  folderReadable,
  providers,
  result,
  onResult,
}: {
  mode: "ai" | "other";
  input: Omit<AuthoringInput, "plan">;
  plan: string;
  onPlan: (plan: string) => void;
  cwd: string;
  folderReadable: boolean;
  providers: DetectedProvider[];
  result: AuthoringCheck | null;
  onResult: (check: AuthoringCheck | null) => void;
}) {
  const { t } = useI18n();
  const generators = GENERATORS.filter((g) => providers.some((p) => p.id === g && p.path));
  const [provider, setProvider] = useState<Generator | "">(generators[0] ?? "");
  const [modelId, setModelId] = useState("");
  const [readFolder, setReadFolder] = useState(true);
  const [job, setJob] = useState<GenerateJob | null>(null);
  const [answer, setAnswer] = useState("");
  const [check, setCheck] = useState<AuthoringCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const jobRef = useRef<GenerateJob | null>(null);
  jobRef.current = job;
  const running = job?.state === "running";
  const now = useNow(running);

  useEffect(() => {
    if (!provider && generators[0]) setProvider(generators[0]);
  }, [provider, generators]);

  // Results are for the inputs they were made with.
  const inputKey = JSON.stringify(input);
  useEffect(() => {
    setCheck(null);
  }, [inputKey, mode]);
  useEffect(() => {
    if (!result) setCheck((c) => (c && c.errors.length === 0 ? null : c));
  }, [result]);

  // A run still going when the window closes is stopped.
  useEffect(
    () => () => {
      const j = jobRef.current;
      if (j?.state === "running") void api.stopGenerate(j.id).catch(() => undefined);
    },
    [],
  );

  const full = (previous?: { text: string; errors: string[] }): AuthoringInput => ({
    ...input,
    plan,
    canReadRepository: mode === "ai" && readFolder && folderReadable,
    previous,
  });

  const accept = async (text: string) => {
    const res = await api.checkAnswer(text, full());
    setCheck(res);
    onResult(res.errors.length === 0 && res.text ? res : null);
  };

  const generate = async (previous?: { text: string; errors: string[] }) => {
    if (!provider) return;
    setError(null);
    setCheck(null);
    onResult(null);
    try {
      let current = await api.generate(provider, cwd, full(previous), modelId || undefined);
      setJob(current);
      while (current.state === "running") {
        await new Promise((r) => window.setTimeout(r, 1000));
        current = await api.generateStatus(current.id);
        setJob(current);
      }
      if (current.state === "done" && current.answer) await accept(current.answer);
      else if (current.state === "failed") setError(current.error ?? t("np_aiFailed"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyInstructions = async (previous?: { text: string; errors: string[] }) => {
    try {
      await copyText(await api.authoringPrompt(full(previous)));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const models = providers.find((p) => p.id === provider)?.models ?? [];
  const errors = check?.errors ?? [];

  return (
    <div className="plan-source">
      <div className="field">
        <label htmlFor="plan-text">
          {t("np_plan")} <InfoTip text={t("np_planHint")} />
        </label>
        <textarea
          id="plan-text"
          className="input plan-text"
          value={plan}
          placeholder={t("np_planPlaceholder")}
          onChange={(e) => onPlan(e.target.value)}
        />
      </div>

      {mode === "ai" ? (
        <>
          <div className="row wrap">
            <div className="field">
              <label htmlFor="plan-cli">{t("np_cli")}</label>
              <select id="plan-cli" className="input" value={provider} onChange={(e) => setProvider(e.target.value as Generator)} disabled={running}>
                {generators.map((g) => (
                  <option key={g} value={g}>
                    {CLI_NAME[g]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="plan-model">{t("run_model")}</label>
              <select id="plan-model" className="input" value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={running}>
                <option value="">{t("run_modelDefault")}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="check wide-check" title={folderReadable ? cwd : t("np_readFolderMissing")}>
              <input type="checkbox" checked={readFolder && folderReadable} disabled={!folderReadable || running} onChange={(e) => setReadFolder(e.target.checked)} />
              {t("np_readFolder")}
              <InfoTip text={t("np_readFolderHint")} align="end" />
            </label>
          </div>
          {running ? (
            <div className="gen-progress">
              <div className="row">
                <span className="pulse" aria-hidden="true" />
                <strong>{t("np_aiWorking", { cli: CLI_NAME[job!.provider] ?? job!.provider })}</strong>
                <span className="mono muted">{formatDuration(now - Date.parse(job!.startedAt))}</span>
                <span className="spacer" />
                <button className="btn small" onClick={() => void api.stopGenerate(job!.id).then(setJob)}>
                  {t("run_stop")}
                </button>
              </div>
              <div className="gen-activity mono small">
                {(job!.activity.length ? job!.activity.slice(-5) : [t("np_aiStarting")]).map((line, i) => (
                  <div key={i} className="ellipsis">
                    {line}
                  </div>
                ))}
              </div>
              <div className="small muted">{t("np_aiWait")}</div>
            </div>
          ) : (
            <div className="row">
              <button className="btn primary" disabled={!provider || (!plan.trim() && !(readFolder && folderReadable))} onClick={() => void generate()}>
                {check ? t("np_aiAgain") : t("np_aiCreate", { cli: CLI_NAME[provider] ?? "" })}
              </button>
              {job?.state === "stopped" && <span className="small muted">{t("np_aiStopped")}</span>}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row wrap">
            <button className="btn" disabled={!plan.trim()} onClick={() => void copyInstructions()}>
              {copied ? `✓ ${t("copied")}` : t("np_copyInstructions")}
            </button>
            <span className="small muted">{t("np_copyHint")}</span>
          </div>
          <div className="field">
            <label htmlFor="plan-answer">{t("np_answer")}</label>
            <textarea
              id="plan-answer"
              className="input mono plan-answer"
              value={answer}
              placeholder={t("np_answerPlaceholder")}
              onChange={(e) => {
                setAnswer(e.target.value);
                if (check) {
                  setCheck(null);
                  onResult(null);
                }
              }}
            />
          </div>
          <div className="row">
            <button className="btn primary" disabled={!answer.trim()} onClick={() => void accept(answer).catch((e) => setError((e as Error).message))}>
              {t("np_check")}
            </button>
          </div>
        </>
      )}

      {error && <div className="error">{error}</div>}
      {check && errors.length > 0 && (
        <div className="danger-zone">
          <strong>{t("np_errors", { n: errors.length })}</strong>
          <ul className="plain-list">
            {errors.slice(0, 8).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <div className="row">
            {mode === "ai" ? (
              <button className="btn" onClick={() => void generate({ text: jobRef.current?.answer ?? "", errors })}>
                {t("np_aiFix", { cli: CLI_NAME[provider] ?? "" })}
              </button>
            ) : (
              <button className="btn" onClick={() => void copyInstructions({ text: answer, errors })}>
                {copied ? `✓ ${t("copied")}` : t("np_copyFix")}
              </button>
            )}
          </div>
        </div>
      )}
      {check && errors.length === 0 && check.summary && <PlanPreview check={check} />}
    </div>
  );
}

/** What the AI planned: chats, tasks and their order, before anything is saved. */
export function PlanPreview({ check }: { check: AuthoringCheck }) {
  const { t } = useI18n();
  const s = check.summary!;
  const names = new Map(s.chats.map((c) => [c.id, c.name]));
  const firsts = s.tasks.filter((x) => x.dependsOn.length === 0).length;
  return (
    <div className="plan-preview">
      <div className="row wrap">
        <strong>✓ {t("np_ready")}</strong>
        <span className="pill ready">{t(s.tasks.length === 1 ? "np_nTask1" : "np_nTasks", { n: s.tasks.length })}</span>
        <span className="pill">{t(s.chats.length === 1 ? "np_nChat1" : "np_nChats", { n: s.chats.length })}</span>
        <span className="pill">{t(s.prompts === 1 ? "np_nPrompt1" : "np_nPrompts", { n: s.prompts })}</span>
        {s.milestones.length > 0 && (
          <span className="pill">{t(s.milestones.length === 1 ? "np_nMilestone1" : "np_nMilestones", { n: s.milestones.length })}</span>
        )}
        <span className="small muted">{t("np_startNow", { n: firsts })}</span>
      </div>
      <div className="plan-table">
        <table>
          <thead>
            <tr>
              <th>{t("task")}</th>
              <th>{t("title")}</th>
              <th>{t("chat")}</th>
              <th>{t("dependsOn")}</th>
            </tr>
          </thead>
          <tbody>
            {s.tasks.map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.id}</td>
                <td>{x.title}</td>
                <td>{names.get(x.agent) ?? x.agent}</td>
                <td className="mono muted">{x.dependsOn.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {check.warnings.length > 0 && (
        <details className="advanced">
          <summary>{t("np_warnings", { n: check.warnings.length })}</summary>
          <ul className="plain-list small muted">
            {check.warnings.slice(0, 20).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Planning an existing project that has no tasks yet, with an AI. */
export function PlanWithAIDialog({ model, onClose, onDone }: { model: Model; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useI18n();
  const project = model.detail.project!;
  const providers = useProviders();
  const generators = GENERATORS.filter((g) => (providers ?? []).some((p) => p.id === g && p.path));
  const [mode, setMode] = useState<"ai" | "other">("ai");
  const [touched, setTouched] = useState(false);
  const [plan, setPlan] = useState("");
  const [result, setResult] = useState<AuthoringCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!touched && providers) setMode(generators.length ? "ai" : "other");
  }, [providers, generators.length, touched]);
  const folder = model.detail.filePath.replace(/[\\/][^\\/]*$/, "");
  const input: Omit<AuthoringInput, "plan"> = {
    projectId: project.project.id,
    projectName: project.project.name,
    language: project.settings.language,
    chats: project.agents.map((a) => ({ id: a.id, name: a.name, tool: a.tool, role: a.role })),
  };
  const save = async () => {
    if (!result?.text) return;
    setBusy(true);
    setError(null);
    try {
      await api.replacePlan(model.detail.key, result.text);
      onDone(t("np_planned", { n: result.summary?.tasks.length ?? 0 }));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("np_planWithAi")} onClose={onClose} wide>
      <p className="small muted wizard-lead">{t("np_planWithAiLead")}</p>
      <Segmented
        value={mode}
        label={t("np_step_plan")}
        options={[
          { value: "ai", label: t("np_src_ai") },
          { value: "other", label: t("np_src_other") },
        ]}
        onChange={(m) => {
          if (m === "ai" && !generators.length) return;
          setTouched(true);
          setMode(m);
          setResult(null);
        }}
      />
      {mode === "ai" && !generators.length ? (
        <div className="small muted">{t("np_src_aiNone")}</div>
      ) : (
        <PlanSource
          key={mode}
          mode={mode}
          input={input}
          plan={plan}
          onPlan={setPlan}
          cwd={folder}
          folderReadable
          providers={providers ?? []}
          result={result}
          onResult={setResult}
        />
      )}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn primary" disabled={busy || !result?.text} onClick={() => void save()}>
          {t("np_savePlan")}
        </button>
      </div>
    </Dialog>
  );
}
