@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 英语写作批改老师

if "%PORT%"=="" set PORT=6801
set "URL=http://127.0.0.1:%PORT%"

echo.
echo   英语写作批改老师
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [x] 没有找到 Node.js。
  echo       请先安装 Node.js 20.11 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem 端口已被占用说明服务已经在跑，直接打开页面即可
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{exit 1}"
if not errorlevel 1 (
  echo   [i] 服务已经在运行，直接打开页面。
  echo       地址：%URL%
  if not defined EWC_NO_BROWSER start "" "%URL%"
  echo.
  echo       想重启的话：先关掉原来那个窗口，或结束 node.exe 进程。
  echo.
  ping -n 6 127.0.0.1 >nul
  exit /b 0
)

echo   [i] 正在启动服务，稍等会自动打开浏览器...
echo       地址：%URL%
echo       停止：在这个窗口按 Ctrl + C
echo.

rem 延后 2 秒再开浏览器，避免页面比服务先就绪
if not defined EWC_NO_BROWSER start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"

node server.mjs

echo.
echo   服务已停止。
pause
