#!/usr/bin/env python3
"""
CDP (Chrome DevTools Protocol) で実Chromeを操縦するデモスクリプト。

前提:
  google-chrome を --remote-debugging-port=9222 で起動済み
  http サーバが 5173/5180 で動いている

実行:
  python3 cdp-drive.py
"""
import base64, json, time, urllib.request, sys, os
import websocket  # pip install websocket-client


CDP_HTTP = "http://127.0.0.1:9222"
APP_URL  = "http://127.0.0.1:5173/index.html"
OUT_DIR  = "/tmp/ac-screens"
os.makedirs(OUT_DIR, exist_ok=True)


def pick_blank_target():
    """about:blank ページの webSocketDebuggerUrl を取得"""
    targets = json.loads(urllib.request.urlopen(f"{CDP_HTTP}/json").read())
    for t in targets:
        if t["type"] == "page" and t["url"] in ("about:blank", "chrome://newtab/"):
            return t
    # 新しいタブを作る (CDPだと開けないので fallback: 既存ページを使う)
    for t in targets:
        if t["type"] == "page":
            return t
    raise RuntimeError("no usable page target")


class CDP:
    """超ミニ CDP クライアント"""
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url)
        self.id = 0
        # Page / Runtime ドメインを有効化
        self.call("Page.enable")
        self.call("Runtime.enable")

    def call(self, method, params=None, timeout=10):
        self.id += 1
        rid = self.id
        self.ws.send(json.dumps({"id": rid, "method": method, "params": params or {}}))
        # 自分のidの応答が来るまで読む (eventは捨てる)
        end = time.time() + timeout
        while time.time() < end:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
        raise TimeoutError(method)

    def screenshot(self, path):
        r = self.call("Page.captureScreenshot", {"format": "png"})
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        return path

    def navigate(self, url):
        self.call("Page.navigate", {"url": url})
        # loadEventFired をだいたい待つ簡易ロジック
        time.sleep(1.2)

    def eval(self, expr):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        if r.get("exceptionDetails"):
            raise RuntimeError(r["exceptionDetails"])
        return r.get("result", {}).get("value")

    def close(self):
        self.ws.close()


def banner(s):
    print(f"\n\033[1;36m── {s}\033[0m")


def main():
    tgt = pick_blank_target()
    print(f"target: {tgt['title']!r}  url={tgt['url']!r}")
    print(f"ws    : {tgt['webSocketDebuggerUrl']}")

    cdp = CDP(tgt["webSocketDebuggerUrl"])

    banner("① ナビゲート → Atelier アプリ")
    cdp.navigate(APP_URL)
    cdp.screenshot(f"{OUT_DIR}/cdp-01-loaded.png")
    title = cdp.eval("document.title")
    print(f"  document.title = {title!r}")

    banner("② ページ内オブジェクトを直接取得")
    # サイドバーの保存済みエージェント名を全部抜く
    names = cdp.eval(
        "[...document.querySelectorAll('.agent-item .agent-name')].map(n => n.textContent)"
    )
    print(f"  saved agents = {names}")

    banner("③ サイドバー先頭(Atelier Bistro)をクリック")
    # NOTE: clickをCDP的にやるならInputドメインだが、JSの.click()で十分
    cdp.eval("document.querySelector('.agent-item').click()")
    time.sleep(1.6)
    cdp.screenshot(f"{OUT_DIR}/cdp-02-connected.png")

    banner("④ チャット欄に質問を入れて送信")
    cdp.eval("""(() => {
        const w = document.querySelector('.agent-window');
        const ta = w.querySelector('.compose-input');
        ta.value = 'A2Aプロトコルを一言で説明して、できることも教えて';
        ta.dispatchEvent(new Event('input', {bubbles: true}));
        w.querySelector('.compose-send').click();
        return true;
    })()""")
    time.sleep(1.4)
    cdp.screenshot(f"{OUT_DIR}/cdp-03-chatted.png")

    # チャットスレッドの最後のメッセージ本文を取得
    reply = cdp.eval(
        "document.querySelector('.agent-window .chat-stream').lastElementChild?.querySelector('.msg-body')?.textContent"
    )
    print(f"  最新の応答 = {reply!r}")

    banner("⑤ Debug タブへ切り替えて RPC フレーム確認")
    cdp.eval("document.querySelector('.agent-window .aw-tab[data-tab=\"debug\"]').click()")
    time.sleep(0.4)
    cdp.screenshot(f"{OUT_DIR}/cdp-04-debug.png")
    frames = cdp.eval(
        "[...document.querySelectorAll('.agent-window .dbg-entry .dbg-summary')].map(e=>e.textContent)"
    )
    print("  captured frames:")
    for i, f in enumerate(frames, 1):
        print(f"   {i}. {f}")

    banner("⑥ AgentCard タブへ → カード情報")
    cdp.eval("document.querySelector('.agent-window .aw-tab[data-tab=\"card\"]').click()")
    time.sleep(0.3)
    cdp.screenshot(f"{OUT_DIR}/cdp-05-card.png")
    card = cdp.eval(
        "({name: document.querySelector('.card-name')?.textContent,"
        " desc: document.querySelector('.card-desc')?.textContent,"
        " skills: [...document.querySelectorAll('.card-skill .skill-name')].map(s=>s.firstChild?.textContent?.trim())})"
    )
    print(f"  card = {json.dumps(card, ensure_ascii=False, indent=2)}")

    cdp.close()
    banner("done.")
    print(f"  screenshots → {OUT_DIR}/cdp-*.png")


if __name__ == "__main__":
    main()
