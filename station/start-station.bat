@echo off
rem DCC counting station for Windows. Double-click this file to start it.
rem Needs Node.js and FFmpeg:  winget install OpenJS.NodeJS.LTS Gyan.FFmpeg
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Open PowerShell and run: winget install OpenJS.NodeJS.LTS & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo FFmpeg is not installed. Open PowerShell and run: winget install Gyan.FFmpeg & pause & exit /b 1)
if not exist node_modules\onnxruntime-node (
  echo Installing the detector, one time only...
  call npm install --ignore-scripts || (pause & exit /b 1)
)
if not exist config.json (
  copy config.example.json config.json >nul
  echo Created config.json. Put the camera's stream link in "url", save, then start this file again.
  notepad config.json
  exit /b 0
)
echo.
echo Station page: http://localhost:8090   (from a phone on the same Wi-Fi: http://THIS-PC-ADDRESS:8090)
echo Leave this window open; closing it stops counting.
echo.
node station.mjs config.json
pause
