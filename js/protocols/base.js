// ProtocolAdapter — 全プロトコル実装の共通インターフェース
//
// イベント:
//   "open"     接続確立 (agentCard 確定)
//   "message"  エージェントからのメッセージ受信 ({ role, text, partial? })
//   "rpc"      生のRPCフレーム (debug用) ({ dir: "out"|"in"|"err", method, payload, raw })
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
      this._emit("rpc", { dir: "out", method: "message/send (mock)", payload: rpcOut, raw: JSON.stringify(rpcOut, null, 2) });

      // 人工 delay: ユーザー入力表示が終わってからスピナーを ~3 秒回し、 LLM の
      // 思考時間っぽさを出してから応答する (短いと入力と応答が被って不自然)。
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 600));

      const reply = this._mockResolve(text);
      this._emit("message", { role: "agent", text: reply, final: true });

      const rpcIn = { jsonrpc: "2.0", id: reqId,
        result: { status: { state: "completed" }, messages: [{ role: "agent", parts: [{ kind: "text", text: reply }], messageId: `m-${turn}-a` }] } };
      this._emit("rpc", { dir: "in", method: "200 OK · message/send (mock)", payload: rpcIn, raw: JSON.stringify(rpcIn, null, 2) });
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
