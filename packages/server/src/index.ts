import type { Server } from "node:http";
import { ensureControlToken } from "./control.ts";
import { createHttpServer } from "./http.ts";
import { ProjectManager } from "./manager.ts";
import { ProjectGenerator } from "./runners/generate.ts";
import { RunManager } from "./runners/runs.ts";
import { RunnerStore } from "./runners/store.ts";
import { Supervisor } from "./runners/supervisor.ts";
import { defaultDataDir, Store } from "./store.ts";

export { createHttpServer, VERSION } from "./http.ts";
export { HttpError, ProjectManager } from "./manager.ts";
export type { ProjectDetail, ProjectSummary, ReportResult } from "./manager.ts";
export type { AgentSnapshot, BoardSnapshot, TaskSnapshot } from "@aitrack/core";
export { defaultDataDir, Store } from "./store.ts";
export { ensureControlToken } from "./control.ts";
export { RunManager } from "./runners/runs.ts";
export { ProjectGenerator, type GenerateJob } from "./runners/generate.ts";
export type { RunSummary, RunnerState } from "./runners/runs.ts";
export { Supervisor, type ManagerRun, type ManagerState } from "./runners/supervisor.ts";
export { PROVIDER_INFO, type ChatRunner, type ProviderId } from "./runners/providers.ts";

export interface StartOptions {
  /** Preferred port; the next free port is used when it is taken (up to 10 tries). */
  port?: number;
  dataDir?: string;
  uiDir?: string;
  /** Project files to open on start. */
  projects?: string[];
  watch?: boolean;
  /** Token for the endpoints that start programs; read from or created in the data folder by default. */
  controlToken?: string;
  /** How long the manager waits after a change before it looks, and how often it looks anyway (tests). */
  managerDelayMs?: number;
  managerTickMs?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  manager: ProjectManager;
  runs: RunManager;
  generator: ProjectGenerator;
  supervisor: Supervisor;
  server: Server;
  controlToken: string;
  /** The UI address with the control token, for opening in a browser. */
  controlUrl: string;
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
  const dataDir = options.dataDir ?? defaultDataDir();
  const manager = new ProjectManager(new Store(dataDir));
  await manager.init();
  for (const p of options.projects ?? []) await manager.addProject(p);
  const controlToken = options.controlToken ?? (await ensureControlToken(dataDir));
  const runs = new RunManager(manager, new RunnerStore(dataDir), dataDir);

  const generator = new ProjectGenerator();
  const supervisor = new Supervisor(manager, runs, generator, dataDir, { delayMs: options.managerDelayMs, tickMs: options.managerTickMs });
  supervisor.on("warning", (e: unknown) => manager.emit("warning", e));
  const server = createHttpServer(manager, { uiDir: options.uiDir, runs, generator, controlToken, supervisor });
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
  await runs.init();
  supervisor.start();
  if (options.watch !== false) manager.startWatching();

  return {
    url,
    port,
    manager,
    runs,
    generator,
    supervisor,
    server,
    controlToken,
    controlUrl: `${url}/#token=${controlToken}`,
    close: () =>
      new Promise<void>((resolve) => {
        supervisor.close();
        void runs.close();
        generator.close();
        manager.stopWatching();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
