@echo off
set /p TELEGRAM_TOKEN=Token gir:
set /p TELEGRAM_CHAT_ID=Chat ID gir:
set TELEGRAM_TOKEN=%TELEGRAM_TOKEN%
set TELEGRAM_CHAT_ID=%TELEGRAM_CHAT_ID%
node telegram-bot.js
pause
