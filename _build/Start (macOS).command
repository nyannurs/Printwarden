#!/bin/bash
# Runs the app straight from the source files, without building.
cd "$(dirname "$0")" || exit 1
# node_modules from another computer (e.g. copied from Windows) holds the wrong Electron.
if [ -d node_modules ] && [ ! -d node_modules/electron/dist/Electron.app ]; then
  echo "Removing dependencies installed for another system..."
  rm -rf node_modules
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies, this happens once..."
  npm install || { echo "Something went wrong. Is Node.js installed? See README.txt."; read -r; exit 1; }
fi
npm start
