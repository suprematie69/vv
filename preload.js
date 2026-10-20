const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listDrives: () => ipcRenderer.invoke('list-drives'),
  selectIso: () => ipcRenderer.invoke('select-iso'),
  startFlash: (isoPath, device) => ipcRenderer.invoke('flash-start', { isoPath, device }),
  onProgress: (callback) => {
    ipcRenderer.on('flash-progress', (_event, data) => callback(data));
  },
  onLog: (callback) => {
    ipcRenderer.on('flash-log', (_event, line) => callback(line));
  },
  platform: process.platform,
});
