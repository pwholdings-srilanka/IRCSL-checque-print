@echo off
title IRSCL - Cheque Printer
cd /d "%~dp0"
echo ========================================================
echo  IRSCL
echo  Cheque & Voucher Print System
echo  Starting local server on http://localhost:8888 ...
echo ========================================================
start "" "http://localhost:8888"
node --env-file-if-exists=.env server.js
pause

