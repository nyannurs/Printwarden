# Printwarden documentation

These pages describe every part of Printwarden. The user guide covers what the app does and how to use it. The other chapters cover how it works inside: what each part of the code is for, the decisions behind it, and how it is tested and built.

They are written for two readers:
- **Print designers** who want to know exactly what the app shows them and how far to trust it.
- **Programmers** who want to change it.

Print terms are explained in the glossary. Where a page names a file, the path is from the repository's root.

## Chapters

| Chapter | What it covers |
|---|---|
| [User guide](user-guide.md) | Every window, panel, dialog and control, from importing a PDF to exporting. |
| [How it works](how-it-works.md) | The big picture: the four layers, what happens when a PDF is opened, and the rules the code keeps. |
| [Print arithmetic](core.md) | Page pairing, binding rules, imposition and folding schemes, creep, spine width, paper, and every Preflight check (`app/core/`). |
| [PDFs](pdf.md) | Reading PDFs, rendering pages in background threads, color management and overprint, and writing the imposed PDF (`app/pdf/`, `app/impose/`). |
| [The 3D book](3d-view.md) | How each sheet lies, bends and turns, how every binding is built, how pages stay sharp, shadows, the camera, screenshots and videos (`app/viewer/`). |
| [The interface](interface.md) | The window's code: state, the side panel, the timeline, dialogs, page images, the performance check (`app/ui/`). |
| [The client viewer](client-viewer.md) | The HTML file you send a client: what goes in it, how it starts, and what it shares with the app (`app/client/`, `app/ui/client.js`). |
| [The desktop app](desktop-app.md) | The Electron shell, what the app may touch, the update check, building and releasing (`_build/`). |
| [Testing](testing.md) | The test suite, the development tools and the test documents (`tests/`, `tools/`). |
| [Glossary](glossary.md) | Print and code terms used in these pages. |

## Where else to look

- [`README.md`](../README.md): the short introduction, download and first start.
- [`CREDITS.md`](../CREDITS.md): every outside project Printwarden includes, with its license.
- [`_build/README.txt`](../_build/README.txt): building the desktop app step by step.
- The code itself: nearly every function starts with a comment saying what it does and why. Where a choice was measured, the comment gives the measurement.
