// A2AAdapter — Agent2Agent プロトコル
//
// AgentCard URL の決定ルール:
//   - "*/.well-known/agent-card.json" を含む  → そのまま使用 (新仕様)
//   - "*/.well-known/agent.json"      を含む  → そのまま使用 (旧仕様)
//   - それ以外                                → "<base>/.well-known/agent-card.json" を試し、
//                                                404なら "<base>/.well-known/agent.json" にフォールバック
//
// CORS:
//   外部ドメインへのfetchはブラウザがブロックするので、
//   同一オリジンの "/proxy?url=..." 経由でリクエストする。
//   ローカル(同一オリジン)のURLは直接fetch。

import { ProtocolAdapter } from "./base.js";

export class A2AAdapter extends ProtocolAdapter {
  static get id()    { return "a2a"; }
  static get label() { return "A2A"; }

  constructor(config) {
    super(config);
    this.endpoint = normalizeUrl(config.url);
    this.rpcUrl   = null;
    this.turn = 0;
  }

  async connect() {
    this._setState("connecting");

    const candidates = candidateCardUrls(this.endpoint);

    let card = null, cardUrl = null, lastErr = null;
    for (const cu of candidates) {
      this._emit("rpc", { dir: "out", method: `GET ${cu}`, raw: `GET ${cu}\nAccept: application/json` });
      try {
        const headers = { Accept: "application/json" };
        if (this.config.auth) headers["Authorization"] = `Bearer ${this.config.auth}`;
        const res = await fetch(proxify(cu), { headers });
        if (res.status === 404) {
          this._emit("rpc", { dir: "err", method: "404 not found", raw: cu });
          continue; // 次のパスを試す
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        card = await res.json();
        cardUrl = cu;
        break;
      } catch (e) {
        lastErr = e;
        this._emit("rpc", { dir: "err", method: `fetch failed: ${cu}`, raw: String(e) });
      }
    }

    if (!card) {
      this._setState("error");
      const err = lastErr || new Error(`AgentCard not found at ${candidates.join(", ")}`);
      this._emit("error", err);
      throw err;
    }

    this.agentCard = card;
    this.rpcUrl = card.url || trimSlash(this.endpoint);

    this._emit("rpc", {
      dir: "in", method: `200 OK · agent card · ${shortPath(cardUrl)}`,
      payload: card, raw: JSON.stringify(card, null, 2)
    });

    this._setState("open");
    this.startedAt = Date.now();
    this._emit("open", { card });
  }

  async send(text, opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    this.turn += 1;
    const reqId = `req-${this.turn}`;

    const useStream = !!(opts.stream && this.agentCard?.capabilities?.streaming);
    const method = useStream ? "message/stream" : "message/send";

    const body = {
      jsonrpc: "2.0",
      id: reqId,
      method,
      params: {
        message: {
          kind: "message",                    // A2A 0.3+ で discriminator として必須
          role: "user",
          parts: [{ kind: "text", text }],
          messageId: uuid()
        },
        configuration: {}
      }
    };

    this._emit("rpc", {
      dir: "out", method, payload: body, raw: JSON.stringify(body, null, 2)
    });

    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.config.auth) headers["Authorization"] = `Bearer ${this.config.auth}`;

    try {
      const res = await fetch(proxify(this.rpcUrl), { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this._emit("rpc", {
        dir: "in", method: `200 OK · ${method}`,
        payload: data, raw: JSON.stringify(data, null, 2)
      });

      if (data.error) throw new Error(`RPC error: ${data.error.message || data.error.code}`);

      // A2A 0.3 互換: 応答が様々な形を取りうるため、テキストパートを掘り出す
      const messages = collectMessages(data.result || {});
      for (const m of messages) {
        const txt = collectText(m);
        if (txt) this._emit("message", { role: m.role || "agent", text: txt, final: true });
      }
    } catch (e) {
      this._emit("rpc", { dir: "err", method: `error: ${method}`, raw: String(e) });
      this._emit("error", e);
      throw e;
    }
  }
}

// ─── helpers ────────────────────────────────────────
function normalizeUrl(u) {
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) return "https://" + u;
  return u;
}
function trimSlash(u) { return u.replace(/\/+$/, ""); }

function candidateCardUrls(endpoint) {
  if (/\/\.well-known\/agent-card\.json\b/.test(endpoint)) return [endpoint];
  if (/\/\.well-known\/agent\.json\b/.test(endpoint))      return [endpoint];
  const base = trimSlash(endpoint);
  return [
    `${base}/.well-known/agent-card.json`,   // 新仕様 (preferred)
    `${base}/.well-known/agent.json`         // 旧仕様
  ];
}

function shortPath(u) {
  try { return new URL(u).pathname; } catch { return u; }
}

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // fallback: pseudo UUID v4
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
    (c ^ (Math.random() * 16) >> (c / 4)).toString(16)
  );
}

// CORS バイパス: 外部オリジン宛は /proxy?url=... に書き換える
function proxify(targetUrl) {
  try {
    const t = new URL(targetUrl);
    if (t.origin === location.origin) return targetUrl;
  } catch { /* fall through */ }
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// A2A 0.3+ で result の形が増えたため、複数候補を見て messages を集める
function collectMessages(result) {
  if (!result) return [];
  // Direct messages array (legacy)
  if (Array.isArray(result.messages)) return result.messages;
  if (result.message)                  return [result.message];
  // Task形式: { kind:"task", status:{ message, state }, artifacts, history }
  // 最新の応答は status.message に入るので最優先
  if (result.kind === "task") {
    const out = [];
    if (result.status?.message) out.push(result.status.message);
    if (Array.isArray(result.artifacts)) {
      for (const a of result.artifacts) {
        if (a?.parts?.length) out.push({ role: "agent", parts: a.parts });
      }
    }
    if (out.length) return out;
  }
  // Artifact 形式
  if (result.artifact?.parts) return [{ role: "agent", parts: result.artifact.parts }];
  if (Array.isArray(result.artifacts)) {
    return result.artifacts.map(a => ({ role: "agent", parts: a.parts || [] }));
  }
  // text-only fallback
  if (typeof result.text === "string") return [{ role: "agent", parts: [{ kind: "text", text: result.text }] }];
  return [];
}

function collectText(msg) {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  const parts = msg.parts || [];
  return parts
    .map(p => {
      if (p.kind === "text" && typeof p.text === "string") return p.text;
      if (p.kind === "data" && p.data != null) {
        // データパートを文字列化 (JSON 出力エージェント対策)
        try { return "```json\n" + JSON.stringify(p.data, null, 2) + "\n```"; }
        catch { return ""; }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
