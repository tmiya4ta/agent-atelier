// ProtocolAdapter — 全プロトコル実装の共通インターフェース
//
// イベント:
//   "open"     接続確立 (agentCard 確定)
//   "message"  エージェントからのメッセージ受信 ({ role, text, partial? })
//   "rpc"      生のRPCフレーム (debug用) ({ dir: "out"|"in"|"err", method, headers, payload, raw })
//              headers: out = リクエストヘッダ / in = レスポンスヘッダ (debug タブの header サブタブ用)
//   "error"    エラー発生 (Error)
//   "close"    切断

export class ProtocolAdapter extends EventTarget {
  constructor(config) {
    super();
    this.config = config;          // { url, name, auth, ... }
    this.agentCard = null;
    this.state = "idle";           // idle | connecting | open | error | closed
    this.startedAt = null;
  }

  // ライフサイクル
  async connect()   { throw new Error("connect() not implemented"); }
  async disconnect(){ this.state = "closed"; this._emit("close"); }

  // 双方向
  async send(text, opts = {}) { throw new Error("send() not implemented"); }

  // 進行中の送信 (fetch / 人工 delay) を中断する。 送信していなければ no-op。
  // 実装側は this._inflight (AbortController) を立てておけば、 基底のこの実装で中断できる。
  abort() {
    if (this._inflight) {
      try { this._inflight.abort(); } catch {}
      this._inflight = null;
    }
  }

  // protocol identifier ("a2a", "mcp", "openai", "mock")
  static get id() { return "base"; }
  static get label() { return "Base"; }

  // helpers
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _setState(s)        { this.state = s; }

  // ─── モックモード ──────────────────────────────────────────
  // adapter の send だけをローカル応答に乗っ取る (実通信なし)。
  // window / ScriptRunner / UI は無変更で、 typewriter・debug タブも本番同様に動く。
  //   entries: [{ match: "部分文字列" | "*", reply: "応答テキスト" }, ...]
  // 同じ window へ複数回送る台本は match で出し分ける。
  mockInstall(entries) {
    if (this._mockActive) return;
    this._mockActive  = true;
    this._realSend    = this.send;
    this._realState   = this.state;
    this._realCard    = this.agentCard;
    this._mockEntries = Array.isArray(entries) ? entries.slice() : [];
    this._mockSeq     = 0;   // 順番消費型 (文字列配列) の位置

    // 擬似 agentCard + open 状態 (ネット fetch なし)
    if (!this.agentCard) {
      this.agentCard = { name: this.config?.name || "mock-agent", description: "(mock mode)", version: "mock", capabilities: {}, skills: [] };
    }
    this._setState("open");
    this._emit("open", { card: this.agentCard });

    let turn = 0;
    this.send = async (text, _opts = {}) => {
      turn += 1;
      const reqId = `mock-${turn}`;
      // outgoing RPC frame (debug タブ用)
      const rpcOut = { jsonrpc: "2.0", id: reqId, method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text }], messageId: `m-${turn}-u` } } };
      this._emit("rpc", { dir: "out", method: "message/send (mock)",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        payload: rpcOut, raw: JSON.stringify(rpcOut, null, 2) });

      // 応答を先に解決して長さを測る (順番消費型なので二度呼ばない)。
      const reply = this._mockResolve(text);

      // 思考時間の見積り (LLM が考えている感)。base 7〜10s + 文字数連動、上限 26s。
      const thinkDelay = (txt) => {
        const base    = 7000 + Math.random() * 3000;
        const perChar = Math.min((txt?.length || 0) * 14, 16000);
        return Math.min(base + perChar, 26000);
      };

      // `[[STEP]]` 区切りを含む応答は、各セグメントを順番に表示する
      // (Broker が「各エージェントへの依頼を 1 つずつ」見せる演出)。
      // 最後のセグメント以外は status イベント (独立行・wait を解決しない)、
      // 最後だけ final message として出す → 台本の wait は最終セグメントで解決。
      if (typeof reply === "string" && reply.indexOf("[[STEP]]") >= 0) {
        const segs = reply.split("[[STEP]]").map(s => s.trim()).filter(Boolean);
        for (let s = 0; s < segs.length; s++) {
          const isLast = s === segs.length - 1;
          // 各ステップごとに少し考えてから出す (一気に出さず順次)
          await new Promise(r => setTimeout(r, Math.min(thinkDelay(segs[s]), isLast ? 26000 : 9000)));
          if (isLast) {
            this._emit("message", { role: "agent", text: segs[s], final: true });
          } else {
            this._emit("status", { state: "working", text: segs[s] });
          }
        }
      } else {
        await new Promise(r => setTimeout(r, thinkDelay(reply)));
        this._emit("message", { role: "agent", text: reply, final: true });
      }

      const rpcIn = { jsonrpc: "2.0", id: reqId,
        result: { status: { state: "completed" }, messages: [{ role: "agent", parts: [{ kind: "text", text: reply }], messageId: `m-${turn}-a` }] } };
      this._emit("rpc", { dir: "in", method: "200 OK · message/send (mock)",
        headers: { "Content-Type": "application/json", "Server": "atelier-mock" },
        payload: rpcIn, raw: JSON.stringify(rpcIn, null, 2) });
    };
  }

  // 入力テキストから mock 応答を解決。 2 形式を受ける:
  //   - 文字列配列 ["応答1","応答2"] (台本インライン `@` 由来) → 送信順に消費
  //   - [{match,reply}] (JSON mocks 由来) → 部分一致 / "*" で解決
  _mockResolve(text) {
    const entries = this._mockEntries || [];
    if (entries.length && typeof entries[0] === "string") {
      // 順番消費型: n 回目の send が n 番目の応答を取る
      this._mockSeq = (this._mockSeq || 0);
      const r = entries[this._mockSeq];
      this._mockSeq += 1;
      return r != null ? String(r) : `⚠️ (mock) 応答が尽きました: ${String(text||"").slice(0,40)}`;
    }
    const t = String(text || "");
    for (const e of entries) {
      const m = e && e.match;
      if (m === "*" || (m && t.indexOf(m) >= 0)) return String(e.reply ?? "");
    }
    return `⚠️ (mock) 応答が定義されていません: ${t.slice(0, 40)}`;
  }

  mockRestore() {
    if (!this._mockActive) return;
    this.send      = this._realSend;
    this.state     = this._realState;
    this.agentCard = this._realCard;
    this._mockActive = false;
    this._realSend = this._mockEntries = null;
  }
}

// fetch の Response.headers (Headers) を debug タブ用の plain object に変換する。
// proxy 経由の場合 CORS で一部ヘッダが見えないことがあるが、 見える範囲をそのまま並べる。
export function headersToObj(h) {
  const out = {};
  if (!h) return out;
  try {
    if (typeof h.forEach === "function") h.forEach((v, k) => { out[k] = v; });
    else if (typeof h === "object") Object.assign(out, h);
  } catch { /* ignore */ }
  return out;
}
