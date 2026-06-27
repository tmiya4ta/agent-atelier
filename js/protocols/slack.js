// SlackAdapter — Slack 互換 Web API (chat.postMessage / auth.test)
// 想定サーバ: Slack 本体 (https://slack.com) または Slack 互換 mock サーバ
//
// 認証: Bearer Token (xoxb-... / xoxp-...)
// 送信: POST {baseUrl}/api/chat.postMessage  body: { channel, text }
// 返答: 同期 reply (mock 用) — レスポンスに { bot_reply | reply | message.text } があれば agent message として emit
//       実 Slack の場合は別途 Events API / Socket Mode が必要 (今は未実装)

import { ProtocolAdapter, headersToObj } from "./base.js";

const proxify = (url) => `/proxy?url=${encodeURIComponent(url)}`;

export class SlackAdapter extends ProtocolAdapter {
  static get id()    { return "slack"; }
  static get label() { return "Slack"; }

  constructor(config) {
    super(config);
    this.baseUrl = normalizeUrl(config.url);
    this.token   = config.auth || "";
    this.channel = config.channel || "general";
    this.turn    = 0;
  }

  async connect() {
    this._setState("connecting");
    try {
      const auth = await this._call("auth.test", {});
      if (!auth.ok) throw new Error(auth.error || "auth.test failed");
      this.identity = auth;
      // 仮想 agent card (UI 共通 pane で表示するため)
      this.agentCard = {
        name:        this.config.name || auth.user || `Slack · #${this.channel}`,
        description: `Slack workspace${auth.team ? ` · ${auth.team}` : ""} · channel #${this.channel}`,
        url:         this.baseUrl,
        version:     "slack-web-api",
        provider:    { organization: auth.team || "Slack" },
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes:  ["text", "mrkdwn"],
        defaultOutputModes: ["text", "mrkdwn"],
        skills: [
          { id: "post-message", name: "chat.postMessage", description: "Post a message", tags: ["slack"] }
        ]
      };
      this.startedAt = Date.now();
      this._setState("open");
      this._emit("open", { card: this.agentCard });
    } catch (e) {
      this._setState("error");
      this._emit("error", e);
      throw e;
    }
  }

  async send(text, _opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    this.turn += 1;
    const data = await this._call("chat.postMessage", {
      channel:   this.channel,
      text,
      as_user:   true,
      mrkdwn:    true
    });
    if (!data.ok) {
      this._emit("message", { role: "system", text: `error: ${data.error || "unknown"}`, final: true });
      throw new Error(data.error || "post failed");
    }
    // mock の場合は同期で reply が返る想定
    const reply = data.bot_reply || data.reply || data.message?.bot_reply || data.message?.reply;
    if (reply) {
      this._emit("message", { role: "agent", text: String(reply), final: true });
    }
  }

  async _call(method, body) {
    const url = `${this.baseUrl}/api/${method}`;
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Accept":       "application/json"
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    this._emit("rpc", { dir: "out", method, headers, payload: body, raw: JSON.stringify(body, null, 2) });
    try {
      const res = await fetch(proxify(url), {
        method:  "POST",
        headers,
        body:    JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({ ok: false, error: `non-json response (HTTP ${res.status})` }));
      this._emit("rpc", {
        dir: "in",
        method: `${res.status} · ${method}`,
        headers: headersToObj(res.headers),
        payload: data,
        raw: JSON.stringify(data, null, 2)
      });
      return data;
    } catch (e) {
      this._emit("rpc", { dir: "err", method: `error: ${method}`, raw: String(e) });
      throw e;
    }
  }
}

function normalizeUrl(u) {
  if (!u) return "";
  let s = u.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}
