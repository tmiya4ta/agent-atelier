#!/usr/bin/env python3
"""POST の中身/応答を見る minimal 版"""
import base64, json, os, signal, subprocess, sys, time, traceback, urllib.request, websocket

PORT = 9342
PROFILE = "/tmp/c-trace2"
subprocess.run(["rm", "-rf", PROFILE])

p = subprocess.Popen(
    ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
     f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     f"--user-data-dir={PROFILE}", "--window-size=1400,950", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
sys.stdout.write("chrome launched\n"); sys.stdout.flush()
for _ in range(60):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=0.3)
        break
    except: time.sleep(0.2)
sys.stdout.write("chrome ready\n"); sys.stdout.flush()

try:
    targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json").read())
    page = next(t for t in targets if t["type"] == "page")
    sys.stdout.write(f"target {page['url']}\n"); sys.stdout.flush()
    ws = websocket.create_connection(page["webSocketDebuggerUrl"])

    rid = [0]
    def call(method, params=None):
        rid[0] += 1; r = rid[0]
        ws.send(json.dumps({"id": r, "method": method, "params": params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == r:
                return m.get("result", m.get("error", {}))

    call("Page.enable"); call("Runtime.enable"); call("Network.enable")
    sys.stdout.write("domains enabled\n"); sys.stdout.flush()

    URL = "https://agent-network-ingress-gw-df8af0.xdfpbh.jpn-e1.cloudhub.io/scrsBroker/.well-known/agent-card.json"
    enc = URL.replace(":", "%3A").replace("/", "%2F")
    call("Page.navigate", {"url": f"http://127.0.0.1:5173/index.html?reset&a2a={enc}"})
    sys.stdout.write("navigated, sleeping...\n"); sys.stdout.flush()
    time.sleep(4)

    # send message
    call("Runtime.evaluate", {"expression": """
      (() => {
        const ta = document.querySelector('.compose-input');
        if (!ta) return 'no input';
        ta.value = 'テスト';
        ta.dispatchEvent(new Event('input', {bubbles:true}));
        document.querySelector('.compose-send').click();
        return 'sent';
      })()
    """, "returnByValue": True})
    sys.stdout.write("send triggered, watching network...\n"); sys.stdout.flush()

    # 7秒間 Network イベント拾う
    ws.settimeout(0.3)
    deadline = time.time() + 8
    posts = {}
    while time.time() < deadline:
        try: m = json.loads(ws.recv())
        except websocket.WebSocketTimeoutException: continue
        except Exception as e:
            sys.stdout.write(f"recv err: {e}\n"); sys.stdout.flush(); break
        method_ = m.get("method", "")
        if method_ == "Network.requestWillBeSent":
            req = m["params"]["request"]
            if req.get("method") == "POST":
                sys.stdout.write(f"POST {req['url']}\n  body: {(req.get('postData') or '')[:300]}\n"); sys.stdout.flush()
                posts[m["params"]["requestId"]] = True
        elif method_ == "Network.responseReceived":
            r = m["params"]["response"]
            if m["params"]["requestId"] in posts:
                sys.stdout.write(f"RESP {r['status']} {r['url']}\n"); sys.stdout.flush()
        elif method_ == "Network.loadingFinished":
            rid_ = m["params"]["requestId"]
            if rid_ in posts:
                try:
                    b = call("Network.getResponseBody", {"requestId": rid_})
                    txt = b.get("body","")
                    sys.stdout.write(f"BODY: {txt[:800]}\n"); sys.stdout.flush()
                except Exception as e:
                    sys.stdout.write(f"body err: {e}\n"); sys.stdout.flush()

    ws.close()
except Exception:
    traceback.print_exc()
finally:
    sys.stdout.write("cleanup\n"); sys.stdout.flush()
    p.send_signal(signal.SIGTERM); p.wait(timeout=3)
