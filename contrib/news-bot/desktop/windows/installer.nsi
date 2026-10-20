; News Radar for Windows: a normal Setup.exe (no administrator rights needed).
; Build it with build_installer.py, which prepares the folder passed as STAGE.

Unicode true
!include "MUI2.nsh"

!ifndef STAGE
  !error "Build this with build_installer.py (it passes -DSTAGE and -DOUTFILE)."
!endif
!ifndef VERSION
  !define VERSION "1.0.0"
!endif

!define APPNAME "News Radar"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewsRadar"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\NewsRadar" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT license"

!define MUI_ICON "${STAGE}\news-radar.ico"
!define MUI_UNICON "${STAGE}\news-radar.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APPNAME}"
!define MUI_WELCOMEPAGE_TEXT "${APPNAME} is a news app that runs on your computer: breaking news, what Trump and the Fed say, live market prices, your own stocks and what could happen next.$\r$\n$\r$\nIt needs no account. Click Install to continue."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APPNAME} now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchApp
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\News Radar.vbs"'
FunctionEnd

; Stops a running News Radar so its files can be replaced. Only the node.exe that lives in
; this program's own folder is stopped, never anyone else's.
!macro StopRunning
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq '$INSTDIR\node\node.exe' } | Stop-Process -Force"`
  Pop $0
!macroend

Section "Install"
  !insertmacro StopRunning
  RMDir /r "$INSTDIR\program"

  SetOutPath "$INSTDIR"
  File "${STAGE}\News Radar.vbs"
  File "${STAGE}\news-radar.ico"

  SetOutPath "$INSTDIR\node"
  File "${STAGE}\node\node.exe"
  File "${STAGE}\node\LICENSE"

  SetOutPath "$INSTDIR\program"
  File /r "${STAGE}\program\*.*"

  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\News Radar.vbs"' "$INSTDIR\news-radar.ico" 0
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\News Radar.vbs"' "$INSTDIR\news-radar.ico" 0

  WriteRegStr HKCU "Software\NewsRadar" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "News Radar"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\news-radar.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  !insertmacro StopRunning

  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"

  ; Only what the installer put here is removed, then the folder if it is empty.
  RMDir /r "$INSTDIR\program"
  RMDir /r "$INSTDIR\node"
  Delete "$INSTDIR\News Radar.vbs"
  Delete "$INSTDIR\news-radar.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "Software\NewsRadar"

  IfSilent keepData
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your News Radar settings and saved news?" IDNO keepData
  RMDir /r "$LOCALAPPDATA\NewsRadar"
  keepData:
SectionEnd
