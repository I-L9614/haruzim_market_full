# Windows installer 1.0.9

The ApplicationID plugin (shortcut toast attribution) is vendored at
`build/nsis-plugins/ApplicationID.dll` (from the connectiblutz
NSIS-ApplicationID 1.1 release, ReleaseUnicode build) and loaded with
`!addplugindir /x86-unicode "nsis-plugins"` - stage that folder next to
`installer.nsi` when compiling. `APP_VERSION` can be overridden with
makensis `-DAPP_VERSION=x.y.z` for the CI update-target build.

`/AUTORUN` (passed by the in-app updater after the user approves an install)
launches the app once the upgrade completes; manual installs do not launch.
`/S` (silent) is supported and used by the packaged Windows smoke only.

The custom per-user NSIS installer is used instead of electron-builder's
NSIS target. It keeps the original app path, registry keys and shortcuts.
The existing registry App Paths value supplies the default upgrade folder.

## Build

From the repository root, install the locked npm dependencies. Then:

```sh
cd admin-desktop
VITE_API_URL=https://haruzim-api.haruzim-probe.workers.dev/api npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win dir --x64
```

Patch `release/win-unpacked/Haruzim Admin.exe` with `build/patch_icon.cjs`
using resedit and `build/icon.ico`. In a separate build folder, place
`installer.nsi`, `icon.ico`, and the complete win-unpacked directory as `app`.
Compile `installer.nsi` with NSIS 3 Unicode, including System, LogicLib and
FileFunc. Do not use a partial archive extraction as the app source.

## Upgrade safety

- Extract to a versioned sibling staging folder before changing the old app.
- Skip is disabled. A failed extraction cannot be reported as success.
- Check existing files with non-truncating OPEN_EXISTING exclusive handles.
  Busy or unwritable files block the upgrade. No process is force-terminated.
- Refuse a nonempty destination without the known Haruzim app executable.
- Refuse linked subfolders rather than walking outside the installation.
- Rename the old application folder to a unique sibling backup. Activate the
  staged folder only after successful extraction and preflight.
- If activation fails, try restoring the old folder. If restoration fails,
  identify the backup and stop with an error. Do not delete that backup.
- Retain the old folder even on success. Never recursively remove the old
  installation during upgrade. A canceled staging attempt only cleans the
  staging folder created by this run.
- Registration is changed only after activation. A registration failure is
  reported explicitly, not as a completed install.
- No automatic launch on manual install (only the updater's /AUTORUN flag
  starts the app after an approved update). No Windows startup registration.
  No admin elevation.
- The Electron user profile under AppData and cloud database are not changed.

This is not a power-loss-atomic transaction. A machine crash between folder
renames can require manual restoration from the retained backup. Antivirus,
disk-space, access-policy and runtime compatibility errors remain possible.

## Required real Windows checks

Static payload validation is not a Windows runtime test. Before shop rollout:

1. On the developer PC, close the app fully via its tray menu. If the installed
   version lacks that menu or its integrity is uncertain, restart Windows and
   run the new installer before reopening the app. Do not uninstall first.
2. Install into the detected existing folder. Any warning/error stops the test;
   do not bypass Windows protections, change privileges or delete directories.
3. Windows Installed Apps must report 1.0.3. Open the app and verify login and
   the existing data. No test orders/products should be written to production.
4. Separately test a fresh per-user installation on the shop PC, only after
   the developer upgrade completes without errors. Check notifications with
   an approved test or normal real order, including the hidden-window case.
5. Exercise locked-file cancel/retry, extraction failure, and activation
   failure/rollback in an isolated Windows test environment before calling
   those branches runtime-verified.

The executable is unsigned. Do not tell users to disable security protections.

## Validation recorded for 1.0.3

- NSIS compilation succeeds, with Skip disabled and installer CRC enforced.
- Every packaged app payload file was extracted and SHA-256 compared with its
  build source (72 files, zero mismatches).
- Isolated Wine 11.21 compatibility checks: fresh per-user installation exit 0;
  in-place upgrade exit 0; exclusive app.asar file lock causes installer exit 2
  and preserves the existing app.asar hash; profile sentinel preserved;
  old application folder retained. Interactive completion screen inspected.
- These are compatibility checks, not real Windows tests. Electron app launch,
  login, notification/sound behavior and Windows security prompts still need
  the developer PC. Failure rollback and power-loss branches were not executed.
