#!/usr/bin/env python3
"""ズームボタンの動作とリロード時の復元を検証"""
import base64, json, os, signal, subprocess, time, urllib.request, websocket

PORT = 9334
PROFILE = "/tmp/c-zoom-test"
OUT = "/tmp/ac-screens"
os.makedirs(OUT, exist_ok=True)
subprocess.run(["rm", "-rf", PROFILE])

p = subprocess.Popen(
    ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
     f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     f"--user-data-dir={PROFILE}", "--window-size=1440,900", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
for _ in range(40):
    try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=0.3); break
    except: time.sleep(0.15)

try:
    targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json").read())
    page = next(t for t in targets if t["type"] == "page")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"])
    rid = [0]
    def call(method, params=None):
        rid[0] += 1; r = rid[0]
        ws.send(json.dumps({"id": r, "method": method, "params": params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == r:
                if "error" in m: raise RuntimeError(m["error"])
                return m.get("result", {})
    def evalu(expr):
        r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        return r.get("result", {}).get("value")
    def shot(name):
        d = call("Page.captureScreenshot", {"format": "png"})["data"]
        with open(f"{OUT}/{name}.png", "wb") as f: f.write(base64.b64decode(d))

    call("Page.enable"); call("Runtime.enable")
    call("Page.navigate", {"url": "http://127.0.0.1:5173/index.html?reset"})
    time.sleep(1.3)

    # ① 初期100% を確認
    z0 = evalu("getComputedStyle(document.body).zoom || document.body.style.zoom || '1'")
    label0 = evalu("document.querySelector('#zoomVal').textContent")
    print(f"[100%] body.zoom={z0!r}  label={label0!r}")
    shot("zoom-01-default")

    # ② + を3回 → 130%
    for _ in range(3):
        evalu("document.querySelector('#zoomIn').click()")
    z1 = evalu("document.body.style.zoom")
    label1 = evalu("document.querySelector('#zoomVal').textContent")
    print(f"[after +×3] body.zoom={z1!r}  label={label1!r}")
    shot("zoom-02-130")

    # ③ Page.reload → 復元確認
    call("Page.reload")
    time.sleep(1.4)
    z2 = evalu("document.body.style.zoom")
    label2 = evalu("document.querySelector('#zoomVal').textContent")
    print(f"[after reload] body.zoom={z2!r}  label={label2!r}")
    shot("zoom-03-after-reload")
    print(f"  restored? {z2 == z1 and label2 == label1}")

    # ④ 値をクリックで100%リセット
    evalu("document.querySelector('#zoomVal').click()")
    z3 = evalu("document.body.style.zoom")
    label3 = evalu("document.querySelector('#zoomVal').textContent")
    print(f"[after reset] body.zoom={z3!r}  label={label3!r}")
    shot("zoom-04-reset")

    # ⑤ - を3回 → 80% (min)
    for _ in range(3):
        evalu("document.querySelector('#zoomOut').click()")
    z4 = evalu("document.body.style.zoom")
    label4 = evalu("document.querySelector('#zoomVal').textContent")
    print(f"[after -×3] body.zoom={z4!r}  label={label4!r}")
    shot("zoom-05-80")

    # ⑥ 限界以下にしても min で止まるか
    for _ in range(5):
        evalu("document.querySelector('#zoomOut').click()")
    z5 = evalu("document.body.style.zoom")
    label5 = evalu("document.querySelector('#zoomVal').textContent")
    print(f"[after -×5 more (clamped)] body.zoom={z5!r}  label={label5!r}")

    ws.close()
finally:
    p.send_signal(signal.SIGTERM); p.wait(timeout=3)
