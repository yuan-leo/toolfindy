@echo off
setlocal
title Findry - Local Tool Inventory
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0server.cjs"
if errorlevel 1 (
  echo.
  echo Findry stopped because of the error above.
  pause
)
