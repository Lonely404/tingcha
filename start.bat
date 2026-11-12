@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8000"
set "PY="

where python >nul 2>nul
if not errorlevel 1 set "PY=python"

if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py"
)

if not defined PY (
  echo.
  echo  [ERROR] Python not found.
  echo.
  echo  Option A: install Python 3  https://www.python.org/downloads/
  echo  Option B: if you have Node.js, run:  npx serve .
  echo.
  echo  Why you cannot just double-click index.html:
  echo  browsers block ES modules on file:// ^(origin is null^),
  echo  so js/main.js never runs and the page stays half-rendered.
  echo.
  pause
  exit /b 1
)

echo.
echo   Ting Cha - local preview
echo   -----------------------------------------
echo   URL : http://localhost:%PORT%/index.html
echo   Stop: close the minimized server window
echo.
echo   Do NOT open index.html by double-clicking.
echo   Browsers block ES modules on file:// - the page will be empty.
echo.

start "TingCha local server" /min %PY% -m http.server %PORT% --bind 127.0.0.1
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:%PORT%/index.html"

echo   Server is starting in a minimized window.
echo   Browser will open automatically in 2 seconds.
echo.
pause
