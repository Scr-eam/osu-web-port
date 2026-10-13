"""Serves the web port on http://localhost:8080 with caching turned off.

Python's plain http.server sends no cache headers, so a browser may keep using old copies of the
scripts after the files are replaced, and run an older build than the one on disk. This server tells
the browser not to keep anything, so a reload always runs the files in this folder. It also gives
.js and .wasm their proper types (Windows can map .js to text/plain, which browsers refuse for modules).

Usage: python serve.py [port]
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    here = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=here)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving {here} on http://localhost:{port} (no caching). Ctrl+C to stop.")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
