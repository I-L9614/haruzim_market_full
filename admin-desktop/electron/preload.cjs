const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge: renderer asks the main process to show an OS notification
// for a new order (used when the window is hidden to the tray).
contextBridge.exposeInMainWorld('haruzimDesktop', {
  notifyNewOrder: (payload) => {
    try { ipcRenderer.send('order-notification', payload); } catch { /* bridge must never break the page */ }
  }
});
