import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// The UI is a plain web app served by the local tracker. These are the only native helpers it
// gets: file dialogs, "show in folder", the floating window and the control token that lets it
// start agents. Everything else goes through the HTTP API.
contextBridge.exposeInMainWorld("aitrackDesktop", {
  isDesktop: true,
  platform: process.platform,
  /** True when the window is translucent and the page should let the material show through. */
  vibrancy: process.argv.includes("--aitrack-vibrancy"),
  setTheme: (theme: "dark" | "light" | "system"): Promise<void> => ipcRenderer.invoke("aitrack:set-theme", String(theme)),
  controlToken: (): Promise<string | null> => ipcRenderer.invoke("aitrack:control-token"),
  openProjectDialog: (): Promise<string | null> => ipcRenderer.invoke("aitrack:open-dialog"),
  saveProjectDialog: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke("aitrack:save-dialog", String(defaultName)),
  newProjectDialog: (): Promise<string | null> => ipcRenderer.invoke("aitrack:new-dialog"),
  showInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke("aitrack:show-in-folder", String(filePath)),
  openMini: (): Promise<void> => ipcRenderer.invoke("aitrack:mini-open"),
  closeMini: (): Promise<void> => ipcRenderer.invoke("aitrack:mini-close"),
  setMini: (options: { pinned?: boolean; opacity?: number }): Promise<void> =>
    ipcRenderer.invoke("aitrack:mini-set", {
      pinned: typeof options?.pinned === "boolean" ? options.pinned : undefined,
      opacity: typeof options?.opacity === "number" ? options.opacity : undefined,
    }),
  focusMain: (projectKey?: string, taskId?: string): Promise<void> =>
    ipcRenderer.invoke("aitrack:focus-main", projectKey === undefined ? undefined : String(projectKey), taskId === undefined ? undefined : String(taskId)),
  onOpenTask: (callback: (projectKey: string | undefined, taskId: string | undefined) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, projectKey: unknown, taskId: unknown) =>
      callback(typeof projectKey === "string" ? projectKey : undefined, typeof taskId === "string" ? taskId : undefined);
    ipcRenderer.on("aitrack:open-task", listener);
    return () => ipcRenderer.removeListener("aitrack:open-task", listener);
  },
});
