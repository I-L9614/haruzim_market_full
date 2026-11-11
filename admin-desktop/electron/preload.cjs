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
