#!/usr/bin/env python3
"""SCRS Broker へ実際にメッセージを送って応答を取る"""
import base64, json, os, signal, subprocess, time, urllib.request, websocket

PORT = 9339
PROFILE = "/tmp/c-ext-msg"
OUT = "/tmp/ac-screens"
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
    def evalu(expr):
        r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        if "exceptionDetails" in r: raise RuntimeError(r["exceptionDetails"])
        return r.get("result", {}).get("value")
    def shot(name):
        d = call("Page.captureScreenshot", {"format": "png"})["data"]
        with open(f"{OUT}/{name}.png", "wb") as f: f.write(base64.b64decode(d))

    call("Page.enable"); call("Runtime.enable")

    URL = "https://agent-network-ingress-gw-df8af0.xdfpbh.jpn-e1.cloudhub.io/scrsBroker/.well-known/agent-card.json"
    enc = URL.replace(":", "%3A").replace("/", "%2F")
    call("Page.navigate", {"url": f"http://127.0.0.1:5173/index.html?reset&a2a={enc}"})
    time.sleep(3.5)

    # 接続確認
    title = evalu("document.querySelector('.aw-title')?.textContent")
    print(f"connected to: {title}")

    # メッセージ送信
    sample = "INC-2026-0521 G-KANSAI-PARTS-001 partNumber=P-2024-KAN-001 quantity=500 severity=HIGH"
    evalu(f"""(() => {{
        const ta = document.querySelector('.compose-input');
        ta.value = {json.dumps(sample)};
        ta.dispatchEvent(new Event('input', {{bubbles:true}}));
        document.querySelector('.compose-send').click();
    }})()""")

    print(f"sending: {sample!r}")
    print("waiting up to 60s for response...")
    deadline = time.time() + 60
    while time.time() < deadline:
        time.sleep(2)
        last = evalu("""
          (() => {
            const stream = document.querySelector('.chat-stream');
            const msgs = stream ? [...stream.querySelectorAll('.msg')] : [];
            const last = msgs[msgs.length-1];
            if (!last) return null;
            return {
              isAgent: last.classList.contains('msg-agent'),
              text:    last.querySelector('.msg-body')?.textContent?.slice(0, 600)
            };
          })()
        """)
        # typing インジケーター以外の agent メッセージを待つ
        if last and last.get("isAgent") and last["text"] and not last.get("text", "").startswith("send failed"):
            # typing インジケーター？
            typing = evalu("!!document.querySelector('.msg-typing')")
            if not typing:
                print(f"\nresponse received ({int(time.time()-(deadline-60))}s):")
                print(last["text"])
                break
            print(f"  ... still typing ({int(time.time()-(deadline-60))}s elapsed)")
        else:
            print(f"  ... no agent reply yet ({int(time.time()-(deadline-60))}s)")

    shot("ext-msg-chat")

    # debug タブで全フレームを取得
    evalu("document.querySelector('.agent-window .aw-tab[data-tab=\"debug\"]').click()")
    time.sleep(0.4)
    frames = evalu("""[...document.querySelectorAll('.dbg-entry .dbg-summary')].map(e => e.textContent)""")
    print("\ndebug frames:")
    for f in frames: print(f"  · {f}")
    shot("ext-msg-debug")
    ws.close()
finally:
    p.send_signal(signal.SIGTERM); p.wait(timeout=3)
