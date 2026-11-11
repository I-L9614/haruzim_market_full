// Windows packaged smoke: proves the in-app updater end to end with REAL
// installers on a real Windows machine (CI windows-latest), no secrets.
//
// Phase A - old-install compatibility: install the published 1.0.8 over its
//   own userData marker, then upgrade silently to the freshly built 1.0.9 and
//   assert a single install, updated registry version, preserved marker.
// Phase B - full updater cycle: launch the installed 1.0.9, sign in against a
//   stubbed API (CDP interception only), click the update button, approve the
//   download (real installer bytes downloaded from the temporary GitHub test
//   prerelease, SHA-256 verified by the app), approve the install, and watch
//   the app close, the installer upgrade silently to 9.9.9, and the new app
//   relaunch via /AUTORUN - with the userData marker still intact.
//
// Required env:
//   HARUZIM_SETUP_EXE  - path to the freshly built 1.0.9 installer exe
//   HARUZIM_FEED_URL   - GitHub API URL of the temporary 9.9.9 test prerelease
//   SMOKE_SHOTS_DIR    - folder for screenshots (optional)

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const fail = (msg) => { console.error('SMOKE FAIL: ' + msg); process.exit(1); };
const ok = (msg) => console.log('smoke ok: ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP_EXE = process.env.HARUZIM_SETUP_EXE;
const FEED_URL = process.env.HARUZIM_UPDATE_FEED_URL;
const SHOTS = process.env.SMOKE_SHOTS_DIR || path.join(os.tmpdir(), 'hz-win-shots');
fs.mkdirSync(SHOTS, { recursive: true });
if (!SETUP_EXE || !fs.existsSync(SETUP_EXE)) fail('HARUZIM_SETUP_EXE missing or not found');
if (!FEED_URL) fail('HARUZIM_UPDATE_FEED_URL missing');

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'Haruzim Admin');
const APP_EXE = path.join(INSTALL_DIR, 'Haruzim Admin.exe');
const USER_DATA = path.join(process.env.APPDATA, 'Haruzim Admin');
const MARKER = path.join(USER_DATA, 'smoke-marker.txt');
const UNINST_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HaruzimAdmin';
const CDP_PORT = 9223;
const OLD_SETUP_URL = 'https://github.com/I-L9614/haruzim_market_full/releases/download/admin-desktop-v1.0.8/Haruzim-Admin-Setup-1.0.8.exe';

const displayVersion = () => {
  const r = spawnSync('reg', ['query', UNINST_KEY, '/v', 'DisplayVersion'], { encoding: 'utf8' });
  const m = (r.stdout || '').match(/DisplayVersion\s+REG_SZ\s+(\S+)/);
  return m ? m[1] : null;
};
const appRunning = () => {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Haruzim Admin.exe', '/NH'], { encoding: 'utf8' });
  return (r.stdout || '').includes('Haruzim Admin.exe');
};
const killApp = () => { spawnSync('taskkill', ['/F', '/IM', 'Haruzim Admin.exe'], { stdio: 'ignore' }); };
const captureScreen = (name) => {
  const out = path.join(SHOTS, name);
  const ps1 = path.join(os.tmpdir(), 'hz-shot.ps1');
  fs.writeFileSync(ps1, [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${out.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()'
  ].join('\n'));
  const shot = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8', timeout: 60000 });
  if (shot.error || shot.status !== 0 || !fs.existsSync(out)) fail('screen capture failed: ' + (shot.stderr || shot.error?.message || 'no file'));
  ok(`captured ${name}`);
};
const waitFor = async (fn, what, tries = 60, everyMs = 2000) => {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(everyMs); }
  fail(`timed out waiting for: ${what}`);
};
const silentInstall = (exePath, label) => {
  const r = spawnSync(exePath, ['/S'], { timeout: 180000 });
  if (r.error || r.status !== 0) fail(`${label} installer exited with ${r.status ?? r.error?.message}`);
};

const FAKE_TOKEN = ['e30', Buffer.from(JSON.stringify({ role: 'admin', id: 'smoke-admin' })).toString('base64url'), 'sig'].join('.');
const API_ROUTES = {
  'POST /api/auth/admin/login': { token: FAKE_TOKEN, admin: { id: 'smoke-admin', name: 'בדיקת עשן', email: 'smoke@admin.local', role: 'admin' } },
  'GET /api/auth/admin/me': { admin: { id: 'smoke-admin', name: 'בדיקת עשן', email: 'smoke@admin.local', role: 'admin' } },
  'GET /api/admin/orders': { orders: [], nextCursor: null },
  'GET /api/admin/products': { products: [], categories: [] },
  'GET /api/admin/stats': { totalRevenue: 0, totalOrders: 0, orderStatusBreakdown: {}, topSellingProducts: [] },
  'GET /api/shabbat/status': { success: true, isShabbat: false }
};

killApp();
await sleep(1500);

// ---------- Phase A: old-install compatibility ----------
const oldSetup = path.join(os.tmpdir(), 'Haruzim-Admin-Setup-1.0.8.exe');
if (!fs.existsSync(oldSetup)) {
  const res = await fetch(OLD_SETUP_URL);
  if (!res.ok) fail(`cannot download published 1.0.8 installer: ${res.status}`);
  fs.writeFileSync(oldSetup, Buffer.from(await res.arrayBuffer()));
}
ok('downloaded the published 1.0.8 installer');
silentInstall(oldSetup, '1.0.8');
await waitFor(() => displayVersion() === '1.0.8', 'registry DisplayVersion 1.0.8', 15);
fs.mkdirSync(USER_DATA, { recursive: true });
fs.writeFileSync(MARKER, `smoke marker ${Date.now()}`);
ok('1.0.8 installed; userData marker written');

silentInstall(SETUP_EXE, '1.0.9');
await waitFor(() => displayVersion() === '1.0.9', 'registry DisplayVersion 1.0.9', 15);
if (!fs.existsSync(APP_EXE)) fail('app exe missing after upgrade to 1.0.9');
if (!fs.existsSync(MARKER)) fail('userData marker lost in the 1.0.8 -> 1.0.9 upgrade');
ok('upgrade 1.0.8 -> 1.0.9: same install dir, registry updated, userData preserved');

// ---------- Phase B: full updater cycle 1.0.9 -> 9.9.9 ----------
const appLog = path.join(SHOTS, 'hz-app-first-instance.log');
const appLogFd = fs.openSync(appLog, 'w');
const child = spawn(APP_EXE, [`--remote-debugging-port=${CDP_PORT}`], {
  env: { ...process.env, HARUZIM_UPDATE_FEED_URL: FEED_URL, HARUZIM_UPDATE_SILENT: '1' },
  stdio: ['ignore', appLogFd, appLogFd]
});
process.on('exit', () => { try { killApp(); } catch {} });

let browser = null;
for (let i = 0; i < 90 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); } catch { await sleep(1000); }
}
if (!browser) fail('installed 1.0.9 did not expose CDP');
const page = browser.contexts()[0].pages()[0];
page.on('pageerror', (e) => console.log('renderer pageerror: ' + e.message));

await page.route('https://haruzim-api.haruzim-probe.workers.dev/**', (route) => {
  const req = route.request();
  const body = API_ROUTES[`${req.method()} ${new URL(req.url()).pathname}`];
  if (req.url().includes('/realtime')) return route.abort();
  return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body || { error: 'not-stubbed' }) });
});

await page.waitForSelector('form', { timeout: 30000 });
const initial = await page.evaluate(() => window.haruzimDesktop?.getUpdateState?.());
if (!initial || initial.status === 'disabled') fail('update controller disabled in the installed 1.0.9');
ok(`update controller live in the installed 1.0.9 (status: ${initial.status})`);

await page.fill('input[type="email"]', 'smoke@admin.local');
await page.fill('input[type="password"]', 'smoke-password');
await page.click('button[type="submit"]');
await page.waitForSelector('#updateButton', { timeout: 30000 });
ok('signed in (stub); update button rendered in the installed window');
captureScreen('win-01-update-button.png');

await page.click('#updateButton'); // manual check against the test prerelease
await page.waitForFunction(() => document.querySelector('#updateButton')?.textContent.includes('עדכון זמין'), null, { timeout: 30000 });
await page.waitForSelector('.update-dot', { timeout: 5000 });
ok('update 9.9.9 marked available (dot + label)');
captureScreen('win-02-update-available.png');

await page.click('#updateButton');
await page.waitForSelector('.update-modal', { timeout: 5000 });
captureScreen('win-03-download-dialog.png');
await page.click('.update-modal .primary-btn'); // approve download
await page.waitForFunction(() => document.querySelector('#updateButton')?.textContent.includes('התקנת עדכון'), null, { timeout: 120000 });
ok('real installer bytes downloaded from GitHub and SHA-256 verified by the app');

await page.waitForSelector('.update-modal', { timeout: 5000 });
captureScreen('win-04-install-dialog.png');

// ---------- Work-preservation guard scenarios (same rules as unit/Linux) ----------
// A local stub with a route that never answers simulates an in-flight write.
const hangStub = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
  // /hang never answers
});
await new Promise((resolve) => hangStub.listen(0, '127.0.0.1', resolve));
const hangPort = hangStub.address().port;

// 1. An in-flight write blocks the install with its own dialog (no discard).
await page.evaluate((port) => {
  window.__smokeAbort = new AbortController();
  window.fetch(`http://127.0.0.1:${port}/hang`, { method: 'POST', signal: window.__smokeAbort.signal }).catch(() => 'settled');
}, hangPort);
await sleep(1000);
await page.click('.update-modal .primary-btn'); // עדכון עכשיו
await page.waitForFunction(() => document.querySelector('.update-modal h3')?.textContent.includes('שמירות עדיין מתבצעות'), null, { timeout: 10000 });
ok('in-flight write blocks the install with an explanatory dialog');
captureScreen('win-05-install-blocked-pending-write.png');
await page.click('.update-modal .primary-btn'); // חזרה
await page.evaluate(() => window.__smokeAbort.abort());
await sleep(500);
hangStub.close();

// 2. Unsaved form edits require the explicit save/discard/cancel decision.
await page.fill('.category-create-form input', 'קטגוריית בדיקה');
await page.click('#updateButton');
await page.waitForSelector('.update-modal', { timeout: 5000 });
await page.click('.update-modal .primary-btn'); // עדכון עכשיו
await page.waitForFunction(() => {
  const modal = document.querySelector('.update-modal');
  return modal?.querySelector('h3')?.textContent.includes('יש שינויים שלא נשמרו') && modal?.textContent.includes('טופס אחד עם שינויים שלא נשמרו');
}, null, { timeout: 10000 });
ok('dirty form routes to the explicit save/discard/cancel decision');
captureScreen('win-06-install-decision-unsaved-form.png');
await page.click('.update-modal .primary-btn'); // חזרה לשמירה
await page.waitForFunction(() => !document.querySelector('.update-modal'), null, { timeout: 5000 });

// 3. The main process enforces the same guard on the IPC itself.
const enforced = await page.evaluate(() => window.haruzimDesktop.installUpdate());
if (!(enforced?.installed === false && enforced?.reason === 'unsaved-forms')) fail('main process did not refuse install over unsaved forms: ' + JSON.stringify(enforced));
ok('main process refuses install over unsaved forms (IPC enforcement)');

// 4. Clear the dirty form (submit hands it to the app; the stub 404s, which
//    is fine - the point is the mark releases) so the real approve below
//    exercises the plain path.
await page.click('.category-create-form button[type="submit"]');
await page.waitForFunction(() => {
  const g = window.__updateGuard?.state();
  return g && g.dirtyForms === 0 && g.pendingWrites === 0;
}, null, { timeout: 10000 });
ok('guard cleared after the form submit (dirty released, write settled)');

await page.click('#updateButton');
await page.waitForSelector('.update-modal', { timeout: 5000 });
await page.click('.update-modal .primary-btn'); // approve install: app quits, installer runs /S /AUTORUN
ok('install approved; waiting for the silent upgrade and relaunch');

await waitFor(() => displayVersion() === '9.9.9', 'registry DisplayVersion 9.9.9 (silent upgrade)', 90);
if (!fs.existsSync(MARKER)) fail('userData marker lost in the 1.0.9 -> 9.9.9 in-app update');
ok('silent upgrade applied: registry DisplayVersion 9.9.9, userData preserved');

let relaunched = false;
for (let i = 0; i < 30 && !relaunched; i++) { if (appRunning()) relaunched = true; else await sleep(2000); }
if (!relaunched) {
  // Diagnostics: desktop state + first-instance log + a manual launch attempt
  // (distinguishes "autorun never fired" from "the 9.9.9 build cannot start").
  try { captureScreen('win-07-relaunch-timeout.png'); } catch {}
  console.log('first-instance log tail:\n' + (fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8').slice(-4000) : '(no app log)'));
  const relog = path.join(SHOTS, 'hz-relaunch-manual.log');
  const relogFd = fs.openSync(relog, 'w');
  const manual = spawn(APP_EXE, [], { stdio: ['ignore', relogFd, relogFd], detached: true });
  manual.unref();
  await sleep(12000);
  const manualOk = appRunning();
  console.log('manual launch log tail:\n' + (fs.existsSync(relog) ? fs.readFileSync(relog, 'utf8').slice(-4000) : '(empty)'));
  if (manualOk) console.log('note: manual launch works - the 9.9.9 build starts, so /AUTORUN itself did not fire');
  fail(`updated app did not relaunch via /AUTORUN (manual launch ${manualOk ? 'WORKS' : 'ALSO FAILS'})`);
}
ok('in-app update completed: 1.0.9 -> 9.9.9, data preserved, app relaunched');
await sleep(4000);
captureScreen('win-07-after-update.png');

try { await browser.close(); } catch {}
console.log('SMOKE_PASSED');
killApp();
process.exit(0);
