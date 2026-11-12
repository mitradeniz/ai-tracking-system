import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { ReportSchema } from "@aitrack/core";
import { HttpError, type ProjectManager } from "./manager.ts";

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
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  port: number;
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

function stream(ctx: Ctx, manager: ProjectManager): void {
  ctx.res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...SECURITY_HEADERS,
  });
  ctx.res.write(`event: hello\ndata: {}\n\n`);
  const onChanged = (payload: { key: string }) => ctx.res.write(`event: changed\ndata: ${JSON.stringify(payload)}\n\n`);
  const onActivity = (payload: unknown) => ctx.res.write(`event: activity\ndata: ${JSON.stringify(payload)}\n\n`);
  manager.on("changed", onChanged);
  manager.on("activity", onActivity);
  const ping = setInterval(() => ctx.res.write(`: ping\n\n`), 25_000);
  ctx.req.on("close", () => {
    clearInterval(ping);
    manager.off("changed", onChanged);
    manager.off("activity", onActivity);
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
    const { filePath, id, name } = body as Record<string, string>;
    if (!filePath || !id || !name) throw new HttpError(400, '"filePath", "id" and "name" are required.');
    send(ctx.res, 201, await manager.createProject(filePath, id, name));
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
  route("GET", "/api/stream", (ctx) => stream(ctx, manager));

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
