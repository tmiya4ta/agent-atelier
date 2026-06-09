// MockAdapter — 汎用の疑似 A2A エージェント (オフライン)
// ────────────────────────────────────────────────────────
// 実通信はしない。AgentCard は接続時に config.name から合成する。
// 「名前」だけがその役割を表す汎用エージェント (与信審査 / 不正検知 /
// インシデント / 法務 … 業種を問わない)。
//
// 応答は 2 系統:
//   1) Script Editor の台本実行 (`<` 送信 / `$>` 応答) — base.js の
//      mockInstall/mockRestore が send を順番消費型に乗っ取る。これが主用途。
//   2) チャット欄に手入力したとき — ここの send() が汎用の定型応答を返す
//      (窓を「生きてる」ように見せるための保険。台本ほど作り込まない)。

import { ProtocolAdapter } from "./base.js";

export class MockAdapter extends ProtocolAdapter {
  static get id()    { return "mock"; }
  static get label() { return "Mock"; }

  constructor(config) {
    super(config);
    this.turn = 0;
  }

  // config.name から汎用 AgentCard を組み立てる。url は mock:// の合成値。
  _buildCard() {
    const name = (this.config?.name || "Mock Agent").trim();
    const role = (this.config?.role || this.config?.description || "").trim();
    return {
      name,
      description: role || `${name} の役割を担う疑似エージェント (mock)。実通信はせず、台本 (Script Editor) のやりとりを再生します。`,
      url: this.config?.url || `mock://${slug(name)}`,
      version: "mock",
      provider: { organization: "Atelier (mock)" },
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text", "markdown"],
      skills: [
        { id: "scripted", name: "Scripted dialog", description: "Script Editor の台本 (`<` / `$>`) を再生", tags: ["mock", "demo"] }
      ]
    };
  }

  async connect() {
    this._setState("connecting");
    await sleep(220 + Math.random() * 200);

    const card = this._buildCard();
    this.agentCard = card;
    this.startedAt = Date.now();

    // debug タブ用に「AgentCard 取得」の擬似 RPC フレームを出す
    this._emit("rpc", {
      dir: "out",
      method: "GET /.well-known/agent-card.json",
      headers: { "Accept": "application/json" },
      payload: null,
      raw: `GET ${card.url}/.well-known/agent-card.json HTTP/1.1\nAccept: application/json`
    });
    this._emit("rpc", {
      dir: "in",
      method: "200 OK · agent card",
      headers: { "Content-Type": "application/json", "Server": "atelier-mock" },
      payload: card,
      raw: JSON.stringify(card, null, 2)
    });

    this._setState("open");
    this._emit("open", { card });
  }

  // 手入力時の汎用応答。台本実行時は base.mockInstall が send を上書きするので
  // ここは通らない (window/ScriptRunner は無変更)。
  async send(text, _opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    this.turn += 1;
    const reqId = `req-${this.turn}`;
    const name = this.agentCard?.name || "Mock Agent";

    const rpcOut = {
      jsonrpc: "2.0", id: reqId, method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text }], messageId: `msg-${this.turn}-u` } }
    };
    this._emit("rpc", { dir: "out", method: "message/send",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      payload: rpcOut, raw: JSON.stringify(rpcOut, null, 2) });

    await sleep(2400 + Math.random() * 600);

    const snippet = String(text || "").trim().slice(0, 60);
    const reply = `**${name}** (mock) — 受け付けました${snippet ? `: 「${snippet}${text.length > 60 ? "…" : ""}」` : ""}。\n\n` +
      `_これは疑似応答です。実際の処理は行っていません。台本 (Script Editor の \`$>\` 行) を使うと、シナリオに沿った応答を再生できます。_`;
    this._emit("message", { role: "agent", text: reply, final: true });

    const rpcIn = {
      jsonrpc: "2.0", id: reqId,
      result: { status: { state: "completed" },
        messages: [{ role: "agent", parts: [{ kind: "text", text: reply }], messageId: `msg-${this.turn}-a` }] }
    };
    this._emit("rpc", { dir: "in", method: "200 OK · message/send",
      headers: { "Content-Type": "application/json", "Server": "atelier-mock" },
      payload: rpcIn, raw: JSON.stringify(rpcIn, null, 2) });
  }

  async disconnect() {
    this._setState("closed");
    this._emit("close");
  }
}

// ─── helpers ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 名前 → mock:// URL 用の slug (英数以外をハイフンに、日本語等はそのまま encode 可能に)
export function slug(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-぀-ヿ一-龯]/g, "")
    || "agent";
}

// 表示名から mock:// の合成 URL を作る (bookmark のキーに使う)
export function mockUrl(name) {
  return `mock://${slug(name)}`;
}
