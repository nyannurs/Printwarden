"""Development server: static files with caching disabled, so edits show up on reload."""

import http.server
import pathlib
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript"}

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_PUT(self) -> None:
        """A test page saved from the browser (the client viewer's HTML, built in the app):
        into _testfiles/ only, by its bare name."""
        name = pathlib.PurePosixPath(self.path).name
        if not self.path.startswith("/_testfiles/") or not name or "/" in name or name.startswith("."):
            self.send_error(403)
            return
        length = int(self.headers.get("Content-Length", "0"))
        target = pathlib.Path("_testfiles") / name
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(self.rfile.read(length))
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler).serve_forever()
