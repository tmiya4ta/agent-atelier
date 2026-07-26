#!/usr/bin/env node
/**
 * files-upload — theorems-files (files.theorems.io の Caddy file_server) への
 * PUT/POST アップロードを受ける小さなアプリ。
 *
 *   node server/files-upload.js [--port 8104] [--host 0.0.0.0] [--root <dir>]
 *
 * Caddy 標準の file_server は read-only (書き込み機能なし) なので、
 * PUT/POST だけこのアプリに reverse_proxy し、書き込みを代行する。
 * 認証は Caddy 側の basic_auth (files.theorems.io の site block) が既に
 * サイト全体にかかっているので、このアプリ自体には認証を持たせない。
 *
 * theorems-relay / edge 経由での公開を想定:
 *   client → https://files.theorems.io/<path>  (Caddy basic_auth)
 *          → (GET/HEAD)  file_server (root /srv/files, 読み取り専用)
 *          → (PUT/POST)  host:8104 (このアプリ, 書き込み)
 *
 * エンドポイント:
 *   GET  /              : ブラウザ用の簡易アップロード UI (fetch PUT で送信)
 *   GET  /health         : ヘルスチェック
 *   PUT  /<path>          : body をそのまま <root>/<path> に書き込む (親ディレクトリは自動作成)
 *   POST /<path>          : PUT と同じ (curl -X POST --data-binary @file が使いやすいクライアント向け)
 *
 * 既定では既存ファイルを上書きしない (409)。上書きしたい時は ?overwrite=1 を付ける。
 * パストラバーサル (`../` 等) は解決後のパスが root 配下か検証して弾く。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
let PORT = Number(process.env.PORT) || 8104;
let HOST = process.env.HOST || "0.0.0.0";
let ROOT = process.env.FILES_ROOT || "/home/myst/srv/theorems-files";
const MAX_BODY = 200 * 1024 * 1024; // 200MB

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") PORT = Number(argv[++i]);
  else if (a === "--host") HOST = argv[++i];
  else if (a === "--root") ROOT = argv[++i];
  else if (a === "-h" || a === "--help") {
    console.log("usage: node files-upload.js [--port N] [--host H] [--root DIR]");
    process.exit(0);
  }
}
ROOT = path.resolve(ROOT);

function ts() { return new Date().toISOString(); }
function log(...a) { console.log(ts(), ...a); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length });
  res.end(buf);
}
function sendHtml(res, status, html) {
  const buf = Buffer.from(html);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length });
  res.end(buf);
}

// decodeURIComponent 後のパスを root 配下に解決する。 `..` 等で root を
// 抜けようとした場合は null を返す (呼び出し側で 400 にする)。
function safeResolve(root, urlPath) {
  const decoded = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const resolved = path.resolve(root, decoded);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  if (resolved === root) return null; // ルート自体への書き込みは不可 (ファイル名が要る)
  return resolved;
}

function uploadPageHtml() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>files-upload</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 640px; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 1rem; margin: 1rem 0; }
  input[type=file] { width: 100%; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: .5rem; border-radius: 8px; border: 1px solid #8886; font-family: ui-monospace, monospace; }
  button { padding: .5rem 1rem; border-radius: 8px; border: 1px solid #8886; cursor: pointer; margin-top: .5rem; }
  label { display: block; margin-top: .75rem; font-size: 12px; opacity: .8; }
  .muted { color: #8889; font-size: 12px; }
  #r { margin-top: .5rem; }
</style></head><body>
<h1>files-upload</h1>
<p class="muted">ここでアップロードしたファイルは <a href="../">files.theorems.io の一覧</a>に並びます。</p>
<div class="card">
  <input id="f" type="file">
  <label>保存先パス (空欄ならファイル名をそのまま使用)</label>
  <input id="p" type="text" placeholder="例: reports/2026-07.pdf">
  <label><input id="ow" type="checkbox"> 既存ファイルを上書きする</label>
  <button onclick="upload()">アップロード</button>
  <div id="r" class="muted"></div>
</div>
<script>
async function upload(){
  const f = document.getElementById('f').files[0];
  const r = document.getElementById('r');
  if (!f) { r.textContent = 'ファイルを選択してください'; return; }
  const p = document.getElementById('p').value.trim() || f.name;
  const ow = document.getElementById('ow').checked;
  r.textContent = 'アップロード中…';
  try {
    // '_upload/' は常に files ルートの1階層下 (直アクセスでも relay 経由の /files/_upload/ でも同じ)。
    // 絶対パス '/' + ... で書くと relay 経由時に 'files' プレフィックスが外れて別サービスに飛ぶため、
    // 必ず '../' 相対で files ルートへ戻す。
    const res = await fetch('../' + encodeURIComponent(p).replace(/%2F/g, '/') + (ow ? '?overwrite=1' : ''), {
      method: 'PUT', body: f
    });
    const j = await res.json();
    if (!res.ok) { r.textContent = '❌ ' + (j.error || res.status); return; }
    r.textContent = '✅ 保存しました: ' + j.path + ' (' + j.bytes + ' bytes)';
  } catch (e) { r.textContent = '❌ ' + e.message; }
}
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";

  if (method === "GET" && u.pathname === "/health") {
    sendJson(res, 200, { status: "ok", root: ROOT, time: ts() });
    return;
  }
  if (method === "GET" && u.pathname === "/") {
    sendHtml(res, 200, uploadPageHtml());
    return;
  }

  if (method === "PUT" || method === "POST") {
    const target = safeResolve(ROOT, u.pathname);
    if (!target) {
      sendJson(res, 400, { error: "invalid path" });
      return;
    }
    if (!req.headers["content-length"] && req.headers["transfer-encoding"] !== "chunked") {
      // 空リクエストなど。 続行しても readBody が空 Buffer を返すだけなので許容。
    }
    let body;
    try {
      body = await readBody(req, MAX_BODY);
    } catch (e) {
      sendJson(res, 413, { error: e.message });
      return;
    }
    const overwrite = u.searchParams.get("overwrite") === "1";
    if (!overwrite && fs.existsSync(target)) {
      sendJson(res, 409, { error: "file already exists (add ?overwrite=1 to replace)" });
      return;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    } catch (e) {
      log(`write error for ${target}:`, e.message);
      sendJson(res, 500, { error: e.message });
      return;
    }
    const rel = path.relative(ROOT, target);
    log(`${method} ${u.pathname} -> ${rel} (${body.length} bytes)`);
    sendJson(res, 201, { ok: true, path: rel, bytes: body.length, ts: ts() });
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${u.pathname}` });
});

server.listen(PORT, HOST, () => {
  log(`files-upload listening on http://${HOST}:${PORT}  (root: ${ROOT})`);
  log(`  PUT:  curl -T myfile.txt https://myst:<pw>@files.theorems.io/myfile.txt`);
  log(`  POST: curl -X POST --data-binary @myfile.txt https://myst:<pw>@files.theorems.io/myfile.txt`);
});
