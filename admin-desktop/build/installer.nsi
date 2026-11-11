!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define APP_NAME "Haruzim Admin"
!define APP_VERSION "1.0.6"
!define APP_PUBLISHER "Haruzim Market"
!define APP_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\HaruzimAdmin.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\HaruzimAdmin"
Unicode true
SetCompressor zlib
CRCCheck force
AllowSkipFiles off
Name "${APP_NAME} ${APP_VERSION}"
OutFile "Haruzim-Admin-Setup-${APP_VERSION}.exe"
Icon "icon.ico"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
RequestExecutionLevel user
ShowInstDetails show
ShowUnInstDetails show
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles
Var StageDir
Var BackupDir
Var CheckDir
Var BusyFile
Var HadOld
Var RegistrationError

Function .onInit
  ; Match the original per-user installer, including a custom selected folder.
  ReadRegStr $0 HKCU "${APP_DIR_REGKEY}" ""
  ${If} $0 != ""
    ${GetParent} "$0" $INSTDIR
  ${EndIf}
FunctionEnd

; Open every existing application file without modifying it. A running app,
; protected file, or denied permission blocks the upgrade before any move.
Function CheckFiles
  Push $0
  Push $1
  Push $2
  FindFirst $0 $1 "$CheckDir\*"
  check_next:
    StrCmp $1 "" check_done
    StrCmp $1 "." check_advance
    StrCmp $1 ".." check_advance
    IfFileExists "$CheckDir\$1\*" check_subdir check_file
  check_subdir:
    ; Never recurse into a junction/symlink outside the application directory.
    System::Call 'kernel32::GetFileAttributesW(w "$CheckDir\$1") i.r2'
    IntOp $2 $2 & 0x400
    IntCmp $2 0 +3
      StrCpy $BusyFile "$CheckDir\$1 (linked folder)"
      Goto check_done
    Push $CheckDir
    StrCpy $CheckDir "$CheckDir\$1"
    Call CheckFiles
    Pop $CheckDir
    StrCmp $BusyFile "" check_advance check_done
  check_file:
    ; OPEN_EXISTING, GENERIC_WRITE, share=0. No truncation or write occurs.
    System::Call 'kernel32::CreateFileW(w "$CheckDir\$1", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r2'
    IntCmp $2 -1 check_busy
    System::Call 'kernel32::CloseHandle(p r2)'
    Goto check_advance
  check_busy:
    StrCpy $BusyFile "$CheckDir\$1"
    Goto check_done
  check_advance:
    FindNext $0 $1
    Goto check_next
  check_done:
    FindClose $0
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

Section "Install"
  StrCpy $StageDir "$INSTDIR.haruzim-stage-1.0.6"
  IfFileExists "$StageDir\*" stage_exists
  ClearErrors
  CreateDirectory "$StageDir"
  IfErrors stage_failed
  SetOutPath "$StageDir"
  ; Extract fully before touching the existing application. No Skip button.
  File /r "app\*.*"
  WriteUninstaller "$StageDir\Uninstall.exe"
  IfErrors stage_failed
  ; Move the current working directory away before renaming the staged folder.
  SetOutPath "$TEMP"
  preflight:
    ; Do not move an arbitrary nonempty folder selected on the directory page.
    IfFileExists "$INSTDIR\*" 0 known_target
    IfFileExists "$INSTDIR\Haruzim Admin.exe" known_target
    MessageBox MB_OK|MB_ICONSTOP "Choose the existing Haruzim Admin application folder, or a new empty folder. No installed files were changed." /SD IDOK
    Goto cancel_install
  known_target:
    StrCpy $BusyFile ""
    StrCpy $CheckDir "$INSTDIR"
    IfFileExists "$INSTDIR\*" 0 commit
    Call CheckFiles
    StrCmp $BusyFile "" commit
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Close Haruzim Admin completely (including its tray icon) and retry.$\r$\nIf it is already closed, check the file permissions.$\r$\nNo installed files have been replaced.$\r$\n$BusyFile" /SD IDCANCEL IDRETRY preflight IDCANCEL cancel_install
  commit:
    StrCpy $HadOld "0"
    IfFileExists "$INSTDIR\*" 0 activate
    System::Call 'kernel32::GetTickCount() i.r0'
    StrCpy $BackupDir "$INSTDIR.haruzim-backup-$0"
    IfFileExists "$BackupDir\*" backup_failed
    ClearErrors
    Rename "$INSTDIR" "$BackupDir"
    IfErrors backup_failed
    StrCpy $HadOld "1"
  activate:
    ClearErrors
    Rename "$StageDir" "$INSTDIR"
    IfErrors rollback
    ; Registration occurs only after complete activation. Backups are retained.
    ClearErrors
    SetOutPath "$INSTDIR"
    ClearErrors
    CreateDirectory "$SMPROGRAMS\חרוזים"
    IfErrors 0 +3
      StrCpy $RegistrationError "CreateDirectory"
      Goto registration_failed
    ClearErrors
    CreateShortcut "$SMPROGRAMS\חרוזים\חרוזים - ניהול.lnk" "$INSTDIR\Haruzim Admin.exe" "" "$INSTDIR\Haruzim Admin.exe" 0
    IfErrors 0 +3
      StrCpy $RegistrationError "CreateShortcut"
      Goto registration_failed
    ClearErrors
    CreateShortcut "$SMPROGRAMS\חרוזים\הסר התקנה.lnk" "$INSTDIR\Uninstall.exe"
    IfErrors 0 +3
      StrCpy $RegistrationError "CreateShortcut"
      Goto registration_failed
    ClearErrors
    CreateShortcut "$DESKTOP\חרוזים - ניהול.lnk" "$INSTDIR\Haruzim Admin.exe" "" "$INSTDIR\Haruzim Admin.exe" 0
    IfErrors 0 +3
      StrCpy $RegistrationError "CreateShortcut"
      Goto registration_failed
    ClearErrors
    WriteRegStr HKCU "${APP_DIR_REGKEY}" "" "$INSTDIR\Haruzim Admin.exe"
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegStr"
      Goto registration_failed
    ClearErrors
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "חרוזים - ניהול"
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegStr"
      Goto registration_failed
    ClearErrors
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegStr"
      Goto registration_failed
    ClearErrors
    WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegStr"
      Goto registration_failed
    ClearErrors
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Haruzim Admin.exe"
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegStr"
      Goto registration_failed
    ClearErrors
    WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegStr"
      Goto registration_failed
    ClearErrors
    WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegStr"
      Goto registration_failed
    ClearErrors
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegDWORD"
      Goto registration_failed
    ClearErrors
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
    IfErrors 0 +3
      StrCpy $RegistrationError "WriteRegDWORD"
      Goto registration_failed
    DetailPrint "Installed ${APP_NAME} ${APP_VERSION}. User profile and cloud data were not changed."
    StrCmp $HadOld "1" 0 success
    DetailPrint "Previous application files retained at: $BackupDir"
    Goto success
  rollback:
    StrCmp $HadOld "1" 0 stage_failed
    ClearErrors
    Rename "$BackupDir" "$INSTDIR"
    IfErrors rollback_failed
    MessageBox MB_OK|MB_ICONSTOP "Installation failed. Previous application files were restored. Do not uninstall." /SD IDOK
    Goto cancel_install
  rollback_failed:
    MessageBox MB_OK|MB_ICONSTOP "Installation stopped. Previous files remain at:$\r$\n$BackupDir$\r$\nDo not delete this folder. Contact support before continuing." /SD IDOK
    SetErrorLevel 3
    Quit
  stage_exists:
    MessageBox MB_OK|MB_ICONSTOP "A previous incomplete installation folder exists:$\r$\n$StageDir$\r$\nNo installed files were changed. Contact support before retrying." /SD IDOK
    SetErrorLevel 2
    Quit
  backup_failed:
    MessageBox MB_OK|MB_ICONSTOP "The existing application could not be moved safely. Close it completely and retry. No installed files were replaced." /SD IDOK
    Goto cancel_install
  stage_failed:
    MessageBox MB_OK|MB_ICONSTOP "The new files could not be prepared. Installation was not completed. No installed files were replaced." /SD IDOK
    Goto cancel_install
  registration_failed:
    MessageBox MB_OK|MB_ICONSTOP "Application files were installed, but Windows shortcuts or registration could not be completed ($RegistrationError). Contact support." /SD IDOK
    SetErrorLevel 4
    Quit
  cancel_install:
    SetOutPath "$TEMP"
    RMDir /r "$StageDir"
    SetErrorLevel 2
    Quit
  success:
SectionEnd

Section "Uninstall"
  ; Never remove the Electron user profile or any retained upgrade backup.
  Delete "$DESKTOP\חרוזים - ניהול.lnk"
  Delete "$SMPROGRAMS\חרוזים\חרוזים - ניהול.lnk"
  Delete "$SMPROGRAMS\חרוזים\הסר התקנה.lnk"
  RMDir "$SMPROGRAMS\חרוזים"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${APP_DIR_REGKEY}"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
