import { existsSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { defaultDataDir, startServer, type RunningServer } from "@aitrack/server";

const PREFERRED_PORT = Number(process.env.AITRACK_PORT ?? 4317);
const REPO_URL = "https://github.com/mitradeniz/ai-tracking-system";

let running: RunningServer | null = null;
let baseUrl = "";
let win: BrowserWindow | null = null;
const pendingFiles: string[] = [];

function uiDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "ui")
    : path.resolve(__dirname, "..", "..", "..", "packages", "ui", "dist");
}

function projectFilesFromArgv(argv: string[]): string[] {
  return argv.filter((a) => /\.(aitrack|json)$/i.test(a) && existsSync(a)).map((a) => path.resolve(a));
}

/** Reuses a tracker already running on the preferred port (for example `aitrack serve`). */
async function findRunningTracker(): Promise<string | null> {
  const url = `http://127.0.0.1:${PREFERRED_PORT}`;
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = (await res.json()) as { name?: string };
    return res.ok && body.name === "ai-tracking-system" ? url : null;
  } catch {
    return null;
  }
}

async function addProjectFile(filePath: string): Promise<void> {
  if (!baseUrl) {
    pendingFiles.push(filePath);
    return;
  }
  try {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? res.statusText);
    }
  } catch (e) {
    dialog.showErrorBox("AI Tracking System", `Could not open ${filePath}\n\n${(e as Error).message}`);
  }
  win?.show();
  win?.focus();
}

function isOwnFrame(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return Boolean(baseUrl) && url.startsWith(baseUrl);
}

function registerIpc(): void {
  const filters = [{ name: "AI Tracking project", extensions: ["aitrack", "json"] }];
  ipcMain.handle("aitrack:open-dialog", async (event) => {
    if (!isOwnFrame(event) || !win) return null;
    const res = await dialog.showOpenDialog(win, { properties: ["openFile"], filters });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle("aitrack:save-dialog", async (event, defaultName: unknown) => {
    if (!isOwnFrame(event) || !win) return null;
    const res = await dialog.showSaveDialog(win, { defaultPath: String(defaultName ?? "project.aitrack"), filters });
    return res.canceled ? null : (res.filePath ?? null);
  });
  ipcMain.handle("aitrack:new-dialog", async (event) => {
    if (!isOwnFrame(event) || !win) return null;
    const res = await dialog.showSaveDialog(win, { defaultPath: "project.aitrack", filters });
    return res.canceled ? null : (res.filePath ?? null);
  });
  ipcMain.handle("aitrack:show-in-folder", (event, filePath: unknown) => {
    if (!isOwnFrame(event)) return;
    const p = String(filePath ?? "");
    if (p && existsSync(p)) shell.showItemInFolder(p);
  });
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            if (!win) return;
            const res = await dialog.showOpenDialog(win, {
              properties: ["openFile"],
              filters: [{ name: "AI Tracking project", extensions: ["aitrack", "json"] }],
            });
            if (!res.canceled && res.filePaths[0]) await addProjectFile(res.filePaths[0]);
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Documentation", click: () => void shell.openExternal(REPO_URL) },
        { label: "Report an Issue", click: () => void shell.openExternal(`${REPO_URL}/issues`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b1120",
    title: "AI Tracking System",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win?.show());

  // Keep the window on the local tracker; open other links in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(baseUrl)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  void win.loadURL(`${baseUrl}/`);
  win.on("closed", () => {
    win = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingFiles.push(...projectFilesFromArgv(process.argv.slice(1)));

  app.on("second-instance", (_event, argv) => {
    for (const f of projectFilesFromArgv(argv)) void addProjectFile(f);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // macOS: double-clicked .aitrack files.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    void addProjectFile(filePath);
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === "notifications" || permission === "clipboard-sanitized-write");
    });

    const existing = await findRunningTracker();
    if (existing) {
      baseUrl = existing;
    } else {
      try {
        running = await startServer({ port: PREFERRED_PORT, dataDir: defaultDataDir(), uiDir: uiDir() });
        baseUrl = running.url;
      } catch (e) {
        dialog.showErrorBox("AI Tracking System", `The local tracker could not start.\n\n${(e as Error).message}`);
        app.quit();
        return;
      }
    }

    registerIpc();
    buildMenu();
    createWindow();
    for (const f of pendingFiles.splice(0)) await addProjectFile(f);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    void running?.close();
  });
}
