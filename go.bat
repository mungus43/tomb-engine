@echo off
REM Auto-loop launcher for build.ps1.
REM Used by Cowork to fire rebuilds without typing into PowerShell.
cd /D "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
echo.
echo === go.bat: build.ps1 finished, exit code %ERRORLEVEL% ===
pause
