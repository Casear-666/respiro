@echo off
setlocal
cd /d "%~dp0EC"
if exist "release\win-unpacked\精力日历.exe" (
  start "" "release\win-unpacked\精力日历.exe"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 release 目录中的 EnergyCalendar-2.0.1-Setup.exe。
  echo 开发启动需要 Node 24 或更高版本。
  pause
  exit /b 1
)
echo 正在打开精力日历桌面版……
call npm run desktop
if errorlevel 1 pause
