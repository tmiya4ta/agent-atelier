#!/usr/bin/env node
/**
 * Gemini API emulator — MuleSoft LLM Proxy (Gemini ルート) 検証用。
 *
 *   node server/gemini-emu.js [--port 8101] [--host 0.0.0.0] [--key <api-key>]
 *
 * Gemini (Google Generative Language API) は OpenAI とは別形式:
 *   URL:  POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *         POST .../v1beta/models/{model}:streamGenerateContent?alt=sse   (SSE)
 *   認証: header `x-goog-api-key: <KEY>`  または  ?key=<KEY>
 *   body: { contents:[{role, parts:[{text}]}], systemInstruction, generationConfig }
 *   resp: { candidates:[{content:{role:"model",parts:[{text}]}, finishReason}],
 *           usageMetadata:{promptTokenCount, candidatesTokenCount, totalTokenCount}, modelVersion }
 *
 * 対応エンドポイント:
 *   POST /v1beta/models/{model}:generateContent        ← ネイティブ (JSON)
 *   POST /v1beta/models/{model}:streamGenerateContent  ← ネイティブ SSE (?alt=sse)
 *   POST /v1beta/models/{model}:countTokens            ← { totalTokens }
 *   POST .../chat/completions                          ← OpenAI 互換 (Gemini の openai endpoint 用フォールバック)
 *   GET  /v1beta/models | /v1/models                   ← モデル一覧
 *   GET  /health | /                                   ← ヘルス
 *
 * MuleSoft の Gemini プロバイダーが native/openai どちらで来ても応答し、
 * 受信内容 (method/path/model/api-key/body) を全部ログ出力する (実際の形を確認する用)。
 * これは検証用モック。実 LLM 呼び出しはしない。
 */

const http = require("http");

// ─── args ──────────────────────────────────────────────
const argv = process.argv.slice(2);
let PORT = Number(process.env.PORT) || 8101;
let HOST = process.env.HOST || "0.0.0.0";
let REQUIRE_KEY = process.env.API_KEY || null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") PORT = Number(argv[++i]);
  else if (a === "--host") HOST = argv[++i];
  else if (a === "--key") REQUIRE_KEY = argv[++i];
  else if (a === "-h" || a === "--help") {
    console.log("usage: node gemini-emu.js [--port N] [--host H] [--key K]");
    process.exit(0);
  }
}

// ─── helpers ────────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(...a) { console.log(ts(), ...a); }
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
    req.on("error", () => resolve(b));
  });
}
function countTokens(text) { return Math.max(1, Math.ceil((text || "").length / 4)); } // 概算 ~4文字/token
let SEQ = 0;
function genId(prefix) { SEQ += 1; return `${prefix}-emu${String(SEQ).padStart(6, "0")}`; }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,x-goog-api-key,authorization",
};
function sendJson(res, status, obj, extra) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length, ...CORS, ...(extra || {}) });
  res.end(buf);
}
function geminiError(res, status, message, statusStr) {
  sendJson(res, status, { error: { code: status, message, status: statusStr || "INVALID_ARGUMENT" } });
}

// パスから model と method (generateContent 等) を取り出す。
// /v1beta/models/gemini-2.5-flash:generateContent → {model, action}
function parseGeminiPath(pathname) {
  const m = pathname.match(/\/models\/([^:/]+):(\w+)/);
  return { model: m ? m[1] : null, action: m ? m[2] : null };
}

// Gemini contents から直近 user テキスト
function lastUserText(body) {
  const contents = (body && body.contents) || [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (!c.role || c.role === "user") {
      return ((c.parts || []).map((p) => p.text || "").join(" ")).trim();
    }
  }
  return "";
}
function allText(body) {
  const contents = (body && body.contents) || [];
  let s = contents.flatMap((c) => (c.parts || []).map((p) => p.text || "")).join("\n");
  if (body && body.systemInstruction) s += " " + ((body.systemInstruction.parts || []).map((p) => p.text || "").join(" "));
  return s;
}

const SAFETY = [
  { category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "NEGLIGIBLE" },
  { category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "NEGLIGIBLE" },
];

function buildReply(model, body) {
  const user = lastUserText(body);
  return `[gemini-emu] model="${model}"` + (user ? ` — echo: ${user}` : " — (no user text)");
}

function usage(model, body, reply) {
  const p = countTokens(allText(body));
  const c = countTokens(reply);
  return { promptTokenCount: p, candidatesTokenCount: c, totalTokenCount: p + c };
}

// ─── native generateContent ─────────────────────────────
function handleGenerate(res, model, body) {
  const reply = buildReply(model, body);
  sendJson(res, 200, {
    candidates: [
      { content: { role: "model", parts: [{ text: reply }] }, finishReason: "STOP", index: 0, safetyRatings: SAFETY },
    ],
    usageMetadata: usage(model, body, reply),
    modelVersion: model,
    responseId: genId("resp"),
  });
}

// ─── native streamGenerateContent (SSE) ─────────────────
function handleStream(res, model, body) {
  const reply = buildReply(model, body);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", ...CORS });
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\r\n\r\n`);
  const parts = reply.match(/\S+\s*/g) || [reply];
  // 逐次テキストチャンク
  for (const p of parts) {
    write({ candidates: [{ content: { role: "model", parts: [{ text: p }] }, index: 0 }], modelVersion: model });
  }
  // 最終チャンク: finishReason + usageMetadata (Gemini は [DONE] を送らない)
  write({
    candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP", index: 0, safetyRatings: SAFETY }],
    usageMetadata: usage(model, body, reply),
    modelVersion: model,
  });
  res.end();
}

// ─── countTokens ────────────────────────────────────────
function handleCountTokens(res, model, body) {
  const t = countTokens(allText(body));
  sendJson(res, 200, { totalTokens: t, promptTokensDetails: [{ modality: "TEXT", tokenCount: t }] });
}

// ─── OpenAI 互換 (Gemini の /v1beta/openai/chat/completions フォールバック) ──
function lastOpenAiUser(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      const c = messages[i].content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join(" ").trim();
    }
  }
  return "";
}
function handleOpenAiChat(res, body) {
  const model = body.model || "gemini";
  const user = lastOpenAiUser(body.messages);
  const reply = `[gemini-emu/openai] model="${model}"` + (user ? ` — echo: ${user}` : "");
  const pt = countTokens((body.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
  const ct = countTokens(reply);
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", ...CORS });
    const base = { id: genId("chatcmpl"), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
    const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    for (const p of reply.match(/\S+\s*/g) || [reply]) w({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
    w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    if (body.stream_options && body.stream_options.include_usage)
      w({ ...base, choices: [], usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct } });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  sendJson(res, 200, {
    id: genId("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
  });
}

// ─── server ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = u.pathname;
  const method = req.method || "GET";

  if (method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (method === "GET" && (pathname === "/" || pathname === "/health")) {
    sendJson(res, 200, { status: "ok", emulator: "gemini", time: ts() });
    return;
  }
  if (method === "GET" && (pathname === "/v1beta/models" || pathname === "/v1/models" || pathname === "/v1beta/openai/models")) {
    sendJson(res, 200, {
      models: [
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"] },
        { name: "models/gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
        { name: "models/gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
      ],
    });
    return;
  }

  const body = await readBody(req);
  const apiKey = req.headers["x-goog-api-key"] || u.searchParams.get("key") || null;
  const authz = req.headers["authorization"] || null;
  const { model, action } = parseGeminiPath(pathname);

  log(
    `${method} ${pathname}${u.search}`,
    `| model=${model || "-"}`,
    `| action=${action || "-"}`,
    `| api-key=${apiKey ? "present" : authz ? "bearer" : "MISSING"}`,
    `| bytes=${Buffer.byteLength(body)}`
  );
  if (body) log("  body:", body.length > 2000 ? body.slice(0, 2000) + "…(truncated)" : body);

  if (REQUIRE_KEY) {
    const bearer = authz && authz.replace(/^Bearer\s+/i, "");
    if (apiKey !== REQUIRE_KEY && bearer !== REQUIRE_KEY) {
      log("  -> 401 key mismatch");
      geminiError(res, 401, "API key not valid. Please pass a valid API key.", "UNAUTHENTICATED");
      return;
    }
  }

  let parsed = {};
  if (body) {
    try { parsed = JSON.parse(body); }
    catch (e) { geminiError(res, 400, `Invalid JSON body: ${e.message}`); return; }
  }

  if (method === "POST") {
    // OpenAI 互換パス (.../chat/completions)
    if (/\/chat\/completions\/?$/.test(pathname)) { handleOpenAiChat(res, parsed); return; }
    // ネイティブ Gemini
    if (action === "generateContent") { handleGenerate(res, model, parsed); return; }
    if (action === "streamGenerateContent") { handleStream(res, model, parsed); return; }
    if (action === "countTokens") { handleCountTokens(res, model, parsed); return; }
  }

  geminiError(res, 404, `No emulated route for ${method} ${pathname}`, "NOT_FOUND");
});

server.listen(PORT, HOST, () => {
  log(`Gemini emulator listening on http://${HOST}:${PORT}`);
  log(`  key check: ${REQUIRE_KEY ? "ON" : "OFF (any api-key accepted)"}`);
  log(`  gen : curl -s -X POST 'http://127.0.0.1:${PORT}/v1beta/models/gemini-2.5-flash:generateContent' -H 'x-goog-api-key: test' -H 'content-type: application/json' -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'`);
});
