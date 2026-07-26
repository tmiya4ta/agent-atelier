// llm-proxy.js — 実 LLM (HF Inference router 等) への dumb pass-through proxy
//
// 経路: ブラウザ → (Atelier /proxy or theorems-relay) → host:8103 → 実 LLM API
//
// 役割は 3 つだけ (dumb = 翻訳しない・provider 非依存):
//   1. Authorization: Bearer <token> を付与 (token は host 側 env/ファイル、ブラウザに出さない)
//   2. CORS (ブラウザから叩けるように)
//   3. リクエストをそのまま upstream に転送し、応答をそのまま返す
//
// OpenAI 互換 (/v1/chat/completions) をそのまま流すので、upstream を差し替えるだけで
// HF / OpenAI / ローカル (ollama 等) に切り替えられる。翻訳 (Anthropic⇔OpenAI) は agent 側。
//
// 設定 (env、無ければ既定):
//   LLM_UPSTREAM  … 転送先 (既定 https://router.huggingface.co)
//   HF_TOKEN / LLM_TOKEN … Bearer token。無ければ ~/.hf_token を読む。
//   PORT          … 待受ポート (既定 8103)
//
// 常駐: node server/llm-proxy.js (run_in_background)。Caddy に llm.theorems.io → 172.23.0.1:8103 を足す。

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const os    = require("os");

const PORT     = process.env.PORT || 8103;
const UPSTREAM = (process.env.LLM_UPSTREAM || "https://router.huggingface.co").replace(/\/+$/, "");
let   TOKEN    = process.env.HF_TOKEN || process.env.LLM_TOKEN || "";
if (!TOKEN) {
  // ~/.hf_token を読む (chmod 600 推奨)。token をチャット/コードに埋め込まないための逃げ道。
  try { TOKEN = fs.readFileSync(os.homedir() + "/.hf_token", "utf8").trim(); } catch { /* none */ }
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Expose-Headers": "Content-Type",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  // health
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM, token: TOKEN ? "set" : "MISSING" }));
    return;
  }

  // それ以外は upstream に req.url をそのまま (例 /v1/chat/completions) 転送
  const target = new URL(UPSTREAM + req.url);
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const buf = Buffer.concat(chunks);
    const headers = {
      "Content-Type": req.headers["content-type"] || "application/json",
      "Accept":       req.headers["accept"] || "application/json",
    };
    if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
    if (buf.length) headers["Content-Length"] = buf.length;

    const up = https.request({
      method:   req.method,
      hostname: target.hostname,
      path:     target.pathname + target.search,
      headers,
    }, upRes => {
      res.writeHead(upRes.statusCode, { ...CORS, "Content-Type": upRes.headers["content-type"] || "application/json" });
      upRes.pipe(res);
    });
    up.on("error", e => {
      res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e && e.message || e) } }));
    });
    if (buf.length) up.write(buf);
    up.end();
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`llm-proxy on :${PORT} → ${UPSTREAM}  (token ${TOKEN ? "set" : "MISSING — put it in ~/.hf_token"})`));
