@echo off
setlocal
title Tool Findy - Local Tool Inventory
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0server.cjs"
if errorlevel 1 (
  echo.
  echo Tool Findy stopped because of the error above.
  pause
)
