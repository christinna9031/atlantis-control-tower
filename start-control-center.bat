@echo off
title Atlantis Control Tower
cd /d "%~dp0"
start "" /MIN cmd /c "node src/server.js"
timeout /t 3 /nobreak >nul
start http://localhost:9900
