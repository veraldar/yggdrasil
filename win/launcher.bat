@echo off
REM launcher.bat - Veraldar: starts this PC's root inside WSL and keeps WSL awake while it runs.
REM No questions, no window: keepalive.vbs runs it hidden at every logon (Startup: "Veraldar") and once
REM right after the phone approved the join. It reads the distribution and the Linux user from wsl.ini
REM (written by the installer) and runs the root's bin/start --hold there: the services start if they
REM are not running, then it stays (Windows stops an idle WSL, and the root with it). Before a join: exit 2.
setlocal EnableExtensions
set "APPDIR=%~dp0"
set "DISTRO="
set "LUSER="
if not exist "%APPDIR%wsl.ini" exit /b 2
for /f "usebackq eol=[ tokens=1,* delims==" %%A in ("%APPDIR%wsl.ini") do (
  if /i "%%A"=="distro" set "DISTRO=%%B"
  if /i "%%A"=="user" set "LUSER=%%B"
)
if not defined DISTRO exit /b 2
if not defined LUSER exit /b 2
REM a 32-bit cmd (started by a 32-bit wscript) sees System32\wsl.exe only as Sysnative
set "WSL=%SystemRoot%\System32\wsl.exe"
if exist "%SystemRoot%\Sysnative\wsl.exe" set "WSL=%SystemRoot%\Sysnative\wsl.exe"
"%WSL%" -d %DISTRO% -u %LUSER% -e sh -c "s=$HOME/.local/share/yggdrasil-root/bin/start; [ -x $s ] && exec $s --hold"
exit /b %ERRORLEVEL%
