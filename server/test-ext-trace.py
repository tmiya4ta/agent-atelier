#!/usr/bin/env python3
"""POST 中身まで見えるトレース"""
import base64, json, os, signal, subprocess, time, urllib.request, websocket

PORT = 9340
PROFILE = "/tmp/c-ext-trace"
subprocess.run(["rm", "-rf", PROFILE])

p = subprocess.Popen(
    ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
     f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     f"--user-data-dir={PROFILE}", "--window-size=1400,950", "about:blank"],
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

    call("Page.enable"); call("Runtime.enable"); call("Network.enable")

    URL = "https://agent-network-ingress-gw-df8af0.xdfpbh.jpn-e1.cloudhub.io/scrsBroker/.well-known/agent-card.json"
    enc = URL.replace(":", "%3A").replace("/", "%2F")
    call("Page.navigate", {"url": f"http://127.0.0.1:5173/index.html?reset&a2a={enc}"})

    # 接続待ち
    time.sleep(3.5)
    call("Runtime.evaluate", {"expression": """
        (() => {
          const ta = document.querySelector('.compose-input');
          ta.value = 'テスト';
          ta.dispatchEvent(new Event('input', {bubbles:true}));
          document.querySelector('.compose-send').click();
        })()
    """})

    # 5秒間ネットワークイベント拾う
    deadline = time.time() + 8
    ws.settimeout(0.3)
    posts = {}
    while time.time() < deadline:
        try: m = json.loads(ws.recv())
        except: continue
        if m.get("method") == "Network.requestWillBeSent":
            req = m["params"]["request"]
            if req.get("method") == "POST" and "proxy" in req.get("url",""):
                posts[m["params"]["requestId"]] = {
                    "url": req["url"][:120],
                    "body": req.get("postData")
                }
                print(f"POST {req['url'][:80]}")
                print(f"  body: {req.get('postData')[:300] if req.get('postData') else None}")
        if m.get("method") == "Network.responseReceived":
            r = m["params"]["response"]
            if m["params"]["requestId"] in posts:
                print(f"RESP {r['status']} {r['url'][:80]}")
        if m.get("method") == "Network.loadingFinished":
            rid_ev = m["params"]["requestId"]
            if rid_ev in posts:
                try:
                    body = call("Network.getResponseBody", {"requestId": rid_ev})
                    print(f"BODY: {body.get('body','')[:500]}")
                except Exception as e:
                    print(f"BODY error: {e}")
        if m.get("method") == "Network.loadingFailed":
            print(f"FAILED: {m['params']}")

    ws.close()
finally:
    p.send_signal(signal.SIGTERM); p.wait(timeout=3)
