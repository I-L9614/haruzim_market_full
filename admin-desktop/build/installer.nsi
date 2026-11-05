!define APP_NAME "Haruzim Admin"
!define APP_VERSION "1.0.2"
!define APP_PUBLISHER "Haruzim Market"
!define APP_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\HaruzimAdmin.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\HaruzimAdmin"

Unicode true
SetCompressor zlib

Name "${APP_NAME}"
OutFile "Haruzim-Admin-Setup-1.0.2.exe"
Icon "icon.ico"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
RequestExecutionLevel user
ShowInstDetails show
ShowUnInstDetails show

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "app\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\חרוזים"
  CreateShortcut "$SMPROGRAMS\חרוזים\חרוזים - ניהול.lnk" "$INSTDIR\Haruzim Admin.exe" "" "$INSTDIR\Haruzim Admin.exe" 0
  CreateShortcut "$SMPROGRAMS\חרוזים\הסר התקנה.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\חרוזים - ניהול.lnk" "$INSTDIR\Haruzim Admin.exe" "" "$INSTDIR\Haruzim Admin.exe" 0

  WriteRegStr HKCU "${APP_DIR_REGKEY}" "" "$INSTDIR\Haruzim Admin.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "חרוזים - ניהול"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Haruzim Admin.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\חרוזים - ניהול.lnk"
  Delete "$SMPROGRAMS\חרוזים\חרוזים - ניהול.lnk"
  Delete "$SMPROGRAMS\חרוזים\הסר התקנה.lnk"
  RMDir "$SMPROGRAMS\חרוזים"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${APP_DIR_REGKEY}"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
