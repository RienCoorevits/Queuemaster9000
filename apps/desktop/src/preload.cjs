const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("queuemasterDesktop", {
  getConfig: () => ipcRenderer.sendSync("queuemaster:get-runtime-config"),
  windows: {
    openServices: () => ipcRenderer.invoke("queuemaster:windows:open-services")
  },
  services: {
    getStatus: () => ipcRenderer.invoke("queuemaster:services:status"),
    installAgent: (options) => ipcRenderer.invoke("queuemaster:services:install-agent", options),
    installServer: (options) => ipcRenderer.invoke("queuemaster:services:install-server", options),
    uninstallAgent: () => ipcRenderer.invoke("queuemaster:services:uninstall-agent"),
    uninstallServer: () => ipcRenderer.invoke("queuemaster:services:uninstall-server")
  }
});
