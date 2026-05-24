#!/usr/bin/env python3
"""
Mock A2A agent — JSON-RPC 2.0 over HTTP, with a friendly chat persona.

エンドポイント:
  GET  /.well-known/agent.json     →  AgentCard
  POST /                            →  JSON-RPC  message/send
  OPTIONS /*                        →  CORS preflight

起動:
  python3 mock-agent.py            (default: 0.0.0.0:5180)
  python3 mock-agent.py --port 5181 --name "別のエージェント"
"""

import argparse
import json
import random
import time
import sys
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# ─── Persona configuration ─────────────────────────────
def build_agent_card(host: str, port: int, name: str) -> dict:
    base = f"http://{host}:{port}"
    return {
        "name": name,
        "description": (
            "Atelier Bistro — 雑談・要約・ちょっとした思考整理を担当する A2A モックエージェント。"
            "学術的な議論からカジュアルな質問まで、落ち着いたトーンで応答します。"
        ),
        "url": base,
        "version": "0.1.0",
        "provider": {
            "organization": "Atelier Labs",
            "url": "https://atelier.example",
        },
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
            "stateTransitionHistory": True,
        },
        "defaultInputModes":  ["text"],
        "defaultOutputModes": ["text"],
        "skills": [
            {
                "id": "chitchat",
                "name": "Chitchat",
                "description": "日本語/英語のカジュアル会話",
                "tags": ["chat", "smalltalk"],
            },
            {
                "id": "echo",
                "name": "Echo",
                "description": "発話を整形して返す (デバッグ用)",
                "tags": ["debug"],
            },
            {
                "id": "summarize",
                "name": "Summarize",
                "description": "短文を要約する (簡易)",
                "tags": ["summary"],
            },
        ],
    }


# ─── Reply generator (no LLM, deterministic-ish) ───────
GREETING_RE = re.compile(r"^(hi|hello|hey|こんにちは|やあ|もしもし|こんばんは)\b", re.I)
HOWAREYOU_RE = re.compile(r"(元気|how.*are.*you|調子.*どう)", re.I)
WHO_RE = re.compile(r"(だれ|誰|who.*are.*you|なまえ|名前)", re.I)
HELP_RE = re.compile(r"(help|手伝|できること|スキル|何ができる)", re.I)
BYE_RE = re.compile(r"^(bye|goodbye|さよなら|またね|お疲れ)", re.I)


def gen_reply(text: str, name: str) -> str:
    t = text.strip()
    if not t:
        return "（何かメッセージを送ってもらえますか？）"

    if BYE_RE.search(t):
        return "またいつでも。良い一日を。"
    if GREETING_RE.search(t):
        opts = [
            f"やあ、{name} です。今日はどんな話をしましょうか？",
            "こんにちは。お手伝いできることがあれば言ってくださいね。",
            "Hi there — what's on your mind today?",
        ]
        return random.choice(opts)
    if HOWAREYOU_RE.search(t):
        return "私はバックエンドの片隅で元気にしています。あなたはどうですか？"
    if WHO_RE.search(t):
        return (
            f"{name} と申します。A2Aプロトコル経由でおしゃべりするモックエージェントです。"
            f"中身はpython標準ライブラリだけで動いています。"
        )
    if HELP_RE.search(t):
        return (
            "現在できることはこのくらいです:\n"
            " · chitchat — 雑談\n"
            " · echo     — 発話の整形オウム返し\n"
            " · summarize — 入力文の超簡易要約\n"
            "本物のLLM接続はまだですが、A2Aフレーム検証用には十分です。"
        )

    # naive "summarize" trigger
    if len(t) > 80:
        first = t.split("。")[0][:60]
        return f"要点: 「{first}…」 ですね。もう少し具体的にお聞きできますか？"

    # echo + small commentary
    flavours = [
        f"「{t}」ですね。なるほど。",
        f"了解しました — 「{t}」について考えてみますね。",
        f"はい。あなたは今こう言いました: 「{t}」。",
        f"面白いトピックです。「{t}」をもう少し展開してくれませんか？",
    ]
    return random.choice(flavours)


# ─── HTTP handler ──────────────────────────────────────
class A2AHandler(BaseHTTPRequestHandler):
    server_version = "MockA2A/0.1"

    # silence default logging, use our own format
    def log_message(self, fmt, *args):
        ts = datetime.now().strftime("%H:%M:%S")
        sys.stderr.write(f"[{ts}] {self.address_string()} {fmt % args}\n")

    # ─── CORS ─────
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ─── GET /.well-known/agent[-card].json ─────
    def do_GET(self):
        if self.path in (
            "/.well-known/agent.json", "/.well-known/agent.json/",
            "/.well-known/agent-card.json", "/.well-known/agent-card.json/",
        ):
            body = json.dumps(self.server.agent_card, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path in ("/", "/health"):
            body = b'{"ok":true,"agent":"' + self.server.agent_card["name"].encode("utf-8") + b'"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self._cors()
        self.end_headers()

    # ─── POST / (JSON-RPC) ─────
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        try:
            req = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as e:
            self._json_rpc_error(None, -32700, f"Parse error: {e}")
            return

        method = req.get("method")
        rid = req.get("id")
        params = req.get("params") or {}

        # simulate small server-side think time
        time.sleep(0.18 + random.random() * 0.22)

        if method in ("message/send", "message/stream"):
            text = self._extract_text(params)
            reply = gen_reply(text, self.server.agent_card["name"])
            result = {
                "status": {"state": "completed"},
                "messages": [
                    {
                        "role": "agent",
                        "parts": [{"kind": "text", "text": reply}],
                        "messageId": f"msg-{int(time.time()*1000)}",
                    }
                ],
            }
            self._json_rpc_ok(rid, result)
            return

        if method == "agent/getCard":
            self._json_rpc_ok(rid, self.server.agent_card)
            return

        self._json_rpc_error(rid, -32601, f"Method not found: {method}")

    # ─── helpers ─────
    def _extract_text(self, params: dict) -> str:
        msg = params.get("message") or {}
        parts = msg.get("parts") or []
        for p in parts:
            if p.get("kind") == "text" and isinstance(p.get("text"), str):
                return p["text"]
        return ""

    def _json_rpc_ok(self, rid, result):
        body = json.dumps(
            {"jsonrpc": "2.0", "id": rid, "result": result},
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _json_rpc_error(self, rid, code, message):
        body = json.dumps(
            {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}},
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)


# ─── main ──────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5180)
    ap.add_argument("--name", default="Atelier Bistro")
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), A2AHandler)
    srv.agent_card = build_agent_card(args.host, args.port, args.name)

    print(f"╭─ Mock A2A agent ─────────────────────────────")
    print(f"│  name  : {args.name}")
    print(f"│  card  : http://{args.host}:{args.port}/.well-known/agent.json")
    print(f"│  rpc   : http://{args.host}:{args.port}/")
    print(f"╰──────────────────────────────────────────────")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye.")


if __name__ == "__main__":
    main()
