#!/usr/bin/env node
/**
 * Azure OpenAI API emulator — MuleSoft LLM Proxy (Azure OpenAI ルート) 検証用。
 *
 *   node server/azure-openai-emu.js [--port 8099] [--host 0.0.0.0] [--key <api-key>]
 *
 * 何を模倣するか:
 *   Azure OpenAI の実 URL 形は
 *     https://{resource-name}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=YYYY-MM-DD
 *   認証は `api-key: <KEY>` ヘッダー (OpenAI の `Authorization: Bearer` とは違う)。
 *   モデルは body の "model" ではなく URL の {deployment} で決まる。
 *   レスポンス body は OpenAI 互換 (choices[].message.content / usage)。
 *
 * 対応エンドポイント (すべて `?api-version=` を要求はしないが受け取る):
 *   POST /openai/deployments/{deployment}/chat/completions   ← メイン。stream 対応 (SSE)
 *   POST /openai/deployments/{deployment}/completions        ← レガシー補完
 *   POST /openai/deployments/{deployment}/embeddings         ← ダミー埋め込み
 *   POST /openai/responses                                   ← v1 Responses API (簡易)
 *   GET  /openai/models | /openai/deployments                ← 検証用一覧
 *   GET  /health | /                                         ← ヘルスチェック
 *
 * 挙動:
 *   - 受信リクエスト (method/path/deployment/api-version/api-key 有無/body) を必ずログ出力。
 *     MuleSoft が実際に何を投げているかの確認に使う。
 *   - assistant 応答は「どの deployment / api-version に届いたか + 直近 user メッセージのエコー」
 *     を返すので、ルーティングが正しいか一目で分かる。
 *   - --key を指定すると api-key ヘッダーを検証 (不一致は 401 を Azure 形式で返す)。未指定なら素通し。
 *
 * これは検証用モック。実 LLM 呼び出しはしない。
 */

const http = require("http");

// ─── args ──────────────────────────────────────────────
const argv = process.argv.slice(2);
let PORT = Number(process.env.PORT) || 8099;
let HOST = process.env.HOST || "0.0.0.0";
let REQUIRE_KEY = process.env.API_KEY || null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") PORT = Number(argv[++i]);
  else if (a === "--host") HOST = argv[++i];
  else if (a === "--key") REQUIRE_KEY = argv[++i];
  else if (a === "-h" || a === "--help") {
    console.log("usage: node azure-openai-emu.js [--port N] [--host H] [--key K]");
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

// rough token estimate (~4 chars/token). 実 tiktoken ではないが usage 形の確認には十分。
function countTokens(text) {
  return Math.max(1, Math.ceil((text || "").length / 4));
}

// 決定論的な擬似 id (Date.now は避け、カウンタ + 内容長で作る)
let SEQ = 0;
function genId(prefix) {
  SEQ += 1;
  return `${prefix}-emu${String(SEQ).padStart(6, "0")}`;
}

// created は epoch 秒。テストで時刻依存を嫌うなら固定値でもよいが実物に寄せて現在時刻を使う。
function nowSec() { return Math.floor(Date.now() / 1000); }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,api-key,authorization,x-api-key",
};

function sendJson(res, status, obj, extra) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": buf.length,
    ...CORS,
    ...(extra || {}),
  });
  res.end(buf);
}

function azureError(res, status, code, message) {
  sendJson(res, status, { error: { code, message, type: null, param: null } });
}

// リクエストから種別・deployment・api-version を取り出す。
// Azure 形 (/openai/deployments/{id}/chat/completions) と
// OpenAI 形 (/v1/chat/completions) の両方に対応 (パス末尾の種別で判定)。
// これで LLM Proxy の Azure ルート/OpenAI ルート どちらの宛先にもなれる。
function parseAzurePath(pathname, query) {
  const dep = pathname.match(/\/deployments\/([^/]+)(?:\/|$)/);
  let kind = null;
  if (/\/chat\/completions\/?$/.test(pathname)) kind = "chat/completions";
  else if (/\/responses\/?$/.test(pathname)) kind = "responses";
  else if (/\/embeddings\/?$/.test(pathname)) kind = "embeddings";
  else if (/\/completions\/?$/.test(pathname)) kind = "completions"; // chat より後に判定
  return {
    deployment: dep ? decodeURIComponent(dep[1]) : null,
    kind,
    apiVersion: query.get("api-version") || null,
  };
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      const c = messages[i].content;
      if (typeof c === "string") return c;
      // content が配列 (multimodal) の場合は text パートを結合
      if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join(" ").trim();
    }
  }
  return "";
}

function messagesText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      const c = m && m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join(" ");
      return "";
    })
    .join("\n");
}

// ─── chat/completions ───────────────────────────────────
function buildReply(deployment, apiVersion, body) {
  const user = lastUserMessage(body.messages);
  return (
    `[azure-openai-emu] deployment="${deployment}" api-version="${apiVersion || "(none)"}"` +
    (user ? ` — echo: ${user}` : " — (no user message)")
  );
}

function handleChat(res, deployment, apiVersion, body) {
  const reply = buildReply(deployment, apiVersion, body);
  const promptTokens = countTokens(messagesText(body.messages));
  const completionTokens = countTokens(reply);
  const created = nowSec();
  const id = genId("chatcmpl");

  if (body.stream) {
    // SSE ストリーム
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    });
    const base = { id, object: "chat.completion.chunk", created, model: deployment };
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // 1) role
    write({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    // 2) content を語ごとに分割して流す
    const parts = reply.match(/\S+\s*/g) || [reply];
    for (const p of parts) {
      write({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
    }
    // 3) 終了
    write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    // 4) usage (stream_options.include_usage の時のみ Azure/OpenAI は付与)
    if (body.stream_options && body.stream_options.include_usage) {
      write({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: deployment,
    system_fingerprint: "fp_emu",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function handleLegacyCompletion(res, deployment, apiVersion, body) {
  const prompt = Array.isArray(body.prompt) ? body.prompt.join(" ") : body.prompt || "";
  const text = `[azure-openai-emu] deployment="${deployment}" — echo: ${prompt}`;
  const promptTokens = countTokens(prompt);
  const completionTokens = countTokens(text);
  sendJson(res, 200, {
    id: genId("cmpl"),
    object: "text_completion",
    created: nowSec(),
    model: deployment,
    choices: [{ text, index: 0, finish_reason: "stop", logprobs: null }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function handleEmbeddings(res, deployment, body) {
  const inputs = Array.isArray(body.input) ? body.input : [body.input || ""];
  const dim = 8; // 短いダミー次元
  const data = inputs.map((inp, i) => {
    // 内容から決定論的に生成 (Math.random 不使用)
    const s = String(inp);
    const vec = Array.from({ length: dim }, (_, k) =>
      Number((((s.charCodeAt(k % Math.max(1, s.length)) || 0) % 100) / 100).toFixed(4))
    );
    return { object: "embedding", index: i, embedding: vec };
  });
  const total = inputs.reduce((n, s) => n + countTokens(String(s)), 0);
  sendJson(res, 200, {
    object: "list",
    data,
    model: deployment,
    usage: { prompt_tokens: total, total_tokens: total },
  });
}

// v1 Responses API (簡易) — /openai/responses
function handleResponses(res, apiVersion, body) {
  const model = body.model || "(deployment-in-model)";
  const input =
    typeof body.input === "string"
      ? body.input
      : Array.isArray(body.input)
      ? messagesText(body.input)
      : "";
  const text = `[azure-openai-emu] responses model="${model}" api-version="${apiVersion || "(none)"}" — echo: ${input}`;
  const pt = countTokens(input);
  const ct = countTokens(text);
  sendJson(res, 200, {
    id: genId("resp"),
    object: "response",
    created_at: nowSec(),
    model,
    status: "completed",
    output: [
      {
        id: genId("msg"),
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: pt, output_tokens: ct, total_tokens: pt + ct },
  });
}

// ─── server ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = u.pathname;
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // health
  if (method === "GET" && (pathname === "/" || pathname === "/health")) {
    sendJson(res, 200, { status: "ok", emulator: "azure-openai", time: ts() });
    return;
  }

  // モデル/デプロイ一覧 (検証用)
  if (method === "GET" && (pathname === "/openai/models" || pathname === "/openai/deployments")) {
    sendJson(res, 200, {
      object: "list",
      data: [
        { id: "gpt-4o", object: "model", capabilities: { chat_completion: true } },
        { id: "gpt-4o-mini", object: "model", capabilities: { chat_completion: true } },
        { id: "text-embedding-3-small", object: "model", capabilities: { embeddings: true } },
      ],
    });
    return;
  }

  const body = await readBody(req);
  const apiKey = req.headers["api-key"] || null;
  const authz = req.headers["authorization"] || null;
  const { deployment, kind, apiVersion } = parseAzurePath(pathname, u.searchParams);

  log(
    `${method} ${pathname}${u.search}`,
    `| deployment=${deployment || "-"}`,
    `| api-version=${apiVersion || "-"}`,
    `| api-key=${apiKey ? "present" : authz ? "bearer" : "MISSING"}`,
    `| bytes=${Buffer.byteLength(body)}`
  );
  if (body) log("  body:", body.length > 2000 ? body.slice(0, 2000) + "…(truncated)" : body);

  // api-key 検証 (--key 指定時のみ)
  if (REQUIRE_KEY) {
    const bearer = authz && authz.replace(/^Bearer\s+/i, "");
    if (apiKey !== REQUIRE_KEY && bearer !== REQUIRE_KEY) {
      log("  -> 401 key mismatch");
      azureError(res, 401, "401", "Access denied due to invalid subscription key or wrong API endpoint.");
      return;
    }
  }

  let parsed = {};
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      azureError(res, 400, "BadRequest", `Invalid JSON body: ${e.message}`);
      return;
    }
  }

  // deployment が URL に無ければ (OpenAI 形) body.model を使う
  const target = deployment || parsed.model || "openai";

  if (method === "POST" && kind === "responses") {
    handleResponses(res, apiVersion, parsed);
    return;
  }
  if (method === "POST" && kind === "chat/completions") {
    handleChat(res, target, apiVersion, parsed);
    return;
  }
  if (method === "POST" && kind === "completions") {
    handleLegacyCompletion(res, target, apiVersion, parsed);
    return;
  }
  if (method === "POST" && kind === "embeddings") {
    handleEmbeddings(res, target, parsed);
    return;
  }

  // 未対応
  azureError(res, 404, "404", `No emulated route for ${method} ${pathname}`);
});

server.listen(PORT, HOST, () => {
  log(`Azure OpenAI emulator listening on http://${HOST}:${PORT}`);
  log(`  key check: ${REQUIRE_KEY ? "ON" : "OFF (any api-key accepted)"}`);
  log(`  try: curl -s http://127.0.0.1:${PORT}/health`);
  log(
    `  chat: curl -s -X POST 'http://127.0.0.1:${PORT}/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21' ` +
      `-H 'api-key: test' -H 'content-type: application/json' ` +
      `-d '{"messages":[{"role":"user","content":"hi"}]}'`
  );
});
