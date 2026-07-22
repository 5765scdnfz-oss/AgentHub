@echo off
chcp 65001 >nul
title AgentHub
echo.
echo   AgentHub starting...
echo.
cd /d "%~dp0"
start http://localhost:3456
node server.js
pause
