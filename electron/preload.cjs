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
  loadTasks: () => ipcRenderer.invoke('tasks:list'),
  hasAnyTasks: () => ipcRenderer.invoke('tasks:has-any'),
  loadWorkdayControl: () => ipcRenderer.invoke('workday:get-control'),
  saveTasks: (tasks) => ipcRenderer.invoke('tasks:save', tasks),
  deleteTask: (taskId) => ipcRenderer.invoke('tasks:delete', taskId),
  onTasksChanged: (callback) => {
    const listener = (_event, tasks) => callback(tasks);
    ipcRenderer.on('tasks:changed', listener);
    return () => ipcRenderer.removeListener('tasks:changed', listener);
  },
  onWorkdayChanged: (callback) => {
    const listener = (_event, control) => callback(control);
    ipcRenderer.on('workday:changed', listener);
    return () => ipcRenderer.removeListener('workday:changed', listener);
  },
  hideFor: (milliseconds) => ipcRenderer.send('window:hide-for', milliseconds),
  close: () => ipcRenderer.send('window:close'),
  quit: () => ipcRenderer.send('app:quit')
});
