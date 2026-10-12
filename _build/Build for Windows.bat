@echo off
rem Builds the portable Windows app. Output goes to _build\dist:
rem   Printwarden <version> Windows.zip  - send this one (unzip, then open Printwarden.exe)
rem   win-unpacked\                      - the same app, unzipped
cd /d "%~dp0"
rem node_modules from another computer (e.g. copied from a Mac) holds the wrong Electron.
if exist node_modules if not exist node_modules\electron\dist\electron.exe (
  echo Removing dependencies installed for another system...
  rmdir /s /q node_modules
)
echo Installing dependencies...
call npm install || goto :fail
echo Building...
call npm run build:win || goto :fail
echo.
echo Done. Send the .zip in _build\dist; win-unpacked is the same app, unzipped.
start "" "%~dp0dist"
pause
exit /b 0
:fail
echo.
echo The build failed. See the messages above, and README.txt.
pause
exit /b 1
