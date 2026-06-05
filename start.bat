@echo off
setlocal
cd /d "%~dp0"

set "NODE_OPTIONS=--max-old-space-size=8192"
set "LOAD_LEGACY_INDEX=0"
set "PDF_IMPORT_PAGE_CONCURRENCY=1"
set "QR_IMPORT_ITEM_CONCURRENCY_MIN=2"
set "QR_IMPORT_ITEM_CONCURRENCY=16"
set "IMPORT_MEMORY_CHECK_MS=1500"

where node >nul 2>nul
if errorlevel 1 goto missing_node

where npm >nul 2>nul
if errorlevel 1 goto missing_npm

if not exist "%~dp0node_modules\sharp\package.json" goto missing_deps
if not exist "%~dp0node_modules\pdfjs-dist\package.json" goto missing_deps
if not exist "%~dp0node_modules\@napi-rs\canvas\package.json" goto missing_deps

node "%~dp0server.js"
pause
exit /b %errorlevel%

:missing_node
echo Node.js was not found.
echo Install Node.js 20 or newer, then run start.bat again.
pause
exit /b 1

:missing_npm
echo npm was not found.
echo Reinstall Node.js or reopen this command window, then run start.bat again.
pause
exit /b 1

:missing_deps
echo Project dependencies are missing or incomplete.
echo.
echo Run this command in the project folder:
echo   npm install
echo.
echo After installation, run start.bat again.
pause
exit /b 1
