@echo off
title PokéProfit Server

echo.
echo  ================================================
echo   PokéProfit — Live EV Server (TCGCSV edition)
echo   No API key required!
echo  ================================================
echo.

REM Install dependencies if node_modules is missing
if not exist "%~dp0node_modules" (
  echo  Installing dependencies (first run only)...
  echo.
  call npm install
  echo.
)

echo  Starting server...
echo  Keep this window open while using the calculator.
echo.
node "%~dp0server.js"

pause
