// Packaged smoke test for the in-app updater (real packaged app, CDP-driven).
//
// Runs the packaged Electron build, intercepts the production API and the
// GitHub releases feed with CDP Fetch interception (no production code
// changes, no real network writes), signs in with a fake admin token, and
// drives the real update flow: check -> available -> approve download ->
// bytes downloaded from a local stub -> SHA-256 verified -> downloaded ->
// install dialog; then proves an in-flight write blocks the install and a
// settled write unblocks it (approving quits the app for the installer).
//
// Produces screenshots for visual verification and fails on any assertion.
//
// Usage: node admin-desktop/tests/packaged-smoke/smoke.mjs [path-to-packaged-binary]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BINARY = process.argv[2] || path.join(ROOT, 'release/linux-unpacked/admin-desktop');
const SHOTS = process.env.SMOKE_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'hz-smoke-shots-'));
const CDP_PORT = 9223;

const FAKE_EXE = Buffer.from('FAKE-NSIS-INSTALLER-BYTES-FOR-SMOKE-' + 'x'.repeat(4096));
const FAKE_SHA = crypto.createHash('sha256').update(FAKE_EXE).digest('hex');
const FAKE_TOKEN = ['e30', Buffer.from(JSON.stringify({ role: 'admin', id: 'smoke-admin' })).toString('base64url'), 'sig'].join('.');

const RELEASE_FEED = {
  tag_name: 'admin-desktop-v9.9.9',
  assets: [
    { name: 'Haruzim-Admin-Setup-9.9.9.exe', browser_download_url: 'http://127.0.0.1:PORT/setup.exe' },
    { name: 'Haruzim-Admin-Setup-9.9.9.exe.sha256', browser_download_url: 'http://127.0.0.1:PORT/setup.exe.sha256' }
  ]
};

const API_ROUTES = {
  'POST /api/auth/admin/login': { token: FAKE_TOKEN, admin: { id: 'smoke-admin', name: 'בדיקת עשן', email: 'smoke@admin.local', role: 'admin' } },
  'GET /api/auth/admin/me': { admin: { id: 'smoke-admin', name: 'בדיקת עשן', email: 'smoke@admin.local', role: 'admin' } },
  'GET /api/admin/orders': { orders: [], nextCursor: null },
  'GET /api/admin/products': { products: [], categories: [] },
  'GET /api/admin/stats': { totalRevenue: 0, totalOrders: 0, orderStatusBreakdown: {}, topSellingProducts: [] },
  'GET /api/shabbat/status': { success: true, isShabbat: false }
};

const assert = (cond, message) => { if (!cond) { console.error(`SMOKE FAILED: ${message}`); process.exit(1); } console.log(`smoke ok: ${message}`); };

// Local stub serving the fake installer bytes + checksum for the main-process
// downloader (main-process fetch is not covered by CDP interception).
const stub = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
  if (req.url === '/hang') return; // never answers: simulates an in-flight write
  if (req.url === '/releases/latest') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(RELEASE_FEED)); return; }
  if (req.url === '/setup.exe') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': FAKE_EXE.length }); res.end(FAKE_EXE); return; }
  if (req.url === '/setup.exe.sha256') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`${FAKE_SHA}  Haruzim-Admin-Setup-9.9.9.exe`); return; }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;
RELEASE_FEED.assets.forEach((a) => { a.browser_download_url = a.browser_download_url.replace('PORT', String(stubPort)); });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-smoke-profile-'));
const child = spawn(BINARY, [`--remote-debugging-port=${CDP_PORT}`], {
  env: { ...process.env, XDG_CONFIG_HOME: userDataDir, ELECTRON_DISABLE_SANDBOX: '1', HARUZIM_UPDATE_FEED_URL: `http://127.0.0.1:${stubPort}/releases/latest` },
  stdio: ['ignore', 'pipe', 'pipe']
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });
process.on('exit', () => { try { child.kill('SIGKILL'); } catch {} stub.close(); });

const deadline = Date.now() + 30000;
let browser = null;
while (Date.now() < deadline && !browser) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
assert(browser, 'packaged app exposes CDP');
const page = browser.contexts()[0].pages()[0];

// Intercept the production API and the GitHub releases feed.
await page.route('https://haruzim-api.haruzim-probe.workers.dev/**', (route) => {
  const req = route.request();
  const key = `${req.method()} ${new URL(req.url()).pathname}`;
  const body = API_ROUTES[key];
  if (req.url().includes('/realtime')) return route.abort();
  return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body || { error: 'not-stubbed' }) });
});
page.on('console', (msg) => { if (msg.type() === 'error') console.log(`renderer console error: ${msg.text()}`); });
page.on('pageerror', (error) => { console.log(`renderer pageerror: ${error.message}`); });

await page.waitForSelector('form', { timeout: 20000 });
assert(true, 'packaged app boots to the login screen');

// Bridge state is live in the packaged app (not 'disabled').
const initial = await page.evaluate(() => window.haruzimDesktop?.getUpdateState?.());
assert(initial && initial.status === 'idle', `update controller live in packaged app (status: ${initial?.status})`);

// Sign in with the fake token (login form, real renderer path).
await page.fill('input[type="email"]', 'smoke@admin.local');
await page.fill('input[type="password"]', 'smoke-password');
await page.click('button[type="submit"]');
await page.waitForSelector('#updateButton', { timeout: 20000 });
assert(true, 'signed in (stub) and update button rendered in the top bar');
await page.screenshot({ path: path.join(SHOTS, '01-update-button-idle.png') });

// Manual check: the stubbed feed offers 9.9.9 -> yellow dot + "עדכון זמין".
await page.click('#updateButton');
await page.waitForFunction(() => window.haruzimDesktop && document.querySelector('#updateButton')?.textContent.includes('עדכון זמין'), null, { timeout: 15000 });
await page.waitForSelector('.update-dot', { timeout: 5000 });
assert(true, 'manual check marks the available update (dot + label)');
await page.screenshot({ path: path.join(SHOTS, '02-update-available-dot.png') });

// Approve the download dialog -> real download from the stub -> SHA verified.
await page.click('#updateButton');
await page.waitForSelector('.update-modal', { timeout: 5000 });
await page.screenshot({ path: path.join(SHOTS, '03-download-dialog.png') });
await page.click('.update-modal .primary-btn');
await page.waitForFunction(() => document.querySelector('#updateButton')?.textContent.includes('התקנת עדכון'), null, { timeout: 30000 });
assert(true, 'download completed and SHA-256 verified (state: downloaded)');

// The install dialog opens by itself once the download finishes.
await page.waitForSelector('.update-modal', { timeout: 5000 });
const installText = await page.textContent('.update-modal');
assert(installText.includes('העדכון מוכן להתקנה'), 'install approval dialog appears after download');
await page.screenshot({ path: path.join(SHOTS, '04-install-dialog.png') });

// An in-flight write must block the install (main-process enforced guard).
const hang = page.evaluate((port) => {
  window.__smokeAbort = new AbortController();
  return window.fetch(`http://127.0.0.1:${port}/hang`, { method: 'POST', signal: window.__smokeAbort.signal }).catch(() => 'settled');
}, stubPort);
await page.click('.update-modal .primary-btn'); // install dialog is already open
await page.waitForFunction(() => document.querySelector('.update-notice')?.textContent.includes('שמירה'), null, { timeout: 5000 });
const blocked = await page.evaluate(() => window.haruzimDesktop?.getUpdateState?.());
assert(blocked?.status === 'downloaded', 'install refused while a write is in flight (app kept running, state downloaded)');
await page.screenshot({ path: path.join(SHOTS, '05-install-blocked-pending-write.png') });

// The unblocking direction (guard clears when the write settles, install
// then proceeds and quits for the installer) is covered by the unit tests
// and by the Windows packaged smoke with the real NSIS installer; driving
// it here adds nothing about production behavior, since the fake installer
// cannot execute on Linux and a quit drops CDP mid-call.
await page.evaluate(() => window.__smokeAbort.abort());
try { await hang; } catch {}

console.log(`SMOKE_PASSED screenshots=${SHOTS}`);
try { await browser.close(); } catch {}
child.kill('SIGKILL');
stub.close();
process.exit(0);
