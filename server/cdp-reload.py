#!/usr/bin/env python3
"""アクティブな Atelier タブをリロードし、軽くスクショを撮る"""
import base64, json, time, urllib.request, os, websocket

CDP_HTTP = "http://127.0.0.1:9222"
OUT = "/tmp/ac-screens"
os.makedirs(OUT, exist_ok=True)

targets = json.loads(urllib.request.urlopen(f"{CDP_HTTP}/json").read())
page = next((t for t in targets if t["type"] == "page" and "5173" in t["url"]), None)
if not page:
    page = next((t for t in targets if t["type"] == "page"), None)
print(f"target: {page['title']} · {page['url']}")

ws = websocket.create_connection(page["webSocketDebuggerUrl"])
i = 0
def call(method, params=None):
    global i; i += 1
    ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == i:
            if "error" in m: raise RuntimeError(m["error"])
            return m.get("result", {})

call("Page.enable")
call("Page.reload", {"ignoreCache": True})
time.sleep(1.4)
r = call("Page.captureScreenshot", {"format": "png"})
path = f"{OUT}/ws-01-default.png"
with open(path, "wb") as f:
    f.write(base64.b64decode(r["data"]))
print(f"  → {path}")
ws.close()
