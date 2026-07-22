// AgentAdapter — ブラウザ内 MCP Host (LLM + MCP tool-use ループ)
//
// A2A のように chat で会話できるが、中身は Atelier 自身が回す agent loop:
//   ユーザー入力 → LLM 応答 → tool_use 検出 → MCP callTool → tool_result → 再び LLM
//   → stop_reason=end_turn まで繰り返す。
//
// LLM は現状「ダミー(決め打ち)」。server/agent-poc.js の dummyLLM をそのまま移植。
// Anthropic Messages API 互換の応答 { role, stop_reason, content[] } を返すので、
// ★ dummyLLM() を実 LLM 呼び出し (fetch /proxy → api.anthropic.com 等) に差し替える
//   だけで実 agent になる。loop 本体・MCP 実行・tool schema 変換は無改修。
//
// MCP 実行は既存 MCPAdapter を composition で内部利用する:
//   - config.url = 使う MCP サーバの endpoint (MCP window で繋がる URL がそのまま使える)
//   - connect() で MCP に接続 → tools/list を LLM の tool schema に変換
//   - MCP の "rpc" を転送するので、tools/call の生 JSON-RPC も debug タブに出る
//
// 可視化:
//   - LLM の各ステップ → "rpc" (debug タブに llm request/response)
//   - tool 呼び出し → "status" (chat に「🔧 calling ...」を逐次表示)
//   - 最終回答 → "message" (通常の agent メッセージ)

import { ProtocolAdapter } from "./base.js";
import { MCPAdapter }      from "./mcp.js";

const MAX_STEPS = 6;

export class AgentAdapter extends ProtocolAdapter {
  static get id()    { return "agent"; }
  static get label() { return "Agent"; }

  constructor(config) {
    super(config);
    this.mcpUrl = config.url;
    this.mcp    = null;   // 内部 MCPAdapter
    this.tools  = [];     // Anthropic 形式の tool 定義
    this.turn   = 0;
  }

  // chat の「履歴クリア」から呼ばれる (window.js)。会話状態を持たないので turn だけ戻す。
  resetContext() { this.turn = 0; }

  async connect() {
    this._setState("connecting");
    try {
      // ── 内部 MCP に接続 ──
      this.mcp = new MCPAdapter({
        url:          this.mcpUrl,
        auth:         this.config.auth,
        authHeaders:  this.config.authHeaders,
        authRef:      this.config.authRef,
        refreshAuth:  this.config.refreshAuth
      });
      // MCP の生フレーム (initialize / tools/list / tools/call) を debug タブへ転送
      this.mcp.addEventListener("rpc", (e) => this._emit("rpc", e.detail));

      await this.mcp.connect();
      this.tools = toAnthropicTools(this.mcp.tools);

      // agent card 相当 (A2A window の card タブに「使える tools」を見せる)
      const srvName = this.mcp.serverInfo?.name || "mcp";
      this.agentCard = {
        name:        this.config.name || `agent · ${srvName}`,
        description: `ダミー LLM + MCP tool-use ループ。tool source = ${srvName}。`,
        version:     "poc",
        capabilities: {},
        skills: this.tools.map(t => ({ id: t.name, name: t.name, description: t.description }))
      };

      this._setState("open");
      this.startedAt = Date.now();
      this._emit("open", { card: this.agentCard });
    } catch (err) {
      this._setState("error");
      this._emit("error", err);
      throw err;
    }
  }

  async disconnect() {
    try { await this.mcp?.disconnect(); } catch { /* ignore */ }
    this.mcp = null;
    await super.disconnect();
  }

  // 停止ボタン: 進行中の MCP fetch を中断する
  abort() {
    try { this.mcp?.abort(); } catch { /* ignore */ }
    super.abort();
  }

  // ── agent loop 本体 (ここは実 LLM でも無改修) ──
  async send(text, _opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    this.turn += 1;
    const messages = [{ role: "user", content: text }];

    for (let step = 1; step <= MAX_STEPS; step++) {
      const resp = dummyLLM(messages, this.tools);

      // LLM 往復を debug に出す (実 LLM 化したときと同じ見え方)
      this._emit("rpc", {
        dir: "out", method: `LLM · step ${step} (dummy)`,
        headers: { "Content-Type": "application/json" },
        payload: { model: "dummy", messages, tools: this.tools },
        raw: JSON.stringify({ messages, tools: this.tools }, null, 2)
      });
      this._emit("rpc", {
        dir: "in", method: `LLM · ${resp.stop_reason}`,
        payload: resp, raw: JSON.stringify(resp, null, 2)
      });

      if (resp.stop_reason === "tool_use") {
        const tu = resp.content.find(c => c.type === "tool_use");
        // chat に逐次「何を呼んでいるか」を出す
        this._emit("status", { state: "working", text: `🔧 ${tu.name}(${JSON.stringify(tu.input)})` });

        // assistant の tool_use を履歴へ
        messages.push({ role: "assistant", content: resp.content });

        // 実際に MCP を叩く (tools/call の rpc は転送済みなので debug に出る)
        let contentStr, isError = false;
        try {
          const out = await this.mcp.callTool(tu.name, tu.input);
          isError = !!out.isError;
          contentStr = typeof out.parsed === "string" ? out.parsed : JSON.stringify(out.parsed);
        } catch (e) {
          if (e?.name === "AbortError") { this._emit("aborted", { method: "tools/call" }); throw e; }
          isError = true;
          contentStr = `tool error: ${e.message}`;
        }

        // tool_result を履歴へ
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: tu.id, content: contentStr, is_error: isError }]
        });
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

// ─── MCP tools → Anthropic Messages 形式の tool schema ───────────
// MCP の inputSchema は JSON Schema なので input_schema にキー名を変えるだけ。
function toAnthropicTools(mcpTools) {
  return (Array.isArray(mcpTools) ? mcpTools : []).map(t => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} }
  }));
}

// ─── ダミー LLM (server/agent-poc.js と同じロジック) ────────────
// Anthropic Messages API 互換の応答 { role, stop_reason, content[] } を返す。
//   content: {type:"text",text} | {type:"tool_use",id,name,input}
// ★実 LLM に差し替えるのはこの関数だけ。
let toolUseSeq = 0;
function dummyLLM(messages, tools) {
  // 直近が tool_result なら「最終回答フェーズ」
  const lastMsg = messages[messages.length - 1];
  const hasToolResult = lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)
    && lastMsg.content.some(c => c.type === "tool_result");

  if (hasToolResult) {
    const tr = lastMsg.content.find(c => c.type === "tool_result");
    const payload = tr ? tr.content : "";
    return {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text",
        text: `【ダミーLLMの最終回答】ツール結果をもとに回答します:\n${payload}` }]
    };
  }

  const firstUser = messages.find(m => m.role === "user");
  const prompt = typeof firstUser?.content === "string"
    ? firstUser.content
    : (firstUser?.content || []).filter(c => c.type === "text").map(c => c.text).join(" ");

  const toolNames = new Set((tools || []).map(t => t.name));
  const mk = (name, input) => ({
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: `toolu_dummy_${++toolUseSeq}`, name, input }]
  });

  // 1) 顧客ID (C-1234 / C1234) が含まれれば get_customer
  const idm = prompt.match(/C-?\d{3,}/i);
  if (idm && toolNames.has("get_customer")) {
    return mk("get_customer", { id: idm[0].toUpperCase().replace(/^C(?!-)/, "C-") });
  }

  // 2) 一覧系
  if (toolNames.has("list_customers") && /一覧|リスト|\blist\b|全部|すべて|全顧客/i.test(prompt)) {
    let status;
    if (/active|アクティブ|稼働/i.test(prompt))      status = "active";
    else if (/trial|トライアル|試用/i.test(prompt))  status = "trial";
    else if (/churn|解約|離脱/i.test(prompt))        status = "churned";
    return mk("list_customers", status ? { status } : {});
  }

  // 3) 検索
  if (toolNames.has("search_customers")) {
    const q = prompt.replace(/[。、．，!?！？]/g, " ").trim();
    return mk("search_customers", { query: q });
  }

  // 4) fallback: 最初のツールを引数なしで呼ぶ (customers 以外の MCP でも一応動かす)
  const first = (tools || [])[0];
  if (first) return mk(first.name, {});

  // ツールが1つも無い → そのまま回答
  return {
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "(ダミーLLM) 使えるツールがありません。" }]
  };
}
