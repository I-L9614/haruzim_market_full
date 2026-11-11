import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  compareVersions, parseTagVersion, createGitHubFeed, createUpdateController
} from '../electron/updater.js';

const RELEASE = {
  tag_name: 'admin-desktop-v1.0.9',
  assets: [
    { name: 'Haruzim-Admin-Setup-1.0.9.exe', browser_download_url: 'https://example.test/setup.exe' },
    { name: 'Haruzim-Admin-Setup-1.0.9.exe.sha256', browser_download_url: 'https://example.test/setup.exe.sha256' }
  ]
};

const fakeFeed = (overrides = {}) => ({
  findLatest: async () => RELEASE && ({
    version: '1.0.9',
    exeAsset: RELEASE.assets[0],
    shaAsset: RELEASE.assets[1]
  }),
  downloadTo: async (_url, dest) => { fs.writeFileSync(dest, 'fake-installer-bytes'); return dest; },
  fetchSha256: async () => crypto.createHash('sha256').update('fake-installer-bytes').digest('hex'),
  ...overrides
});

const makeController = (overrides = {}) => {
  const sent = [];
  const controller = createUpdateController({
    feed: fakeFeed(), currentVersion: '1.0.8', isPackaged: true,
    tempDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hz-upd-')),
    send: (s) => sent.push(s), ...overrides
  });
  return { controller, sent };
};

test('compareVersions orders X.Y.Z numerically', () => {
  assert.ok(compareVersions('1.0.9', '1.0.8') > 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.0.8', '1.0.8'), 0);
  assert.ok(compareVersions('1.0.8', '1.0.9') < 0);
});

test('parseTagVersion accepts only the admin-desktop prefix and strict X.Y.Z', () => {
  assert.equal(parseTagVersion('admin-desktop-v1.0.9'), '1.0.9');
  assert.equal(parseTagVersion('v1.0.9'), null);
  assert.equal(parseTagVersion('admin-desktop-v1.0'), null);
  assert.equal(parseTagVersion('admin-desktop-v9.9.9-test'), null);
  assert.equal(parseTagVersion(''), null);
});

test('feed findLatest picks the highest matching release with exe + sha256 assets', async () => {
  const releases = [
    { tag_name: 'admin-desktop-v1.0.7', assets: [] }, // no assets - skipped
    { tag_name: 'admin-desktop-v1.0.9', assets: RELEASE.assets },
    { tag_name: 'admin-desktop-v1.0.8', assets: RELEASE.assets },
    { tag_name: 'unrelated-v9.9.9', assets: RELEASE.assets }
  ];
  const feed = createGitHubFeed({
    includePrerelease: true,
    fetchImpl: async () => ({ ok: true, json: async () => releases })
  });
  const latest = await feed.findLatest();
  assert.equal(latest.version, '1.0.9');
  assert.equal(latest.exeAsset.name, 'Haruzim-Admin-Setup-1.0.9.exe');
});

test('controller is disabled when not packaged', async () => {
  const { controller } = makeController({ isPackaged: false });
  const state = await controller.check();
  assert.equal(state.status, 'disabled');
});

test('newer release marks available without downloading', async () => {
  let downloads = 0;
  const { controller } = makeController({ feed: fakeFeed({ downloadTo: async () => { downloads += 1; } }) });
  const state = await controller.check();
  assert.equal(state.status, 'available');
  assert.equal(state.version, '1.0.9');
  assert.equal(downloads, 0);
});

test('same or older release reports uptodate', async () => {
  const { controller } = makeController({ feed: fakeFeed({ findLatest: async () => ({ version: '1.0.8', exeAsset: {}, shaAsset: {} }) }) });
  assert.equal((await controller.check()).status, 'uptodate');
});

test('download refuses before check, then verifies hash and marks downloaded', async () => {
  const { controller } = makeController();
  assert.equal((await controller.download()).status, 'idle'); // refused: not available
  await controller.check();
  const state = await controller.download();
  assert.equal(state.status, 'downloaded');
  assert.equal(state.percent, 100);
});

test('hash mismatch deletes the file and reports an error', async () => {
  let destSeen = null;
  const feed = fakeFeed({
    downloadTo: async (_url, dest) => { destSeen = dest; fs.writeFileSync(dest, 'tampered'); return dest; }
  });
  const { controller } = makeController({ feed });
  await controller.check();
  const state = await controller.download();
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'update-download-failed');
  assert.ok(!fs.existsSync(destSeen), 'tampered installer must be deleted');
});

test('install only runs from downloaded state, then spawns installer and quits', async () => {
  const calls = [];
  let quit = false;
  const spawnImpl = (...args) => { calls.push(args); return { unref() {} }; };
  const { controller } = makeController({ spawnImpl, quitApp: () => { quit = true; } });
  assert.deepEqual(controller.install(), { installed: false, reason: 'not-downloaded' });
  await controller.check();
  await controller.download();
  assert.deepEqual(controller.install(), { installed: true });
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].endsWith('Haruzim-Admin-Setup-1.0.9.exe'));
  assert.deepEqual(calls[0][1], ['/AUTORUN']);
  assert.equal(quit, true);
});

test('install is blocked while writes are in flight (no app close mid-save)', async () => {
  let quit = false;
  const spawnImpl = () => ({ unref() {} });
  const { controller } = makeController({ spawnImpl, quitApp: () => { quit = true; }, canInstall: () => ({ allow: false, reason: 'pending-writes' }) });
  await controller.check();
  await controller.download();
  assert.deepEqual(controller.install(), { installed: false, reason: 'pending-writes' });
  assert.equal(quit, false, 'app must not quit while a write is in flight');
});

test('production feed excludes prereleases even with the highest version', async () => {
  const releases = [
    { tag_name: 'admin-desktop-v9.9.9', prerelease: true, assets: RELEASE.assets },
    { tag_name: 'admin-desktop-v1.0.9', prerelease: false, assets: RELEASE.assets }
  ];
  const feed = createGitHubFeed({ fetchImpl: async () => ({ ok: true, json: async () => releases[1] }) });
  assert.equal((await feed.findLatest()).version, '1.0.9');
  const listFeed = createGitHubFeed({ includePrerelease: true, fetchImpl: async () => ({ ok: true, json: async () => releases }) });
  assert.equal((await listFeed.findLatest()).version, '9.9.9', 'test mode does see the prerelease');
});

test('install adds /S under the unattended test flag', async () => {
  process.env.HARUZIM_UPDATE_SILENT = '1';
  try {
    const calls = [];
    const spawnImpl = (...args) => { calls.push(args); return { unref() {} }; };
    const { controller } = makeController({ spawnImpl });
    await controller.check();
    await controller.download();
    assert.deepEqual(controller.install(), { installed: true });
    assert.deepEqual(calls[0][1], ['/S', '/AUTORUN']);
  } finally {
    delete process.env.HARUZIM_UPDATE_SILENT;
  }
});

test('check failure reports error and keeps working on retry', async () => {
  let attempts = 0;
  const feed = fakeFeed({ findLatest: async () => { attempts += 1; if (attempts === 1) throw new Error('network down'); return { version: '1.0.9', exeAsset: RELEASE.assets[0], shaAsset: RELEASE.assets[1] }; } });
  const { controller } = makeController({ feed });
  assert.equal((await controller.check()).status, 'error');
  assert.equal((await controller.check()).status, 'available');
});
