@echo off
title LG TV Magic Remote Server
chcp 65001 >nul
cd /d "%~dp0"

echo ======================================================
echo       LG TV MAGIC REMOTE - WEB APP SERVER
echo ======================================================
echo.
echo  * THÔNG TIN KẾT NỐI:
echo    - Cấu hình IP/MAC TV trong remote-app\config.json hoặc trực tiếp trên web UI
echo.
echo  1. Mở trên máy tính này:
echo     http://localhost:5000
echo.
echo  2. Mở trên điện thoại (kết nối cùng Wi-Fi):
echo     http://<IP-MAY-TINH>:5000
echo.
echo  * Lần đầu kết nối, hãy bấm "Cho phép" (Accept) trên màn hình TV!
echo ======================================================
echo.
echo Đang khởi động máy chủ...
node server.js
pause
