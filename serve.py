from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
root=Path(__file__).resolve().parents[1]
os.chdir(root)
print('Render360 V30: http://127.0.0.1:8080/')
ThreadingHTTPServer(('0.0.0.0',8080),SimpleHTTPRequestHandler).serve_forever()
