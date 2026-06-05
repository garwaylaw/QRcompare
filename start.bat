@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_OPTIONS=--max-old-space-size=8192"
set "LOAD_LEGACY_INDEX=0"
set "PDF_IMPORT_PAGE_CONCURRENCY=1"
set "QR_IMPORT_ITEM_CONCURRENCY_MIN=2"
set "QR_IMPORT_ITEM_CONCURRENCY=16"
set "IMPORT_MEMORY_CHECK_MS=1500"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。
  echo 请先安装 Node.js 24 或较新的稳定版本，然后重新运行 start.bat。
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm。
  echo 请确认 Node.js 安装完整，并重新打开命令行或重新运行 start.bat。
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\sharp\package.json" goto missing_deps
if not exist "%~dp0node_modules\pdfjs-dist\package.json" goto missing_deps
if not exist "%~dp0node_modules\@napi-rs\canvas\package.json" goto missing_deps

node "%~dp0server.js"
pause
exit /b %errorlevel%

:missing_deps
echo 项目依赖尚未安装或不完整。
echo.
echo 请在当前项目目录执行：
echo   npm install
echo.
echo 安装完成后再双击 start.bat 启动。
pause
exit /b 1
