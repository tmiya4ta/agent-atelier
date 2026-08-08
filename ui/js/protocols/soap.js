// SOAP adapter — WSDL を読んで operation 一覧を出し、 Envelope の雛形を組み立てる。
//
// 送信そのものは REST の raw ペインを使い回す。 そのため rawRequest() のシグネチャは
// RestAdapter と同一にしてある (window.js の _wireRawPane が無改修で動く)。
//
// SOAP は CORS ヘッダを返すサーバがほぼ無いので、 実運用ではまず /proxy 経由になる。
// /proxy には SSRF allowlist があるため、 第三者ホストは deployment の
// `proxy.allowHosts` に足す必要がある (info タブにその旨を出している)。
//
// 対応範囲 (第一段階):
//   - document/literal と RPC style の両方の binding を読む
//   - SOAP 1.1 / 1.2 を binding の名前空間で判別し、 Content-Type と action の渡し方を変える
//   - Envelope 雛形は inline schema の xs:sequence / xs:element / xs:complexType から組む
// 未対応: xs:choice · xs:any · maxOccurs の繰り返し展開 · <xs:import> の外部取得 · WS-Security

import { ProtocolAdapter, headersToObj } from "./base.js";

const NS = {
  wsdl:   "http://schemas.xmlsoap.org/wsdl/",
  soap11: "http://schemas.xmlsoap.org/wsdl/soap/",
  soap12: "http://schemas.xmlsoap.org/wsdl/soap12/",
  xsd:    "http://www.w3.org/2001/XMLSchema",
  env11:  "http://schemas.xmlsoap.org/soap/envelope/",
  env12:  "http://www.w3.org/2003/05/soap-envelope",
};

export class SoapAdapter extends ProtocolAdapter {
  static get id()    { return "soap"; }
  static get label() { return "SOAP"; }
  // 会話 protocol ではないので chat は使わない。 REST と同じ raw ペインが主役。
  static get primaryTab() { return "raw"; }

  constructor(config) {
    super(config);
    this.wsdlUrl    = String(config.url || "").trim();
    this.baseUrl    = "";      // 既定の endpoint (raw ペインの初期値に使われる)
    this.operations = [];
    this.serviceName = "";
    this.wsdlError  = null;
  }

  async connect() {
    this._setState("connecting");
    try {
      const { text, via } = await this._fetchText(this.wsdlUrl);
      this._emit("rpc", {
        dir: "in", method: `200 OK · wsdl · ${via}`,
        raw: text.length > 20000 ? text.slice(0, 20000) + "\n… (truncated)" : text
      });
      const parsed = parseWsdl(text);
      this.serviceName = parsed.serviceName;
      this.operations  = parsed.operations;
      this.baseUrl     = parsed.operations[0]?.endpoint || "";
    } catch (e) {
      // WSDL が読めなくても raw ペインからは送れる。 行き止まりにしない。
      this.wsdlError = e?.message || String(e);
      this._emit("rpc", { dir: "err", method: "wsdl fetch/parse failed", raw: this.wsdlError });
      this.baseUrl = this.wsdlUrl.replace(/\?wsdl$/i, "");
    }
    this._setState("open");
    this.startedAt = Date.now();
    this._emit("open", {
      card: this._buildCard(),
      operations: this.operations,
      serviceName: this.serviceName,
      wsdlError: this.wsdlError
    });
  }

  // まず直接 fetch し、 CORS で落ちたら /proxy に退避する (REST と同じ方針)。
  async _fetchText(url) {
    this._emit("rpc", { dir: "out", method: `GET ${url}`, raw: `GET ${url}` });
    try {
      // CORS が無い相手は例外で即返るが、 ヘアピン NAT のように応答も拒否も
      // 返らない相手だと延々待つ (LAN 内から *.theorems.io がこれ)。 数秒で見切る。
      const r = await fetch(url, { headers: { Accept: "text/xml, application/xml, */*" },
                                   signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { text: await r.text(), via: "direct" };
    } catch (direct) {
      const r = await fetch(proxied(url), { headers: { Accept: "text/xml, application/xml, */*" } });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}${body ? ` · ${body.slice(0, 200)}` : ""}`);
      }
      return { text: await r.text(), via: "/proxy" };
    }
  }

  // window.js の raw ペインがそのまま呼ぶ。 RestAdapter と同一シグネチャ。
  async rawRequest({ method = "POST", url, headers = {}, body = "" } = {}) {
    const started = Date.now();
    const send = async (target, via, timeoutMs) => {
      const res = await fetch(target, { method, headers, body: body || undefined,
                                        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
      const text = await res.text();
      return {
        ok: res.ok, status: res.status, statusText: res.statusText,
        headers: headersToObj(res.headers), body: text,
        ms: Date.now() - started, via
      };
    };
    this._emit("rpc", { dir: "out", method: `${method} ${url}`, headers, raw: body || "" });
    let out;
    try {
      out = await send(url, "direct", 4000);   // 直接は数秒で見切る (上と同じ理由)
    } catch {
      out = await send(proxied(url), "/proxy");  // /proxy 側は待つ
    }
    this._emit("rpc", {
      dir: out.ok ? "in" : "err",
      method: `${out.status} ${out.statusText || ""} · ${method}`,
      headers: out.headers, raw: out.body
    });
    return out;
  }

  // 選んだ operation から、 そのまま送れる状態の一式を返す。
  requestFor(opKey) {
    const op = this.operations.find(o => o.key === opKey) || this.operations.find(o => o.name === opKey);
    if (!op) return null;
    const headers = op.soapVersion === "1.2"
      // SOAP 1.2 は SOAPAction ヘッダではなく Content-Type の action パラメータで渡す
      ? { "Content-Type": `application/soap+xml; charset=utf-8${op.soapAction ? `; action="${op.soapAction}"` : ""}` }
      : { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": `"${op.soapAction || ""}"` };
    return { url: op.endpoint || this.baseUrl, headers, body: buildEnvelope(op) };
  }

  _buildCard() {
    return {
      name: this.serviceName || hostOf(this.wsdlUrl) || "SOAP service",
      // 汎用の card 描画がこの description をそのまま出す。 /proxy の allowlist は
      // 引っかかると 403 になるだけで理由が分からないので、 ここに書いておく。
      description: (this.wsdlError
        ? `Could not load the WSDL: ${this.wsdlError} — you can still send from the raw tab.`
        : `${this.operations.length} operations · pick one to fill in endpoint, SOAPAction and an envelope skeleton.`)
        + " SOAP servers rarely send CORS headers, so requests normally go through /proxy."
        + " To reach your own service, add its host to proxy.allowHosts in the deployment (otherwise you get 403).",
      url: this.baseUrl,
      skills: this.operations.map(o => ({
        id: o.key, name: o.label,
        description: [o.soapVersion ? `SOAP ${o.soapVersion}` : null, o.style,
                      o.soapAction ? `action: ${o.soapAction}` : null].filter(Boolean).join(" · ")
      }))
    };
  }
}

function proxied(target) {
  return `/proxy?url=${encodeURIComponent(target)}`;
}
function hostOf(u) { try { return new URL(u, location.href).host; } catch { return ""; } }

// ─── WSDL の解析 ────────────────────────────────────────
// rest.js の parseSpec/extractOperations と同じ形にしてある (兄弟として読めるように)。
export function parseWsdl(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("Not valid XML");
  const defs = doc.getElementsByTagNameNS(NS.wsdl, "definitions")[0];
  if (!defs) throw new Error("No wsdl:definitions element");
  const tns = defs.getAttribute("targetNamespace") || "";

  const schemas = [...doc.getElementsByTagNameNS(NS.xsd, "schema")];
  const messages = indexBy(doc.getElementsByTagNameNS(NS.wsdl, "message"), "name");
  const portTypes = indexBy(doc.getElementsByTagNameNS(NS.wsdl, "portType"), "name");

  // service/port から binding 名 → endpoint URL を引けるようにする
  const endpointByBinding = {};
  for (const port of doc.getElementsByTagNameNS(NS.wsdl, "port")) {
    const bind = localName(port.getAttribute("binding") || "");
    const addr = port.getElementsByTagNameNS(NS.soap11, "address")[0]
              || port.getElementsByTagNameNS(NS.soap12, "address")[0];
    if (bind && addr) endpointByBinding[bind] = addr.getAttribute("location") || "";
  }
  const serviceName = doc.getElementsByTagNameNS(NS.wsdl, "service")[0]?.getAttribute("name") || "";

  const operations = [];
  const seen = new Set();
  for (const binding of doc.getElementsByTagNameNS(NS.wsdl, "binding")) {
    const bindName = binding.getAttribute("name") || "";
    const soapBind = binding.getElementsByTagNameNS(NS.soap11, "binding")[0];
    const soap12Bind = binding.getElementsByTagNameNS(NS.soap12, "binding")[0];
    if (!soapBind && !soap12Bind) continue;                 // HTTP GET/POST binding は対象外
    const soapVersion = soap12Bind ? "1.2" : "1.1";
    const ver = soap12Bind ? NS.soap12 : NS.soap11;
    const style = (soap12Bind || soapBind).getAttribute("style") || "document";
    const ptName = localName(binding.getAttribute("type") || "");
    const portType = portTypes[ptName];
    const endpoint = endpointByBinding[bindName] || "";

    for (const bop of binding.getElementsByTagNameNS(NS.wsdl, "operation")) {
      const name = bop.getAttribute("name");
      if (!name) continue;
      // 同じ operation が 1.1 と 1.2 の両方の binding に出ることがある (.asmx は典型)。
      // 先に見つかった方 (= WSDL の記述順) を採用し、 1.2 を別名で併記する。
      const key = `${name}@${soapVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sop = bop.getElementsByTagNameNS(ver, "operation")[0];
      const soapAction = sop?.getAttribute("soapAction") || "";
      const opStyle = sop?.getAttribute("style") || style;

      // portType 側から入力メッセージ → part の element/type を辿る
      const pop = portType ? [...portType.getElementsByTagNameNS(NS.wsdl, "operation")]
                              .find(o => o.getAttribute("name") === name) : null;
      const inMsg = localName(pop?.getElementsByTagNameNS(NS.wsdl, "input")[0]?.getAttribute("message") || "");
      const part  = messages[inMsg]?.getElementsByTagNameNS(NS.wsdl, "part")[0];
      const elementQName = part?.getAttribute("element") || "";
      const typeQName    = part?.getAttribute("type") || "";

      operations.push({
        // name は 1.1 / 1.2 で重複しうるので、 選択にはこの key を使う
        key: `${name}@${soapVersion}`,
        label: `${name} (SOAP ${soapVersion})`,
        name, soapAction, soapVersion, style: opStyle, endpoint,
        targetNamespace: tns,
        elementName: localName(elementQName) || name,
        // 雛形を組むのに必要な情報だけ持たせる (schema ノードは DOM のまま保持)
        _schemas: schemas, _elementQName: elementQName, _typeQName: typeQName
      });
    }
  }
  if (!operations.length) throw new Error("No operations found in any SOAP binding");
  return { serviceName, targetNamespace: tns, operations };
}

function indexBy(nodes, attr) {
  const out = {};
  for (const n of nodes) { const k = n.getAttribute(attr); if (k) out[k] = n; }
  return out;
}
function localName(qname) { return String(qname || "").split(":").pop(); }

// ─── Envelope 雛形 ─────────────────────────────────────
export function buildEnvelope(op) {
  const envNs = op.soapVersion === "1.2" ? NS.env12 : NS.env11;
  const body = buildBodyXml(op);
  return [
    `<soap:Envelope xmlns:soap="${envNs}" xmlns:ns="${op.targetNamespace}">`,
    `  <soap:Header/>`,
    `  <soap:Body>`,
    body.split("\n").map(l => `    ${l}`).join("\n"),
    `  </soap:Body>`,
    `</soap:Envelope>`
  ].join("\n");
}

function buildBodyXml(op) {
  const el = findElement(op._schemas, localName(op._elementQName) || op.elementName);
  if (el) {
    const type = resolveType(op._schemas, el);
    return renderElement(op._schemas, el.getAttribute("name"), type, 0);
  }
  // element が引けない (rpc/encoded で part が type 指定など) → 名前だけの殻を出す
  return `<ns:${op.elementName}>\n  <!-- put arguments here -->\n</ns:${op.elementName}>`;
}

function findElement(schemas, name) {
  if (!name) return null;
  for (const s of schemas)
    for (const e of s.getElementsByTagNameNS(NS.xsd, "element"))
      if (e.parentNode === s && e.getAttribute("name") === name) return e;
  return null;
}
function findComplexType(schemas, name) {
  if (!name) return null;
  for (const s of schemas)
    for (const t of s.getElementsByTagNameNS(NS.xsd, "complexType"))
      if (t.parentNode === s && t.getAttribute("name") === name) return t;
  return null;
}

// element ノードから「中身を決める型ノード」を返す。 inline complexType 優先。
function resolveType(schemas, el) {
  const inline = [...el.children].find(c => c.namespaceURI === NS.xsd && c.localName === "complexType");
  if (inline) return inline;
  const t = el.getAttribute("type") || "";
  return findComplexType(schemas, localName(t));   // 単純型なら null
}

const MAX_DEPTH = 6;

function renderElement(schemas, name, typeNode, depth) {
  const tag = `ns:${name}`;
  if (depth >= MAX_DEPTH) return `<${tag}><!-- … --></${tag}>`;
  if (!typeNode) return `<${tag}>?</${tag}>`;      // 単純型
  const kids = childElements(typeNode);
  if (!kids.length) return `<${tag}/>`;
  const inner = kids.map(k => renderChild(schemas, k, depth + 1)).join("\n");
  return `<${tag}>\n${inner.split("\n").map(l => `  ${l}`).join("\n")}\n</${tag}>`;
}

// complexType の下から xs:sequence/xs:all の子 element を集める。
// xs:choice は「どれか 1 つ」だが、 第一段階では全部並べてコメントで断る。
function childElements(typeNode) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.namespaceURI !== NS.xsd) continue;
      if (c.localName === "element") out.push(c);
      else if (["sequence", "all", "choice", "complexContent", "extension"].includes(c.localName)) walk(c);
    }
  };
  walk(typeNode);
  return out;
}

function renderChild(schemas, el, depth) {
  const name = el.getAttribute("name") || localName(el.getAttribute("ref") || "") || "item";
  const type = el.getAttribute("type") || "";
  const nested = resolveType(schemas, el);
  if (nested) return renderElement(schemas, name, nested, depth);
  return `<ns:${name}>${placeholder(localName(type))}</ns:${name}>`;
}

function placeholder(t) {
  switch (t) {
    case "int": case "integer": case "long": case "short": case "byte": return "0";
    case "decimal": case "float": case "double": return "0.0";
    case "boolean": return "false";
    case "date": return "2026-01-01";
    case "dateTime": return "2026-01-01T00:00:00Z";
    case "base64Binary": case "hexBinary": return "";
    default: return "?";
  }
}

// ブラウザ無しでも試せるように内部関数を出しておく (rest.js と同じ形)
export const __internals = { parseWsdl, buildEnvelope, buildBodyXml, findElement, resolveType, childElements, placeholder };
