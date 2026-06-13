// MCPAdapter — Model Context Protocol (公式 spec, JSON-RPC 2.0 over HTTP)
//
// Streamable HTTP transport (MCP 2025-03-26+):
//   - 単一 endpoint POST /mcp に initialize / tools/list / tools/call を JSON-RPC で投げる
//   - GET /mcp は server-initiated stream (今は使わない)
//
// connect() 時に initialize → tools/list を打って tool 一覧を保存し、
// "open" イベントで { tools } を渡す。
// 個別 tool 呼び出しは callTool(name, args) で tools/call を投げて結果を返す。
//
// この adapter は a2a.js のように send(text) で「会話」する protocol ではない。
// chat tab は使わず、 window 側で tools tab + dynamic form を出す前提。
//
// CORS:
//   外部オリジン宛は a2a.js と同じ /proxy?url=... を経由する (proxify ヘルパは a2a.js から複製)。

import { ProtocolAdapter, headersToObj } from "./base.js";

export class MCPAdapter extends ProtocolAdapter {
  static get id()    { return "mcp"; }
  static get label() { return "MCP"; }

  constructor(config) {
    super(config);
    this.endpoint = normalizeUrl(config.url);
    this.rpcId = 0;
    this.tools = [];
    this.serverInfo = null;
    // Streamable HTTP: initialize の応答ヘッダで発行される session id。
    // 以降の全リクエストに Mcp-Session-Id ヘッダで付ける。
    this.sessionId = null;
  }

  async connect() {
    this._setState("connecting");
    this.sessionId = null;   // 再接続時に前回 session を持ち越さない
    try {
      const init = await this._rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "atelier", version: "1.0" }
      });
      this.serverInfo = init?.serverInfo || null;

      // 初期化完了通知 (no response expected)
      try {
        await this._rpc("notifications/initialized", {}, { isNotification: true });
      } catch {
        // notification 失敗は無視
      }

      const list = await this._rpc("tools/list", {});
      this.tools = Array.isArray(list?.tools) ? list.tools : [];

      this._setState("open");
      this.startedAt = Date.now();
      this._emit("open", { serverInfo: this.serverInfo, tools: this.tools });
    } catch (err) {
      this._setState("error");
      this._emit("error", err);
      throw err;
    }
  }

  async send() {
    // MCP は会話 protocol ではない。 chat 入力からの送信は無効化。
    throw new Error("MCP adapter does not support chat send(). Use callTool(name, args) instead.");
  }

  async listTools() {
    if (this.state !== "open") throw new Error("not connected");
    const list = await this._rpc("tools/list", {});
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
    return this.tools;
  }

  async callTool(name, args) {
    if (this.state !== "open") throw new Error("not connected");
    const result = await this._rpc("tools/call", { name, arguments: args || {} });
    // MCP spec: result.content[].text は文字列。 backend が JSON 文字列を入れているので
    // できればパースして UI 側に渡す。 失敗したらそのまま文字列で返す。
    const parsed = extractToolResult(result);
    // chat-compat: UI 側で chat に出したい場合があるので message も emit。
    const summary = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
    this._emit("message", { role: "agent", text: summary, final: true });
    return { raw: result, parsed, isError: !!result?.isError };
  }

  // ─── internal: JSON-RPC POST helper ───────────────────
  async _rpc(method, params, opts = {}) {
    await this._ensureFreshAuth();   // 期限切れトークンをここで更新
    const id = opts.isNotification ? undefined : ++this.rpcId;
    const body = opts.isNotification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id, method, params };

    const headers = {
      "Content-Type": "application/json",
      // Streamable HTTP: server は JSON か SSE のどちらかで返す。 両方受ける。
      "Accept":       "application/json, text/event-stream"
    };
    if (this.config.auth) headers["Authorization"] = `Bearer ${this.config.auth}`;
    if (this.config.authHeaders) Object.assign(headers, this.config.authHeaders);
    // initialize で得た session id を以降の全リクエストに付ける (無いと session 不正で弾かれる)
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    this._emit("rpc", {
      dir: "out", method, headers,
      payload: body, raw: JSON.stringify(body, null, 2)
    });

    // 停止ボタン用: tools/call 等を中断できるよう AbortController を立てる
    const ac = new AbortController();
    this._inflight = ac;

    let res;
    try {
      res = await fetch(proxify(this.endpoint), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal
      });
    } catch (e) {
      if (this._inflight === ac) this._inflight = null;
      if (e?.name === "AbortError") {
        this._emit("rpc", { dir: "err", method: `aborted · ${method}`, raw: "stopped by user" });
        this._emit("aborted", { method });
        const err = new Error("aborted by user");
        err.name = "AbortError";
        throw err;
      }
      this._emit("rpc", { dir: "err", method: `network: ${method}`, raw: String(e) });
      throw e;
    }

    if (this._inflight === ac) this._inflight = null;

    // initialize 応答などで発行される session id を捕捉して保持。
    const sid = res.headers.get("mcp-session-id");
    if (sid && !this.sessionId) this.sessionId = sid;

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      this._emit("rpc", { dir: "err", method: `HTTP ${res.status}: ${method}`, headers: headersToObj(res.headers), raw: errText });
      throw new Error(`HTTP ${res.status} on ${method}`);
    }

    if (opts.isNotification) {
      this._emit("rpc", { dir: "in", method: `${method} ack (no body)`, headers: headersToObj(res.headers), payload: {}, raw: "" });
      return null;
    }

    // Streamable HTTP: server は application/json か text/event-stream を返す。
    // SSE のときは event/data フレームから JSON-RPC 応答 (data:) を取り出す。
    const ctype = res.headers.get("content-type") || "";
    const rawText = await res.text();
    const data = ctype.includes("text/event-stream")
      ? parseSseJsonRpc(rawText)
      : (rawText ? JSON.parse(rawText) : {});

    this._emit("rpc", {
      dir: "in", method: `${method} response${ctype.includes("event-stream") ? " (SSE)" : ""}`,
      headers: headersToObj(res.headers), payload: data, raw: JSON.stringify(data, null, 2)
    });

    if (data.error) {
      const e = new Error(`RPC error ${data.error.code}: ${data.error.message}`);
      e.code = data.error.code;
      throw e;
    }
    return data.result || {};
  }
}

// SSE (text/event-stream) のボディから JSON-RPC 応答オブジェクトを取り出す。
// MCP の 1 リクエスト応答は単一の `event: message` + `data: {jsonrpc...}`。
// 複数 data 行は仕様上連結する。 result を持つ最後のフレームを採用。
function parseSseJsonRpc(text) {
  const frames = String(text || "").split(/\n\n+/);
  let last = {};
  for (const frame of frames) {
    let dataStr = "";
    for (const raw of frame.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("data:")) dataStr += (dataStr ? "\n" : "") + line.slice(5).trim();
    }
    if (!dataStr) continue;
    try {
      const obj = JSON.parse(dataStr);
      // result または error を含むフレームを優先採用
      if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
      else if (Object.keys(last).length === 0) last = obj;
    } catch { /* skip non-JSON data lines */ }
  }
  return last;
}

// ─── helpers (local copy of a2a.js's normalize / proxify) ───────────
function normalizeUrl(u) {
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) return "https://" + u;
  return u;
}

function proxify(targetUrl) {
  try {
    const t = new URL(targetUrl);
    if (t.origin === location.origin) return targetUrl;
  } catch { /* fall through */ }
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// MCP の tools/call 結果は { content:[{type:"text",text:"<json string>"}], isError }。
// text を JSON.parse できれば object を、 できなければ raw text を返す。
// content が空 / 形が違うときは raw result をそのまま返す。
function extractToolResult(result) {
  if (!result) return null;
  const content = Array.isArray(result.content) ? result.content : [];
  const textPart = content.find(p => p && p.type === "text" && typeof p.text === "string");
  if (!textPart) return result;
  const t = textPart.text;
  try { return JSON.parse(t); } catch { return t; }
}
