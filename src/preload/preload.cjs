const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sniffer", {
  getApiBase: () => ipcRenderer.invoke("api-base")
});
