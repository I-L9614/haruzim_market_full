// In-app updates for the packaged Haruzim admin desktop app.
//
// The admin installer is a hand-written NSIS script (atomic staged install,
// custom shortcuts with our AppUserModelID, custom uninstall key), not an
// electron-builder NSIS package - so electron-updater cannot drive it. This
// module implements the same user-facing flow on top of that installer:
//
// Flow: the app checks the GitHub Releases feed for a newer admin-desktop
// release. A newer version only MARKS the release - the renderer shows a dot
// on the update button. Nothing downloads or installs until the user clicks
// and approves. An approved download streams the installer exe to the temp
// folder and verifies its SHA-256 against the .sha256 asset published with
// the release. An approved install launches the installer with /AUTORUN (the
// installer upgrades in place, then starts the new app) and quits this
// instance. User profile data (login session, settings) lives in the OS
// user-data folder, outside the install folder, so it carries over.
//
// The controller is a small state machine so it can be unit-tested with a
// fake feed; main.js wires it to the real GitHub feed and window.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const UPDATE_STARTUP_DELAY_MS = 15 * 1000;

export const RELEASES_REPO = 'I-L9614/haruzim_market_full';
export const RELEASE_TAG_PREFIX = 'admin-desktop-v';
export const INSTALLER_NAME_PREFIX = 'Haruzim-Admin-Setup-';

// Compares X.Y.Z versions (numeric segments only). Returns >0 when a is newer.
export const compareVersions = (a, b) => {
  const pa = String(a || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const parseTagVersion = (tag, prefix = RELEASE_TAG_PREFIX) => {
  const value = String(tag || '');
  if (!value.startsWith(prefix)) return null;
  const version = value.slice(prefix.length);
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
};

// Reads the GitHub releases feed and finds the newest release with a usable
// installer asset. Prereleases are ignored unless includePrerelease is set
// (used only by the packaged smoke test, never in production).
export const createGitHubFeed = ({
  repo = RELEASES_REPO,
  tagPrefix = RELEASE_TAG_PREFIX,
  exeNamePrefix = INSTALLER_NAME_PREFIX,
  includePrerelease = false,
  releasesUrl = '',
  fetchImpl = fetch
} = {}) => ({
  async findLatest() {
    const url = releasesUrl || (includePrerelease
      ? `https://api.github.com/repos/${repo}/releases?per_page=20`
      : `https://api.github.com/repos/${repo}/releases/latest`);
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'haruzim-admin-updater', Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`releases feed responded ${response.status}`);
    const payload = await response.json();
    const releases = Array.isArray(payload) ? payload : [payload];
    let best = null;
    for (const release of releases) {
      // Prereleases are never offered to production installs, even if one
      // somehow carries the highest tag (smoke targets are prereleases).
      if (release?.prerelease && !includePrerelease) continue;
      const version = parseTagVersion(release?.tag_name, tagPrefix);
      if (!version) continue;
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const exeAsset = assets.find((asset) => asset?.name?.startsWith(exeNamePrefix) && asset.name.endsWith('.exe'));
      const shaAsset = assets.find((asset) => asset?.name === `${exeAsset?.name || ''}.sha256`);
      if (!exeAsset || !shaAsset) continue;
      if (!best || compareVersions(version, best.version) > 0) {
        best = { version, exeAsset, shaAsset };
      }
    }
    return best;
  },

  async downloadTo(assetUrl, destPath, onProgress) {
    const response = await fetchImpl(assetUrl, { headers: { 'User-Agent': 'haruzim-admin-updater' } });
    if (!response.ok || !response.body) throw new Error(`update download responded ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    const counting = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (total > 0 && typeof onProgress === 'function') onProgress(Math.round((received / total) * 100));
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), counting, fs.createWriteStream(destPath));
    return destPath;
  },

  async fetchSha256(assetUrl) {
    const response = await fetchImpl(assetUrl, { headers: { 'User-Agent': 'haruzim-admin-updater' } });
    if (!response.ok) throw new Error(`checksum download responded ${response.status}`);
    const text = await response.text();
    const match = text.trim().match(/^([0-9a-f]{64})/i);
    if (!match) throw new Error('checksum file is not a SHA-256 digest');
    return match[1].toLowerCase();
  }
});

export const sha256File = (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(filePath)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', () => resolve(hash.digest('hex')))
    .on('error', reject);
});

// Install authorization, enforced by the main process on the update-install
// IPC so no caller can bypass the renderer's dialogs. A pending write always
// blocks - a half-written record is never discarded. Unsaved forms block
// too, unless the user explicitly chose "discard and install" in the dialog.
export const decideUpdateInstall = (guardState, { discardUnsaved = false } = {}) => {
  if ((guardState?.pendingWrites || 0) > 0) return { allow: false, reason: 'pending-writes' };
  if ((guardState?.dirtyForms || 0) > 0 && !discardUnsaved) return { allow: false, reason: 'unsaved-forms' };
  return { allow: true };
};

export const createUpdateController = ({
  feed = null,
  currentVersion = '0.0.0',
  isPackaged = false,
  tempDir = '',
  send = () => {},
  log = () => {},
  quitApp = () => {},
  spawnImpl = spawn,
  // Renderer-reported work at risk (dirty forms, in-flight writes). Install
  // decisions are enforced here, in the main process - see decideUpdateInstall.
  getGuardState = () => ({})
} = {}) => {
  let state = { status: isPackaged && feed ? 'idle' : 'disabled', version: null, percent: null, error: null };
  let pendingRelease = null;
  let downloadedInstaller = null;

  const setState = (patch) => {
    state = { ...state, ...patch };
    send(state);
    return state;
  };

  const getState = () => state;

  const check = async () => {
    if (!isPackaged || !feed) return setState({ status: 'disabled' });
    setState({ status: 'checking', error: null });
    try {
      const latest = await feed.findLatest();
      if (!latest || compareVersions(latest.version, currentVersion) <= 0) {
        pendingRelease = null;
        return setState({ status: 'uptodate', version: null, percent: null, error: null });
      }
      pendingRelease = latest;
      return setState({ status: 'available', version: latest.version, percent: null, error: null });
    } catch (error) {
      log(`update check failed: ${error?.message || error}`);
      return setState({ status: 'error', percent: null, error: 'update-check-failed' });
    }
  };

  const download = async () => {
    if (!isPackaged || !feed) return setState({ status: 'disabled' });
    if ((state.status !== 'available' && state.status !== 'error') || !pendingRelease) return state;
    const release = pendingRelease;
    setState({ status: 'downloading', percent: 0, error: null });
    try {
      const destPath = path.join(tempDir, release.exeAsset.name);
      await feed.downloadTo(release.exeAsset.browser_download_url, destPath, (percent) => {
        if (state.status === 'downloading') setState({ percent });
      });
      const expected = await feed.fetchSha256(release.shaAsset.browser_download_url);
      const actual = await sha256File(destPath);
      if (actual !== expected) {
        try { fs.unlinkSync(destPath); } catch { /* best effort */ }
        throw new Error('downloaded installer failed its SHA-256 check');
      }
      downloadedInstaller = destPath;
      return setState({ status: 'downloaded', version: release.version, percent: 100, error: null });
    } catch (error) {
      log(`update download failed: ${error?.message || error}`);
      return setState({ status: 'error', percent: null, error: 'update-download-failed' });
    }
  };

  // Launches the verified installer (which upgrades in place and, via
  // /AUTORUN, starts the new app) and quits this instance. Only from the
  // downloaded state - nothing installs without an approved download.
  // discardUnsaved is the user's explicit dialog choice to install despite
  // unsaved form edits; it never overrides an in-flight write.
  const install = ({ discardUnsaved = false } = {}) => {
    if (state.status !== 'downloaded' || !downloadedInstaller) return { installed: false, reason: 'not-downloaded' };
    const guard = decideUpdateInstall(getGuardState(), { discardUnsaved });
    if (!guard.allow) return { installed: false, reason: guard.reason || 'blocked' };
    // /AUTORUN starts the new app once the upgrade finishes. HARUZIM_UPDATE_SILENT
    // is an unattended-install flag used by the packaged smoke test only.
    const args = process.env.HARUZIM_UPDATE_SILENT === '1' ? ['/S', '/AUTORUN'] : ['/AUTORUN'];
    try {
      const child = spawnImpl(downloadedInstaller, args, { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (error) {
      log(`update install failed: ${error?.message || error}`);
      setState({ status: 'error', percent: null, error: 'update-install-failed' });
      return { installed: false, reason: 'spawn-failed' };
    }
    quitApp();
    return { installed: true };
  };

  return { getState, check, download, install };
};
