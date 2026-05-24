#!/usr/bin/env python3
"""font-size-only スケール方式の検証:
  - viewportは溢れない (overflow発生しない)
  - フォントサイズが scale * base に正しく適用される
"""
import base64, json, os, signal, subprocess, time, urllib.request, websocket

PORT = 9336
PROFILE = "/tmp/c-fs"
OUT = "/tmp/ac-screens"
os.makedirs(OUT, exist_ok=True)
subprocess.run(["rm", "-rf", PROFILE])

p = subprocess.Popen(
    ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
     f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     f"--user-data-dir={PROFILE}",
     "--window-size=1000,900", "about:blank"],
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
        if "exceptionDetails" in r: raise RuntimeError(r["exceptionDetails"])
        return r.get("result", {}).get("value")
    def shot(name):
        d = call("Page.captureScreenshot", {"format": "png"})["data"]
        with open(f"{OUT}/{name}.png", "wb") as f: f.write(base64.b64decode(d))

    call("Page.enable"); call("Runtime.enable")
    call("Page.navigate", {"url": "http://127.0.0.1:5173/index.html?reset"})
    time.sleep(1.4)

    # Atelier Bistro 接続
    evalu("document.querySelectorAll('.agent-item')[0].click()")
    time.sleep(1.4)

    def measure(label):
        m = evalu("""(() => {
          const body = document.body;
          const sample = document.querySelector('.msg-body');
          const title  = document.querySelector('.brand-name');
          const ws = document.querySelector('.workspace');
          return {
            viewport: { w: window.innerWidth, h: window.innerHeight },
            body_rect: { w: body.getBoundingClientRect().width, h: body.getBoundingClientRect().height },
            workspace_overflow: {
              x: ws.scrollWidth  - ws.offsetWidth,
              y: ws.scrollHeight - ws.offsetHeight
            },
            msg_fontsize:   sample ? getComputedStyle(sample).fontSize : null,
            brand_fontsize: title  ? getComputedStyle(title ).fontSize : null,
            fs: getComputedStyle(document.documentElement).getPropertyValue('--fs')
          };
        })()""")
        print(f"\n[{label}]")
        print(json.dumps(m, indent=2, ensure_ascii=False))

    measure("100%")
    shot("fs-01-100")

    for _ in range(3): evalu("document.querySelector('#zoomIn').click()")
    time.sleep(0.2)
    measure("130%")
    shot("fs-02-130")

    for _ in range(6): evalu("document.querySelector('#zoomOut').click()")
    time.sleep(0.2)
    measure("80%")
    shot("fs-03-80")

    ws.close()
finally:
    p.send_signal(signal.SIGTERM); p.wait(timeout=3)
