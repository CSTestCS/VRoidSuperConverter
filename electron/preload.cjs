// Exposes a minimal, file-dialog-only API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vsc', {
  openFiles: (opts) => ipcRenderer.invoke('open-files', opts),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  readSiblings: (filePath) => ipcRenderer.invoke('read-siblings', filePath),
});
