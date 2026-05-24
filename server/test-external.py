#!/usr/bin/env python3
"""外部A2Aサーバ (CloudHub) への接続テスト"""
import base64, json, os, signal, subprocess, time, urllib.request, websocket

PORT = 9337
PROFILE = "/tmp/c-ext"
OUT = "/tmp/ac-screens"
os.makedirs(OUT, exist_ok=True)
subprocess.run(["rm", "-rf", PROFILE])

p = subprocess.Popen(
    ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
     f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     f"--user-data-dir={PROFILE}", "--window-size=1200,900", "about:blank"],
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
        r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in r: raise RuntimeError(r["exceptionDetails"])
        return r.get("result", {}).get("value")
    def shot(name):
        d = call("Page.captureScreenshot", {"format": "png"})["data"]
        with open(f"{OUT}/{name}.png", "wb") as f: f.write(base64.b64decode(d))

    call("Page.enable"); call("Runtime.enable")

    URL = "https://agent-network-ingress-gw-df8af0.xdfpbh.jpn-e1.cloudhub.io/scrsBroker/.well-known/agent-card.json"
    encoded = URL.replace(":", "%3A").replace("/", "%2F")
    call("Page.navigate", {"url": f"http://127.0.0.1:5173/index.html?reset&a2a={encoded}"})
    time.sleep(3.5)  # 外部リクエストなので余裕めに

    # 状況をチェック
    state = evalu("""(() => {
      const w = document.querySelector('.agent-window');
      if (!w) return { connected: false, reason: 'no window' };
      return {
        connected: true,
        title:   w.querySelector('.aw-title')?.textContent,
        status:  w.querySelector('.aw-status-dot.is-live') ? 'live' : (w.querySelector('.aw-status-dot.is-error') ? 'error' : 'idle'),
        latency: w.querySelector('.aw-latency')?.textContent,
        latestMsg: w.querySelector('.chat-stream')?.lastElementChild?.querySelector('.msg-body')?.textContent
      };
    })()""")
    print(json.dumps(state, indent=2, ensure_ascii=False))
    shot("ext-01-chat")

    # AgentCard タブ
    evalu("document.querySelector('.agent-window .aw-tab[data-tab=\"card\"]').click()")
    time.sleep(0.5)
    card = evalu("""(() => ({
      name:  document.querySelector('.card-name')?.textContent,
      url:   document.querySelector('.card-url')?.textContent,
      desc:  document.querySelector('.card-desc')?.textContent?.slice(0, 80),
      skills: [...document.querySelectorAll('.card-skill .skill-name')].map(s => s.firstChild?.textContent?.trim())
    }))()""")
    print("--- card ---")
    print(json.dumps(card, indent=2, ensure_ascii=False))
    shot("ext-02-card")

    # Debug タブ
    evalu("document.querySelector('.agent-window .aw-tab[data-tab=\"debug\"]').click()")
    time.sleep(0.3)
    frames = evalu("""[...document.querySelectorAll('.dbg-entry .dbg-summary')].map(e => e.textContent)""")
    print("--- debug frames ---")
    for f in frames: print(f"  · {f}")
    shot("ext-03-debug")

    ws.close()
finally:
    p.send_signal(signal.SIGTERM); p.wait(timeout=3)
