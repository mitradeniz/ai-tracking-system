import type { Server } from "node:http";
import { createHttpServer } from "./http.ts";
import { ProjectManager } from "./manager.ts";
import { defaultDataDir, Store } from "./store.ts";

export { createHttpServer, VERSION } from "./http.ts";
export { HttpError, ProjectManager } from "./manager.ts";
export type { ProjectDetail, ProjectSummary, ReportResult } from "./manager.ts";
export type { AgentSnapshot, BoardSnapshot, TaskSnapshot } from "@aitrack/core";
export { defaultDataDir, Store } from "./store.ts";

export interface StartOptions {
  /** Preferred port; the next free port is used when it is taken (up to 10 tries). */
  port?: number;
  dataDir?: string;
  uiDir?: string;
  /** Project files to open on start. */
  projects?: string[];
  watch?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  manager: ProjectManager;
  server: Server;
  close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const manager = new ProjectManager(new Store(options.dataDir ?? defaultDataDir()));
  await manager.init();
  for (const p of options.projects ?? []) await manager.addProject(p);

  const server = createHttpServer(manager, { uiDir: options.uiDir });
  const preferred = options.port ?? 4317;
  let port = -1;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10 && port < 0; attempt += 1) {
    const candidate = preferred === 0 ? 0 : preferred + attempt;
    try {
      port = await listen(server, candidate);
    } catch (e) {
      lastError = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || preferred === 0) throw e;
    }
  }
  if (port < 0) throw lastError;

  const url = `http://127.0.0.1:${port}`;
  manager.serverUrl = url;
  if (options.watch !== false) manager.startWatching();

  return {
    url,
    port,
    manager,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        manager.stopWatching();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
