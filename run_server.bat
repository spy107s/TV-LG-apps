@echo off
title Family TV App Server
echo ======================================================
echo           FAMILY TV - LOCAL WEB SERVER
echo ======================================================
echo.
echo  1. Truong hop test tren PC:
echo     Mo trinh duyet va truy cap: http://localhost:8000
echo.
echo  2. Truong hop chay tren TV LG:
echo     Dam bao TV va PC ket noi chung mang Wi-Fi.
echo     Xem dia chi IP cua PC (VD: 192.168.1.5) va truy cap
echo     tren TV browser: http://192.168.1.5:8000
echo.
echo ======================================================
echo.
echo Dang khoi dong server (Lắng nghe trên toàn bộ cổng mạng)...
npx -y http-server ./ -a 0.0.0.0 -p 8000 -c-1
pause
