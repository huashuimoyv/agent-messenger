@echo off
setlocal
cd /d "%~dp0"

netstat -ano | findstr ":3721" >nul
if %errorlevel% neq 0 (
    start "" /b node --disable-warning=ExperimentalWarning "%~dp0scripts\dashboard.mjs"
    timeout /t 1 /nobreak >nul
)

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://127.0.0.1:3721/ --window-size=1280,850
