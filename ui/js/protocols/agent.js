// AgentAdapter — ブラウザ内 MCP Host (LLM + 複数 MCP の tool-use ループ)
//
// A2A のように chat で会話できるが、中身は Atelier 自身が回す agent loop:
//   ユーザー入力 → LLM 応答 → tool_use 検出 → MCP callTool → tool_result → 再び LLM
//   → stop_reason=end_turn まで繰り返す。
//   MCP が 0 個なら tool 無しで普通に会話する (LLM とおしゃべり)。
//
// Claude Code の mcpServers のように、MCP サーバを複数登録できる。
//   - 接続時は 0 個で開く (window を先に開く)。
//   - Settings タブで動的に add/remove する (addServer / removeServer)。各 MCP に auth も付けられる。
//   - 全サーバの tools を prefix 付き (mcp__<srvId>__<tool>) で集約し LLM に渡す。
//   - tool_use が来たら prefix から (server, baseName) を逆引きして callTool。
//
// LLM は現状「ダミー(決め打ち)」。dummyLLM() を実 LLM 呼び出しに差し替えるだけで
// 実 agent になる (loop 本体・MCP 実行・tool schema 変換は無改修)。
//
// ⚠ 既知の制限: send() は毎回 messages を新規に組むので single-turn (会話履歴なし)。
//   ダミーは履歴を見ないので無害だが、実 LLM 化時に履歴保持を足すこと。

import { ProtocolAdapter } from "./base.js";
import { MCPAdapter }      from "./mcp.js";

const MAX_STEPS = 8;

export class AgentAdapter extends ProtocolAdapter {
  static get id()    { return "agent"; }
  static get label() { return "Agent"; }

  constructor(config) {
    super(config);
    // synthetic URL: window/bookmark 機構は (protoId, url) でキー化するので、
    // url 空だと全 Agent window が 1 キーに collapse する (dedup/reconnect 誤動作)。
    // 生成時に agent://local/<id> を振っておく (app.js 側でも同じ url を bookmark に使う)。
    if (!this.config.url) this.config.url = `agent://local/${genId()}`;
    // config.mcpServers = [{ name?, url, auth?, authHeaders? }] から復元 (永続化・Phase 2)。
    this._seed   = Array.isArray(config.mcpServers) ? config.mcpServers.slice() : [];
    this.servers = [];   // [{ id, name, url, auth, authHeaders, mcp, tools, state, error }]
    this._srvSeq = 0;
    this.turn    = 0;
  }

  resetContext() { this.turn = 0; }

  async connect() {
    this._setState("connecting");
    // 0 個でも即 open (MCP は後から Settings で add。tool 無しでも会話はできる)
    this.agentCard = this._buildCard();
    this._setState("open");
    this.startedAt = Date.now();
    this._emit("open", { card: this.agentCard });
    // seed の MCP を順に接続 (失敗しても open は維持)
    for (const s of this._seed) {
      try { await this.addServer(s); } catch { /* keep going */ }
    }
  }

  async disconnect() {
    for (const s of this.servers) { try { await s.mcp?.disconnect(); } catch {} }
    this.servers = [];
    await super.disconnect();
  }

  // 停止ボタン: 進行中の MCP fetch を全部止める
  abort() {
    for (const s of this.servers) { try { s.mcp?.abort(); } catch {} }
    super.abort();
  }

  // ─── MCP サーバの動的追加/削除 (Settings から呼ぶ) ───────────
  async addServer({ url, auth, authHeaders, name } = {}) {
    if (!url) throw new Error("url required");
    const id  = `s${++this._srvSeq}`;
    const rec = { id, name: name || hostLabel(url), url, auth: auth || undefined,
                  authHeaders: authHeaders || undefined,
                  mcp: null, tools: [], state: "connecting", error: null };
    this.servers.push(rec);
    this._emit("servers-changed", { servers: this.serverSummaries() });

    try {
      const mcp = new MCPAdapter({
        url, auth: rec.auth,
        authHeaders: rec.authHeaders || this.config.authHeaders,
        refreshAuth: this.config.refreshAuth
      });
      // 各 MCP の生フレーム (initialize / tools/list / tools/call) を debug へ転送。
      // どのサーバか分かるよう method に [name] を付ける。
      mcp.addEventListener("rpc", (e) => {
        const d = e.detail || {};
        this._emit("rpc", { ...d, method: `[${rec.name}] ${d.method || ""}` });
      });
      rec.mcp = mcp;
      await mcp.connect();
      rec.tools = Array.isArray(mcp.tools) ? mcp.tools : [];
      rec.state = "open";
    } catch (e) {
      rec.state = "error";
      rec.error = e?.message || String(e);
    }
    this.agentCard = this._buildCard();
    this._emit("servers-changed", { servers: this.serverSummaries() });
    return rec.state;
  }

  async removeServer(id) {
    const i = this.servers.findIndex(s => s.id === id);
    if (i < 0) return;
    const [rec] = this.servers.splice(i, 1);
    try { await rec.mcp?.disconnect(); } catch {}
    this.agentCard = this._buildCard();
    this._emit("servers-changed", { servers: this.serverSummaries() });
  }

  // window (Settings) が描画に使う軽量サマリ
  serverSummaries() {
    return this.servers.map(s => ({
      id: s.id, name: s.name, url: s.url, state: s.state, error: s.error,
      toolCount: s.tools.length, hasAuth: !!(s.auth || s.authHeaders)
    }));
  }

  // 永続化用 (Phase 2): 復元に必要な最小情報
  serverConfigs() {
    return this.servers.map(s => ({ name: s.name, url: s.url, auth: s.auth, authHeaders: s.authHeaders }));
  }

  _buildCard() {
    const tools = this._allTools();
    return {
      name:        this.config.name || "agent",
      description: `ブラウザ内 MCP Host (LLM 現状ダミー)。MCP servers: ${this.servers.length} / tools: ${tools.length}。`,
      version:     "poc",
      capabilities: {},
      skills: tools.map(t => ({ id: t.name, name: t.name, description: t.description }))
    };
  }

  // 全 MCP の tools を prefix 付き (mcp__<srvId>__<tool>) で集約。名前衝突を回避。
  _allTools() {
    const out = [];
    for (const s of this.servers) {
      if (s.state !== "open") continue;
      for (const t of s.tools) {
        out.push({
          name:         `mcp__${s.id}__${t.name}`,
          description:  `[${s.name}] ${t.description || ""}`,
          input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} },
          _srv: s.id, _base: t.name
        });
      }
    }
    return out;
  }

  // prefix 名 → { srv, base }
  _resolveTool(name) {
    const m = /^mcp__(s\d+)__(.+)$/.exec(name || "");
    if (!m) return null;
    const srv = this.servers.find(s => s.id === m[1]);
    return srv ? { srv, base: m[2] } : null;
  }

  // ─── agent loop 本体 (実 LLM でも無改修) ───────────────────
  async send(text, _opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    const tools = this._allTools();   // 毎回 live 再読 (mid-session 追加を拾う)
    // tools が 0 個でも普通に会話する (ダミーはツール無しなら dummyChat を返す)。
    this.turn += 1;
    const messages = [{ role: "user", content: text }];

    for (let step = 1; step <= MAX_STEPS; step++) {
      const resp = dummyLLM(messages, tools);
      this._emit("rpc", {
        dir: "out", method: `LLM · step ${step} (dummy)`,
        headers: { "Content-Type": "application/json" },
        payload: { model: "dummy", messages, tools }, raw: JSON.stringify({ messages, tools }, null, 2)
      });
      this._emit("rpc", { dir: "in", method: `LLM · ${resp.stop_reason}`, payload: resp, raw: JSON.stringify(resp, null, 2) });

      if (resp.stop_reason === "tool_use") {
        const tu = resp.content.find(c => c.type === "tool_use");
        this._emit("status", { state: "working", text: `🔧 ${tu.name}(${JSON.stringify(tu.input)})` });
        messages.push({ role: "assistant", content: resp.content });

        const resolved = this._resolveTool(tu.name);
        let contentStr, isError = false;
        if (!resolved) {
          isError = true; contentStr = `unknown tool: ${tu.name}`;
        } else {
          try {
            const out = await resolved.srv.mcp.callTool(resolved.base, tu.input);
            isError = !!out.isError;
            contentStr = typeof out.parsed === "string" ? out.parsed : JSON.stringify(out.parsed);
          } catch (e) {
            if (e?.name === "AbortError") { this._emit("aborted", { method: "tools/call" }); throw e; }
            isError = true; contentStr = `tool error: ${e.message}`;
          }
        }
        messages.push({ role: "user",
          content: [{ type: "tool_result", tool_use_id: tu.id, content: contentStr, is_error: isError }] });
        continue;
      }

      // end_turn — 最終回答
      const finalText = resp.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      this._emit("message", { role: "agent", text: finalText, final: true });
      return;
    }
    this._emit("message", { role: "agent", text: "⚠️ MAX_STEPS 到達 (loop 上限で打ち切り)", final: true });
  }
}

// ─── ダミー LLM (server/agent-poc.js と同じ決め打ち) ────────────
// tools は prefix 付き名 (mcp__<srvId>__<tool>) なので、base 名で判定して
// prefix 付きの完全名で tool_use を返す。★実 LLM に差し替えるのはこの関数だけ。
let toolUseSeq = 0;
function dummyLLM(messages, tools) {
  const lastMsg = messages[messages.length - 1];
  const hasToolResult = lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)
    && lastMsg.content.some(c => c.type === "tool_result");
  if (hasToolResult) {
    const tr = lastMsg.content.find(c => c.type === "tool_result");
    return { role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: `【ダミーLLMの最終回答】ツール結果をもとに回答します:\n${tr ? tr.content : ""}` }] };
  }

  const firstUser = messages.find(m => m.role === "user");
  const prompt = typeof firstUser?.content === "string"
    ? firstUser.content
    : (firstUser?.content || []).filter(c => c.type === "text").map(c => c.text).join(" ");

  // base 名 → prefix 付き完全名 の逆引き (最初に見つかったサーバを採用)
  const byBase = new Map();
  for (const t of (tools || [])) {
    const base = /^mcp__s\d+__(.+)$/.exec(t.name)?.[1] || t.name;
    if (!byBase.has(base)) byBase.set(base, t.name);
  }
  const mk = (base, input) => ({
    role: "assistant", stop_reason: "tool_use",
    content: [{ type: "tool_use", id: `toolu_dummy_${++toolUseSeq}`,
                name: byBase.get(base) || (tools[0] && tools[0].name), input }]
  });

  // 1) 顧客ID → get_customer
  const idm = prompt.match(/C-?\d{3,}/i);
  if (idm && byBase.has("get_customer")) {
    return mk("get_customer", { id: idm[0].toUpperCase().replace(/^C(?!-)/, "C-") });
  }
  // 2) 一覧系
  if (byBase.has("list_customers") && /一覧|リスト|\blist\b|全部|すべて|全顧客/i.test(prompt)) {
    let status;
    if (/active|アクティブ|稼働/i.test(prompt))      status = "active";
    else if (/trial|トライアル|試用/i.test(prompt))  status = "trial";
    else if (/churn|解約|離脱/i.test(prompt))        status = "churned";
    return mk("list_customers", status ? { status } : {});
  }
  // 3) 検索
  if (byBase.has("search_customers")) {
    const q = prompt.replace(/[。、．，!?！？]/g, " ").trim();
    return mk("search_customers", { query: q });
  }
  // 4) tools はあるが該当なし → 最初のツールを引数なしで (ダミーの苦しい fallback)
  const first = (tools || [])[0];
  if (first) {
    return { role: "assistant", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: `toolu_dummy_${++toolUseSeq}`, name: first.name, input: {} }] };
  }
  // 5) tools が 0 個 → 普通のおしゃべり (MCP 無しでも会話できる)
  return { role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text: dummyChat(prompt) }] };
}

// ツール無しのおしゃべり応答 (ダミーなので定型)。★実 LLM ならここも普通の会話になる。
function dummyChat(prompt) {
  const p = (prompt || "").trim();
  if (!p) return "(ダミー LLM) メッセージをどうぞ。";
  if (/^(こんにちは|こんばんは|おはよう|やあ|hi|hello|hey)\b/i.test(p)) {
    return "こんにちは! ダミー LLM です。Settings タブの「MCP servers」でツールを追加すると、それを使って答えられるようになります。";
  }
  return `(ダミー LLM) 「${p}」を受け取りました。今はツールが無いので普通に返事するだけです。Settings で MCP を追加するとツールを使えます。`;
}

function genId() {
  try { if (crypto?.randomUUID) return crypto.randomUUID().slice(0, 8); } catch {}
  return Math.floor(Math.random() * 1e9).toString(36);
}
function hostLabel(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).host; }
  catch { return url; }
}
