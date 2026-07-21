#!/usr/bin/env node
// 顧客情報 MCP サーバ (Streamable HTTP transport, stateless + JSON レスポンス)。
//
//   Atelier / MCP クライアント ── POST /mcp (JSON-RPC 2.0) ──▶ このサーバ
//   theorems-relay 経由: https://theorems-relay-….cloudhub.io/customers/mcp
//   経路: host :8102 → Caddy edge customers.theorems.io → 172.23.0.1:8102
//
// stateless: Mcp-Session-Id を発行しない (毎リクエスト独立)。
// 依存なし (Node 標準 http のみ)。 既存 emu (aoai/gemini/textsink) と同じ host プロセス方式。
//
// 起動: node server/customers-mcp.js   (PORT 環境変数で上書き可)
"use strict";
const http = require("http");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "8102", 10);
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "customers-mcp", version: "0.1.0" };

// ─── ダミー顧客データ (すべて架空) ──────────────────────────
const CUSTOMERS = [
  { id: "C-1001", name: "山田 太郎",   company: "Aoba Robotics",       email: "taro.yamada@aoba-robotics.example",   phone: "+81-3-1234-0001", plan: "Enterprise", status: "active",  mrr: 4800, since: "2023-04-12", region: "JP", tags: ["priority", "manufacturing"] },
  { id: "C-1002", name: "佐藤 花子",   company: "Kite Logistics",      email: "hanako.sato@kite-logi.example",        phone: "+81-6-2234-0002", plan: "Pro",        status: "active",  mrr: 1200, since: "2023-09-01", region: "JP", tags: ["logistics"] },
  { id: "C-1003", name: "Emily Carter", company: "Northwind Analytics", email: "emily.carter@northwind.example",       phone: "+1-415-555-0103", plan: "Enterprise", status: "active",  mrr: 6200, since: "2022-11-20", region: "US", tags: ["priority", "analytics"] },
  { id: "C-1004", name: "鈴木 一郎",   company: "Sakura Foods",        email: "ichiro.suzuki@sakura-foods.example",   phone: "+81-52-334-0004", plan: "Pro",        status: "trial",   mrr: 0,    since: "2026-07-02", region: "JP", tags: ["food", "trial"] },
  { id: "C-1005", name: "Liam O'Brien", company: "Shamrock Retail",     email: "liam.obrien@shamrock.example",         phone: "+353-1-555-0105", plan: "Free",       status: "active",  mrr: 0,    since: "2025-02-18", region: "EU", tags: ["retail"] },
  { id: "C-1006", name: "田中 美咲",   company: "Hikari Medical",      email: "misaki.tanaka@hikari-med.example",     phone: "+81-92-445-0006", plan: "Enterprise", status: "active",  mrr: 5400, since: "2021-06-30", region: "JP", tags: ["priority", "healthcare"] },
  { id: "C-1007", name: "Sofia Rossi",  company: "Lumen Design",        email: "sofia.rossi@lumen.example",            phone: "+39-02-555-0107", plan: "Pro",        status: "churned", mrr: 0,    since: "2022-03-14", region: "EU", tags: ["design", "churned"] },
  { id: "C-1008", name: "高橋 健",     company: "Tsurugi Security",    email: "ken.takahashi@tsurugi-sec.example",    phone: "+81-3-1234-0008", plan: "Enterprise", status: "active",  mrr: 7100, since: "2020-10-05", region: "JP", tags: ["priority", "security"] },
  { id: "C-1009", name: "Noah Kim",     company: "Everpeak Cloud",      email: "noah.kim@everpeak.example",            phone: "+82-2-555-0109", plan: "Pro",        status: "active",  mrr: 1800, since: "2024-01-22", region: "KR", tags: ["cloud"] },
  { id: "C-1010", name: "渡辺 由紀",   company: "Midori Travel",       email: "yuki.watanabe@midori-travel.example",  phone: "+81-75-556-0010", plan: "Free",       status: "trial",   mrr: 0,    since: "2026-06-28", region: "JP", tags: ["travel", "trial"] },
  { id: "C-1011", name: "Aisha Khan",   company: "Zenith Fintech",      email: "aisha.khan@zenith-fin.example",        phone: "+971-4-555-0111", plan: "Enterprise", status: "active",  mrr: 5900, since: "2023-01-09", region: "AE", tags: ["priority", "fintech"] },
  { id: "C-1012", name: "中村 翔",     company: "Asagiri Energy",      email: "sho.nakamura@asagiri-energy.example",  phone: "+81-11-667-0012", plan: "Pro",        status: "churned", mrr: 0,    since: "2021-12-01", region: "JP", tags: ["energy", "churned"] },
];

// ─── tools 定義 ──────────────────────────
const TOOLS = [
  {
    name: "list_customers",
    description: "顧客の一覧を返す。status で絞り込み、limit で件数を制限できる。",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "trial", "churned"], description: "顧客ステータスで絞り込み (任意)" },
        limit:  { type: "integer", minimum: 1, maximum: 100, description: "最大件数 (既定 20)" },
      },
    },
  },
  {
    name: "get_customer",
    description: "顧客 ID を指定して 1 件の詳細を返す。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "顧客 ID (例: C-1001)" } },
      required: ["id"],
    },
  },
  {
    name: "search_customers",
    description: "名前・会社名・メールにキーワードを含む顧客を検索する。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "検索キーワード" } },
      required: ["query"],
    },
  },
];

// ─── tool 実装 ──────────────────────────
function callTool(name, args) {
  args = args || {};
  if (name === "list_customers") {
    let rows = CUSTOMERS;
    if (args.status) rows = rows.filter(c => c.status === args.status);
    const limit = Math.min(Math.max(parseInt(args.limit || 20, 10), 1), 100);
    rows = rows.slice(0, limit);
    return { count: rows.length, customers: rows };
  }
  if (name === "get_customer") {
    const c = CUSTOMERS.find(c => c.id.toLowerCase() === String(args.id || "").toLowerCase());
    if (!c) throw new Error(`customer not found: ${args.id}`);
    return c;
  }
  if (name === "search_customers") {
    const q = String(args.query || "").toLowerCase().trim();
    if (!q) throw new Error("query is required");
    const rows = CUSTOMERS.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.company.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q)
    );
    return { count: rows.length, query: q, customers: rows };
  }
  throw new Error(`unknown tool: ${name}`);
}

// ─── JSON-RPC ハンドラ ──────────────────────────
function handleRpc(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "架空の顧客データを提供するデモ MCP サーバ。list_customers / get_customer / search_customers が使える。",
      } };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (method === "tools/call") {
      const out = callTool(params && params.name, params && params.arguments);
      return { jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: false,
      } };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (e) {
    // tools/call のエラーは result.isError で返すのが MCP 流儀
    if (method === "tools/call") {
      return { jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } };
  }
}

// ─── HTTP サーバ ──────────────────────────
const server = http.createServer((req, res) => {
  // Correlation ID: リクエストの X-Correlation-ID をそのままレスポンスに返す。
  // 無ければ生成 (Mule 4 の HTTP Listener と同じ挙動 — mcp-inventory-api で確認済み)。
  const correlationId = req.headers["x-correlation-id"] || crypto.randomUUID();
  res.setHeader("X-Correlation-ID", correlationId);
  // CORS (ブラウザから直接叩けるように)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, mcp-session-id, Authorization, Last-Event-ID, X-Correlation-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, X-Correlation-ID");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = (req.url || "").split("?")[0];

  if (req.method === "GET" && (url === "/health" || url === "/__health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: SERVER_INFO, customers: CUSTOMERS.length }));
    return;
  }

  // Streamable HTTP は GET /mcp で SSE ストリームを開く実装もあるが、
  // stateless なのでサーバ発の通知は無く、GET は 405 で十分。
  if (req.method === "GET" && url === "/mcp") {
    res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST for JSON-RPC" } }));
    return;
  }

  if (req.method === "POST" && url === "/mcp") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        return;
      }
      // バッチ (配列) 対応
      if (Array.isArray(msg)) {
        const responses = msg.map(handleRpc).filter(r => r !== null && r !== undefined);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responses));
        return;
      }
      // notification (id 無し) は本体なしで受領
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202); res.end();
        return;
      }
      const resp = handleRpc(msg);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[customers-mcp] listening on 0.0.0.0:${PORT}  (endpoint POST /mcp, ${CUSTOMERS.length} customers)`);
});
