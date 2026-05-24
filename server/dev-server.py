#!/usr/bin/env python3
"""Atelier dev server: 静的ファイル配信 + CORSバイパスプロキシ

使い方:
  python3 server/dev-server.py [--port 5173]

エンドポイント:
  GET/POST/OPTIONS /             : 静的ファイル (./)
  GET/POST/OPTIONS /proxy?url=...: 任意のURLへ転送 (CORSヘッダ付与)
"""
import argparse, json, ssl, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class StripAuthOnRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Anypoint Exchange は 303 で S3 (presigned URL) にリダイレクトしてくる。
    S3 は Authorization ヘッダがあると "Only one auth mechanism allowed" で 400 を返すので、
    redirect 時に明示的に Authorization を取り除く。"""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        for k in list(new.headers.keys()):
            if k.lower() == "authorization":
                del new.headers[k]
        for k in list(new.unredirected_hdrs.keys()):
            if k.lower() == "authorization":
                del new.unredirected_hdrs[k]
        return new


_PROXY_OPENER = urllib.request.build_opener(
    StripAuthOnRedirectHandler(),
    urllib.request.HTTPSHandler(context=ssl.create_default_context()),
)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        ts = datetime.now().strftime("%H:%M:%S")
        sys.stderr.write(f"[{ts}] {self.address_string()} {fmt % args}\n")

    # ─── CORS ─────
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/proxy?") or self.path == "/proxy":
            return self._proxy("GET")
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/proxy?") or self.path == "/proxy":
            return self._proxy("POST")
        self.send_response(404); self._cors(); self.end_headers()

    def end_headers(self):
        # 静的アセットにも CORS を付ける
        self._cors()
        super().end_headers()

    # ─── Proxy ─────
    def _proxy(self, method):
        q = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(q)
        target = (params.get("url") or [None])[0]
        if not target:
            return self._send_json(400, {"error": "missing url= param"})

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(target, data=body, method=method)
        # 必要なヘッダだけ転送 (Host/Origin等は付けない)
        for h in ("Content-Type", "Authorization", "Accept", "X-Atelier-Stream"):
            v = self.headers.get(h)
            if v: req.add_header(h, v)

        try:
            with _PROXY_OPENER.open(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(resp.status)
                ct = resp.headers.get("Content-Type", "application/octet-stream")
                self.send_header("Content-Type", ct)
                self._cors()
                self.send_header("Content-Length", str(len(data)))
                self.send_header("X-Atelier-Proxied-Url", target)
                # SimpleHTTPRequestHandler の end_headers 経由で CORS が二重に
                # 付与されないよう、ここでは super().end_headers() を直接呼ぶ
                SimpleHTTPRequestHandler.end_headers(self)
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read() if e.fp else b""
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self._cors()
            self.send_header("Content-Length", str(len(data)))
            SimpleHTTPRequestHandler.end_headers(self)
            self.wfile.write(data)
        except Exception as e:
            self._send_json(502, {"error": str(e), "target": target})

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        SimpleHTTPRequestHandler.end_headers(self)
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"╭─ Atelier dev server ─────────────────────────")
    print(f"│  static: http://{args.host}:{args.port}/")
    print(f"│  proxy : http://{args.host}:{args.port}/proxy?url=...")
    print(f"╰─────────────────────────────────────────────")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
