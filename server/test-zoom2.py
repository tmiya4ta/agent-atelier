#!/usr/bin/env python3
"""ズーム時のレイアウト溢れが緩和されたかを検証する。
小さめウインドウ (880x900) でズーム 130% にして、はみ出しの状況を確認。"""
import base64, json, os, signal, subprocess, time, urllib.request, websocket

PORT = 9335
PROFILE = "/tmp/c-zoom2"
OUT = "/tmp/ac-screens"
os.makedirs(OUT, exist_ok=True)
subprocess.run(["rm", "-rf", PROFILE])

p = subprocess.Popen(
    ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
     f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     f"--user-data-dir={PROFILE}",
     "--window-size=1000,950",                       # 小さいウインドウを再現
     "about:blank"],
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
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"])
        return r.get("result", {}).get("value")
    def shot(name):
        d = call("Page.captureScreenshot", {"format": "png"})["data"]
        with open(f"{OUT}/{name}.png", "wb") as f: f.write(base64.b64decode(d))

    call("Page.enable"); call("Runtime.enable")
    call("Page.navigate", {"url": "http://127.0.0.1:5173/index.html?reset"})
    time.sleep(1.4)

    # demo 接続
    evalu("document.querySelectorAll('.agent-item')[1].click()")  # Atelier Research
    time.sleep(1.3)

    # 120%にズーム (ユーザーが試した値)
    for _ in range(2): evalu("document.querySelector('#zoomIn').click()")
    time.sleep(0.3)

    # overflow測定
    sizes = evalu("""(() => {
      const ws = document.querySelector('.workspace');
      const body = document.body;
      return {
        viewport:        { w: window.innerWidth, h: window.innerHeight },
        body:            { sw: body.scrollWidth, sh: body.scrollHeight, ow: body.offsetWidth, oh: body.offsetHeight,
                           bw: body.getBoundingClientRect().width, bh: body.getBoundingClientRect().height },
        workspace:       { sw: ws.scrollWidth,   sh: ws.scrollHeight,   ow: ws.offsetWidth,   oh: ws.offsetHeight },
        zoom:            getComputedStyle(document.documentElement).getPropertyValue('--zoom'),
        hintHidden:      getComputedStyle(document.querySelector('.ws-tabs-hint')).display === 'none',
        kbdHintHidden:   getComputedStyle(document.querySelector('.primary-btn-kbd')).display === 'none'
      };
    })()""")
    print(json.dumps(sizes, indent=2, ensure_ascii=False))
    shot("zoom-narrow-120")

    # スクロールしてウインドウ右側が見えるか
    evalu("document.querySelector('.workspace').scrollLeft = 400")
    time.sleep(0.2)
    shot("zoom-narrow-120-scrolled")

    ws.close()
finally:
    p.send_signal(signal.SIGTERM); p.wait(timeout=3)
