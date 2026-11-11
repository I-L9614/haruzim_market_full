const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge between the renderer and the main process:
// - renderer asks the main process to show an OS notification for a new order
//   while the window is hidden to the tray;
// - main process asks the renderer to navigate to a specific order when a
//   notification is clicked.
contextBridge.exposeInMainWorld('haruzimDesktop', {
  notifyNewOrder: (payload) => {
    try { ipcRenderer.send('order-notification', payload); } catch { /* bridge must never break the page */ }
  },
  sendTestNotification: () => {
    try { ipcRenderer.send('test-notification'); } catch { /* bridge must never break the page */ }
  },
  getNotificationDiagnostics: () => {
    try { return ipcRenderer.invoke('notification-diagnostics'); } catch { return Promise.resolve(null); }
  },
  // In-app updates: state pull + push, and the three user-approved actions.
  getUpdateState: () => {
    try { return ipcRenderer.invoke('update-get-state'); } catch { return Promise.resolve(null); }
  },
  checkForUpdates: () => {
    try { return ipcRenderer.invoke('update-check'); } catch { return Promise.resolve(null); }
  },
  downloadUpdate: () => {
    try { return ipcRenderer.invoke('update-download'); } catch { return Promise.resolve(null); }
  },
  installUpdate: () => {
    try { return ipcRenderer.invoke('update-install'); } catch { return Promise.resolve({ installed: false, reason: 'ipc-failed' }); }
  },
  reportUpdateGuard: (state) => {
    try { ipcRenderer.send('update-guard-state', state || {}); } catch { /* guard reporting must never break the page */ }
  },
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => {
      try { callback(state || {}); } catch { /* update errors must not break listeners */ }
    };
    ipcRenderer.on('update-status', listener);
    return () => {
      try { ipcRenderer.removeListener('update-status', listener); } catch { /* already torn down */ }
    };
  },
  onNavigateToOrder: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => {
      try { callback(payload || {}); } catch { /* navigation errors must not break listeners */ }
    };
    ipcRenderer.on('navigate-to-order', listener);
    return () => {
      try { ipcRenderer.removeListener('navigate-to-order', listener); } catch { /* already torn down */ }
    };
  }
});
