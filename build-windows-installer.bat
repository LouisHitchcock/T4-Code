@echo off
setlocal

cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo [build-windows-installer] Bun was not found on PATH.
  echo Install Bun first, then rerun this script from the repo root.
  exit /b 1
)

echo [build-windows-installer] Building the Windows desktop app and NSIS installer...

if "%~1"=="" (
  call bun run dist:desktop:win
) else (
  call bun run dist:desktop:win -- %*
)

if errorlevel 1 (
  echo [build-windows-installer] Build failed.
  exit /b %errorlevel%
)

echo [build-windows-installer] Build finished.
echo [build-windows-installer] Release artifacts: "%CD%\release"
exit /b 0
