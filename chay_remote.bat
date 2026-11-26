@echo off
title LG TV Magic Remote Launcher
chcp 65001 >nul
cd /d "%~dp0remote-app"
call start_remote.bat
