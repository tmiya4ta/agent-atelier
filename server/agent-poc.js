#!/usr/bin/env node
// agent-poc.js — MCP Host / agent loop の最小 PoC (ダミー LLM 版)
//
// 目的: Atelier を "MCP Host" にする前段として、agent loop の骨格
//   (LLM 応答 → tool_use 検出 → MCP callTool → tool_result → 再度 LLM → 最終回答)
//   が「本物の MCP ツール実行」を挟んで正しく回ることを実証する。
//
// LLM は「ダミー(決め打ち)」。プロンプトを見て決め打ちで tool_use を返し、
// tool_result を受けたら決め打ちで最終回答を出す。emu と同じ発想 —
// 中身は擬似でも プロトコル/ループの形は本物。
// ★実 LLM client (Anthropic Messages / OpenAI function calling) に
//   差し替えるのは dummyLLM() 1 関数だけ。loop 本体は無改修で実 agent になる。
//
// 使い方 (customers-mcp を :8102 で起動しておくこと):
//   node server/agent-poc.js "C-1001 の顧客情報を教えて"
//   node server/agent-poc.js "active な顧客の一覧"
//   node server/agent-poc.js "fintech の会社を探して"

const MCP_URL   = process.env.MCP_URL || "http://127.0.0.1:8102/mcp";
const MAX_STEPS = 6;

// ─── MCP client (Streamable HTTP, JSON レスポンス) ───────────
let rpcId = 0;
let sessionId = null;

async function mcpRpc(method, params, { notification = false } = {}) {
  const id = notification ? undefined : ++rpcId;
  const body = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id, method, params };
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",   // JSON で受ける (SSE を避ける)
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid && !sessionId) sessionId = sid;
  if (notification) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  const data = text ? JSON.parse(text) : {};
  if (data.error) throw new Error(`MCP RPC ${data.error.code}: ${data.error.message}`);
  return data.result || {};
}

async function mcpConnect() {
  await mcpRpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agent-poc", version: "0.1" },
  });
  try { await mcpRpc("notifications/initialized", {}, { notification: true }); } catch {}
  const list = await mcpRpc("tools/list", {});
  return Array.isArray(list.tools) ? list.tools : [];
}

async function mcpCallTool(name, args) {
  const result = await mcpRpc("tools/call", { name, arguments: args || {} });
  const parts = Array.isArray(result.content) ? result.content : [];
  const texts = parts.filter(p => p && p.type === "text").map(p => {
    try { return JSON.parse(p.text); } catch { return p.text; }
  });
  const value = texts.length === 1 ? texts[0] : texts;
  return { value, isError: !!result.isError };
}

// ─── MCP tools → Anthropic Messages 形式の tool schema ───────
// (実 Claude に差し替えたら、この配列をそのまま tools: に渡せる。
//  MCP の inputSchema は JSON Schema なので input_schema にキー名を変えるだけ)
function toAnthropicTools(mcpTools) {
  return mcpTools.map(t => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} },
  }));
}

// ─── ダミー LLM ────────────────────────────────────────────
// Anthropic Messages API 互換の応答 { role, stop_reason, content[] } を返す。
//   content: {type:"text",text} | {type:"tool_use",id,name,input}
// ★実 LLM に差し替えるのはこの関数だけ。
let toolUseSeq = 0;
function dummyLLM(messages, _tools) {
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
        text: `【ダミーLLMの最終回答】ツール結果をもとに回答します:\n${payload}` }],
    };
  }

  // 最初の user プロンプトで決め打ちルーティング
  const firstUser = messages.find(m => m.role === "user");
  const prompt = typeof firstUser?.content === "string"
    ? firstUser.content
    : (firstUser?.content || []).filter(c => c.type === "text").map(c => c.text).join(" ");

  const mk = (name, input) => ({
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: `toolu_dummy_${++toolUseSeq}`, name, input }],
  });

  // 1) 顧客ID (C-1234 / C1234) が含まれれば get_customer
  const idm = prompt.match(/C-?\d{3,}/i);
  if (idm) return mk("get_customer", { id: idm[0].toUpperCase().replace(/^C(?!-)/, "C-") });

  // 2) 一覧系 (status 語があれば絞り込み)
  if (/一覧|リスト|\blist\b|全部|すべて|全顧客/i.test(prompt)) {
    let status;
    if (/active|アクティブ|稼働/i.test(prompt))      status = "active";
    else if (/trial|トライアル|試用/i.test(prompt))  status = "trial";
    else if (/churn|解約|離脱/i.test(prompt))        status = "churned";
    return mk("list_customers", status ? { status } : {});
  }

  // 3) それ以外は検索
  const q = prompt.replace(/[。、．，!?！？]/g, " ").trim();
  return mk("search_customers", { query: q });
}

// ─── agent loop (ここが本体・実 LLM でも無改修) ──────────────
async function main() {
  const prompt = process.argv.slice(2).join(" ").trim() || "C-1001 の顧客情報を教えて";

  console.log("=".repeat(64));
  console.log("MCP Host agent loop PoC  (LLM=ダミー / MCP=customers-mcp)");
  console.log("=".repeat(64));
  console.log(`User prompt: ${prompt}\n`);

  console.log(`▶ MCP 接続: ${MCP_URL}`);
  const mcpTools = await mcpConnect();
  const tools = toAnthropicTools(mcpTools);
  console.log(`  tools/list → ${mcpTools.map(t => t.name).join(", ")}\n`);

  const messages = [{ role: "user", content: prompt }];

  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`-- step ${step} ------------------------------------`);
    const resp = dummyLLM(messages, tools);

    if (resp.stop_reason === "tool_use") {
      const tu = resp.content.find(c => c.type === "tool_use");
      console.log(`[LLM ] tool_use  ${tu.name}(${JSON.stringify(tu.input)})`);

      messages.push({ role: "assistant", content: resp.content });

      const { value, isError } = await mcpCallTool(tu.name, tu.input);
      const resultStr = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const shown = resultStr.split("\n").slice(0, 10).join("\n");
      const more  = resultStr.split("\n").length > 10 ? "\n  … (略)" : "";
      console.log(`[MCP ] callTool → ${isError ? "ERROR " : ""}${shown}${more}`);

      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tu.id,
          content: typeof value === "string" ? value : JSON.stringify(value) }],
      });
      continue;
    }

    // end_turn — 最終回答
    const finalText = resp.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    console.log(`[LLM ] end_turn\n`);
    console.log("-".repeat(64));
    console.log(finalText);
    console.log("-".repeat(64));
    return;
  }
  console.log("⚠ MAX_STEPS 到達 (loop 上限で打ち切り)");
}

main().catch(e => { console.error("PoC error:", e.message); process.exit(1); });
