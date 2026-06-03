@echo off
setlocal
cd /d "%~dp0"
set "NODE_OPTIONS=--max-old-space-size=8192"
set "LOAD_LEGACY_INDEX=0"
set "PDF_IMPORT_PAGE_CONCURRENCY=1"
set "QR_IMPORT_ITEM_CONCURRENCY_MIN=2"
set "QR_IMPORT_ITEM_CONCURRENCY=16"
set "IMPORT_MEMORY_CHECK_MS=1500"
set "RUNTIME_NODE_MODULES=C:\Users\HUAWEI\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
set "RUNTIME_NODE=C:\Users\HUAWEI\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE_CMD=node"
) else (
  set "NODE_CMD=%RUNTIME_NODE%"
)

if exist "%RUNTIME_NODE_MODULES%" (
  set "NODE_PATH=%RUNTIME_NODE_MODULES%"
  for /d %%D in ("%RUNTIME_NODE_MODULES%\.pnpm\sharp@*") do call set "NODE_PATH=%%NODE_PATH%%;%%D\node_modules"
  for /d %%D in ("%RUNTIME_NODE_MODULES%\.pnpm\detect-libc@*") do call set "NODE_PATH=%%NODE_PATH%%;%%D\node_modules"
  for /d %%D in ("%RUNTIME_NODE_MODULES%\.pnpm\semver@*") do call set "NODE_PATH=%%NODE_PATH%%;%%D\node_modules"
  for /d %%D in ("%RUNTIME_NODE_MODULES%\.pnpm\pdfjs-dist@*") do call set "NODE_PATH=%%NODE_PATH%%;%%D\node_modules"
  for /d %%D in ("%RUNTIME_NODE_MODULES%\.pnpm\@napi-rs+canvas@*") do call set "NODE_PATH=%%NODE_PATH%%;%%D\node_modules"
  for /d %%D in ("%RUNTIME_NODE_MODULES%\.pnpm\@napi-rs+canvas-win32-x64-msvc@*") do call set "NODE_PATH=%%NODE_PATH%%;%%D\node_modules"
)

"%NODE_CMD%" "%~dp0server.js"
pause
