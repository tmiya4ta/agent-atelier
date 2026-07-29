// RestAdapter — REST API クライアント (現在は raw リクエストのみ)
//
// Connect ダイアログの url は「base URL (任意)」で、 raw タブの初期値に入るだけ。
// 接続時にネットワークアクセスは行わない (叩く先は raw タブで都度決める)。
//
// OpenAPI/Swagger からエンドポイント一覧を生成する機能は実装済みだが、 現在は
// connect() から呼んでいない (raw だけ先に使いたいという運用判断)。 復活させる
// ときは connect() で _loadSpec() を await し、 window.js の _setupRestMode で
// endpoints タブを表示に戻せばよい。 spec 解析部 (parseSpec / extractOperations /
// resolveBaseUrl / buildUrl) は __internals 経由でテスト済みのまま残してある。
//
// CORS:
//   まずブラウザから直接 fetch し、 CORS で落ちたときだけ /proxy へフォールバックする。
//   /proxy は SSRF ガードの allowlist (自ドメイン + Anypoint 系) に限られるので、
//   allowlist を緩めずに「CORS を許可している公開 API」まで対象を広げるための順序。
//   (a2a.js / mcp.js の proxify() は最初から /proxy 前提なので、 ここだけ挙動が違う)

import { ProtocolAdapter, headersToObj } from "./base.js";

export class RestAdapter extends ProtocolAdapter {
  static get id()    { return "rest"; }
  static get label() { return "REST"; }
  // chat は持たない。 raw リクエストが主役。
  static get primaryTab() { return "raw"; }

  constructor(config) {
    super(config);
    this.specUrl    = "";     // (OpenAPI 復活時に使う)
    this.spec       = null;
    this.operations = [];
    this.specError  = null;
    // 接続時に指定された base URL。 rest://local/... の synthetic url は
    // window/bookmark のキー用なので base としては使わない。
    // 末尾スラッシュの除去もしない — raw タブの初期値になるだけなので、
    // 入力されたものをそのまま扱う方が意図どおりになる。
    const u = (config.url || "").trim();
    this.baseUrl = /^rest:\/\//i.test(u) ? "" : u;
  }

  // ネットワークアクセスなしで即 open する。 叩く先は raw タブで都度決めるので、
  // 接続の時点で到達性を確かめる相手がいない (base URL は任意入力)。
  async connect() {
    this._setState("connecting");
    this.agentCard = this._buildCard();
    this._setState("open");
    this.startedAt = Date.now();
    this._emit("open", { card: this.agentCard, operations: [], spec: null, specError: null });
  }

  // ─── spec の取得と解析 ─────────────────────────────────
  async _loadSpec() {
    if (!this.specUrl) throw new Error("no spec URL");
    const headers = { Accept: "application/json, application/yaml, text/yaml, text/plain, */*" };
    if (this.config.auth) headers["Authorization"] = `Bearer ${this.config.auth}`;
    if (this.config.authHeaders) Object.assign(headers, this.config.authHeaders);

    this._emit("rpc", { dir: "out", method: `GET ${this.specUrl}`, headers, raw: `GET ${this.specUrl}` });
    const { res, text, via } = await this._fetchText(this.specUrl, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching spec`);
    this._emit("rpc", {
      dir: "in", method: `200 OK · spec (${via})`,
      headers: headersToObj(res.headers), raw: text.slice(0, 4000)
    });

    const doc = parseSpec(text, this.specUrl);
    if (!doc || typeof doc !== "object") throw new Error("spec is not a JSON/YAML object");
    if (!doc.paths) throw new Error("not an OpenAPI/Swagger document (no `paths`)");

    this.spec       = doc;
    this.operations = extractOperations(doc);
    this.baseUrl    = resolveBaseUrl(doc, this.specUrl);
  }

  // ─── operation 実行 ────────────────────────────────────
  // values = { path: {...}, query: {...}, header: {...}, body: <string|undefined> }
  async callOperation(op, values = {}) {
    const url = buildUrl(this.baseUrl, op, values);
    const headers = { Accept: "application/json, */*" };
    if (op.body) headers["Content-Type"] = op.bodyContentType || "application/json";
    Object.assign(headers, values.header || {});
    if (this.config.auth) headers["Authorization"] = `Bearer ${this.config.auth}`;
    if (this.config.authHeaders) Object.assign(headers, this.config.authHeaders);
    return this.rawRequest({ method: op.method, url, headers, body: values.body });
  }

  // raw タブ / operation 実行の共通経路。 結果は表示しやすい形に正規化して返す。
  async rawRequest({ method = "GET", url, headers = {}, body }) {
    if (!url) throw new Error("url required");
    const ac = new AbortController();
    this._inflight = ac;
    const started = Date.now();
    const init = { method, headers, signal: ac.signal };
    if (body != null && body !== "" && method !== "GET" && method !== "HEAD") init.body = body;

    this._emit("rpc", { dir: "out", method: `${method} ${url}`, headers, payload: body, raw: body || `${method} ${url}` });
    try {
      const { res, text, via } = await this._fetchText(url, init);
      const ms = Date.now() - started;
      const resHeaders = headersToObj(res.headers);
      this._emit("rpc", {
        dir: res.ok ? "in" : "err", method: `${res.status} ${res.statusText || ""} · ${method} (${via})`,
        headers: resHeaders, raw: text.slice(0, 20000)
      });
      return { status: res.status, statusText: res.statusText, headers: resHeaders, body: text, ms, via, ok: res.ok };
    } catch (e) {
      if (e?.name === "AbortError") {
        this._emit("aborted", { method });
        const err = new Error("aborted by user"); err.name = "AbortError"; throw err;
      }
      this._emit("rpc", { dir: "err", method: `error · ${method} ${url}`, raw: String(e) });
      throw e;
    } finally {
      if (this._inflight === ac) this._inflight = null;
    }
  }

  // 直 fetch を先に試し、 落ちたら /proxy 経由で再試行する。
  // 同一オリジンなら proxy は不要なのでそのまま。 direct が失敗する理由は
  // ほぼ CORS (TypeError: Failed to fetch) で、 status は取れない。
  async _fetchText(url, init) {
    const sameOrigin = (() => {
      try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
    })();
    if (!sameOrigin) {
      try {
        const res = await fetch(url, init);
        return { res, text: await res.text(), via: "direct" };
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        // CORS 等 → /proxy にフォールバック (allowlist 内のホストのみ通る)
        this._emit("rpc", { dir: "err", method: "direct fetch failed — retrying via /proxy", raw: String(e) });
      }
    }
    const res = await fetch(proxied(url), init);
    return { res, text: await res.text(), via: sameOrigin ? "same-origin" : "proxy" };
  }

  _buildCard() {
    return {
      name:        this.config.name || this.baseUrl || "REST",
      description: "raw HTTP client — メソッド / URL / ヘッダ / ボディを直接指定して送信します。",
      version:     "",
      url:         this.baseUrl,
      capabilities: {},
      skills: []
    };
  }
}

// ─── helpers ────────────────────────────────────────────
function proxied(targetUrl) {
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// JSON を先に試し、 だめなら YAML。 spec URL の拡張子は当てにならない
// (Exchange の download URL は拡張子を持たないことがある) ので中身で判定する。
function parseSpec(text, url) {
  const t = (text || "").trim();
  if (!t) throw new Error("empty spec");
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  if (typeof window !== "undefined" && window.jsyaml) return window.jsyaml.load(t);
  // JSON でもなく YAML パーサも無い
  try { return JSON.parse(t); }
  catch { throw new Error("spec looks like YAML but the YAML parser is not loaded"); }
}

// paths.<path>.<method> を平坦な operation の配列にする。
// path レベルの parameters は operation レベルとマージする (OpenAPI 3 / Swagger 2 共通)。
const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

function extractOperations(doc) {
  const out = [];
  const paths = doc.paths || {};
  for (const p of Object.keys(paths)) {
    const item = paths[p] || {};
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!op || typeof op !== "object") continue;
      const params = mergeParams(shared, Array.isArray(op.parameters) ? op.parameters : [], doc);
      const bodyInfo = extractBody(op, doc);
      out.push({
        id:          op.operationId || `${m.toUpperCase()} ${p}`,
        method:      m.toUpperCase(),
        path:        p,
        summary:     op.summary || "",
        description: op.description || "",
        tags:        Array.isArray(op.tags) ? op.tags : [],
        params,
        body:            bodyInfo.has,
        bodyRequired:    bodyInfo.required,
        bodyContentType: bodyInfo.contentType,
        bodySample:      bodyInfo.sample
      });
    }
  }
  return out;
}

// 同名 (name+in) は operation 側で上書き。 $ref は spec 内を解決する。
function mergeParams(shared, own, doc) {
  const map = new Map();
  for (const raw of [...shared, ...own]) {
    const p = deref(raw, doc);
    if (!p || !p.name) continue;
    map.set(`${p.in}:${p.name}`, {
      name:        p.name,
      in:          p.in || "query",
      required:    !!p.required,
      description: p.description || "",
      // OpenAPI 3 は schema、 Swagger 2 は直下に type を置く
      type:        p.schema?.type || p.type || "string",
      enum:        p.schema?.enum || p.enum || null,
      default:     p.schema?.default ?? p.default ?? ""
    });
  }
  return [...map.values()];
}

// OpenAPI 3 の requestBody と Swagger 2 の in:body パラメータの両方を見る。
function extractBody(op, doc) {
  const rb = deref(op.requestBody, doc);
  if (rb && rb.content) {
    const ct = Object.keys(rb.content)[0] || "application/json";
    const schema = deref(rb.content[ct]?.schema, doc);
    return { has: true, required: !!rb.required, contentType: ct, sample: sampleFor(schema, doc) };
  }
  const bodyParam = (op.parameters || []).map(p => deref(p, doc)).find(p => p && p.in === "body");
  if (bodyParam) {
    const schema = deref(bodyParam.schema, doc);
    return { has: true, required: !!bodyParam.required, contentType: "application/json", sample: sampleFor(schema, doc) };
  }
  return { has: false, required: false, contentType: "", sample: "" };
}

// "#/components/schemas/Foo" 形式のローカル $ref だけ解決する (外部参照は非対応)。
function deref(node, doc, depth = 0) {
  if (!node || typeof node !== "object" || depth > 10) return node;
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let cur = doc;
  for (const seg of ref.slice(2).split("/")) {
    cur = cur?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (cur == null) return node;
  }
  return deref(cur, doc, depth + 1);
}

// schema から編集の出発点になる JSON サンプルを組み立てる。
// 厳密な生成ではなく「型が分かる雛形」が目的 (フォームに置いてユーザーが直す)。
function sampleFor(schema, doc, depth = 0) {
  const s = deref(schema, doc, 0);
  if (!s || depth > 4) return "";
  try { return JSON.stringify(sampleValue(s, doc, depth), null, 2); }
  catch { return ""; }
}
function sampleValue(s, doc, depth) {
  const sc = deref(s, doc);
  if (!sc || depth > 4) return null;
  if (sc.example !== undefined) return sc.example;
  if (sc.default !== undefined) return sc.default;
  if (Array.isArray(sc.enum) && sc.enum.length) return sc.enum[0];
  switch (sc.type) {
    case "object": {
      const o = {};
      for (const k of Object.keys(sc.properties || {})) o[k] = sampleValue(sc.properties[k], doc, depth + 1);
      return o;
    }
    case "array":  return [sampleValue(sc.items || {}, doc, depth + 1)];
    case "integer":
    case "number": return 0;
    case "boolean": return false;
    case "string": return "";
    default: {
      if (sc.properties) {
        const o = {};
        for (const k of Object.keys(sc.properties)) o[k] = sampleValue(sc.properties[k], doc, depth + 1);
        return o;
      }
      return null;
    }
  }
}

// servers[0].url (OpenAPI 3) / host+basePath+schemes (Swagger 2) / spec URL の origin。
// 相対 server URL は spec URL 基準で絶対化する。
function resolveBaseUrl(doc, specUrl) {
  const first = Array.isArray(doc.servers) ? doc.servers[0] : null;
  if (first?.url) {
    let u = String(first.url);
    // {variable} を default で埋める
    for (const [k, v] of Object.entries(first.variables || {})) {
      u = u.replace(new RegExp(`\\{${k}\\}`, "g"), v?.default ?? "");
    }
    try { return stripSlash(new URL(u, specUrl).href); } catch { return stripSlash(u); }
  }
  if (doc.host) {
    const scheme = (Array.isArray(doc.schemes) && doc.schemes[0]) || "https";
    return stripSlash(`${scheme}://${doc.host}${doc.basePath || ""}`);
  }
  try { const u = new URL(specUrl); return stripSlash(u.origin); } catch { return ""; }
}
function stripSlash(s) { return String(s || "").replace(/\/+$/, ""); }

// path テンプレートを埋め、 query を組み立てる。
export function buildUrl(baseUrl, op, values = {}) {
  let path = op.path || "";
  for (const [k, v] of Object.entries(values.path || {})) {
    path = path.replace(new RegExp(`\\{${escapeRe(k)}\\}`, "g"), encodeURIComponent(v));
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(values.query || {})) {
    if (v !== "" && v != null) qs.append(k, v);
  }
  const q = qs.toString();
  return `${stripSlash(baseUrl)}${path.startsWith("/") ? "" : "/"}${path}${q ? `?${q}` : ""}`;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// テスト用に内部関数を公開 (window からは使わない)
export const __internals = { parseSpec, extractOperations, resolveBaseUrl, buildUrl, deref, sampleFor };
