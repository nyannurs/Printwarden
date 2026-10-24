<p align="center"><img src="docs/logo.png" alt="Printwarden"></p>

![Screenshot](docs/screenshot.png)

## AI Disclaimer

This software is built by iterating with Claude Code. I did not write a single line of code, but I did architect the workflows based on my own experience as a print designer, tested everything I could against my own projects, and designed the visual identity, icons and UI myself. That much is human.

## What is Printwarden?

Printwarden lets you import your publication PDF, where it will build a 3D preview for you to interactively navigate through. You can pick the binding type, cover/spine art, paper color and finish to "recreate" your publication digitally. After you recreate your publication digitally, you can export it as a HTML file to send to your client. They can then open it with any conventional browser to receive a self-contained preview of the publication exactly as you constructed it (or you can host the HTML file on your website and send a link instead). Printwarden also lets you impose your PDF: 2 sheets a side, 8 pages a sheet/2 folds and 16 pages a sheet/3 folds. You can then re-import the imposed PDF and visually check that everything is right where it's supposed to be.

## Installation

Download the macOS or Windows build from the Releases page. macOS users should unzip the downloaded zip file and move the app to the Applications folder. The macOS build works both on Apple Silicon and Intel machines.

I don't sign the builds, so Windows and macOS will complain the first time you open the app:

- **Windows**: click "More info", then "Run anyway".
- **macOS**: open the app once and close the warning. macOS will not allow you to open it right away, you need to allow it in System Settings > Privacy & Security.

If you'd rather not do that, you can run it from the source instead.

## Running from the source

1. Install Node.js (the LTS version) from <https://nodejs.org>.
2. Download or clone this repository.
3. On Windows, double-click `_build/Start (Windows).bat`. On a Mac, double-click `_build/Start (macOS).command`. If macOS won't run it, run `chmod +x` on the file once in Terminal.

The first start downloads Electron, which is a few hundred MB. If you want to build the app yourself, have a look at [`_build/README.txt`](_build/README.txt).

## Features

- **Importing a PDF**: Printwarden automatically detects your imported PDF and adjusts page size, bleed and slug accordingly (you can modify these after importing).
- **Cover/Spine art**: In addition to importing a publication PDF you can also import a cover art or spine art PDF. One spread with the spine (and flaps if present), and an optional inside spread. Printwarden will take the spine width from it and render the flaps folded in.
- **Different bindings**: Staple, perfect, sewn, hardcover, spiral and wire-o binding.
- **Paper settings**: Color, finish and weight, set separately for the pages and cover.
- **Spot finish**: Gold, silver or copper foil and spot UV. Must be imported separately.
- **Process plate separation**: You can manually toggle process plates on and off to check overprint for example.
- **Preflight**: Any uncertainties that can be automatically detected will be reported to you in the right-side panel.
- **Imposition**: You can export an imposed PDF with creep compensation as 2 sheets a side, 8 pages a sheet/2 folds or 16 pages a sheet/3 folds.
- **Self-contained HTML**: Printwarden can export your publication as a self-contained HTML file for viewing without having to install the program (by either sharing the HTML file or uploading it somewhere that serves HTML files).
- **Screenshots and videos**: You can render screenshots or a flipbook animation of your publication in various resolutions.

## Controls

- **Drag**: turn the book (it springs back when you let go)
- **Space + drag**: move the view (the view will be unlocked)
- **Press space twice**: reset the view
- **Mouse wheel**: zoom
- **Click a page**: turn the page

## Color profiles

Printwarden comes with ISO Coated v2 (ECI) and uses it by default. It's included with kind permission of the European Color Initiative (Copyright 2026 by European Color Initiative, [www.eci.org](https://www.eci.org)) and isn't covered by Printwarden's license. If your PDF has an output intent (PDF/X), that one is used instead.

## Scope

I have not been able to conceive a clean method to implement things like gatefold/foldout pages, concertina folds, non-standard formats, special features, or anything related to special-format pages. Feel free to PR.

## Documentation

Everything Printwarden does, and how it works inside, is described in [`docs/`](docs/README.md): a user guide covering every panel and dialog, and chapters on the print arithmetic, the PDF handling, the 3D book, the interface, the client viewer, the desktop app and the tests.

## Credits

All the projects Printwarden uses code from are listed in [`CREDITS.md`](CREDITS.md). You can also find their licenses in the app under About > Licenses.

## License

Printwarden is licensed under the GNU Affero General Public License, version 3 or later (see `LICENSE` and `NOTICE`). Releases 1.0.0 and 1.0.1 were under the Apache License 2.0. The third-party code it includes keeps its own licenses, which are listed in `CREDITS.md`.

The release builds include FFmpeg 9.0.2 for ProRes video. It's compiled from the official source with only the parts Printwarden needs and nothing under the GPL, so it's licensed under the LGPL 2.1 or later. Printwarden runs it as a separate program and doesn't modify it. Its license and build notes sit next to it, and the FFmpeg source is attached to each release. FFmpeg is a trademark of Fabrice Bellard. Printwarden is not affiliated with the FFmpeg project.
