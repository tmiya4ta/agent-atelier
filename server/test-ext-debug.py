#!/usr/bin/env python3
"""console.log と fetch エラーを拾うデバッグ版"""
import base64, json, os, signal, subprocess, time, urllib.request, websocket

PORT = 9338
PROFILE = "/tmp/c-ext-dbg"
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

    # console + network イベントを拾う
    call("Page.enable"); call("Runtime.enable"); call("Network.enable")
    call("Log.enable") if False else None

    URL = "https://agent-network-ingress-gw-df8af0.xdfpbh.jpn-e1.cloudhub.io/scrsBroker/.well-known/agent-card.json"
    encoded = URL.replace(":", "%3A").replace("/", "%2F")
    call("Page.navigate", {"url": f"http://127.0.0.1:5173/index.html?reset&a2a={encoded}"})

    # 5秒間イベントを集める
    deadline = time.time() + 6
    ws.settimeout(0.3)
    while time.time() < deadline:
        try:
            m = json.loads(ws.recv())
        except:
            continue
        if m.get("method") == "Runtime.consoleAPICalled":
            level = m["params"]["type"]
            args = " ".join(a.get("value", a.get("description", "")) for a in m["params"]["args"])
            print(f"console.{level}: {args}")
        if m.get("method") == "Runtime.exceptionThrown":
            ed = m["params"]["exceptionDetails"]
            print(f"EXCEPTION at {ed.get('url','')}:{ed.get('lineNumber','')}: {ed.get('text','')} {ed.get('exception',{}).get('description','')}")
        if m.get("method") == "Network.requestWillBeSent":
            req = m["params"]["request"]
            print(f"→ {req['method']} {req['url'][:140]}")
        if m.get("method") == "Network.responseReceived":
            r = m["params"]["response"]
            print(f"← {r['status']} {r['url'][:140]}")
        if m.get("method") == "Network.loadingFailed":
            print(f"NETERR: {m['params'].get('errorText')} for {m['params'].get('requestId')}")

    ws.close()
finally:
    p.send_signal(signal.SIGTERM); p.wait(timeout=3)
