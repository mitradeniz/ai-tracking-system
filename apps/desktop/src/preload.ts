import { contextBridge, ipcRenderer } from "electron";

// The UI is a plain web app served by the local tracker. These are the only native helpers it
// gets: file dialogs and "show in folder". Everything else goes through the HTTP API.
contextBridge.exposeInMainWorld("aitrackDesktop", {
  isDesktop: true,
  openProjectDialog: (): Promise<string | null> => ipcRenderer.invoke("aitrack:open-dialog"),
  saveProjectDialog: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke("aitrack:save-dialog", String(defaultName)),
  newProjectDialog: (): Promise<string | null> => ipcRenderer.invoke("aitrack:new-dialog"),
  showInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke("aitrack:show-in-folder", String(filePath)),
});
