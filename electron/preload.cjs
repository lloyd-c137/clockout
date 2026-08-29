const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopWidget', {
  setMode: (mode) => ipcRenderer.invoke('window:set-mode', mode),
  togglePin: () => ipcRenderer.invoke('window:toggle-pin'),
  updateTrayCountdown: (seconds) => ipcRenderer.invoke('tray:update-countdown', seconds),
  onModeChanged: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('window:mode-changed', listener);
    return () => ipcRenderer.removeListener('window:mode-changed', listener);
  },
  hideFor: (milliseconds) => ipcRenderer.send('window:hide-for', milliseconds),
  close: () => ipcRenderer.send('window:close'),
  quit: () => ipcRenderer.send('app:quit')
});
