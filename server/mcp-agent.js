#!/usr/bin/env node
/**
 * mcp-agent — Atelier の A2A window が動的に登録した MCP サーバの URL を受け取り、
 * このエージェント自身が MCP クライアントとして tools/list・tools/call を直接叩く
 * A2A (legacy JSON-RPC) 対応のデモエージェント。
 *
 *   node server/mcp-agent.js [--port 8105]
 *
 * このエージェントは固定の MCP サーバを持たない。 呼び出し元 (Atelier) がメッセージの
 * data part に {mcpServers:[{url,name}]} を乗せてくるので、その場で対象 MCP へ
 * initialize → tools/list → (該当すれば) tools/call を実行し、1 ターンで最終回答を返す。
 * ツール実行は常にこのエージェント自身が行う (呼び出し元には投げ返さない)。
 *
 * mcpServers が無い (data part 無し) ときは、これまで通り普通に会話するだけ。
 *
 * A2A ワイヤーは legacy 形式のみ実装 (method: "message/send", kind 判別子あり)。
 * Atelier の a2a.js クライアントは常にこの形式を先に試すため、proto (SendMessage) は不要。
 *
 * エンドポイント:
 *   GET  /.well-known/agent-card.json : AgentCard (url フィールドを必ず含める)
 *   POST /a2a                          : JSON-RPC 2.0 (message/send)
 *   GET  /health
 */
"use strict";
const http = require("http");

const PORT = Number(process.env.PORT) || (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : 8105;
})();
// このサーバ自身の公開 base URL。 AgentCard.url に絶対 URL で入れる必要があるため、
// Caddy 経由で公開するときは環境変数で実際のホスト名を渡す。 未設定時は素の host:port。
const PUBLIC_BASE = process.env.PUBLIC_BASE || "";

function ts() { return new Date().toISOString(); }
function log(...a) { console.log(ts(), ...a); }

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ─── MCP クライアント (Streamable HTTP, 最小実装。 ui/js/protocols/mcp.js の
//     サーバ版相当。 セッション毎に initialize してすぐ捨てる stateless な使い方) ───
let mcpRpcSeq = 0;
async function mcpRpc(url, sessionId, method, params, isNotification) {
  const id = isNotification ? undefined : ++mcpRpcSeq;
  const body = isNotification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id, method, params };
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const newSessionId = res.headers.get("mcp-session-id") || sessionId;
  if (isNotification) return { sessionId: newSessionId, result: null };
  const ctype = res.headers.get("content-type") || "";
  const rawText = await res.text();
  const data = ctype.includes("text/event-stream") ? parseSseJsonRpc(rawText) : (rawText ? JSON.parse(rawText) : {});
  if (data.error) throw new Error(data.error.message || "MCP error");
  return { sessionId: newSessionId, result: data.result };
}

// SSE ボディから JSON-RPC 応答を取り出す。
// 1 レスポンスを複数の data: フレームに分けて流すサーバがある
// (customers-mcp の list_customers は 1 件ずつ {seq, of, customer} で送る)。
// 最後のフレームだけ採ると件数が落ちるので、 result を持つフレームは全部集める。
// 単一フレームなら従来どおりそのまま、 複数なら { streamed, frames } にまとめる。
function parseSseJsonRpc(text) {
  const results = [];
  let errored = null, id;
  for (const frame of String(text || "").split(/\n\n+/)) {
    let dataStr = "";
    for (const raw of frame.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("data:")) dataStr += (dataStr ? "\n" : "") + line.slice(5).trim();
    }
    if (!dataStr) continue;
    try {
      const obj = JSON.parse(dataStr);
      if (obj.id !== undefined) id = obj.id;
      if (obj.error !== undefined) errored = obj;
      else if (obj.result !== undefined) results.push(obj.result);
    } catch { /* 壊れたフレームは飛ばす */ }
  }
  if (errored) return errored;
  if (!results.length) return {};
  if (results.length === 1) return { jsonrpc: "2.0", id, result: results[0] };
  return { jsonrpc: "2.0", id, result: { streamed: true, count: results.length, frames: results } };
}

async function mcpListTools(url) {
  let session = (await mcpRpc(url, null, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mcp-agent", version: "0.1.0" },
  })).sessionId;
  await mcpRpc(url, session, "notifications/initialized", {}, true);
  const { result } = await mcpRpc(url, session, "tools/list", {});
  return { session, tools: Array.isArray(result?.tools) ? result.tools : [] };
}

async function mcpCallTool(url, session, name, args) {
  const { result } = await mcpRpc(url, session, "tools/call", { name, arguments: args || {} });
  const content = result?.content?.[0]?.text;
  return { isError: !!result?.isError, content: content ?? JSON.stringify(result ?? {}) };
}

// ユーザー発話 + 渡された tools 一覧 → 呼ぶ tool をルールベースで決める (dummyLLM 相当・LLM 不使用)。
// tools はどの MCP サーバのものかを覚えておく必要があるので { tool, srv } で返す。
function pickTool(text, toolsBySrv) {
  const t = text.toLowerCase();
  const find = (name) => {
    for (const { srv, tools } of toolsBySrv) {
      const tool = tools.find(x => x.name === name);
      if (tool) return { tool, srv };
    }
    return null;
  };

  const idMatch = text.match(/C-\d{3,4}/i);
  if (idMatch) { const f = find("get_customer"); if (f) return { ...f, args: { id: idMatch[0].toUpperCase() } }; }
  if (/(検索|さがして|探して|search)/.test(text)) {
    const f = find("search_customers");
    if (f) {
      const q = text.replace(/(検索|さがして|探して|search|して|を|で)/g, " ").trim().split(/\s+/).filter(Boolean).pop() || text;
      return { ...f, args: { query: q } };
    }
  }
  if (/(トライアル|trial)/.test(t)) { const f = find("list_customers"); if (f) return { ...f, args: { status: "trial" } }; }
  if (/(解約|churn)/.test(t)) { const f = find("list_customers"); if (f) return { ...f, args: { status: "churned" } }; }
  if (/(顧客|customer|一覧|リスト|list)/.test(t)) { const f = find("list_customers"); if (f) return { ...f, args: {} }; }
  return null;
}

function formatCustomer(c) {
  return `${c.name}(${c.company})\nID: ${c.id} / プラン: ${c.plan} / ステータス: ${c.status} / MRR: ${c.mrr}\nメール: ${c.email}`;
}
function formatCustomerList(result, title) {
  if (!result.customers || !result.customers.length) return `${title}該当する顧客が見つかりませんでした。`;
  const lines = result.customers.map(c => `- ${c.id} ${c.name}(${c.company}) / ${c.plan} / ${c.status}`);
  return `${title}${result.count}件見つかりました。\n${lines.join("\n")}`;
}
function formatToolResult(name, args, contentStr) {
  try {
    const parsed = JSON.parse(contentStr);
    if (name === "get_customer") return formatCustomer(parsed);
    if (name === "list_customers") return formatCustomerList(parsed, "");
    if (name === "search_customers") return formatCustomerList(parsed, args.query ? `「${args.query}」で` : "");
    return contentStr;
  } catch { return contentStr; }
}

// 渡された mcpServers それぞれに tools/list を打ち、まとめて返す。 1 台落ちていても他は使う。
async function gatherTools(mcpServers) {
  const out = [];
  for (const srv of mcpServers || []) {
    try {
      const { session, tools } = await mcpListTools(srv.url);
      out.push({ srv: { ...srv, session }, tools });
    } catch (e) {
      log(`tools/list failed for ${srv.url}: ${e.message}`);
    }
  }
  return out;
}

async function respond(text, mcpServers) {
  if (!mcpServers || !mcpServers.length) {
    return "MCP サーバが登録されていません。A2A window の Settings で MCP サーバを追加すると、そのツールを使って答えられるようになります。";
  }
  const toolsBySrv = await gatherTools(mcpServers);
  const allNames = toolsBySrv.flatMap(t => t.tools.map(x => x.name));
  if (!allNames.length) return "登録された MCP サーバからツールを取得できませんでした。";

  const pick = pickTool(text, toolsBySrv);
  if (!pick) return `渡された tools(${allNames.join(", ")}) の中に該当するものが見つかりませんでした。`;

  try {
    const out = await mcpCallTool(pick.srv.url, pick.srv.session, pick.tool.name, pick.args);
    if (out.isError) return `ツール呼び出しに失敗しました: ${out.content}`;
    return formatToolResult(pick.tool.name, pick.args, out.content);
  } catch (e) {
    return `ツール呼び出しに失敗しました: ${e.message}`;
  }
}

function agentCard(base) {
  return {
    protocolVersion: "0.3.0",
    name: "MCP Customer Agent",
    description: "呼び出し元 (Atelier) が動的に渡す MCP サーバへ、自分で接続してツールを実行するデモエージェント。",
    url: `${base}/a2a`,
    version: "0.2.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      { id: "customer-lookup", name: "顧客情報検索", description: "渡された MCP サーバの顧客情報ツールを使って回答する。", tags: ["customers", "mcp"] },
    ],
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, A2A-Version",
    });
    res.end();
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const base = PUBLIC_BASE || `http://${req.headers.host}`;

  if (req.method === "GET" && u.pathname === "/health") {
    sendJson(res, 200, { status: "ok", time: ts() });
    return;
  }

  if (req.method === "GET" && u.pathname === "/.well-known/agent-card.json") {
    sendJson(res, 200, agentCard(base));
    return;
  }

  if (req.method === "POST" && u.pathname === "/a2a") {
    let msg;
    try { msg = JSON.parse(await readBody(req)); }
    catch { sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }

    const { id, method, params } = msg;
    if (method !== "message/send" && method !== "message/stream") {
      sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    const userMessage = params && params.message || {};
    const parts = userMessage.parts || [];
    const text = parts.filter(p => p.kind === "text").map(p => p.text).join("\n");
    const dataParts = parts.filter(p => p.kind === "data" && p.data);
    const mcpServersData = dataParts.find(p => Array.isArray(p.data.mcpServers));
    const mcpServers = mcpServersData?.data.mcpServers || [];
    const contextId = userMessage.contextId;

    log(`message/send: ${JSON.stringify(text).slice(0, 200)} (mcpServers: ${mcpServers.length})`);

    let replyText;
    try { replyText = await respond(text, mcpServers); }
    catch (e) { replyText = `内部エラー: ${e.message}`; }

    const result = {
      kind: "message", role: "agent",
      parts: [{ kind: "text", text: replyText }],
      messageId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, contextId,
    };
    sendJson(res, 200, { jsonrpc: "2.0", id, result });
    return;
  }

  sendJson(res, 404, { error: `no route for ${req.method} ${u.pathname}` });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`mcp-agent listening on 0.0.0.0:${PORT}`);
  log(`  AgentCard: http://localhost:${PORT}/.well-known/agent-card.json`);
});
