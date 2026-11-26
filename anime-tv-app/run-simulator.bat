@echo off
chcp 65001 >nul
title Anime47 TV - webOS TV 6.0 Simulator
cd /d "%~dp0"
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" "%~dp0run-simulator.js"
) else (
  node "%~dp0run-simulator.js"
)
pause
