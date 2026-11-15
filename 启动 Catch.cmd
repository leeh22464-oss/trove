@echo off
chcp 65001 >nul
cd /d %~dp0
title Catch - 本地收集库
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 node，请先安装 Node.js
  pause
  exit /b 1
)
if not defined PORT set PORT=5173
start "" http://127.0.0.1:%PORT%
node --disable-warning=ExperimentalWarning src\server.js
pause
