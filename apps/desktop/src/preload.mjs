import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("queuemasterDesktop", {
  getConfig: () => ipcRenderer.sendSync("queuemaster:get-runtime-config")
});
