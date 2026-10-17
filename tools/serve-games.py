#!/usr/bin/env python3
"""Serve your own game files from the Mac to the Render360 iOS app over Wi-Fi.

    python3 tools/serve-games.py "/Volumes/EXTERNAL HD/Render360-games" [--port 8360] [--token SECRET]

The app's Import > "From my Mac" lists /games.json and downloads files with
HTTP Range requests, so an interrupted download resumes where it stopped.

* Read-only: GET/HEAD only, nothing outside the served folder (no symlink or
  ".." escapes), no directory listings except the JSON catalogue.
* Optional --token: the app must send it as ?token= or the X-Render360-Token
  header (prints a URL with the token to paste into the app).
* Game files never go into git: serve them from a folder outside the repo.

Catalogue format (/games.json): {"games":[{"id","title","discs":[{"name","path","size"}]}]}
A game is a sub-folder (its files are its discs, sorted by name: Watch Dogs
Disc 1, Disc 2) or a single file at the top level.
"""
import argparse
import hashlib
import http.server
import json
import os
import socket
import socketserver
import sys
import urllib.parse

GAME_EXTENSIONS = {".iso", ".xex", ".god", ".stfs", ".con", ".live", ""}
CHUNK = 1 << 20


def is_game_file(name):
    if name.startswith("."):
        return False
    ext = os.path.splitext(name)[1].lower()
    # STFS packages are usually extension-less 42-hex-digit names (Banjo).
    return ext in GAME_EXTENSIONS or ext in {".bin", ".img"}


def catalogue(root):
    games = []
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if name.startswith("."):
            continue
        if os.path.isdir(full):
            discs = []
            for disc in sorted(os.listdir(full)):
                path = os.path.join(full, disc)
                if os.path.isfile(path) and is_game_file(disc):
                    discs.append({"name": disc, "path": f"{name}/{disc}", "size": os.path.getsize(path)})
            if discs:
                games.append({"id": hashlib.sha1(name.encode()).hexdigest()[:12], "title": name, "discs": discs})
        elif os.path.isfile(full) and is_game_file(name):
            games.append({"id": hashlib.sha1(name.encode()).hexdigest()[:12], "title": name,
                          "discs": [{"name": name, "path": name, "size": os.path.getsize(full)}]})
    return {"games": games}


class Handler(http.server.BaseHTTPRequestHandler):
    root = "."
    token = None
    server_version = "Render360GameServer/1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def authorized(self, query):
        if not self.token:
            return True
        supplied = self.headers.get("X-Render360-Token") or query.get("token", [None])[0]
        return supplied == self.token

    def resolve(self, rel):
        rel = urllib.parse.unquote(rel).lstrip("/")
        path = os.path.realpath(os.path.join(self.root, rel))
        if path != self.root and not path.startswith(self.root + os.sep):
            return None
        return path if os.path.isfile(path) else None

    def do_HEAD(self):
        self.handle_request(head=True)

    def do_GET(self):
        self.handle_request(head=False)

    def handle_request(self, head):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        if not self.authorized(query):
            self.send_error(403, "token required")
            return
        if url.path == "/games.json":
            body = json.dumps(catalogue(self.root)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return
        if not url.path.startswith("/files/"):
            self.send_error(404)
            return
        path = self.resolve(url.path[len("/files/"):])
        if not path:
            self.send_error(404)
            return
        size = os.path.getsize(path)
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng:
            try:
                unit, spec = rng.split("=", 1)
                first, last = spec.split(",")[0].split("-")
                if unit.strip() != "bytes":
                    raise ValueError
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                else:  # suffix range: last N bytes
                    start = max(0, size - int(last))
                if start > end or start >= size:
                    raise ValueError
                end = min(end, size - 1)
                status = 206
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        stat = os.stat(path)
        self.send_header("ETag", '"%x-%x"' % (stat.st_size, int(stat.st_mtime)))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            try:
                while remaining:
                    data = f.read(min(CHUNK, remaining))
                    if not data:
                        break
                    self.wfile.write(data)
                    remaining -= len(data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the app paused/cancelled; it resumes with a Range request


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_address():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", help="folder with your game files (outside any git repository)")
    parser.add_argument("--port", type=int, default=8360)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--token", default=None, help="require this token from the app")
    args = parser.parse_args()
    root = os.path.realpath(args.folder)
    if not os.path.isdir(root):
        parser.error(f"{root} is not a folder")
    probe = root
    while probe != os.path.dirname(probe):
        if os.path.isdir(os.path.join(probe, ".git")):
            print(f"warning: {root} is inside a git repository ({probe}); keep game files out of git", file=sys.stderr)
            break
        probe = os.path.dirname(probe)
    Handler.root = root
    Handler.token = args.token
    games = catalogue(root)["games"]
    url = f"http://{lan_address()}:{args.port}"
    print(f"Serving {len(games)} game(s) from {root}")
    print(f"In the app: Import > From my Mac > {url}" + (f"  (token {args.token})" if args.token else ""))
    Server((args.bind, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
