#!/bin/bash
# Builds the portable macOS app (Apple Silicon and Intel). Must run on a Mac.
# Output goes to _build/dist:
#   Printwarden <version> macOS.zip  - send this one (unzip, then open Printwarden.app)
#   mac-universal/Printwarden.app    - the same app, unzipped
cd "$(dirname "$0")" || exit 1
# node_modules from another computer (e.g. copied from Windows) holds the wrong Electron.
if [ -d node_modules ] && [ ! -d node_modules/electron/dist/Electron.app ]; then
  echo "Removing dependencies installed for another system..."
  rm -rf node_modules
fi
echo "Installing dependencies..."
npm install || { echo "The build failed. Is Node.js installed? See README.txt."; read -r; exit 1; }
echo "Building..."
npm run build:mac || { echo "The build failed. See the messages above."; read -r; exit 1; }
echo
echo "Done. Send the .zip in _build/dist; mac-universal holds the same app, unzipped."
open dist
