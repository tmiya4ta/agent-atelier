#!/usr/bin/env node
/**
 * gemini-agent — Atelier の A2A window が渡してくる MCP サーバ群に自分で接続し、
 * Gemini (function calling) にどのツールを使うか判断させて実行する A2A エージェント。
 *
 *   node server/gemini-agent.js [--port 8106]
 *
 * mcp-agent.js のルールベース判断を実 LLM に置き換えたもの。 MCP クライアント部
 * (initialize / tools/list / tools/call) はそのまま同じ方式。
 *
 * 流れ (1 リクエスト内で完結。 A2A としては 1 ターン):
 *   1. data part の mcpServers[] へ接続して tools/list
 *   2. MCP の inputSchema を Gemini の functionDeclarations に変換して generateContent
 *   3. functionCall が返れば tools/call を実行し、 結果を functionResponse として戻す
 *   4. text が返るまで 2-3 を繰り返す (最大 MAX_STEPS 回)
 *
 * 認証情報 (Gemini proxy の Basic トークン) はソースに埋め込まない。 以下の順で解決:
 *   1. 環境変数 GEMINI_TOKEN
 *   2. --token <base64>
 *   3. 環境変数 GEMINI_CREDENTIAL_FILE が指す YAML の `token:` (既定は
 *      ~/mule/mule-demos/dsol-ai-workshop/demo-credential)
 * ※ このリポジトリは public。 トークンや API キーを含むファイルは絶対に commit しないこと。
 *
 * エンドポイント:
 *   GET  /.well-known/agent-card.json
 *   POST /a2a   (JSON-RPC 2.0 · message/send)
 *   GET  /health
 */
"use strict";
const http = require("http");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const PORT        = Number(process.env.PORT || argOf("--port", 8106));
const PUBLIC_BASE = process.env.PUBLIC_BASE || "";
const GEMINI_URL  = process.env.GEMINI_URL || "https://gemini-proxy.demos.mulesoft.com";
const GEMINI_MODEL = process.env.GEMINI_MODEL || argOf("--model", "gemini-2.5-flash");
const CRED_FILE   = process.env.GEMINI_CREDENTIAL_FILE
  || path.join(os.homedir(), "mule/mule-demos/dsol-ai-workshop/demo-credential");
const MAX_STEPS   = 6;

function ts() { return new Date().toISOString(); }
function log(...a) { console.log(ts(), ...a); }

// Basic トークンの解決。 見つからなければ起動時に落とす (実行時に 401 で
// 迷子になるより、 起動時に理由付きで止まる方が調べやすい)。
function resolveToken() {
  if (process.env.GEMINI_TOKEN) return process.env.GEMINI_TOKEN.trim();
  const fromArg = argOf("--token", "");
  if (fromArg) return fromArg.trim();
  try {
    const src = fs.readFileSync(CRED_FILE, "utf8");
    // YAML の折り返しブロック (`token: >-` の次行) と 1 行形式の両方を拾う
    const m = src.match(/token:\s*>-\s*\n\s*([A-Za-z0-9+/=]+)/) || src.match(/token:\s*([A-Za-z0-9+/=]{20,})/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return "";
}
const GEMINI_TOKEN = resolveToken();

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
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ─── MCP クライアント (Streamable HTTP。 mcp-agent.js と同じ最小実装) ───
let mcpRpcSeq = 0;
async function mcpRpc(url, sessionId, method, params, isNotification, auth) {
  const id = isNotification ? undefined : ++mcpRpcSeq;
  const body = isNotification ? { jsonrpc: "2.0", method, params }
                              : { jsonrpc: "2.0", id, method, params };
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  // 呼び出し元 (Atelier) から渡された MCP サーバの認証情報。 実際に tools/call するのは
  // こちらなので、 これが無いと認証付き MCP サーバには繋げない。
  if (auth?.auth) headers["Authorization"] = `Bearer ${auth.auth}`;
  if (auth?.authHeaders) Object.assign(headers, auth.authHeaders);
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const newSessionId = res.headers.get("mcp-session-id") || sessionId;
  if (isNotification) return { sessionId: newSessionId, result: null };
  const ctype = res.headers.get("content-type") || "";
  const text = await res.text();
  const data = ctype.includes("text/event-stream") ? parseSseJsonRpc(text) : (text ? JSON.parse(text) : {});
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
async function mcpListTools(url, auth) {
  const session = (await mcpRpc(url, null, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gemini-agent", version: "0.1.0" },
  }, false, auth)).sessionId;
  await mcpRpc(url, session, "notifications/initialized", {}, true, auth);
  const { result } = await mcpRpc(url, session, "tools/list", {}, false, auth);
  return { session, tools: Array.isArray(result?.tools) ? result.tools : [] };
}
async function mcpCallTool(url, session, name, args, auth) {
  const { result } = await mcpRpc(url, session, "tools/call", { name, arguments: args || {} }, false, auth);
  const content = result?.content?.[0]?.text;
  return { isError: !!result?.isError, content: content ?? JSON.stringify(result ?? {}) };
}

// 渡された mcpServers それぞれに tools/list。 1 台落ちていても他は使う。
async function gatherTools(mcpServers) {
  const out = [];
  for (const srv of mcpServers || []) {
    try {
      const { session, tools } = await mcpListTools(srv.url, srv);
      out.push({ srv: { ...srv, session }, tools });
    } catch (e) {
      log(`tools/list failed for ${srv.url}: ${e.message}`);
    }
  }
  return out;
}

// ─── MCP inputSchema → Gemini functionDeclarations ───
// Gemini は OpenAPI subset しか受け付けないので、 JSON Schema の余計なキーを落とす。
// $schema / additionalProperties / const 等が入っていると 400 になる。
const ALLOWED_SCHEMA_KEYS = new Set([
  "type", "format", "description", "nullable", "enum", "items", "properties", "required"
]);
function sanitizeSchema(node) {
  if (!node || typeof node !== "object") return { type: "string" };
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (!ALLOWED_SCHEMA_KEYS.has(k)) continue;
    if (k === "properties") {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v || {})) out.properties[pk] = sanitizeSchema(pv);
    } else if (k === "items") {
      out.items = sanitizeSchema(v);
    } else if (k === "type") {
      // Gemini は type を大文字/小文字どちらでも受けるが、 配列型 ["string","null"] は不可
      out.type = Array.isArray(v) ? (v.find(x => x !== "null") || "string") : v;
    } else {
      out[k] = v;
    }
  }
  if (!out.type) out.type = out.properties ? "object" : "string";
  return out;
}

// ツール名は MCP サーバをまたいで衝突しうるので prefix を付け、 呼び出し時に逆引きする。
// Gemini の function name は [a-zA-Z0-9_.-] しか通らないため、 それ以外は _ に潰す。
function safeName(s) { return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_"); }

function buildDeclarations(toolsBySrv) {
  const decls = [];
  const index = new Map();   // gemini function name → { srv, toolName }
  toolsBySrv.forEach((entry, i) => {
    for (const t of entry.tools) {
      const fname = safeName(toolsBySrv.length > 1 ? `s${i}__${t.name}` : t.name);
      index.set(fname, { srv: entry.srv, toolName: t.name });
      decls.push({
        name: fname,
        description: [t.description, toolsBySrv.length > 1 ? `(server: ${entry.srv.name || entry.srv.url})` : ""]
          .filter(Boolean).join(" "),
        parameters: sanitizeSchema(t.inputSchema || t.input_schema || { type: "object", properties: {} })
      });
    }
  });
  return { decls, index };
}

// ─── Gemini 呼び出し ───
async function generateContent(contents, decls) {
  if (!GEMINI_TOKEN) throw new Error("Gemini token が未設定です (GEMINI_TOKEN / --token / 認証ファイル)");
  // systemInstruction で渡す。 会話ターンとして混ぜるより指示の効きが強い
  // (user/model の偽ターンだと、 モデルが「過去の雑談」として軽く扱ってしまう)。
  const instruction = decls.length ? SYSTEM_PREFACE : SYSTEM_NO_TOOLS;
  const body = { contents, systemInstruction: { parts: [{ text: instruction }] } };
  if (decls.length) body.tools = [{ functionDeclarations: decls }];
  const url = `${GEMINI_URL.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${GEMINI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Gemini の応答が JSON ではありません: ${text.slice(0, 200)}`); }
  const cand = data.candidates?.[0];
  if (!cand) throw new Error(`Gemini から候補が返りませんでした: ${text.slice(0, 200)}`);
  return cand.content || {};
}

// MCP の tool description は簡略で、 絞り込み条件や返却フィールドが網羅されていない。
// 素直な指示だと「Enterprise プランで絞る機能はありません」と、 一度もツールを呼ばずに
// 断ってしまう (実際は list_customers を引数なしで呼べば plan も mrr も返ってくる)。
// そこで「呼ばずに断ることの禁止」を最優先の制約として明示している。
// この文面は実際に gemini-2.5-flash で挙動を確認しながら決めたもの。
// ツールが 1 つも無いときに上の「呼ばずに断るな」を渡すと、 モデルは呼べるものが
// 無いので辻褄を合わせようとして、 ツール呼び出しを装ったテキストや架空の値を
// 出してしまう (実際に商品価格を捏造する事例を確認)。 ツール無しでは別の指示にする。
// 文面は「一般ユーザー向け」であることが要件。 MCP / ツール / Atelier / Settings と
// いった内部用語を回答に出さない (エンドユーザーには何のことか分からないため)。
// できないことは「調べる手段が無い」という言い方に統一する。
const SYSTEM_NO_TOOLS = [
  "あなたは質問に答えるアシスタントです。 ただし今は、 外部のデータを調べる手段が一切与えられていません。",
  "",
  "【禁止】ツールを呼び出したかのような出力 (Tool: / Arguments: / Output: のような記述) をしてはいけません。",
  "【禁止】調べないと分からない具体的な事実 (商品の価格・在庫、 顧客情報、 社内データ、",
  "システムの現在の状態など) を、 推測や一般知識から作って答えてはいけません。",
  "",
  "そうした質問には、 次のように答えてください:",
  "「申し訳ありません。 その情報を調べる手段が用意されていないため、 お答えできません。」",
  "必要に応じて『管理者にお問い合わせください』と添えても構いません。",
  "",
  "【重要】回答に次の言葉を使ってはいけません: MCP、 MCP サーバ、 ツール、 Atelier、 Settings、 サーバ接続、 API。",
  "利用者は技術者とは限らないため、 内部の仕組みの話をせず、 できるかできないかだけを普通の日本語で伝えてください。",
  "",
  "一方で、 次のような質問には普通に答えてください (断ってはいけません):",
  "・あいさつ、 雑談",
  "・あなた自身についての質問 (何ができるか)",
  "  → 「今は情報を調べる手段が用意されていないため、 一般的な質問にお答えするくらいです」程度に留める",
  "・調べる必要のない一般的な知識の質問",
  "回答は日本語で簡潔に。"
].join("\n");

const SYSTEM_PREFACE = [
  "あなたは MCP ツールを使って回答するアシスタントです。",
  "【最重要】ツールを一度も呼び出さずに『その機能はありません』『対応していません』と答えることは禁止です。",
  "ツールの description は簡略で、 絞り込み条件や返却フィールドが網羅されていません。",
  "説明に書かれていないからといって不可能と判断してはいけません。",
  "手順: (1) まず関連しそうなツールを実際に呼び出す (一覧系なら引数なしで全件取得する)。",
  "(2) 返ってきた実データのフィールドを見る。",
  "(3) 絞り込み・並べ替え・集計・比較はあなた自身が行う。",
  "(3) まで行っても答えが出せない場合にのみ、 その旨を伝えてください。",
  // 1 回呼んで不十分だと、 そこで諦めて「見つかりません」と答えてしまう事例が実際に出た
  // (検索ツールが商品名だけを返し、 価格を返すツールを続けて呼ばなかった)。
  // 「足りなければ次を呼べ」を具体例つきで明示する。
  "【重要】1 つのツールの結果だけで答えが出ないときは、 そこで諦めずに別のツールを続けて呼んでください。",
  "よくある例:",
  "・検索や一覧のツールが名前や ID しか返さない → 詳細を返すツール (ID 指定・全件取得など) を続けて呼ぶ",
  "・目的の絞り込み条件を持つツールが無い → 条件を付けずに全件取得し、 自分で絞り込む",
  "・引数の候補が分からない → 候補を返すツール (カテゴリ一覧など) を先に呼んで確認する",
  "答えに必要な情報が揃うまで、 何度でもツールを呼んで構いません。",
  // 実例: 「Tシャツの一覧」に対し get_products({category:"Tシャツ"}) を呼び、 0 件
  // だったので「見つかりませんでした」と答えた。 実データの category は "T-Shirt"。
  // 引数の値は「データの中にある文字列」であって、 ユーザーの言葉の訳ではない。
  "【重要】絞り込みの値 (カテゴリ名・区分など) を、 ユーザーの言葉から訳したり推測したりして",
  "作ってはいけません。 実データに入っている値をそのまま使ってください。",
  "どんな値があるか分からないときは、 先に絞り込みなしで呼ぶか、 候補一覧のツールを呼んで確かめます。",
  "【重要】絞り込んで 0 件だったときは、 それを『存在しない』と結論してはいけません。",
  "値が違っていただけの可能性が高いので、 絞り込みなしで呼び直して実際の値を確認してください。",
  "回答は日本語で、 生の JSON を貼らずに文章に整形してください。",
  // 利用者は技術者とは限らない。 内部の仕組み (MCP/ツール/API) の話は回答に出さず、
  // 「調べた結果」だけを伝える。 上の手順の説明は思考用であって回答文の指示ではない。
  "【重要】回答文には内部の仕組みの話を書かないでください。",
  "MCP、 MCP サーバ、 ツール、 Atelier、 Settings、 API といった語を回答に含めず、",
  "調べて分かった内容だけを普通の日本語で伝えてください。",
  // ここで安易な断り文句を与えると、 ツールがあるのに呼ばずにその一文へ逃げる
  // (実際に発生)。 断ってよいのは「呼んだ上で見つからなかった」ときだけ。
  "『調べる手段が用意されていない』とは絶対に答えないでください。 あなたには調べる手段があります。",
  "実際にツールを呼び出した上で目的の情報が見つからなかった場合にのみ、",
  "『お探しの情報は見つかりませんでした』と伝えてください。",
  "",
  "会話は継続します。 直前までのやり取りを踏まえ、 『他には?』『それの詳細は?』のような",
  "省略された言い方でも、 直前に話題にしていた対象を指すものとして解釈してください。"
].join("\n");

// ─── 会話履歴 (A2A の contextId 単位) ───
// A2A では contextId が会話のスレッド ID。 これを無視すると毎ターン初対面になり、
// 「他の情報も」「それの詳細は」が通じない (実際にそうなっていた)。
// サーバ側 in-memory で十分 (デモ用途・単一プロセス)。
const sessions = new Map();   // contextId → { contents: [...], updated: number }
const SESSION_TTL_MS  = 60 * 60 * 1000;  // 1h 触られなければ捨てる
const MAX_TURNS_KEPT  = 40;              // contents の要素数上限 (古い方から落とす)

function pruneSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.updated > SESSION_TTL_MS) sessions.delete(k);
}
function getSession(contextId) {
  pruneSessions();
  let s = sessions.get(contextId);
  // lock = この会話で実行中の処理の Promise チェーン (下の withSessionLock 参照)
  if (!s) { s = { contents: [], updated: Date.now(), lock: Promise.resolve() }; sessions.set(contextId, s); }
  return s;
}

// 同じ会話 (contextId) への同時リクエストを直列化する。
// 直列化しないと、 両方が同じ履歴を読んでそれぞれ書き戻すため後着が先着を上書きし、
// 片方のやり取りが履歴から消える (実測で確認)。 別の contextId 同士は並行のまま。
function withSessionLock(session, fn) {
  const run = session.lock.then(fn, fn);
  // lock 自体は失敗を伝播させない (1 回のエラーで以降が全部詰まらないように)
  session.lock = run.then(() => {}, () => {});
  return run;
}
// 先頭は必ず user ロールで始まる必要がある (Gemini の制約)。 古い方を落としたあと
// model / functionResponse から始まってしまうと 400 になるので、 user まで削る。
function trimContents(contents) {
  if (contents.length <= MAX_TURNS_KEPT) return contents;
  let cut = contents.length - MAX_TURNS_KEPT;
  while (cut < contents.length && contents[cut].role !== "user") cut++;
  return contents.slice(cut);
}

// 絞り込み引数が実際に付いていたか。 空オブジェクトや空文字だけの引数は「絞り込みなし」。
function hasArgs(args) {
  if (!args || typeof args !== "object") return false;
  return Object.values(args).some(v => v !== undefined && v !== null && v !== "");
}

// ツール結果が実質 0 件か。 MCP 実装によって [] だったり {items:[]} だったり
// content が空文字だったりするので、 よくある形を広めに拾う。
function isEmptyResult(parsed) {
  if (parsed == null) return true;
  if (Array.isArray(parsed)) return parsed.length === 0;
  if (typeof parsed === "string") return parsed.trim() === "" || parsed.trim() === "[]";
  if (typeof parsed === "object") {
    if (typeof parsed.text === "string") {
      const t = parsed.text.trim();
      return t === "" || t === "[]" || t === "{}";
    }
    const arrays = Object.values(parsed).filter(Array.isArray);
    if (arrays.length) return arrays.every(a => a.length === 0);
    return Object.keys(parsed).length === 0;
  }
  return false;
}

// ユーザー発話 + MCP サーバ群 → 最終回答テキスト
async function respond(userText, mcpServers, contextId) {
  const session = getSession(contextId);
  // 履歴の読み出しから書き戻しまでを 1 会話ずつ直列化する。 tools/list は会話に
  // 依存しないのでロックの外で先に済ませ、 待ち時間を無駄に伸ばさない。
  const toolsBySrv = await gatherTools(mcpServers);
  return withSessionLock(session, () => runTurn(session, userText, toolsBySrv, contextId));
}

async function runTurn(session, userText, toolsBySrv, contextId) {
  const { decls, index } = buildDeclarations(toolsBySrv);
  log(`tools: ${decls.length} (from ${toolsBySrv.length} server(s)) · ctx ${contextId} · history ${session.contents.length}`);

  const contents = trimContents([...session.contents, { role: "user", parts: [{ text: userText }] }]);

  for (let step = 1; step <= MAX_STEPS; step++) {
    const content = await generateContent(contents, decls);
    const parts = content.parts || [];
    const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);

    if (!calls.length) {
      const text = parts.filter(p => typeof p.text === "string").map(p => p.text).join("\n").trim();
      // 最終回答まで含めて履歴を確定させる。 functionCall / functionResponse も
      // 残すので、 次ターンで「さっき調べた結果」を参照できる。
      session.contents = trimContents([...contents, { role: "model", parts }]);
      session.updated = Date.now();
      return text || "(Gemini から空の応答が返りました)";
    }

    // モデルの発話 (functionCall を含む) を履歴に積んでから、 結果を返す
    contents.push({ role: "model", parts });
    const responseParts = [];
    for (const call of calls) {
      const hit = index.get(call.name);
      log(`step ${step}: functionCall ${call.name}(${JSON.stringify(call.args || {})})`);
      let payload;
      if (!hit) {
        payload = { error: `unknown tool: ${call.name}` };
      } else {
        try {
          const out = await mcpCallTool(hit.srv.url, hit.srv.session, hit.toolName, call.args || {}, hit.srv);
          // content は多くの MCP 実装で JSON 文字列。 パースできれば構造のまま渡す
          let parsed;
          try { parsed = JSON.parse(out.content); } catch { parsed = { text: out.content }; }
          payload = out.isError ? { error: out.content } : { result: parsed };
          // 絞り込み付きで呼んで 0 件だったときは、 そこで「見つかりませんでした」と
          // 結論させない。 実際に category:"Tシャツ" で 0 件 → 即断念する事例が出た
          // (実データの category は "T-Shirt")。 モデルは引数の値をユーザーの言葉から
          // 訳して作ってしまうので、 空だった事実と次の一手を結果に添えて返す。
          // プロンプトだけでは守られなかったため、 ここで機械的に注入する。
          if (!out.isError && hasArgs(call.args) && isEmptyResult(parsed)) {
            payload.hint = [
              `${call.name} を ${JSON.stringify(call.args)} で呼びましたが 0 件でした。`,
              "指定した絞り込みの値が実データと一致していない可能性があります",
              "(日本語で指定したが実データは英語、 表記ゆれ、 単数形/複数形の違いなど)。",
              "ここで『見つかりませんでした』と結論せず、 次のどちらかを行ってください:",
              "(1) 同じツールを絞り込みなし (引数なし) で呼び、 実際に存在する値を確かめる。",
              "(2) 候補の一覧を返すツールがあれば先にそれを呼ぶ。",
              "そのうえで、 実データに存在する値で呼び直してください。"
            ].join(" ");
          }
        } catch (e) {
          payload = { error: e.message };
        }
      }
      responseParts.push({ functionResponse: { name: call.name, response: payload } });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  session.contents = trimContents(contents);
  session.updated = Date.now();
  return `ツール呼び出しが ${MAX_STEPS} 回を超えたため打ち切りました。`;
}

function agentCard(base) {
  return {
    protocolVersion: "0.3.0",
    name: "Gemini MCP Agent",
    description: `呼び出し元 (Atelier) が渡す MCP サーバへ自分で接続し、Gemini (${GEMINI_MODEL}) の function calling でツールを選んで実行するエージェント。`,
    url: `${base}/a2a`,
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [{
      id: "mcp-tool-use", name: "MCP ツール利用",
      // examples は AgentSkill の任意フィールド (string[])。 Atelier は capabilities に
      // 一覧を出し、 1 つを入力欄のゴーストとして Tab で確定できるようにしている。
      // 何ができるかは接続された MCP サーバ次第なので、 ここの例は
      // ハンズオン既定の構成 (Handson 3 の商品 MCP) を前提にした具体例にしている。
      description: "渡された MCP サーバのツールを LLM が選んで呼び出し、結果を日本語で回答する。"
                 + "何を答えられるかは接続された MCP サーバによって変わる (下の例は商品カタログを繋いだ場合)。",
      tags: ["mcp", "gemini", "function-calling"],
      examples: [
        "どんな商品カテゴリがありますか？",
        "Tシャツの一覧を見せて",
        "一番安い商品はどれ？",
        "50ドル以下のパンツを探して"
      ]
    }]
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
    sendJson(res, 200, { status: "ok", model: GEMINI_MODEL, tokenConfigured: !!GEMINI_TOKEN, time: ts() });
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
    const userMessage = (params && params.message) || {};
    const parts = userMessage.parts || [];
    const text = parts.filter(p => p.kind === "text").map(p => p.text).join("\n");
    const dataParts = parts.filter(p => p.kind === "data" && p.data);
    const mcpServers = dataParts.find(p => Array.isArray(p.data.mcpServers))?.data.mcpServers || [];
    const contextId = userMessage.contextId;

    // contextId は A2A の会話スレッド ID。 クライアントが持っていない初回はこちらで
    // 採番して返す。 a2a.js は応答の contextId を覚えて次ターンから送ってくるので、
    // これで会話が継続する (返さないと毎ターン新規スレッド = 記憶なしになる)。
    const ctx = contextId || `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log(`message/send: ${JSON.stringify(text).slice(0, 160)} (mcpServers: ${mcpServers.length})`);
    let replyText;
    try { replyText = await respond(text, mcpServers, ctx); }
    catch (e) { log("respond failed:", e.message); replyText = `エラーが発生しました: ${e.message}`; }

    sendJson(res, 200, { jsonrpc: "2.0", id, result: {
      kind: "message", role: "agent",
      parts: [{ kind: "text", text: replyText }],
      messageId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, contextId: ctx
    }});
    return;
  }
  sendJson(res, 404, { error: `no route for ${req.method} ${u.pathname}` });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`gemini-agent listening on 0.0.0.0:${PORT}  (model: ${GEMINI_MODEL})`);
  log(`  AgentCard: http://localhost:${PORT}/.well-known/agent-card.json`);
  if (!GEMINI_TOKEN) {
    log(`  ⚠ Gemini token が未設定です。 GEMINI_TOKEN / --token / ${CRED_FILE} のいずれかで指定してください。`);
  }
});
