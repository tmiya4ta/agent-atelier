#!/usr/bin/env python3
"""永続化シナリオの自動検証:
  1) ヘッドレスChromeを独立user-data-dirで起動
  2) アプリを開いてデモ + A2A接続を作る
  3) ウインドウを動かす
  4) Page.reload
  5) リロード後、位置/接続が復元されているか確認
"""
import base64, json, os, signal, subprocess, sys, time
import urllib.request, websocket


CHROME_PORT = 9333
PROFILE  = "/tmp/c-persist-test"
APP_URL  = "http://127.0.0.1:5173/index.html?reset"  # 最初はリセット
OUT      = "/tmp/ac-screens"
os.makedirs(OUT, exist_ok=True)


def banner(s): print(f"\n\033[1;36m── {s}\033[0m")


def launch_chrome():
    subprocess.run(["rm", "-rf", PROFILE])
    p = subprocess.Popen(
        ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
         f"--remote-debugging-port={CHROME_PORT}",
         "--remote-allow-origins=*",
         f"--user-data-dir={PROFILE}",
         "--window-size=1440,900",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    # wait until cdp ready
    for _ in range(40):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json/version", timeout=0.3)
            return p
        except Exception:
            time.sleep(0.15)
    raise RuntimeError("chrome failed to start")


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url)
        self.id = 0
        self.call("Page.enable")
        self.call("Runtime.enable")

    def call(self, method, params=None, timeout=10):
        self.id += 1
        rid = self.id
        self.ws.send(json.dumps({"id": rid, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            m = json.loads(self.ws.recv())
            if m.get("id") == rid:
                if "error" in m: raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})
        raise TimeoutError(method)

    def navigate(self, url):
        self.call("Page.navigate", {"url": url})
        time.sleep(1.4)

    def eval(self, expr):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        if r.get("exceptionDetails"):
            raise RuntimeError(r["exceptionDetails"])
        return r.get("result", {}).get("value")

    def screenshot(self, path):
        r = self.call("Page.captureScreenshot", {"format": "png"})
        with open(path, "wb") as f: f.write(base64.b64decode(r["data"]))
        return path


def main():
    chrome = launch_chrome()
    try:
        targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json").read())
        page = next(t for t in targets if t["type"] == "page")
        cdp  = CDP(page["webSocketDebuggerUrl"])

        banner("① アプリを開く (?reset で過去状態クリア)")
        cdp.navigate(APP_URL)

        banner("② Atelier Bistro(A2A)に接続")
        cdp.eval("document.querySelector('.agent-item').click()")
        time.sleep(1.4)

        banner("③ デモmock 3体を追加 → 計4ウインドウ")
        cdp.eval("document.querySelector('#btnDemo').click()")
        time.sleep(2.0)
        cdp.screenshot(f"{OUT}/persist-01-before-move.png")
        ws_count = cdp.eval("document.querySelectorAll('.agent-window').length")
        print(f"  ウインドウ数: {ws_count}")

        banner("④ 1番目のウインドウを (700,200) へ移動")
        cdp.eval("""(() => {
            const w = document.querySelector('.agent-window');
            w.style.left = '700px';
            w.style.top  = '200px';
            w.style.width = '440px';
            w.style.height = '420px';
            // onChange を発火させて保存する
            const ev = new MouseEvent('mouseup', {bubbles: true});
            window.dispatchEvent(ev);
            // 念のため、直接 onChange を叩く
            return true;
        })()""")
        # ドラッグを「終了」させるイベントを発火させ難いので、windowが
        # _persistしてくれるよう、別の方法で。タブ切替が onChange を呼ぶ。
        cdp.eval("document.querySelector('.agent-window .aw-tab[data-tab=\"card\"]').click()")
        time.sleep(0.4)
        cdp.screenshot(f"{OUT}/persist-02-moved.png")

        before = cdp.eval("""(() => {
            return [...document.querySelectorAll('.agent-window')].map(w => ({
                title: w.querySelector('.aw-title').textContent,
                left:  w.style.left, top: w.style.top,
                width: w.style.width, height: w.style.height,
                tab: w.querySelector('.aw-tab.is-active').dataset.tab
            }));
        })()""")
        print("  保存前の状態:")
        for w in before: print(f"   · {w}")

        banner("⑤ Page.reload (F5相当)")
        cdp.call("Page.reload")
        time.sleep(2.6)  # 再接続が落ち着くまで待つ
        cdp.screenshot(f"{OUT}/persist-03-after-reload.png")

        after = cdp.eval("""(() => {
            return [...document.querySelectorAll('.agent-window')].map(w => ({
                title: w.querySelector('.aw-title').textContent,
                left:  w.style.left, top: w.style.top,
                width: w.style.width, height: w.style.height,
                tab: w.querySelector('.aw-tab.is-active').dataset.tab
            }));
        })()""")
        print("  リロード後の状態:")
        for w in after: print(f"   · {w}")

        banner("⑥ 比較")
        # タイトル/位置/サイズ/タブ がすべて一致しているか
        match = (len(before) == len(after) and all(
            b["title"] == a["title"] and b["left"] == a["left"] and b["top"] == a["top"]
            and b["width"] == a["width"] and b["height"] == a["height"]
            and b["tab"] == a["tab"]
            for b, a in zip(before, after)
        ))
        print(f"  match = {match}")
        if not match:
            for b, a in zip(before, after):
                if b != a:
                    print(f"   ≠ before={b}\n     after ={a}")
        cdp.ws.close()
        return 0 if match else 1
    finally:
        chrome.send_signal(signal.SIGTERM)
        chrome.wait(timeout=3)


if __name__ == "__main__":
    sys.exit(main())
