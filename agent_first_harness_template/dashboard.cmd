@echo off
REM Start the local agent dashboard and open it in the browser.
cd /d "%~dp0"
node harness\cli.mjs init >nul
start "" http://127.0.0.1:4317
node harness\server.mjs
