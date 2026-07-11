// MockAdapter — 本物の A2A / MCP を「装う」疑似エージェント (オフライン)
// ────────────────────────────────────────────────────────
// 実通信はしない。接続先 (CloudHub 等) が無い場で、本物と同じ見た目の窓を出す。
//
// config.emulate = "a2a" | "mcp" で、どちらのプロトコルを装うかを決める:
//   - "a2a": 会話エージェント。AgentCard を合成し、chat で応答。
//            主用途は Script Editor の台本再生 (base.js の mockInstall が send を乗っ取る)。
//   - "mcp": ツールサーバ。serverInfo + tools 一覧を合成し、tools タブで callTool を再生。
//
// 「名前」がその役割を表す (例: 査定エージェント / 契約データストア)。UI 上は本物の
// A2A / MCP として振る舞い、Mock であることは表に出さない (一覧の色で内部的に区別するのみ)。

import { ProtocolAdapter } from "./base.js";

export class MockAdapter extends ProtocolAdapter {
  static get id()    { return "mock"; }
  static get label() { return "Mock"; }

  constructor(config) {
    super(config);
    // 装うプロトコル。既定は会話型 (a2a)。
    this.emulate = (config.emulate === "mcp") ? "mcp" : "a2a";
    this.turn = 0;
    this.rpcId = 0;
    // MCP 装い時のツール定義。scenario import 等で config.mockTools を渡せる。
    this.tools = Array.isArray(config.mockTools) && config.mockTools.length
      ? config.mockTools
      : null;   // null のときは name から既定ツールを合成
    this.serverInfo = null;
  }

  // 装う proto を window / UI に伝えるためのヒント (window.js が参照)。
  get emulates() { return this.emulate; }

  async connect() {
    this._setState("connecting");
    await sleep(220 + Math.random() * 200);
    this.startedAt = Date.now();
    if (this.emulate === "mcp") return this._connectMcp();
    return this._connectA2a();
  }

  // ─── A2A 装い ───────────────────────────────────────────
  _buildCard() {
    const name = (this.config?.name || "Mock Agent").trim();
    const role = (this.config?.role || this.config?.description || "").trim();
    return {
      name,
      description: role || `${name}. No real communication — replays the Script Editor exchange.`,
      url: this.config?.url || `mock://${slug(name)}`,
      version: "1.0.0",
      provider: { organization: this.config?.org || "Atelier Demo" },
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text", "markdown"],
      skills: Array.isArray(this.config?.skills) && this.config.skills.length
        ? this.config.skills
        : [{ id: "converse", name: "Converse", description: `Respond as ${name}`, tags: ["agent"] }]
    };
  }

  _connectA2a() {
    const card = this._buildCard();
    this.agentCard = card;
    this._emit("rpc", {
      dir: "out", method: "GET /.well-known/agent-card.json",
      headers: { "Accept": "application/json" }, payload: null,
      raw: `GET ${card.url}/.well-known/agent-card.json HTTP/1.1\nAccept: application/json`
    });
    this._emit("rpc", {
      dir: "in", method: "200 OK · agent card",
      headers: { "Content-Type": "application/json", "Server": "atelier-mock" },
      payload: card, raw: JSON.stringify(card, null, 2)
    });
    this._setState("open");
    this._emit("open", { card });
  }

  // 手入力時の汎用応答。台本実行時は base.mockInstall が send を上書きするのでここは通らない。
  async send(text, _opts = {}) {
    if (this.emulate === "mcp") throw new Error("MCP server does not support chat send().");
    if (this.state !== "open") throw new Error("not connected");
    this.turn += 1;
    const reqId = `req-${this.turn}`;
    const name = this.agentCard?.name || "Agent";

    const rpcOut = {
      jsonrpc: "2.0", id: reqId, method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text }], messageId: `msg-${this.turn}-u` } }
    };
    this._emit("rpc", { dir: "out", method: "message/send",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      payload: rpcOut, raw: JSON.stringify(rpcOut, null, 2) });

    await sleep(7000 + Math.random() * 3000);

    // 手入力時の応答。config.mockReply があれば、その agent の「担当範囲 + 担当外の振り先」を
    // 案内する定型文を返す (どんな質問でも筋が通る)。無ければ汎用の受領応答。
    const reply = this.config?.mockReply
      ? String(this.config.mockReply).replace(/\\n/g, "\n")
      : `I'm **${name}**. How can I help you?`;
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

  // ─── MCP 装い ───────────────────────────────────────────
  _defaultTools() {
    const name = (this.config?.name || "data").trim();
    return [
      { name: "query",  description: `Query ${name}`,
        inputSchema: { type: "object", properties: { q: { type: "string", description: "search criteria / ID" } }, required: ["q"] } },
      { name: "lookup", description: `Fetch a ${name} record by ID`,
        inputSchema: { type: "object", properties: { id: { type: "string", description: "record ID" } }, required: ["id"] } }
    ];
  }

  _connectMcp() {
    const name = (this.config?.name || "Mock MCP").trim();
    this.serverInfo = { name, version: "1.0.0" };
    if (!this.tools) this.tools = this._defaultTools();

    const initOut = { jsonrpc: "2.0", id: ++this.rpcId, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "atelier", version: "1.0" } } };
    this._emit("rpc", { dir: "out", method: "initialize",
      headers: { "Content-Type": "application/json" }, payload: initOut, raw: JSON.stringify(initOut, null, 2) });
    const initIn = { jsonrpc: "2.0", id: this.rpcId,
      result: { protocolVersion: "2025-03-26", serverInfo: this.serverInfo, capabilities: { tools: {} } } };
    this._emit("rpc", { dir: "in", method: "initialize response",
      headers: { "Content-Type": "application/json", "Server": "atelier-mock" }, payload: initIn, raw: JSON.stringify(initIn, null, 2) });

    const listOut = { jsonrpc: "2.0", id: ++this.rpcId, method: "tools/list", params: {} };
    this._emit("rpc", { dir: "out", method: "tools/list",
      headers: { "Content-Type": "application/json" }, payload: listOut, raw: JSON.stringify(listOut, null, 2) });
    const listIn = { jsonrpc: "2.0", id: this.rpcId, result: { tools: this.tools } };
    this._emit("rpc", { dir: "in", method: "tools/list response",
      headers: { "Content-Type": "application/json", "Server": "atelier-mock" }, payload: listIn, raw: JSON.stringify(listIn, null, 2) });

    this._setState("open");
    this._emit("open", { serverInfo: this.serverInfo, tools: this.tools });
  }

  async listTools() {
    if (this.state !== "open") throw new Error("not connected");
    return this.tools || [];
  }

  async callTool(name, args) {
    if (this.state !== "open") throw new Error("not connected");
    const id = ++this.rpcId;
    const callOut = { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args || {} } };
    this._emit("rpc", { dir: "out", method: `tools/call · ${name}`,
      headers: { "Content-Type": "application/json" }, payload: callOut, raw: JSON.stringify(callOut, null, 2) });

    await sleep(700 + Math.random() * 600);

    const tool = (this.tools || []).find(t => t.name === name);
    // tool.mockResult が定義されていればそれを、無ければ汎用の echo 結果を返す。
    const resultObj = (tool && tool.mockResult !== undefined)
      ? tool.mockResult
      : { ok: true, tool: name, arguments: args || {}, note: "(mock) pseudo result." };
    const text = typeof resultObj === "string" ? resultObj : JSON.stringify(resultObj, null, 2);
    const result = { content: [{ type: "text", text }], isError: false };

    const callIn = { jsonrpc: "2.0", id, result };
    this._emit("rpc", { dir: "in", method: `tools/call response · ${name}`,
      headers: { "Content-Type": "application/json", "Server": "atelier-mock" }, payload: callIn, raw: JSON.stringify(callIn, null, 2) });

    const parsed = (() => { try { return JSON.parse(text); } catch { return text; } })();
    this._emit("message", { role: "agent", text, final: true });
    return { raw: result, parsed, isError: false };
  }

  async disconnect() {
    this._setState("closed");
    this._emit("close");
  }
}

// ─── helpers ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 名前 → mock:// URL 用の slug (英数 + 日本語を許容、それ以外は除去)
export function slug(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-぀-ヿ一-龯]/g, "")
    || "agent";
}

// 表示名 + 装う proto から mock:// の合成 URL を作る (bookmark のキーに使う)。
// emulate を含めることで、同名で a2a / mcp の 2 窓を作っても衝突しない。
export function mockUrl(name, emulate = "a2a") {
  return `mock://${emulate}/${slug(name)}`;
}
