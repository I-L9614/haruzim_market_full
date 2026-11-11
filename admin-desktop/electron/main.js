import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, net, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createUpdateController, createGitHubFeed,
  UPDATE_CHECK_INTERVAL_MS, UPDATE_STARTUP_DELAY_MS
} from './updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
protocol.registerSchemesAsPrivileged([{
  scheme: 'haruzim',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

// Windows toast notifications are only delivered reliably when the app's
// AppUserModelID matches the installer shortcut (electron-builder appId).
app.setAppUserModelId('com.haruzim.admin');

const isDev = !app.isPackaged;
let mainWindow = null;
let tray = null;
let isQuitting = false;

// One instance only: reopening via the shortcut focuses the existing window
// (which keeps its session) instead of starting a parallel instance. A second
// instance cannot lock the same profile and gets empty storage, which used to
// drop the user back on the login screen after every X-close + reopen.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'tray-icon.png'));
  tray.setToolTip('חרוזים - ניהול מרקט');
  const showWindow = () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'פתח את חלון הניהול', click: showWindow },
    { type: 'separator' },
    { label: 'יציאה מלאה', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 780,
    backgroundColor: '#101827',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  // Closing the window keeps the app running in the tray (notifications stay on).
  // Full quit is only from the tray menu's "יציאה מלאה".
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3002');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('haruzim://admin/index.html');
  }
}

// Clicking a toast brings the window back and asks the renderer to open the
// orders view; when the toast carries an order id the renderer flashes that
// order's row, otherwise it falls back to the orders list.
function showWindowAndNavigate(payload) {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('navigate-to-order', payload || {});
}

// Display diagnostics: records the last toast's OS-level outcome to a small
// file so the renderer (and support) can tell whether Windows confirmed the
// banner ('shown'), stayed silent ('show-timeout') or threw ('error').
// Diagnostics never break the notification flow.
function recordNotificationEvent(kind, event, extra) {
  try {
    const payload = {
      kind: kind || 'order',
      event,
      at: new Date().toISOString(),
      supported: Notification.isSupported(),
      ...(extra || {})
    };
    fs.writeFileSync(path.join(app.getPath('userData'), 'notification-diagnostics.json'), JSON.stringify(payload, null, 2));
  } catch { /* diagnostics must never break the app */ }
}

function showOrderToast({ title, body, orderId, kind }) {
  try {
    const notification = new Notification({
      title,
      body,
      silent: false,
      icon: path.join(__dirname, 'tray-icon.png')
    });
    let shown = false;
    notification.on('click', () => showWindowAndNavigate(orderId ? { orderId } : {}));
    notification.on('show', () => {
      shown = true;
      recordNotificationEvent(kind, 'shown');
    });
    notification.show();
    setTimeout(() => {
      if (!shown) recordNotificationEvent(kind, 'show-timeout');
    }, 8000);
  } catch (error) {
    recordNotificationEvent(kind, 'error', { message: String((error && error.message) || error) });
  }
}

// In-app updates: a manual updater over the hand-written NSIS installer (see
// electron/updater.js). The renderer shows a small update button; checking
// never downloads, and downloading/installing each require a user approval.
let updateController = null;
function sendUpdateState(state) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', state);
  } catch { /* update reporting must never break the app */ }
}

// The renderer reports work at risk (dirty forms, in-flight writes) so an
// approved install never closes the app over unsaved work. Main enforces the
// same rules on the update-install IPC, so no caller can bypass the dialogs.
let updateGuardState = { dirtyForms: 0, pendingWrites: 0, pendingUploads: 0 };
ipcMain.on('update-guard-state', (_event, state) => {
  updateGuardState = {
    dirtyForms: Number(state?.dirtyForms) || 0,
    pendingWrites: Number(state?.pendingWrites) || 0,
    pendingUploads: Number(state?.pendingUploads) || 0
  };
});

function setupUpdates() {
  // HARUZIM_UPDATE_FEED_URL points the updater at a staging/test feed; unset
  // in production, where the public GitHub releases feed is used.
  const feed = createGitHubFeed({
    includePrerelease: process.env.HARUZIM_UPDATE_INCLUDE_PRERELEASE === '1',
    releasesUrl: process.env.HARUZIM_UPDATE_FEED_URL || ''
  });
  updateController = createUpdateController({
    feed,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    tempDir: app.getPath('temp'),
    send: sendUpdateState,
    log: (message) => console.warn('[updates]', message),
    quitApp: () => { isQuitting = true; app.quit(); },
    getGuardState: () => updateGuardState
  });
  ipcMain.handle('update-get-state', () => updateController.getState());
  ipcMain.handle('update-check', () => updateController.check());
  ipcMain.handle('update-download', () => updateController.download());
  ipcMain.handle('update-install', (_event, options) => updateController.install(options));
  if (app.isPackaged) {
    setTimeout(() => { updateController.check(); }, UPDATE_STARTUP_DELAY_MS).unref();
    setInterval(() => { updateController.check(); }, UPDATE_CHECK_INTERVAL_MS).unref();
  }
}

ipcMain.handle('notification-diagnostics', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'notification-diagnostics.json'), 'utf8'));
  } catch {
    return null;
  }
});

// Renderer reports a new order; show an OS notification only while the window
// is hidden (when visible, the in-page banner + alert tone already cover it,
// so no duplicate sound).
ipcMain.on('order-notification', (_event, payload) => {
  if (mainWindow && mainWindow.isVisible()) return;
  const orderId = payload && payload.orderId ? String(payload.orderId) : '';
  const shortId = orderId.slice(-8);
  const total = payload && payload.total != null ? ' · ' + Number(payload.total).toFixed(2) + '₪' : '';
  showOrderToast({
    title: 'הזמנה חדשה התקבלה',
    body: (shortId ? 'הזמנה מספר ' + shortId : 'התקבלה הזמנה חדשה') + total,
    orderId
  });
});


// Local test toast, on user request only: no order data and no server writes.
// Fires ~5s after the renderer asks so the user can close the window with X
// and verify the OS banner appears while the app sits in the tray. Unlike
// order toasts it also shows while the window is visible - testing the OS
// notification surface is its whole point. Clicking reopens the orders view.
ipcMain.on('test-notification', () => {
  setTimeout(() => {
    globalThis.testNotificationsShown = (globalThis.testNotificationsShown || 0) + 1;
    showOrderToast({
      title: 'התראת בדיקה',
      body: 'כך תיראה התראה על הזמנה חדשה. לחיצה פותחת את מסך ההזמנות.',
      kind: 'test'
    });
  }, 5000);
});

// Startup runs only in the instance that owns the single-instance lock; a
// second launch quits above before creating windows, tray or protocol hooks.
if (gotSingleInstanceLock) app.whenReady().then(() => {
  if (app.isPackaged) {
    const distDirectory = path.resolve(__dirname, '..', 'dist');
    protocol.handle('haruzim', (request) => {
      let relativePath;
      try {
        relativePath = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'index.html';
      } catch {
        return new Response('Not found', { status: 404 });
      }
      const targetPath = path.resolve(distDirectory, relativePath);
      if (!targetPath.startsWith(`${distDirectory}${path.sep}`) && targetPath !== path.join(distDirectory, 'index.html')) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(targetPath).toString());
    });
  }
  setupUpdates();
  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') {
    app.quit();
  }
});
