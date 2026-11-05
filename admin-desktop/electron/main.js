import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, net, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
protocol.registerSchemesAsPrivileged([{
  scheme: 'haruzim',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

const isDev = !app.isPackaged;
let mainWindow = null;
let tray = null;
let isQuitting = false;

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

// Renderer reports a new order; show an OS notification only while the window
// is hidden (when visible, the in-page banner + alert tone already cover it,
// so no duplicate sound).
ipcMain.on('order-notification', (_event, payload) => {
  if (mainWindow && mainWindow.isVisible()) return;
  const orderId = payload && payload.orderId ? String(payload.orderId).slice(-8) : '';
  const total = payload && payload.total != null ? ' · ' + Number(payload.total).toFixed(2) + '₪' : '';
  const notification = new Notification({
    title: 'הזמנה חדשה התקבלה',
    body: (orderId ? 'הזמנה מספר ' + orderId : 'התקבלה הזמנה חדשה') + total,
    silent: false,
    icon: path.join(__dirname, 'tray-icon.png')
  });
  notification.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  notification.show();
});

app.whenReady().then(() => {
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
