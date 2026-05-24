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

  // protocol identifier ("a2a", "mcp", "openai", "mock")
  static get id() { return "base"; }
  static get label() { return "Base"; }

  // helpers
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _setState(s)        { this.state = s; }
}
