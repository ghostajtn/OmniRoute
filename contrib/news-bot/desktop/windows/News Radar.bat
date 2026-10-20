@echo off
setlocal
title News Radar - keep this window open (you can minimise it)
set "NR_HOME=%LOCALAPPDATA%\NewsRadar"
set "NR_SRC=%~dp0program"
if not exist "%NR_SRC%\windows\setup.ps1" (
  echo This file must stay in its folder, next to the "program" folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%NR_SRC%\windows\setup.ps1" -Source "%NR_SRC%" -Target "%NR_HOME%"
if errorlevel 1 (
  echo.
  echo News Radar could not be set up. Please read the message above.
  pause
  exit /b 1
)
set "NEWS_RADAR_HOME=%NR_HOME%\data"
"%NR_HOME%\node\node.exe" "%NR_HOME%\program\desktop\server.mjs"
if errorlevel 1 (
  echo.
  echo News Radar stopped. Please read the message above.
  pause
)
