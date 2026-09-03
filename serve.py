from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

class Render360Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required for SharedArrayBuffer / Wasm threads in local development.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

print("Render360 isolated dev server: http://127.0.0.1:8080/")
ThreadingHTTPServer(("0.0.0.0", 8080), Render360Handler).serve_forever()
