# Serves a built site the way Cloudflare Pages does, for the smoke check: /index.html
# redirects to /, byte ranges are ignored, and public/_headers is applied.
# usage: python3 scripts/serve-like-pages.py dist [port]
import http.server, sys, os, fnmatch
root = sys.argv[1]
def rules():
    out, cur = [], None
    try: lines = open(os.path.join(root, "_headers")).read().splitlines()
    except FileNotFoundError: return out
    for ln in lines:
        if not ln.strip() or ln.lstrip().startswith("#"): continue
        if not ln.startswith(" "): cur = (ln.strip(), []); out.append(cur)
        else: k, v = ln.strip().split(":", 1); cur[1].append((k.strip(), v.strip()))
    return out
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def end_headers(self):
        path = self.path.split("?")[0]
        for pat, hs in rules():
            if fnmatch.fnmatch(path, pat):
                for k, v in hs: self.send_header(k, v)
        super().end_headers()
    def do_GET(self):
        if self.path.split("?")[0].endswith("/index.html"):
            self.send_response(308); self.send_header("Location", self.path.replace("index.html", "")); self.end_headers(); return
        super().do_GET()
    def log_message(self, fmt, *args):
        sys.stderr.write("GET " + self.path + "\n"); sys.stderr.flush()
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2]) if len(sys.argv) > 2 else 4173), H).serve_forever()
