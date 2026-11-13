import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
} from "electron";
import { defaultDataDir, ensureControlToken, startServer, type RunningServer } from "@aitrack/server";
import { checkForUpdates, findRepo, readProgress, startUpdate } from "./updater.ts";

const PREFERRED_PORT = Number(process.env.AITRACK_PORT ?? 4317);
const REPO_URL = "https://github.com/mitradeniz/ai-tracking-system";

let running: RunningServer | null = null;
let baseUrl = "";
let win: BrowserWindow | null = null;
let mini: BrowserWindow | null = null;
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
  return Boolean(baseUrl) && (url === baseUrl || url.startsWith(`${baseUrl}/`));
}

/** Keeps a window inside the tracker: other links open in the default browser. */
function guardNavigation(w: BrowserWindow): void {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(baseUrl)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
}

const miniBoundsFile = () => path.join(app.getPath("userData"), "floating-window.json");

function savedMiniBounds(): Rectangle | null {
  try {
    const b = JSON.parse(readFileSync(miniBoundsFile(), "utf8")) as Rectangle;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
    });
    return visible && b.width >= 260 && b.height >= 200 ? b : null;
  } catch {
    return null;
  }
}

/** The floating window: small, frameless, above other apps and on every desktop. */
function openMini(): void {
  if (mini) {
    mini.showInactive();
    mini.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = savedMiniBounds() ?? { width: 380, height: 600, x: area.x + area.width - 380 - 24, y: area.y + 24 };
  const isMac = process.platform === "darwin";
  mini = new BrowserWindow({
    ...bounds,
    minWidth: 280,
    minHeight: 220,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    title: "AI Tracking System",
    show: false,
    ...(isMac
      ? // "followWindow": the live blur only while the window is in front. A floating window is
        // rarely focused, and an always-live blur makes macOS redraw it whenever anything behind it moves.
        { vibrancy: "under-window" as const, visualEffectState: "followWindow" as const, backgroundColor: "#00000000", roundedCorners: true }
      : { backgroundColor: "#2c2c2a" }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: isMac ? ["--aitrack-vibrancy"] : [],
    },
  });
  mini.setAlwaysOnTop(true, "floating");
  mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  guardNavigation(mini);
  reportActivity(mini);
  mini.once("ready-to-show", () => mini?.show());
  const persist = () => {
    if (!mini) return;
    try {
      writeFileSync(miniBoundsFile(), JSON.stringify(mini.getBounds()));
    } catch {
      // The position is a convenience.
    }
  };
  mini.on("moved", persist);
  mini.on("resized", persist);
  mini.on("closed", () => {
    mini = null;
  });
  void mini.loadURL(`${baseUrl}/?mini=1`);
}

/** Tells the page whether its window is in front, so it can pause its animations in the background. */
function reportActivity(w: BrowserWindow): void {
  const send = () => {
    if (!w.isDestroyed()) w.webContents.send("aitrack:active", w.isFocused() && w.isVisible() && !w.isMinimized());
  };
  for (const name of ["focus", "blur", "show", "hide", "minimize", "restore"] as const) w.on(name as "focus", send);
  w.webContents.on("did-finish-load", send);
}

function showMain(): BrowserWindow {
  if (!win) createWindow();
  const w = win!;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  return w;
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
  ipcMain.handle("aitrack:folder-dialog", async (event, defaultPath: unknown) => {
    if (!isOwnFrame(event) || !win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: typeof defaultPath === "string" && defaultPath ? defaultPath : undefined,
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  // Removing a project and moving its file to the Trash. Only the file of a project in the list
  // can be moved, and only one that ends in .aitrack.
  ipcMain.handle("aitrack:trash-project", async (event, key: unknown) => {
    if (!isOwnFrame(event) || typeof key !== "string" || !baseUrl) return { ok: false, error: "forbidden" };
    try {
      const list = (await (await fetch(`${baseUrl}/api/projects`)).json()) as { projects?: Array<{ key: string; filePath: string }> };
      const project = list.projects?.find((p) => p.key === key);
      if (!project) return { ok: false, error: "Unknown project." };
      if (!project.filePath.endsWith(".aitrack")) return { ok: false, error: "Only .aitrack files are moved to the Trash." };
      const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!res.ok) return { ok: false, error: `The project could not be removed (${res.status}).` };
      if (existsSync(project.filePath)) await shell.trashItem(project.filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle("aitrack:show-in-folder", (event, filePath: unknown) => {
    if (!isOwnFrame(event)) return;
    const p = String(filePath ?? "");
    if (p && existsSync(p)) shell.showItemInFolder(p);
  });
  // Native materials follow the app's theme, not only the system's.
  ipcMain.handle("aitrack:set-theme", (event, theme: unknown) => {
    if (!isOwnFrame(event)) return;
    if (theme === "dark" || theme === "light" || theme === "system") nativeTheme.themeSource = theme;
  });
  // Updates: check the clone the app was built from, and run the updater in the background.
  const repo = () => findRepo(defaultDataDir(), app.isPackaged ? undefined : path.resolve(__dirname, "..", "..", ".."));
  ipcMain.handle("aitrack:update-check", (event) => {
    if (!isOwnFrame(event)) return null;
    return checkForUpdates({ repo: repo(), platform: process.platform, packaged: app.isPackaged });
  });
  ipcMain.handle("aitrack:update-progress", (event) => (isOwnFrame(event) ? readProgress(defaultDataDir()) : null));
  ipcMain.handle("aitrack:update-run", async (event) => {
    if (!isOwnFrame(event)) return { ok: false, error: "forbidden" };
    const info = await checkForUpdates({ repo: repo(), platform: process.platform, packaged: app.isPackaged });
    if (info.state !== "available" || !info.repo) return { ok: false, error: info.reason ?? info.state };
    startUpdate(info.repo, defaultDataDir());
    return { ok: true };
  });

  // Starting agents needs the tracker's control token; only the app's own windows get it.
  ipcMain.handle("aitrack:control-token", async (event) => {
    if (!isOwnFrame(event)) return null;
    if (running) return running.controlToken;
    try {
      return await ensureControlToken(defaultDataDir());
    } catch {
      return null;
    }
  });
  ipcMain.handle("aitrack:mini-open", (event) => {
    if (isOwnFrame(event)) openMini();
  });
  ipcMain.handle("aitrack:mini-close", (event) => {
    if (isOwnFrame(event)) mini?.close();
  });
  ipcMain.handle("aitrack:mini-set", (event, options: unknown) => {
    if (!isOwnFrame(event) || !mini || !options || typeof options !== "object") return;
    const { pinned, opacity } = options as { pinned?: unknown; opacity?: unknown };
    if (typeof pinned === "boolean") mini.setAlwaysOnTop(pinned, "floating");
    if (typeof opacity === "number" && Number.isFinite(opacity)) mini.setOpacity(Math.min(1, Math.max(0.4, opacity)));
  });
  ipcMain.handle("aitrack:focus-main", (event, projectKey: unknown, taskId: unknown) => {
    if (!isOwnFrame(event)) return;
    const w = showMain();
    const key = typeof projectKey === "string" && /^[\w-]{1,80}$/.test(projectKey) ? projectKey : undefined;
    const task = typeof taskId === "string" && taskId.length <= 120 ? taskId : undefined;
    if (key || task) {
      const send = () => w.webContents.send("aitrack:open-task", key, task);
      if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
      else send();
    }
  });
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const tr = app.getLocale().toLowerCase().startsWith("tr");
  const L = tr
    ? {
        file: "Dosya",
        open: "Proje Aç…",
        view: "Görünüm",
        docs: "Belgeler",
        issue: "Sorun Bildir",
        window: "Pencere",
        floating: "Kayan Pencere",
        updates: "Güncellemeleri Denetle…",
      }
    : {
        updates: "Check for Updates…",
        file: "File",
        open: "Open Project…",
        view: "View",
        docs: "Documentation",
        issue: "Report an Issue",
        window: "Window",
        floating: "Floating Window",
      };
  const openUpdates = () => {
    const w = showMain();
    const send = () => w.webContents.send("aitrack:open-updates");
    if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
    else send();
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { label: L.updates, click: openUpdates },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: L.file,
      submenu: [
        {
          label: L.open,
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
      label: L.view,
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
    {
      label: L.window,
      submenu: [
        { label: L.floating, accelerator: "CmdOrCtrl+Shift+F", click: () => openMini() },
        { type: "separator" },
        { role: "minimize" },
        ...(isMac ? [{ role: "zoom" as const }, { type: "separator" as const }, { role: "front" as const }] : [{ role: "close" as const }]),
      ],
    },
    {
      role: "help",
      submenu: [
        ...(isMac ? [] : [{ label: L.updates, click: openUpdates }]),
        { label: L.docs, click: () => void shell.openExternal(REPO_URL) },
        { label: L.issue, click: () => void shell.openExternal(`${REPO_URL}/issues`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "AI Tracking System",
    show: false,
    // macOS: a translucent window that takes the tone of what is behind it, with the traffic
    // lights inside the sidebar (like other native Mac apps).
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 18 },
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
        }
      : { backgroundColor: "#262624" }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: isMac ? ["--aitrack-vibrancy"] : [],
    },
  });
  win.once("ready-to-show", () => win?.show());

  // Keep the window on the local tracker; open other links in the default browser.
  guardNavigation(win);
  reportActivity(win);

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
      showMain();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    mini?.destroy();
    void running?.close();
  });
}
