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
 *   - CORS open ("*", any method, common headers)
 *   - /proxy: forward Content-Type / Authorization / Accept / X-Atelier-Stream
 *   - StripAuthOnRedirect: when target replies 3xx, follow once with Authorization removed
 *     (Anypoint Exchange → S3 presigned URL pattern).
 *   - Streaming POST/GET pipe with no per-response timeout.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

// ─── args ──────────────────────────────────────────────
const args = process.argv.slice(2);
let port = 8000;
let host = "127.0.0.1";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = parseInt(args[++i], 10);
  else if (args[i] === "--host") host = args[++i];
}

const ROOT = path.resolve(__dirname, "..");

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
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
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
  setCors(res); setNoCache(res);
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
  // prevent traversal
  if (!target.startsWith(rootDir)) return null;
  return target;
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
      setCors(res); setNoCache(res);
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

  const body = (req.method === "GET") ? null : await readBody(req);

  // forward only the headers we care about
  const fwdHeaders = {};
  for (const h of ["content-type", "authorization", "accept", "x-atelier-stream"]) {
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
    setCors(res); setNoCache(res);
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
    setCors(res); setNoCache(res);
    res.end();
    log(req, 204);
    return;
  }
  if (req.url.startsWith("/proxy")) {
    return handleProxy(req, res);
  }
  if (req.method === "GET") return serveStatic(req, res);
  sendError(req, res, 404, "not found");
});

server.listen(port, host, () => {
  process.stderr.write(`╭─ Atelier dev server (node) ─────────────────\n`);
  process.stderr.write(`│  static: http://${host}:${port}/\n`);
  process.stderr.write(`│  proxy : http://${host}:${port}/proxy?url=...\n`);
  process.stderr.write(`╰─────────────────────────────────────────────\n`);
});
