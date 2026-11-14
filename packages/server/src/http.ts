import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { authoringPrompt, parsePlan, readGeneratedProject, ReportSchema, type AuthoringInput, type IntegrationPlan } from "@aitrack/core";
import { tokenMatches } from "./control.ts";
import { HttpError, type ProjectManager } from "./manager.ts";
import { detectProviders } from "./runners/env.ts";
import { normalizeHook } from "./runners/hooks.ts";
import { GENERATOR_PROVIDERS, type GeneratorProvider, type ProjectGenerator } from "./runners/generate.ts";
import { applyPlan, checkPlan, integrationPrompt, openNotes, taskFromProposal } from "./proposals.ts";
import { planFolder, type RunManager } from "./runners/runs.ts";
import type { Supervisor } from "./runners/supervisor.ts";

export const VERSION = "0.1.0";
const MAX_BODY = 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

export interface HttpOptions {
  uiDir?: string;
  /** Agent runners; without them the run endpoints answer 404. */
  runs?: RunManager;
  /** Writes project plans with an installed AI CLI. */
  generator?: ProjectGenerator;
  /** Required in the X-Aitrack-Token header by the endpoints that start programs. */
  controlToken?: string;
  /** The manager that stands in for the person while they are away. */
  supervisor?: Supervisor;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  port: number;
}

export interface FolderInfo {
  path: string;
  exists: boolean;
  isDir: boolean;
  /** A git repository (agents can then work in it and in its worktrees). */
  isGit: boolean;
  /** Project files already in the folder. */
  projectFiles: string[];
  name: string;
}

/** What the new-project wizard needs to know about a folder. Reads names only, never contents. */
export function inspectFolder(dir: string): FolderInfo {
  const raw = dir.trim();
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw;
  const abs = expanded ? path.resolve(expanded) : "";
  const info: FolderInfo = { path: abs, exists: false, isDir: false, isGit: false, projectFiles: [], name: path.basename(abs) };
  if (!abs || !path.isAbsolute(expanded)) return info;
  try {
    const st = statSync(abs);
    info.exists = true;
    info.isDir = st.isDirectory();
  } catch {
    return info;
  }
  if (!info.isDir) return info;
  info.isGit = existsSync(path.join(abs, ".git"));
  try {
    info.projectFiles = readdirSync(abs)
      .filter((f) => f.endsWith(".aitrack"))
      .slice(0, 20);
  } catch {
    info.projectFiles = [];
  }
  return info;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new HttpError(415, 'Send JSON with "Content-Type: application/json".');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body is not a JSON object.");
  }
}

/**
 * Only requests addressed to the loopback host are served (protects against DNS rebinding),
 * and state-changing requests from a browser must come from the app's own origin (CSRF).
 */
function checkRequest(ctx: Ctx): void {
  const host = (ctx.req.headers.host ?? "").toLowerCase();
  const allowedHosts = [`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`, `[::1]:${ctx.port}`];
  if (!allowedHosts.includes(host)) throw new HttpError(421, "Unexpected Host header.");
  const method = ctx.req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    const origin = ctx.req.headers.origin;
    if (origin && !allowedHosts.map((h) => `http://${h}`).includes(origin.toLowerCase())) {
      throw new HttpError(403, "Cross-origin request refused.");
    }
  }
}

function serveStatic(ctx: Ctx, uiDir: string): void {
  const rel = decodeURIComponent(ctx.url.pathname).replace(/^\/+/, "");
  let file = path.resolve(uiDir, rel || "index.html");
  if (!file.startsWith(path.resolve(uiDir) + path.sep) && file !== path.resolve(uiDir)) {
    throw new HttpError(403, "Forbidden");
  }
  if (!existsSync(file) || !statSync(file).isFile()) file = path.join(uiDir, "index.html");
  if (!existsSync(file)) {
    send(ctx.res, 200, "AI Tracking System server is running. The UI is not built; run `npm run build` in the repository.");
    return;
  }
  const ext = path.extname(file);
  ctx.res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    "content-security-policy": CSP,
    ...SECURITY_HEADERS,
  });
  createReadStream(file).pipe(ctx.res);
}

function stream(ctx: Ctx, manager: ProjectManager, runs?: RunManager, supervisor?: Supervisor): void {
  ctx.res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...SECURITY_HEADERS,
  });
  ctx.res.write(`event: hello\ndata: {}\n\n`);
  const onChanged = (payload: { key: string }) => ctx.res.write(`event: changed\ndata: ${JSON.stringify(payload)}\n\n`);
  const onActivity = (payload: unknown) => ctx.res.write(`event: activity\ndata: ${JSON.stringify(payload)}\n\n`);
  const onRun = (payload: unknown) => ctx.res.write(`event: run\ndata: ${JSON.stringify(payload)}\n\n`);
  const onRunLog = (payload: unknown) => ctx.res.write(`event: runlog\ndata: ${JSON.stringify(payload)}\n\n`);
  const onRunners = (payload: unknown) => ctx.res.write(`event: runners\ndata: ${JSON.stringify(payload)}\n\n`);
  manager.on("changed", onChanged);
  manager.on("activity", onActivity);
  runs?.on("run", onRun);
  runs?.on("runlog", onRunLog);
  runs?.on("runners", onRunners);
  supervisor?.on("manager", onRunners);
  const ping = setInterval(() => ctx.res.write(`: ping\n\n`), 25_000);
  ctx.req.on("close", () => {
    clearInterval(ping);
    manager.off("changed", onChanged);
    manager.off("activity", onActivity);
    runs?.off("run", onRun);
    runs?.off("runlog", onRunLog);
    runs?.off("runners", onRunners);
    supervisor?.off("manager", onRunners);
  });
}

type Handler = (ctx: Ctx, params: string[]) => Promise<void> | void;

export function createHttpServer(manager: ProjectManager, options: HttpOptions = {}): Server {
  const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  const route = (method: string, pattern: string, handler: Handler) =>
    routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), handler });

  route("GET", "/api/health", (ctx) => send(ctx.res, 200, { ok: true, name: "ai-tracking-system", version: VERSION, serverUrl: manager.serverUrl }));
  route("GET", "/api/projects", (ctx) => send(ctx.res, 200, { projects: manager.list() }));
  route("POST", "/api/projects", async (ctx) => {
    const body = await readJson(ctx.req);
    if (typeof body.filePath !== "string" || !body.filePath) throw new HttpError(400, '"filePath" is required.');
    send(ctx.res, 201, await manager.addProject(body.filePath));
  });
  route("POST", "/api/projects/create", async (ctx) => {
    const body = await readJson(ctx.req);
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const filePath = str(body.filePath);
    const id = str(body.id);
    const name = str(body.name);
    if (!filePath || (body.text === undefined && (!id || !name))) throw new HttpError(400, '"filePath", "id" and "name" are required.');
    const agents = Array.isArray(body.agents)
      ? (body.agents as Array<Record<string, unknown>>).map((a) => ({ id: str(a.id), name: str(a.name), tool: str(a.tool) || undefined, role: str(a.role) || undefined }))
      : undefined;
    const language = body.language === "en" || body.language === "tr" ? body.language : undefined;
    const text = typeof body.text === "string" ? body.text : undefined;
    send(ctx.res, 201, await manager.createProject(filePath, { id, name, language, agents, text }));
  });
  route("POST", "/api/projects/order", async (ctx) => {
    const body = await readJson(ctx.req);
    if (!Array.isArray(body.keys)) throw new HttpError(400, '"keys" is required.');
    send(ctx.res, 200, { projects: await manager.reorder(body.keys.map(String)) });
  });
  route("POST", "/api/projects/:key/pin", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    send(ctx.res, 200, { projects: await manager.setPinned(key!, body.pinned === true) });
  });
  route("POST", "/api/projects/:key/info", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    send(
      ctx.res,
      200,
      await manager.saveInfo(key!, {
        name: typeof body.name === "string" ? body.name : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        language: body.language === "en" || body.language === "tr" ? body.language : body.language === null ? null : undefined,
        requireApproval: typeof body.requireApproval === "boolean" ? body.requireApproval : undefined,
        repoPath: typeof body.repoPath === "string" ? body.repoPath : body.repoPath === null ? null : undefined,
      }),
    );
  });
  route("POST", "/api/projects/:key/tasks/:task/issues", async (ctx, [key, task]) => {
    const body = await readJson(ctx.req);
    const state = body.state;
    if (state !== "resolved" && state !== "ignored" && state !== "open") throw new HttpError(400, '"state" must be resolved, ignored or open.');
    if (Array.isArray(body.issues)) {
      const targets = (body.issues as unknown[]).slice(0, 50).map((x) => {
        const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
        if (typeof o.title !== "string" || !o.title) throw new HttpError(400, 'Each problem needs a "title".');
        const index = typeof o.index === "number" && Number.isInteger(o.index) && o.index >= 0 ? o.index : undefined;
        return { index, title: o.title };
      });
      send(ctx.res, 201, await manager.setIssueStates(key!, task!, targets, state));
      return;
    }
    if (typeof body.title !== "string" || !body.title) throw new HttpError(400, '"title" is required.');
    const index = typeof body.index === "number" && Number.isInteger(body.index) && body.index >= 0 ? body.index : undefined;
    send(ctx.res, 201, await manager.setIssueState(key!, task!, { index, title: body.title, state }));
  });
  route("POST", "/api/projects/:key/plan", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    if (typeof body.text !== "string") throw new HttpError(400, '"text" is required.');
    send(ctx.res, 200, await manager.replacePlan(key!, body.text));
  });
  route("POST", "/api/projects/:key/tasks", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    const task = body.task as Record<string, unknown> | undefined;
    if (!task || typeof task !== "object") throw new HttpError(400, '"task" is required.');
    const mode = body.mode === "update" ? "update" : "create";
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    send(
      ctx.res,
      200,
      await manager.saveTask(
        key!,
        {
          id: String(task.id ?? ""),
          title: String(task.title ?? ""),
          agent: String(task.agent ?? ""),
          description: text(task.description),
          alsoAgents: list(task.alsoAgents),
          dependsOn: list(task.dependsOn),
          prompts: list(task.prompts),
          instructions: text(task.instructions),
          scope: text(task.scope),
          allowedPaths: list(task.allowedPaths),
          acceptance: text(task.acceptance),
          milestone: text(task.milestone),
          estimateDays: task.estimateDays === null ? null : typeof task.estimateDays === "number" ? task.estimateDays : undefined,
          tags: list(task.tags),
        },
        mode,
      ),
    );
  });
  route("POST", "/api/projects/:key/tasks/:task/remove", async (ctx, [key, task]) => {
    send(ctx.res, 200, await manager.removeTask(key!, decodeURIComponent(task!)));
  });
  route("POST", "/api/projects/:key/prompts", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    const prompt = body.prompt as Record<string, unknown> | undefined;
    if (!prompt || typeof prompt !== "object") throw new HttpError(400, '"prompt" is required.');
    const mode = body.mode === "update" ? "update" : "create";
    send(
      ctx.res,
      200,
      await manager.savePrompt(
        key!,
        { id: String(prompt.id ?? ""), title: typeof prompt.title === "string" ? prompt.title : undefined, body: String(prompt.body ?? "") },
        mode,
      ),
    );
  });
  route("POST", "/api/projects/:key/prompts/:prompt/remove", async (ctx, [key, prompt]) => {
    send(ctx.res, 200, await manager.removePrompt(key!, decodeURIComponent(prompt!)));
  });
  route("GET", "/api/projects/:key", (ctx, [key]) => send(ctx.res, 200, manager.detail(key!)));
  route("DELETE", "/api/projects/:key", async (ctx, [key]) => {
    await manager.removeProject(key!);
    send(ctx.res, 200, { ok: true });
  });
  route("POST", "/api/projects/:key/reload", async (ctx, [key]) => {
    await manager.reload(key!);
    send(ctx.res, 200, { ok: true });
  });
  route("POST", "/api/projects/:key/events", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    send(ctx.res, 201, await manager.addEvent(key!, body, "ui"));
  });
  route("POST", "/api/projects/:key/paste", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    send(ctx.res, 200, await manager.paste(key!, String(body.text ?? "")));
  });
  route("GET", "/api/projects/:key/tasks/:task/prompt", (ctx, [key, task]) =>
    send(ctx.res, 200, { text: manager.taskPrompt(key!, decodeURIComponent(task!), ctx.url.searchParams.get("agent") ?? undefined) }),
  );
  route("GET", "/api/projects/:key/agents/:agent/bootstrap", (ctx, [key, agent]) =>
    send(ctx.res, 200, { text: manager.bootstrapPrompt(key!, decodeURIComponent(agent!)) }),
  );
  route("POST", "/api/projects/:key/agents", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    const agent = body.agent as Record<string, unknown> | undefined;
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string" || typeof agent.name !== "string") {
      throw new HttpError(400, '"agent" with "id" and "name" is required.');
    }
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    send(
      ctx.res,
      200,
      await manager.saveAgent(key!, {
        agent: {
          id: agent.id,
          name: agent.name,
          tool: text(agent.tool),
          role: text(agent.role),
          color: text(agent.color),
          capabilities: list(agent.capabilities),
          maxParallel: typeof agent.maxParallel === "number" ? agent.maxParallel : undefined,
          bootstrapPrompts: list(agent.bootstrapPrompts),
          quickPrompts: list(agent.quickPrompts),
        },
        helpsWith: list(body.helpsWith),
      }),
    );
  });
  route("POST", "/api/projects/:key/agents/:agent/remove", async (ctx, [key, agent]) => {
    const body = await readJson(ctx.req);
    const reassignTo = typeof body.reassignTo === "string" && body.reassignTo ? body.reassignTo : undefined;
    send(ctx.res, 200, await manager.removeAgent(key!, decodeURIComponent(agent!), reassignTo));
  });
  route("GET", "/api/projects/:key/prompts/:prompt", (ctx, [key, prompt]) =>
    send(ctx.res, 200, { text: manager.libraryPrompt(key!, decodeURIComponent(prompt!)) }),
  );
  route("GET", "/api/projects/:key/next", (ctx, [key]) => {
    const agent = ctx.url.searchParams.get("agent");
    if (!agent) throw new HttpError(400, '"agent" query parameter is required.');
    send(ctx.res, 200, manager.next(key!, agent));
  });
  route("GET", "/api/projects/:key/export", (ctx, [key]) => {
    const { fileName, text } = manager.exportText(key!, ctx.url.searchParams.get("state") === "1");
    send(ctx.res, 200, text, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName.replace(/[^\w.-]/g, "_")}"`,
    });
  });
  route("POST", "/api/projects/:key/export", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    if (typeof body.filePath !== "string" || !body.filePath) throw new HttpError(400, '"filePath" is required.');
    send(ctx.res, 200, { filePath: await manager.exportTo(key!, body.filePath, body.includeState !== false) });
  });
  route("POST", "/api/report", async (ctx) => {
    const body = await readJson(ctx.req);
    const parsed = ReportSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "report"}: ${i.message}`).join("; "));
    }
    send(ctx.res, 201, { ok: true, ...(await manager.recordReport(parsed.data, "http")) });
  });
  route("GET", "/api/stream", (ctx) => stream(ctx, manager, options.runs, options.supervisor));

  // ---- agent runners ----
  const runs = (): RunManager => {
    if (!options.runs) throw new HttpError(404, "Agent runners are not available in this server.");
    return options.runs;
  };
  /** Endpoints that start programs need the control token. */
  const control = (ctx: Ctx): void => {
    const given = ctx.req.headers["x-aitrack-token"];
    if (!options.controlToken || !tokenMatches(options.controlToken, typeof given === "string" ? given : undefined)) {
      throw new HttpError(401, "This action needs the app's control token. Open the tracker from the desktop app or from the link printed by `aitrack serve`.");
    }
  };
  const generator = () => {
    if (!options.generator) throw new HttpError(404, "Not available.");
    return options.generator;
  };
  const authoringInput = (v: unknown): AuthoringInput => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    const chats = Array.isArray(o.chats)
      ? (o.chats as Array<Record<string, unknown>>).slice(0, 30).map((c) => ({
          id: str(c.id),
          name: str(c.name),
          tool: str(c.tool) || undefined,
          role: str(c.role) || undefined,
        }))
      : [];
    const previous =
      o.previous && typeof o.previous === "object"
        ? {
            text: str((o.previous as Record<string, unknown>).text).slice(0, 300_000),
            errors: Array.isArray((o.previous as Record<string, unknown>).errors)
              ? ((o.previous as Record<string, unknown>).errors as unknown[]).slice(0, 40).map(String)
              : [],
          }
        : undefined;
    return {
      projectId: str(o.projectId),
      projectName: str(o.projectName),
      language: o.language === "en" || o.language === "tr" ? o.language : undefined,
      chats,
      plan: str(o.plan).slice(0, 200_000),
      canReadRepository: o.canReadRepository === true,
      previous,
    };
  };
  // The prompt to give another AI by hand, and the check of what it answered.
  route("POST", "/api/authoring/prompt", async (ctx) => {
    const body = await readJson(ctx.req);
    send(ctx.res, 200, { text: authoringPrompt(authoringInput(body.input)) });
  });
  route("POST", "/api/authoring/check", async (ctx) => {
    const body = await readJson(ctx.req);
    const input = authoringInput(body.input);
    const res = readGeneratedProject(String(body.answer ?? ""), {
      projectId: input.projectId,
      projectName: input.projectName,
      language: input.language,
    });
    const p = res.project;
    send(ctx.res, 200, {
      text: res.text,
      errors: res.issues.filter((i) => i.level === "error").map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)),
      warnings: res.issues.filter((i) => i.level === "warning").map((i) => i.message),
      summary: p
        ? {
            chats: p.agents.map((a) => ({ id: a.id, name: a.name, tool: a.tool ?? null })),
            tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, agent: t.agent, dependsOn: t.dependsOn })),
            prompts: Object.keys(p.prompts).length,
            milestones: p.milestones.map((m) => m.name),
          }
        : null,
    });
  });
  route("POST", "/api/authoring/generate", async (ctx) => {
    control(ctx);
    const body = await readJson(ctx.req);
    const provider = String(body.provider ?? "") as GeneratorProvider;
    if (!GENERATOR_PROVIDERS.includes(provider)) throw new HttpError(400, `Unknown CLI "${provider}".`);
    if (typeof body.cwd !== "string" || !body.cwd) throw new HttpError(400, '"cwd" is required.');
    send(
      ctx.res,
      201,
      await generator().start({
        provider,
        model: typeof body.model === "string" ? body.model : undefined,
        effort: typeof body.effort === "string" ? body.effort : undefined,
        binary: typeof body.binary === "string" && body.binary ? body.binary : undefined,
        cwd: body.cwd,
        input: authoringInput(body.input),
      }),
    );
  });
  route("GET", "/api/authoring/generate/:id", (ctx, [id]) => send(ctx.res, 200, generator().get(decodeURIComponent(id!))));
  route("POST", "/api/authoring/generate/:id/stop", async (ctx, [id]) => {
    control(ctx);
    send(ctx.res, 200, generator().stop(decodeURIComponent(id!)));
  });
  // What is in a folder the wizard is about to use.
  route("POST", "/api/folder", async (ctx) => {
    const body = await readJson(ctx.req);
    send(ctx.res, 200, inspectFolder(String(body.dir ?? "")));
  });
  route("GET", "/api/control", (ctx) => {
    control(ctx);
    send(ctx.res, 200, { ok: true });
  });
  route("GET", "/api/providers", async (ctx) => send(ctx.res, 200, { providers: await detectProviders(ctx.url.searchParams.get("refresh") === "1") }));
  route("GET", "/api/projects/:key/runners", (ctx, [key]) =>
    send(ctx.res, 200, { ...runs().state(key!), ...(options.supervisor && { manager: options.supervisor.state(key!) }) }),
  );
  const supervisor = (): Supervisor => {
    if (!options.supervisor) throw new HttpError(404, "The manager is not available in this server.");
    return options.supervisor;
  };
  route("POST", "/api/projects/:key/manager", async (ctx, [key]) => {
    control(ctx);
    send(ctx.res, 200, await supervisor().setSettings(key!, await readJson(ctx.req)));
  });
  route("POST", "/api/projects/:key/manager/run", async (ctx, [key]) => {
    control(ctx);
    const run = supervisor().run(key!, "manual");
    // The answer comes back when the run has started; it is followed on the stream.
    await Promise.race([run, new Promise((r) => setTimeout(r, 300))]);
    send(ctx.res, 202, supervisor().state(key!));
    void run.catch(() => undefined);
  });
  // Work chats left for later: add to the plan, ignore, or fold in with an AI CLI.
  route("POST", "/api/projects/:key/proposals/add", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    const { project, board } = manager.context(key!);
    const proposal = board.proposals.find((p) => p.id === body.id && p.state === "open");
    if (!proposal) throw new HttpError(409, "That proposed task is no longer open.");
    const task = taskFromProposal(project, proposal, typeof body.agent === "string" ? body.agent : undefined);
    const result = await applyPlan(manager, key!, { tasks: [task], links: [], ignore: [] });
    if (!result.created.length) throw new HttpError(400, result.errors.join("; ") || "The task could not be added.");
    send(ctx.res, 201, result);
  });
  route("POST", "/api/projects/:key/proposals/state", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    const state = body.state;
    if (state !== "ignored" && state !== "open") throw new HttpError(400, '"state" must be ignored or open.');
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    send(ctx.res, 201, await manager.setProposalStates(key!, ids.map((id) => ({ id, state }))));
  });
  route("POST", "/api/projects/:key/proposals/integrate", async (ctx, [key]) => {
    control(ctx);
    const body = await readJson(ctx.req);
    const provider = String(body.provider ?? "") as GeneratorProvider;
    if (!GENERATOR_PROVIDERS.includes(provider)) throw new HttpError(400, `Unknown CLI "${provider}".`);
    const { project, board, filePath } = manager.context(key!);
    if (!board.proposals.some((p) => p.state === "open") && !openNotes(board).length) throw new HttpError(409, "There is nothing to add to the plan.");
    send(
      ctx.res,
      201,
      await generator().startPrompt({
        provider,
        model: typeof body.model === "string" ? body.model : undefined,
        effort: typeof body.effort === "string" ? body.effort : undefined,
        binary: typeof body.binary === "string" && body.binary ? body.binary : undefined,
        cwd: planFolder(filePath),
        prompt: integrationPrompt(project, board),
      }),
    );
  });
  route("POST", "/api/projects/:key/proposals/preview", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    let plan: IntegrationPlan;
    try {
      plan = parsePlan(String(body.answer ?? ""));
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    const { project, board } = manager.context(key!);
    send(ctx.res, 200, checkPlan(project, board, plan));
  });
  route("POST", "/api/projects/:key/proposals/apply", async (ctx, [key]) => {
    const body = await readJson(ctx.req);
    let plan: IntegrationPlan;
    try {
      plan = parsePlan(JSON.stringify(body.plan ?? {}));
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    send(ctx.res, 201, await applyPlan(manager, key!, plan));
  });
  // Creates the project's code folder (settings.repoPath) as an empty git repository.
  route("POST", "/api/projects/:key/code-folder", async (ctx, [key]) => {
    control(ctx);
    send(ctx.res, 200, await runs().createCodeFolder(key!));
  });
  route("POST", "/api/projects/:key/runners", async (ctx, [key]) => {
    control(ctx);
    const body = await readJson(ctx.req);
    send(
      ctx.res,
      200,
      await runs().saveProject(key!, {
        autoDispatch: typeof body.autoDispatch === "boolean" ? body.autoDispatch : undefined,
        maxConcurrent: typeof body.maxConcurrent === "number" ? body.maxConcurrent : undefined,
      }),
    );
  });
  route("POST", "/api/projects/:key/runners/:agent", async (ctx, [key, agent]) => {
    control(ctx);
    const body = await readJson(ctx.req);
    send(ctx.res, 200, await runs().saveChat(key!, decodeURIComponent(agent!), body.runner ?? body));
  });
  route("POST", "/api/projects/:key/tasks/:task/run", async (ctx, [key, task]) => {
    control(ctx);
    const body = await readJson(ctx.req);
    const agent = typeof body.agent === "string" && body.agent ? body.agent : undefined;
    const extra = typeof body.extra === "string" ? body.extra.slice(0, 20000) : undefined;
    send(ctx.res, 201, await runs().start(key!, decodeURIComponent(task!), agent, { extra }));
  });
  route("POST", "/api/projects/:key/agents/:agent/reply", async (ctx, [key, agent]) => {
    control(ctx);
    const body = await readJson(ctx.req);
    const task = typeof body.task === "string" && body.task ? body.task : undefined;
    send(ctx.res, 201, await runs().reply(key!, decodeURIComponent(agent!), String(body.text ?? ""), task));
  });
  route("POST", "/api/projects/:key/runs/stop", async (ctx, [key]) => {
    control(ctx);
    send(ctx.res, 200, await runs().stopAll(key!));
  });
  route("POST", "/api/runs/:id/stop", async (ctx, [id]) => {
    control(ctx);
    send(ctx.res, 200, runs().stop(decodeURIComponent(id!)));
  });
  route("GET", "/api/runs/active", (ctx) => send(ctx.res, 200, { count: options.runs?.activeTotal() ?? 0 }));
  route("GET", "/api/runs/:id/log", (ctx, [id]) =>
    send(ctx.res, 200, runs().log(decodeURIComponent(id!), Number(ctx.url.searchParams.get("after") ?? 0) || 0)),
  );
  // Hooks from sessions opened by hand. They only move a task's status, like a report does.
  route("POST", "/api/hook", async (ctx) => {
    const body = await readJson(ctx.req);
    const header = (name: string) => {
      const v = ctx.req.headers[name];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const signal = normalizeHook(body, {
      tool: ctx.url.searchParams.get("tool") ?? undefined,
      chat: header("x-aitrack-chat"),
      project: header("x-aitrack-project"),
      runId: header("x-aitrack-run"),
    });
    if (!signal || !options.runs) {
      send(ctx.res, 200, { handled: false, detail: "Ignored." });
      return;
    }
    send(ctx.res, 200, await options.runs.hook(signal));
  });

  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const ctx: Ctx = { req, res, url: new URL(req.url ?? "/", "http://127.0.0.1"), port };
    void (async () => {
      try {
        checkRequest(ctx);
        const method = req.method ?? "GET";
        if (ctx.url.pathname.startsWith("/api/")) {
          for (const r of routes) {
            const m = r.method === method ? r.pattern.exec(ctx.url.pathname) : null;
            if (m) {
              await r.handler(ctx, m.slice(1));
              return;
            }
          }
          throw new HttpError(404, "Not found");
        }
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
        if (!options.uiDir) {
          send(res, 200, "AI Tracking System server is running.");
          return;
        }
        serveStatic(ctx, options.uiDir);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) manager.emit("warning", e);
        if (!res.headersSent) send(res, status, { error: status === 500 ? "Internal error" : (e as Error).message });
        else res.end();
      }
    })();
  });
  return server;
}
