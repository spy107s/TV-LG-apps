@echo off
chcp 65001 >nul
title Anime47 TV App Server
cd /d "%~dp0"
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" "%~dp0server.js"
) else (
  node "%~dp0server.js"
)
pause
