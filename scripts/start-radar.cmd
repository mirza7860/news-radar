@echo off
REM The actual server process. start-hidden.vbs runs this with no window.
REM Running this file directly is the same as `npm start`, just with a log file.
cd /d "%~dp0.."
node server\index.js > radar.log 2>&1
