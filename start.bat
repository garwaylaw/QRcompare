@echo off
setlocal
cd /d "%~dp0"

set "NODE_OPTIONS=--max-old-space-size=8192"
set "HOST=0.0.0.0"
set "PORT=8787"
set "LOAD_LEGACY_INDEX=0"
set "SEARCH_CONCURRENCY=1"
set "UPLOAD_RETENTION_HOURS=168"
set "PDF_IMPORT_PAGE_CONCURRENCY=1"
set "QR_IMPORT_ITEM_CONCURRENCY_MIN=2"
set "QR_IMPORT_ITEM_CONCURRENCY=16"
set "IMPORT_MEMORY_CHECK_MS=1500"
set "NODE_CMD=node"
set "NPM_CMD=npm"
set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%LOG_DIR%\start.log"
set "LAN_HOST=%COMPUTERNAME%"
if "%LAN_HOST%"=="" set "LAN_HOST=SERVER_IP"

if exist "C:\Program Files\nodejs\node.exe" (
  set "NODE_CMD=C:\Program Files\nodejs\node.exe"
  set "PATH=C:\Program Files\nodejs;%PATH%"
)
if exist "C:\Program Files\nodejs\npm.cmd" set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
echo QRcompare start log > "%LOG_FILE%"
echo Time: %date% %time% >> "%LOG_FILE%"
echo Project: %~dp0 >> "%LOG_FILE%"

call "%NODE_CMD%" -v >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
  ) else (
    goto missing_node
  )
)

call "%NPM_CMD%" -v >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\npm.cmd" (
    set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"
  ) else (
    goto missing_npm
  )
)

if not exist "%~dp0node_modules\sharp\package.json" goto missing_deps
if not exist "%~dp0node_modules\pdfjs-dist\package.json" goto missing_deps
if not exist "%~dp0node_modules\@napi-rs\canvas\package.json" goto missing_deps

call "%NODE_CMD%" -v >> "%LOG_FILE%" 2>&1
echo Starting QRcompare. If this window closes, open logs\start.log in the project folder.
echo.
echo Access URLs:
echo   Local: http://127.0.0.1:%PORT%
echo   LAN:   http://%LAN_HOST%:%PORT%
echo.
echo Keep this window open while using QRcompare.
echo Other computers in the company network should use the LAN URL.
echo If the LAN URL cannot be opened, use ipconfig to find this computer's IPv4 Address.
echo.
call "%NODE_CMD%" "%~dp0server.js" >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%errorlevel%"
echo.
echo QRcompare stopped. Exit code: %EXIT_CODE%
echo Last startup log:
type "%LOG_FILE%"
pause
exit /b %EXIT_CODE%

:missing_node
echo Node.js was not found.
echo Install Node.js 20 or newer, then run start.bat again.
echo Node.js was not found. >> "%LOG_FILE%"
pause
exit /b 1

:missing_npm
echo npm was not found.
echo Reinstall Node.js or reopen this command window, then run start.bat again.
echo npm was not found. >> "%LOG_FILE%"
pause
exit /b 1

:missing_deps
echo Project dependencies are missing or incomplete.
echo.
echo Run this command in the project folder:
echo   "%NPM_CMD%" install
echo.
echo After installation, run start.bat again.
echo Project dependencies are missing or incomplete. >> "%LOG_FILE%"
pause
exit /b 1
