#!/usr/bin/env node
/**
 * Atelier dev server (Node port of dev-server.py).
 *
 *   node server/dev-server.js [--port 8000]
 *
 *   GET/POST/OPTIONS /              : static files from project root
 *   GET/POST/OPTIONS /proxy?url=... : forward to <url> with CORS headers + Authorization stripped on 3xx
 *
 * Features matched against dev-server.py:
 *   - Static serve from project root (../)
 *   - Cache-Control: no-store on every response
 *   - CORS limited to the local origin (was "*"; tightened to mitigate cross-tab SSRF).
 *   - /proxy: forward Content-Type / Authorization / Accept / X-Atelier-Stream
 *   - StripAuthOnRedirect: when target replies 3xx, follow once with Authorization removed
 *     (Anypoint Exchange → S3 presigned URL pattern).
 *   - Streaming POST/GET pipe with no per-response timeout.
 *
 * Security:
 *   - SSRF guard: /proxy refuses RFC1918 / link-local / loopback / cloud metadata IPs and
 *     non-http(s) protocols. Only http/https URLs to public hosts pass through, with an
 *     allowlist for *.cloudhub.io / *.mulesoft.com / fonts.gstatic.com / cdn.jsdelivr.net /
 *     localhost (127.0.0.1, ::1). Override via --proxy-allow <hostname-glob,...>.
 *   - CORS: Access-Control-Allow-Origin echoes the request Origin only when it matches the
 *     bound host:port. Cross-origin tabs cannot read /proxy responses.
 *   - This server is intended for local development only. Do NOT expose it to the internet.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const net = require("net");
const dns = require("dns").promises;

// ─── args ──────────────────────────────────────────────
const args = process.argv.slice(2);
let port = 8000;
let host = "127.0.0.1";
let extraAllow = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = parseInt(args[++i], 10);
  else if (args[i] === "--host") host = args[++i];
  else if (args[i] === "--proxy-allow") extraAllow = String(args[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
}

const ROOT = path.resolve(__dirname, "..");

// /proxy 経由で許可するホスト suffix。 子ドメイン (.cloudhub.io 等) も含む。
const PROXY_ALLOW_SUFFIX = [
  "cloudhub.io",            // CH2 *.xdfpbh.jpn-e1 / *.pnwfdv.jpn-e1
  "mulesoft.com",           // anypoint.mulesoft.com / exchange* / repository
  "anypoint.mulesoft.com",
  "amazonaws.com",          // exchange の S3 presigned URL
  "salesforce.com",
  "force.com",
  "my.salesforce.com",
  "test.salesforce.com",
  "login.salesforce.com",
  "githubusercontent.com",  // raw scenarios
  "github.com",
  "login.microsoftonline.com",  // Microsoft Entra ID OAuth2 token/authorize endpoint
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
  "localhost",
  "127.0.0.1",
  "::1",
  ...extraAllow
];

// ─── mime ──────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json"
};

// ─── helpers ───────────────────────────────────────────
// CORS は **dev-server 自身が listen している origin のみ** に echo する。
// これで他オリジン (例: 開発機で開いた攻撃サイト) のタブから /proxy 経由で
// 内部ネットを叩いてレスポンスを読む経路 (SSRF + CORS open) を遮断する。
function setCors(req, res) {
  const allowOrigins = [
    `http://${host}:${port}`,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
  const reqOrigin = req.headers.origin;
  if (reqOrigin && allowOrigins.includes(reqOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", reqOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Atelier-Stream, Mcp-Session-Id, Mcp-Protocol-Version");
  // MCP の session id を JS (fetch) から読めるよう expose する
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, X-Atelier-Proxied-Url");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function setNoCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}
function ts() {
  return new Date().toTimeString().slice(0, 8);
}
function log(req, status, extra) {
  const tag = req.socket.remoteAddress || "-";
  process.stderr.write(`[${ts()}] ${tag} ${req.method} ${req.url} → ${status}${extra ? " " + extra : ""}\n`);
}
function sendJson(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  setCors(req, res); setNoCache(res);
  res.setHeader("Content-Length", body.length);
  res.end(body);
  log(req, status);
}
function sendError(req, res, status, msg) {
  sendJson(req, res, status, { error: msg });
}

// ─── static ────────────────────────────────────────────
function safeJoin(rootDir, urlPath) {
  // strip query/fragment
  const decoded = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  const target = path.normalize(path.join(rootDir, decoded));
  // prevent traversal — startsWith だけだと rootDir + "-evil" のような prefix 衝突を許してしまうので
  // path.relative で `..` 系が含まれないことも検査する。
  const rel = path.relative(rootDir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (target !== rootDir && !target.startsWith(rootDir + path.sep)) return null;
  return target;
}

// ─── SSRF guard ────────────────────────────────────────
function isPrivateIPv4(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 10) return true;                      // 10.0.0.0/8
  if (a === 127) return true;                     // 127.0.0.0/8
  if (a === 0) return true;                       // 0.0.0.0/8 (current network)
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                      // multicast / reserved
  return false;
}
function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;          // unspecified / loopback
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;        // ULA fc00::/7
  if (lower.startsWith("ff")) return true;                                  // multicast
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice("::ffff:".length);
    if (isPrivateIPv4(v4)) return true;
  }
  return false;
}
function hostnameIsAllowed(hostname) {
  const h = hostname.toLowerCase();
  return PROXY_ALLOW_SUFFIX.some(s => h === s || h.endsWith("." + s));
}
async function ssrfCheck(targetUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { return { ok: false, reason: "invalid url" }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `protocol "${parsed.protocol}" not allowed` };
  }
  const allowed = hostnameIsAllowed(parsed.hostname);
  if (!allowed) {
    // allowlist 外でもいきなり拒否はせず、 DNS 解決して private IP かをチェック。
    // 結果が public IP であれば許可する。 攻撃者が任意 host を仕込んでも 169.254/10.x/127.x には
    // 飛べない。 この緩めの仕様は demo 用途のため (社外の任意 SaaS に curl 代わりで使う)。
    let ips = [];
    if (net.isIP(parsed.hostname)) {
      ips = [parsed.hostname];
    } else {
      try {
        const recs = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
        ips = recs.map(r => r.address);
      } catch (e) {
        return { ok: false, reason: `dns lookup failed: ${e.code || e.message}` };
      }
    }
    for (const ip of ips) {
      const fam = net.isIP(ip);
      const priv = (fam === 4) ? isPrivateIPv4(ip) : (fam === 6) ? isPrivateIPv6(ip) : true;
      if (priv) {
        return { ok: false, reason: `host "${parsed.hostname}" resolves to private/reserved IP ${ip}` };
      }
    }
    return { ok: true, parsed, ips, viaAllowlist: false };
  }
  // allowlist にある host (Anypoint / GitHub / fonts 等) は CGNAT(100.64.0.0/10) や
  // CDN 内部 IP を返してくることがあるので IP check はスキップ。
  // localhost / 127.0.0.1 は明示的に許可される (allowlist に含めてある)。
  return { ok: true, parsed, viaAllowlist: true };
}
function serveStatic(req, res) {
  let p = safeJoin(ROOT, req.url);
  if (p == null) { sendError(req, res, 403, "forbidden"); return; }
  fs.stat(p, (err, st) => {
    if (err) { sendError(req, res, 404, "not found"); return; }
    if (st.isDirectory()) p = path.join(p, "index.html");
    fs.stat(p, (err2, st2) => {
      if (err2) { sendError(req, res, 404, "not found"); return; }
      const ext = path.extname(p).toLowerCase();
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.setHeader("Content-Length", st2.size);
      setCors(req, res); setNoCache(res);
      if (req.method === "HEAD") {
        res.end();
        log(req, 200, p.replace(ROOT, "") + " (head)");
        return;
      }
      const stream = fs.createReadStream(p);
      stream.on("error", () => { try { res.end(); } catch {} });
      stream.pipe(res);
      log(req, 200, p.replace(ROOT, ""));
    });
  });
}

// ─── proxy ─────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Forward a request once (no auto-redirect). Returns a promise of the response object.
function forwardOnce(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (e) { reject(new Error("invalid url: " + targetUrl)); return; }
    const lib = parsed.protocol === "https:" ? https : http;
    const opts = {
      method,
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers
    };
    const upstream = lib.request(opts, (resp) => resolve(resp));
    upstream.on("error", reject);
    if (body && body.length) upstream.write(body);
    upstream.end();
  });
}

async function handleProxy(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const target = parsedUrl.query.url;
  if (!target) { sendError(req, res, 400, "missing url= param"); return; }

  // Origin check — /proxy は dev-server 自身の origin からの fetch のみ許可。
  // 他オリジンの悪意あるタブから内部ホストを叩かれる経路を遮断する。
  const allowOrigins = [
    `http://${host}:${port}`,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
  const reqOrigin = req.headers.origin;
  if (reqOrigin && !allowOrigins.includes(reqOrigin)) {
    sendError(req, res, 403, `origin "${reqOrigin}" not allowed`);
    return;
  }

  // SSRF guard
  const check = await ssrfCheck(target);
  if (!check.ok) {
    sendError(req, res, 403, `proxy denied: ${check.reason}`);
    log(req, 403, "proxy DENY " + target.slice(0, 80));
    return;
  }

  const body = (req.method === "GET") ? null : await readBody(req);

  // forward only the headers we care about
  const fwdHeaders = {};
  for (const h of ["content-type", "authorization", "accept", "x-atelier-stream", "mcp-session-id", "mcp-protocol-version"]) {
    const v = req.headers[h];
    if (v) fwdHeaders[h.replace(/(^|-)([a-z])/g, (_, p, c) => p + c.toUpperCase())] = v;
  }

  try {
    let upstream = await forwardOnce(target, req.method, fwdHeaders, body);

    // StripAuthOnRedirect: if 3xx with Location, follow once without Authorization
    let redirectTarget = null;
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
      redirectTarget = new URL(upstream.headers.location, target).toString();
      // drain original
      upstream.resume();
      // redirect 先にも SSRF guard を適用
      const redirCheck = await ssrfCheck(redirectTarget);
      if (!redirCheck.ok) {
        sendError(req, res, 403, `proxy redirect denied: ${redirCheck.reason}`);
        log(req, 403, "proxy DENY redirect " + redirectTarget.slice(0, 80));
        return;
      }
      const followHeaders = { ...fwdHeaders };
      delete followHeaders["Authorization"];
      // GET forces on 301/302/303 per common browser semantics (Exchange → S3 case is 303 GET)
      const followMethod = ([301, 302, 303].includes(upstream.statusCode)) ? "GET" : req.method;
      const followBody   = (followMethod === "GET") ? null : body;
      upstream = await forwardOnce(redirectTarget, followMethod, followHeaders, followBody);
    }

    res.statusCode = upstream.statusCode || 502;
    // pass through Content-Type
    if (upstream.headers["content-type"])
      res.setHeader("Content-Type", upstream.headers["content-type"]);
    // MCP Streamable HTTP: session id を client に返す (initialize の応答で発行される)
    if (upstream.headers["mcp-session-id"])
      res.setHeader("Mcp-Session-Id", upstream.headers["mcp-session-id"]);
    setCors(req, res); setNoCache(res);
    res.setHeader("X-Atelier-Proxied-Url", target);
    if (redirectTarget) res.setHeader("X-Atelier-Followed-Redirect", redirectTarget);
    upstream.pipe(res);
    log(req, res.statusCode, "proxy " + target.slice(0, 80));
  } catch (e) {
    sendJson(req, res, 502, { error: String(e && e.message || e), target });
  }
}

// ─── server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    setCors(req, res); setNoCache(res);
    res.end();
    log(req, 204);
    return;
  }
  if (req.url.startsWith("/proxy")) {
    return handleProxy(req, res);
  }
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  sendError(req, res, 404, "not found");
});

server.listen(port, host, () => {
  process.stderr.write(`╭─ Atelier dev server (node) ─────────────────\n`);
  process.stderr.write(`│  static: http://${host}:${port}/\n`);
  process.stderr.write(`│  proxy : http://${host}:${port}/proxy?url=...\n`);
  process.stderr.write(`╰─────────────────────────────────────────────\n`);
});
