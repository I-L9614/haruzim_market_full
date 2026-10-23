import { app, BrowserWindow, net, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
protocol.registerSchemesAsPrivileged([{
  scheme: 'haruzim',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

const isDev = !app.isPackaged;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 780,
    backgroundColor: '#101827',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3002');
  } else {
    mainWindow.loadURL('haruzim://admin/index.html');
  }

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
