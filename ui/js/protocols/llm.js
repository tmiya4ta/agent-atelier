// LLM 直結アダプタ — OpenAI 形式 (/chat/completions) と Anthropic 形式 (/v1/messages)
//
// エージェントではなく LLM そのもの (OpenAI / Azure OpenAI 互換プロキシ / Anthropic、
// または Omni Gateway の Model Proxy) と会話する。 エージェント役として LLM を呼ぶ
// ハンズオン (Model Proxy の Kill Switch など) で、 ポリシーの効き方を見るために使う。
//
// URL:
//   base URL でも、 エンドポイントそのもの (…/chat/completions, …/v1/messages) でもよい。
//   OpenAI      https://api.openai.com/v1            → …/v1/chat/completions
//   Anthropic   https://api.anthropic.com            → …/v1/messages
//   Model Proxy https://<gw>/<base-path>             → …/<base-path>/chat/completions
//
//   モデル・システムプロンプト・max_tokens は URL のフラグメントで指定する:
//     https://…/openai/v1#model=gpt-5-mini&system=あなたは輸出管理の担当者です
//   フラグメントはサーバへ送られない。 URL がブックマーク/窓のキーなので、 別モデルは
//   別の窓になり、 保存・復元にも追加の項目が要らない。 チャットからも変えられる:
//     /model <name>   /system <text>   /reset (会話履歴を消す)   /info
//
// 認証 (identity):
//   Bearer → OpenAI 形式は Authorization: Bearer。 Anthropic 形式は、 宛先が
//   api.anthropic.com なら x-api-key に入れ替える (それ以外の Gateway は Bearer のまま)。
//   ヘッダ名を指定した identity (api-key, x-api-key など) はそのまま付く。
//
// 会話履歴は窓 (adapter) ごとに持ち、 毎回まとめて送る (どちらの API もステートレス)。
// 応答は非ストリーミング。 応答の usage は status 行 (モデル · 入力/出力トークン) に出す。

import { ProtocolAdapter, headersToObj } from "./base.js";

class LlmAdapter extends ProtocolAdapter {
  constructor(config) {
    super(config);
    const { base, opts } = splitUrl(config.url || "");
    this.baseUrl   = base;
    this.model     = opts.model || "";
    this.system    = opts.system || "";
    this.maxTokens = Number(opts.max_tokens) || 0;
    this.endpoint  = this._endpointFor(base);
    this.history   = [];          // [{ role: "user"|"assistant", content: string }]
    this.turn      = 0;
    this.lastUsage = null;
  }

  // ─── サブクラスが決めること ──────────────────────────
  _endpointFor(_base) { throw new Error("not implemented"); }
  _modelsUrl()        { throw new Error("not implemented"); }
  _authHeaders()      { throw new Error("not implemented"); }
  _buildBody()        { throw new Error("not implemented"); }
  _parseReply(_data)  { throw new Error("not implemented"); }
  _parseModels(data)  { return (data?.data || []).map(m => m.id).filter(Boolean); }

  // 接続時は通信しない。 モデル未指定のときだけ /models を引いて先頭を選ぶ
  // (Model Proxy のように /models が無い先もあるので、 失敗しても open にする)。
  async connect() {
    this._setState("connecting");
    if (!this.model) {
      try {
        this.model = pickChatModel(await this._listModels());
      } catch (e) {
        this._emit("rpc", { dir: "err", method: "model list failed", raw: String(e?.message || e) });
      }
    }
    this.agentCard = this._buildCard();
    this._setState("open");
    this.startedAt = Date.now();
    this._emit("open", { card: this.agentCard });
  }

  async _listModels() {
    await this._ensureFreshAuth();
    const url = this._modelsUrl();
    const headers = { Accept: "application/json", ...this._authHeaders() };
    this._emit("rpc", { dir: "out", method: `GET ${shortPath(url)}`, headers, raw: `GET ${url}` });
    const res = await fetch(proxify(url), { headers });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
    this._emit("rpc", { dir: res.ok ? "in" : "err", method: `${res.status} · GET ${shortPath(url)}`,
      headers: headersToObj(res.headers), payload: data ?? undefined, raw: data ? JSON.stringify(data, null, 2) : text });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return this._parseModels(data);
  }

  _buildCard() {
    return {
      name:        this.config.name || hostOf(this.baseUrl) || this.constructor.label,
      description: `${this.constructor.label} · ${this.model || "(model not set — /model <name>)"}`,
      version:     this.model || "",
      url:         this.endpoint,
      capabilities: {},
      skills: []
    };
  }

  // "open" を出し直すと窓が「Connected」を再表示して名前も変えるので、 card だけ差し替える。
  _refreshCard() { this.agentCard = this._buildCard(); }

  // 窓の「Connected · …」行に出す文 (window.js が参照)
  get connectedText() { return `Connected · ${this.constructor.label} · model ${this.model || "(not set — /model <name>)"}`; }

  // チャットのコマンド。 処理したら true。
  _command(text) {
    const m = /^\/(model|system|reset|info)\b\s*([\s\S]*)$/.exec(text.trim());
    if (!m) return false;
    const [, cmd, arg] = m;
    let reply = "";
    if (cmd === "model") {
      if (arg.trim()) { this.model = arg.trim(); this._refreshCard(); reply = `model: ${this.model}`; }
      else reply = `model: ${this.model || "(not set)"}`;
    } else if (cmd === "system") {
      this.system = arg.trim();
      reply = this.system ? `system prompt set (${this.system.length} chars)` : "system prompt cleared";
    } else if (cmd === "reset") {
      this.history = [];
      reply = "conversation history cleared";
    } else {
      // 窓は Markdown で描くので、 1 行ずつ箇条書きにする (素の改行だと詰まって見える)
      reply = [`endpoint: ${this.endpoint}`, `model: ${this.model || "(not set)"}`,
               `system: ${this.system || "(none)"}`, `history: ${this.history.length} messages`].map(l => `- ${l}`).join("\n");
    }
    this._emit("message", { role: "agent", text: reply, final: true });
    return true;
  }

  async send(text, _opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    if (this._command(text)) return;
    if (!this.model) throw new Error("model is not set — send /model <name>, or add #model=<name> to the URL");
    await this._ensureFreshAuth();

    this.turn += 1;
    const messages = [...this.history, { role: "user", content: text }];
    const body = this._buildBody(messages);
    const headers = { "Content-Type": "application/json", Accept: "application/json", ...this._authHeaders() };
    const label = `POST ${shortPath(this.endpoint)}`;
    this._emit("rpc", { dir: "out", method: label, headers, payload: body, raw: JSON.stringify(body, null, 2) });

    const ac = new AbortController();
    this._inflight = ac;
    try {
      const res = await fetch(proxify(this.endpoint), { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
      const raw = await res.text();
      let data = null; try { data = JSON.parse(raw); } catch { /* gateway の拒否は text のことがある */ }
      this._emit("rpc", { dir: res.ok ? "in" : "err", method: `${res.status} ${res.statusText || ""} · ${label}`.replace(/\s+·/, " ·"),
        headers: headersToObj(res.headers), payload: data ?? undefined, raw: data ? JSON.stringify(data, null, 2) : raw });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} — ${errorText(data, raw)}`);
        err.status = res.status;
        err.rpcLogged = true;
        throw err;
      }
      const { text: reply, usage, model } = this._parseReply(data || {});
      this.history = [...messages, { role: "assistant", content: reply }];
      this.lastUsage = usage;
      const parts = [model || this.model];
      if (usage) parts.push(`in ${usage.input} / out ${usage.output} tokens`);
      this._emit("status", { state: "completed", text: parts.join(" · ") });
      this._emit("message", { role: "agent", text: reply || "(empty response)", final: true });
    } finally {
      if (this._inflight === ac) this._inflight = null;
    }
  }
}

// ─── OpenAI 形式 ───────────────────────────────────────
export class OpenAIAdapter extends LlmAdapter {
  static get id()    { return "openai"; }
  static get label() { return "OpenAI"; }

  _endpointFor(base) {
    if (/\/chat\/completions\/?$/.test(base)) return base;
    return `${stripSlash(base)}/chat/completions`;
  }
  _modelsUrl() { return this.endpoint.replace(/\/chat\/completions\/?$/, "/models"); }

  _authHeaders() {
    const h = {};
    if (this.config.auth) h["Authorization"] = `Bearer ${this.config.auth}`;
    if (this.config.authHeaders) Object.assign(h, this.config.authHeaders);
    return h;
  }

  _buildBody(messages) {
    const msgs = this.system ? [{ role: "system", content: this.system }, ...messages] : messages;
    const body = { model: this.model, messages: msgs };
    if (this.maxTokens) body.max_completion_tokens = this.maxTokens;
    return body;
  }

  _parseReply(data) {
    const choice = data.choices?.[0] || {};
    const c = choice.message?.content;
    const text = typeof c === "string" ? c
      : Array.isArray(c) ? c.map(p => p?.text || "").join("") : "";
    const u = data.usage;
    const usage = u ? { input: u.prompt_tokens ?? u.input_tokens ?? 0, output: u.completion_tokens ?? u.output_tokens ?? 0 } : null;
    return { text, usage, model: data.model };
  }
}

// ─── Anthropic 形式 ────────────────────────────────────
export class AnthropicAdapter extends LlmAdapter {
  static get id()    { return "anthropic"; }
  static get label() { return "Anthropic"; }

  _endpointFor(base) {
    if (/\/messages\/?$/.test(base)) return base;
    const b = stripSlash(base);
    return /\/v1$/.test(b) ? `${b}/messages` : `${b}/v1/messages`;
  }
  _modelsUrl() { return this.endpoint.replace(/\/messages\/?$/, "/models"); }

  _authHeaders() {
    const h = { "anthropic-version": "2023-06-01" };
    if (this.config.auth) {
      if (hostOf(this.endpoint) === "api.anthropic.com") h["x-api-key"] = this.config.auth;
      else h["Authorization"] = `Bearer ${this.config.auth}`;
    }
    if (this.config.authHeaders) Object.assign(h, this.config.authHeaders);
    return h;
  }

  _buildBody(messages) {
    const body = { model: this.model, max_tokens: this.maxTokens || 1024, messages };
    if (this.system) body.system = this.system;
    return body;
  }

  _parseReply(data) {
    const text = (data.content || []).filter(b => b?.type === "text").map(b => b.text).join("");
    const u = data.usage;
    const usage = u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 } : null;
    return { text, usage, model: data.model };
  }
}

// ─── helpers ───────────────────────────────────────────
// "https://x/v1#model=a&system=b" → { base: "https://x/v1", opts: { model, system } }
export function splitUrl(url) {
  const i = url.indexOf("#");
  if (i < 0) return { base: url.trim(), opts: {} };
  const opts = {};
  for (const [k, v] of new URLSearchParams(url.slice(i + 1))) opts[k] = v;
  return { base: url.slice(0, i).trim(), opts };
}

// /models の一覧からチャットに使えそうなものを 1 つ選ぶ。 OpenAI 互換の一覧には
// 画像・音声・埋め込みのモデルも並ぶ (共用プロキシでは先頭が dall-e-3 だった)。
const NON_CHAT = /dall-e|whisper|tts|embed|sora|image|audio|realtime|transcribe|moderation|search|davinci|babbage/i;
export function pickChatModel(ids) {
  const chat = (ids || []).filter(id => !NON_CHAT.test(id));
  return chat[0] || "";
}

function stripSlash(s) { return String(s || "").replace(/\/+$/, ""); }
function hostOf(u) { try { return new URL(u).hostname; } catch { return ""; } }
function shortPath(u) { try { return new URL(u).pathname; } catch { return u; } }

// エラー本文の要点。 OpenAI {error:{message}}、 Anthropic {error:{message}}、
// Mule/Flex の拒否 {error:"..."} / {message:"..."}、 素の text の順に拾う。
function errorText(data, raw) {
  const e = data?.error;
  const msg = (e && typeof e === "object" ? e.message : e) || data?.message || data?.detail;
  if (msg) return String(msg);
  return String(raw || "").trim().slice(0, 300) || "(empty body)";
}

// CORS 回避: 外部オリジン宛は /proxy?url=... に書き換える (a2a.js と同じ)
function proxify(targetUrl) {
  try {
    const t = new URL(targetUrl);
    if (t.origin === location.origin) return targetUrl;
  } catch { /* fall through */ }
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}
