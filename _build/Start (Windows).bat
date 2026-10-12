@echo off
rem Runs the app straight from the source files, without building. First run installs
rem what it needs (a few minutes). Close this window to quit the app.
cd /d "%~dp0"
rem node_modules from another computer (e.g. copied from a Mac) holds the wrong Electron.
if exist node_modules if not exist node_modules\electron\dist\electron.exe (
  echo Removing dependencies installed for another system...
  rmdir /s /q node_modules
)
if not exist node_modules (
  echo Installing dependencies, this happens once...
  call npm install || goto :fail
)
call npm start
exit /b 0
:fail
echo.
echo Something went wrong. Is Node.js installed? See README.txt.
pause
exit /b 1
