#!/usr/bin/env python3
"""Receive Render360 iOS telemetry on the Mac and show it at /status.

    python3 tools/telemetry-server.py [--port 8361] [--logs logs/phone]

In the app: Settings > Telemetry to the Mac > http://<mac-ip>:8361
The phone POSTs one JSON object per second to /telemetry?s=<session> and,
after a crash, its last breadcrumbs to /crash?s=<session>. This server keeps:
  logs/phone/telemetry_<session>.jsonl   every line (game FPS, speed, MIPS,
                                         interpreted %, memory, thermal...)
  logs/phone/crash_<session>_<time>.txt  breadcrumbs of a crashed session
and serves:
  GET /status        live page (polls /status.json)
  GET /status.json   the newest line
  GET /summary.json  per-session averages, 1% low, peak memory, lowest free memory
logs/ is git-ignored: telemetry names the game being played.
"""
import argparse
import http.server
import json
import os
import socketserver
import sys
import threading
import time
import urllib.parse

PAGE = """<!doctype html><meta charset=utf-8><title>Render360 iPhone</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 ui-monospace,Menlo,monospace;background:#0f1115;color:#e6e6e6;margin:24px}
h1{font:600 20px system-ui;margin:0 0 12px}td{padding:2px 14px 2px 0}.ok{color:#7ddc7d}.bad{color:#ff8a7a}</style>
<h1>Render360 · iPhone telemetry</h1><table id=t></table><p id=age></p>
<script>
const rows=[['game','Game'],['state','State'],['fps','Game FPS'],['fpsAvg','Average FPS (60 s)'],['low1','1% low'],
['stuttersPerMin','Stutters / min'],['speedPercent','Emulation speed %'],['mips','MIPS'],['interpretedPercent','Interpreted %'],
['guestInstructionsM','Guest instructions (M)'],['guestFrames','Guest frames'],['memFootprintMB','Memory used (MB)'],
['memAvailableMB','Memory free (MB)'],['memLowestAvailableMB','Lowest free (MB)'],['thermal','Thermal'],['battery','Battery'],
['jit','JIT available'],['signingDaysLeft','Signing days left'],['bar30','30 FPS bar']];
async function poll(){try{const s=await (await fetch('/status.json',{cache:'no-store'})).json();
const f=v=>typeof v==='number'?(Number.isInteger(v)?v:v.toFixed(1)):String(v);
document.getElementById('t').innerHTML=rows.map(([k,l])=>`<tr><td>${l}</td><td class=${k==='bar30'?(s[k]?'ok':'bad'):''}>${s[k]===undefined?'–':f(s[k])}</td></tr>`).join('');
document.getElementById('age').textContent=s.time?`updated ${Math.round(Date.now()/1000-s.time)} s ago · session ${s.session}`:'waiting for the phone…';}catch(e){}}
setInterval(poll,1000);poll();
</script>"""


class State:
    lock = threading.Lock()
    latest = {}
    sessions = {}  # session -> summary accumulators
    logs = "logs/phone"


def summarize(session, line):
    s = State.sessions.setdefault(session, {"lines": 0, "fps": [], "speed": [], "mips": [], "peakMemMB": 0,
                                            "lowestFreeMB": None, "game": "", "thermal": {}, "first": line.get("time"),
                                            "last": line.get("time")})
    s["lines"] += 1
    s["last"] = line.get("time")
    s["game"] = line.get("game") or s["game"]
    if line.get("state") == "running":
        for key, src in (("fps", "fps"), ("speed", "speedPercent"), ("mips", "mips")):
            if isinstance(line.get(src), (int, float)):
                s[key].append(line[src])
    s["peakMemMB"] = max(s["peakMemMB"], line.get("memFootprintMB") or 0)
    low = line.get("memLowestAvailableMB")
    if isinstance(low, (int, float)):
        s["lowestFreeMB"] = low if s["lowestFreeMB"] is None else min(s["lowestFreeMB"], low)
    t = line.get("thermal")
    if t:
        s["thermal"][t] = s["thermal"].get(t, 0) + 1


def report(s):
    def avg(v):
        return round(sum(v) / len(v), 2) if v else None
    fps = sorted(s["fps"])
    return {"game": s["game"], "seconds": s["lines"], "avgFps": avg(s["fps"]),
            "low1Fps": round(sum(fps[:max(1, len(fps) // 100)]) / max(1, len(fps) // 100), 2) if fps else None,
            "avgSpeedPercent": avg(s["speed"]), "avgMips": avg(s["mips"]), "peakMemMB": round(s["peakMemMB"]),
            "lowestFreeMB": s["lowestFreeMB"], "thermalSeconds": s["thermal"]}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        with State.lock:
            if path in ("/", "/status"):
                return self.send(200, PAGE, "text/html; charset=utf-8")
            if path == "/status.json":
                return self.send(200, json.dumps(State.latest))
            if path == "/summary.json":
                return self.send(200, json.dumps({k: report(v) for k, v in State.sessions.items()}, indent=1))
        self.send(404, "{}")

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(url.query)
        session = "".join(c for c in q.get("s", ["unknown"])[0] if c.isalnum())[:16] or "unknown"
        body = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 1 << 20))
        os.makedirs(State.logs, exist_ok=True)
        if url.path == "/telemetry":
            try:
                line = json.loads(body)
            except ValueError:
                return self.send(400, "{}")
            with State.lock:
                State.latest = line
                summarize(session, line)
            with open(os.path.join(State.logs, f"telemetry_{session}.jsonl"), "ab") as f:
                f.write(body.rstrip(b"\n") + b"\n")
            return self.send(200, "{}")
        if url.path == "/crash":
            name = os.path.join(State.logs, f"crash_{session}_{int(time.time())}.txt")
            with open(name, "wb") as f:
                f.write(body)
            print(f"crash breadcrumbs from the phone -> {name}", file=sys.stderr)
            return self.send(200, "{}")
        self.send(404, "{}")


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8361)
    p.add_argument("--logs", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs", "phone"))
    a = p.parse_args()
    State.logs = os.path.abspath(a.logs)
    print(f"Telemetry server on :{a.port} · open http://localhost:{a.port}/status · logs in {State.logs}")
    Server(("0.0.0.0", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
