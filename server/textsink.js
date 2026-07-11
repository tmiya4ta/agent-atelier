#!/usr/bin/env node
/**
 * textsink — テキストデータを POST で受けて保存・閲覧する小さなアプリ。
 *
 *   node server/textsink.js [--port 8100] [--host 0.0.0.0] [--file <path>] [--secret <code>]
 *
 * 保存ゲート: POST は secret code (既定 "miya", --secret/TEXTSINK_SECRET で変更) が
 *   一致した時だけ保存する。code は header 'X-Secret-Code' (or 'X-Textsink-Secret') か ?code= で送る。
 *   不一致/未指定は 401 で保存されない。読み取り(GET)は無認証のまま。
 *
 * theorems-relay 経由での公開を想定:
 *   client → https://theorems-relay-xxx.cloudhub.io/textsink/<path>
 *          → (wildcard relay が Host=textsink.theorems.io に上書き)
 *          → Caddy edge (textsink.theorems.io:443)
 *          → host:8100 (このアプリ)
 * relay は先頭セグメント(textsink)を剥がすので、このアプリは / や /messages を受ける。
 *
 * エンドポイント:
 *   POST /            : リクエスト body を1件のテキストとして保存。JSON で {id,bytes,...} を返す
 *                       (パスは何でもよい。/ingest 等でも同じ扱い)
 *   GET  /            : 直近メッセージを表示 (ブラウザは HTML、Accept: application/json は JSON)
 *   GET  /messages    : 保存済み一覧 (JSON, ?limit=N ?q=検索語)
 *   GET  /messages/ID : 1件の生テキスト (text/plain)
 *   DELETE /messages  : 全消去
 *   GET  /health      : ヘルスチェック
 *
 * 保存: メモリのリングバッファ(既定 500 件) + 追記ファイル(JSONL, 既定 ~/textsink.jsonl)。
 *       起動時にファイルから直近を復元する。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ─── args ──────────────────────────────────────────────
const argv = process.argv.slice(2);
let PORT = Number(process.env.PORT) || 8100;
let HOST = process.env.HOST || "0.0.0.0";
let FILE = process.env.TEXTSINK_FILE || path.join(os.homedir(), "textsink.jsonl");
let SECRET = process.env.TEXTSINK_SECRET || "miya"; // これに一致する時だけ保存
const MAX_BODY = 5 * 1024 * 1024; // 5MB
const RING = 500;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") PORT = Number(argv[++i]);
  else if (a === "--host") HOST = argv[++i];
  else if (a === "--file") FILE = argv[++i];
  else if (a === "--secret") SECRET = argv[++i];
  else if (a === "-h" || a === "--help") {
    console.log("usage: node textsink.js [--port N] [--host H] [--file PATH] [--secret CODE]");
    process.exit(0);
  }
}

// ─── store ──────────────────────────────────────────────
/** @type {Array<{id:string,ts:string,ip:string,contentType:string,bytes:number,text:string}>} */
let messages = [];
let counter = 0;

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    for (const line of lines.slice(-RING)) {
      try {
        messages.push(JSON.parse(line));
      } catch {}
    }
    counter = messages.length;
    log(`loaded ${messages.length} message(s) from ${FILE}`);
  } catch (e) {
    if (e.code !== "ENOENT") log("load error:", e.message);
  }
}

function appendToDisk(rec) {
  fs.appendFile(FILE, JSON.stringify(rec) + "\n", (e) => {
    if (e) log("append error:", e.message);
  });
}

// ─── helpers ────────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(...a) { console.log(ts(), ...a); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length, ...CORS });
  res.end(buf);
}
function sendText(res, status, text, type) {
  const buf = Buffer.from(String(text));
  res.writeHead(status, { "Content-Type": type || "text/plain; charset=utf-8", "Content-Length": buf.length, ...CORS });
  res.end(buf);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "-";
}

// 保存の可否を決める secret code 照合。ヘッダー X-Secret-Code (or X-Textsink-Secret)、
// もしくは ?code= で受ける。timing-safe に比較。
function checkSecret(req, u) {
  const provided = String(
    req.headers["x-secret-code"] || req.headers["x-textsink-secret"] || u.searchParams.get("code") || ""
  );
  const a = Buffer.from(provided);
  const b = Buffer.from(SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── HTML view ──────────────────────────────────────────
function renderHtml() {
  const recent = messages.slice(-50).reverse();
  const rows = recent
    .map(
      (m) => `<tr>
        <td class="mono">${esc(m.id)}</td>
        <td class="mono">${esc(m.ts)}</td>
        <td>${esc(m.bytes)}</td>
        <td><pre>${esc(m.text.length > 500 ? m.text.slice(0, 500) + " …" : m.text)}</pre></td>
      </tr>`
    )
    .join("\n");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>textsink</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 1rem; margin: 1rem 0; }
  textarea { width: 100%; box-sizing: border-box; min-height: 90px; font-family: ui-monospace, monospace; }
  button { padding: .5rem 1rem; border-radius: 8px; border: 1px solid #8886; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #8882; vertical-align: top; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .muted { color: #8889; }
</style></head><body>
<h1>textsink <span class="muted">— ${messages.length} 件保存済み</span></h1>
<div class="card">
  <form onsubmit="event.preventDefault();post()">
    <textarea id="t" placeholder="テキストを入力して送信 (POST /)"></textarea>
    <div style="margin-top:.5rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <input id="code" type="password" placeholder="secret code" autocomplete="off"
             style="padding:.5rem;border-radius:8px;border:1px solid #8886;font-family:ui-monospace,monospace">
      <button>POST 送信</button>
      <span id="r" class="muted"></span>
    </div>
    <div class="muted" style="margin-top:.35rem;font-size:12px">secret code が一致した送信だけ保存されます</div>
  </form>
</div>
<div class="card">
  <strong>直近 ${recent.length} 件</strong>（新しい順・本文は500字まで表示）
  <table><thead><tr><th>id</th><th>ts (UTC)</th><th>bytes</th><th>text</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4" class="muted">まだありません</td></tr>'}</tbody></table>
</div>
<script>
document.getElementById('code').value = localStorage.getItem('textsink_code') || '';
async function post(){
  const t=document.getElementById('t'), r=document.getElementById('r'), code=document.getElementById('code');
  localStorage.setItem('textsink_code', code.value);
  const res=await fetch(location.pathname,{method:'POST',headers:{'content-type':'text/plain; charset=utf-8','x-secret-code':code.value},body:t.value});
  if(res.status===401){ r.textContent='❌ secret code が違います（保存されていません）'; return; }
  const j=await res.json(); r.textContent='✅ saved id='+j.id+' ('+j.bytes+' bytes)'; t.value='';
  setTimeout(()=>location.reload(),400);
}
</script>
</body></html>`;
}

// ─── server ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const method = req.method || "GET";

  if (method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (method === "GET" && p === "/health") { sendJson(res, 200, { status: "ok", count: messages.length, time: ts() }); return; }

  // GET /messages/ID  → 生テキスト
  const mById = p.match(/^\/messages\/(.+)$/);
  if (method === "GET" && mById) {
    const rec = messages.find((m) => m.id === mById[1]);
    if (!rec) { sendJson(res, 404, { error: "not found" }); return; }
    sendText(res, 200, rec.text, rec.contentType || "text/plain; charset=utf-8");
    return;
  }

  // GET /messages  → 一覧 JSON (?limit ?q)
  if (method === "GET" && p === "/messages") {
    const limit = Math.min(Number(u.searchParams.get("limit")) || 100, RING);
    const q = u.searchParams.get("q");
    let list = messages;
    if (q) list = list.filter((m) => m.text.includes(q));
    const out = list.slice(-limit).reverse();
    sendJson(res, 200, { count: messages.length, returned: out.length, messages: out });
    return;
  }

  // DELETE /messages  → 全消去
  if (method === "DELETE" && p === "/messages") {
    const n = messages.length;
    messages = [];
    try { fs.truncateSync(FILE, 0); } catch {}
    sendJson(res, 200, { ok: true, cleared: n });
    return;
  }

  // GET / → HTML or JSON
  if (method === "GET" && p === "/") {
    const accept = req.headers["accept"] || "";
    if (accept.includes("application/json")) {
      sendJson(res, 200, { app: "textsink", count: messages.length, recent: messages.slice(-20).reverse() });
    } else {
      sendText(res, 200, renderHtml(), "text/html; charset=utf-8");
    }
    return;
  }

  // POST (任意パス) → secret code 一致時のみ 1件保存
  if (method === "POST") {
    if (!checkSecret(req, u)) {
      log(`POST ${u.pathname} <- REJECTED (bad secret) from ${clientIp(req)}`);
      sendJson(res, 401, {
        error: "invalid or missing secret code",
        hint: "send header 'X-Secret-Code: <code>' (or ?code=<code>)",
      });
      return;
    }
    let body;
    try {
      body = await readBody(req, MAX_BODY);
    } catch (e) {
      sendJson(res, 413, { error: e.message });
      return;
    }
    const text = body.toString("utf8");
    const rec = {
      id: `${String(++counter).padStart(5, "0")}-${crypto.randomBytes(3).toString("hex")}`,
      ts: ts(),
      ip: clientIp(req),
      path: u.pathname,
      contentType: req.headers["content-type"] || "text/plain",
      bytes: body.length,
      text,
    };
    messages.push(rec);
    if (messages.length > RING) messages = messages.slice(-RING);
    appendToDisk(rec);
    log(`POST ${u.pathname} <- ${rec.bytes} bytes from ${rec.ip} (id=${rec.id})`);
    sendJson(res, 201, { ok: true, id: rec.id, bytes: rec.bytes, stored: messages.length, ts: rec.ts });
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${p}` });
});

loadFromDisk();
server.listen(PORT, HOST, () => {
  log(`textsink listening on http://${HOST}:${PORT}  (file: ${FILE})`);
  log(`  secret gate: ON (code required to save; set via --secret / TEXTSINK_SECRET)`);
  log(`  POST: curl -s -X POST http://127.0.0.1:${PORT}/ -H 'x-secret-code: ${SECRET}' -H 'content-type: text/plain' --data 'hello'`);
  log(`  list: curl -s http://127.0.0.1:${PORT}/messages`);
});
