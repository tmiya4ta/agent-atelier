// Anypoint App Tester — 選択した APP を即テストする全面オーバーレイ
//
// console.js の drawer / explorer.js の consumer から `open(spec)` で呼ぶ。
// 型 (rest / a2a / mcp / http) ごとに本体を出し分ける:
//
//   rest / http … mini Postman (method + path + headers + body → /proxy → response)
//   a2a         … A2AAdapter を流用 (AgentCard 表示 + chat 送信)
//   mcp         … MCPAdapter を流用 (tools/list → 動的フォーム → callTool)
//
//   const tester = createTester({
//     stage,                                  // #anypointConsole (overlay をここに append)
//     getContext: () => ({ getToken }),       // identity Bearer 用の async () => token (任意)
//   });
//   tester.open({ type:"rest", title:"my-app", sub:"Sandbox", baseUrl:"https://...", auth:null });
//
// A2A/MCP の通信は protocols/ の adapter を **直接 import** して流用する
// (app.js を一切経由しない = console と同じく剥がしやすい leaf 構成)。
// 全 HTTP は adapter / proxyFetch とも /proxy?url=... 経由 (CORS 回避 + SsrfGuard allowlist)。

import { A2AAdapter } from "../protocols/a2a.js";
import { MCPAdapter } from "../protocols/mcp.js";

const $ = (s, p = document) => p.querySelector(s);

// 軽量 DOM ビルダ (console.js と同じ仕様)
function el(spec, props = {}, ...kids) {
  const m = String(spec).match(/^([a-z0-9]+)?(.*)$/i);
  const node = document.createElement(m[1] || "div");
  for (const tok of (m[2].match(/[.#][^.#]+/g) || [])) {
    if (tok[0] === "#") node.id = tok.slice(1); else node.classList.add(tok.slice(1));
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) node.append(k.nodeType ? k : document.createTextNode(k));
  return node;
}

const TYPES = [["rest", "REST"], ["a2a", "A2A"], ["mcp", "MCP"]];
function typeLabel(t) { return ({ rest: "REST", http: "HTTP", a2a: "A2A", mcp: "MCP" })[t] || "HTTP"; }
// 内部 type は rest/a2a/mcp の 3 タブに正規化 (http は rest タブ扱い)。
function normType(t) { return t === "a2a" || t === "mcp" ? t : "rest"; }

// JSON っぽければ整形、ダメなら原文。
function pretty(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

let _styled = false;
function injectStyles() {
  if (_styled) return; _styled = true;
  const css = `
/* 埋め込み型: overlay ではなく親 flex-column を満たす block (アコーディオン / 列に差す) */
.ap-test { display:flex; flex-direction:column; flex:1 1 auto; min-height:0; background:var(--paper); }
.ap-test-head { display:flex; flex-direction:column; gap:8px; padding:9px 14px; border-bottom:1px solid var(--line); background:var(--paper-2,var(--paper)); }
.ap-test-r1 { display:flex; align-items:center; gap:10px; }
.ap-test-lead { font:700 calc(10px*var(--fs,1)) var(--f-ui); letter-spacing:.08em; color:var(--accent-ink); flex:0 0 auto; }
.ap-test-title { font:700 calc(14px*var(--fs,1)) var(--f-display); color:var(--ink); display:flex; align-items:center; gap:8px; min-width:0; }
.ap-test-title .sub { font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); }
.ap-test-tabs { display:flex; gap:4px; }
.ap-test-tab { padding:4px 12px; font:600 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); background:var(--paper); border:1px solid var(--line); border-radius:99px; cursor:pointer; }
.ap-test-tab.is-on { background:var(--ink-navy); color:var(--you-ink); border-color:var(--ink-navy); }
.ap-test-x { cursor:pointer; border:none; background:none; color:var(--ink-3); font-size:calc(18px*var(--fs,1)); line-height:1; }
.ap-test-r2 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ap-test-url { flex:1; min-width:220px; padding:6px 9px; font:500 calc(12px*var(--fs,1)) var(--f-mono); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-test-auth { padding:6px 8px; font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-test-akv { width:120px; padding:6px 8px; font:500 calc(11px*var(--fs,1)) var(--f-mono); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-test-body { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }

/* ─ REST ─ */
.ap-rq { display:flex; gap:8px; padding:10px 14px; border-bottom:1px solid var(--line-3); }
.ap-rq-m { padding:6px 8px; font:700 calc(12px*var(--fs,1)) var(--f-mono); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-rq-p { flex:1; padding:6px 9px; font:500 calc(12px*var(--fs,1)) var(--f-mono); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-rq-send { padding:6px 16px; font:700 calc(12px*var(--fs,1)) var(--f-ui); color:var(--you-ink); background:var(--accent); border:1px solid var(--accent); border-radius:var(--radius); cursor:pointer; }
.ap-rq-send[disabled] { opacity:.5; cursor:default; }
.ap-rest-cols { flex:1; min-height:0; display:flex; }
.ap-ep-pane { flex:0 0 230px; min-width:0; border-right:1px solid var(--line); overflow:hidden; display:flex; flex-direction:column; background:var(--panel-soft); }
.ap-ep-h { padding:8px 12px 4px; font:600 calc(10px*var(--fs,1)) var(--f-ui); letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3); }
.ap-ep-filter { margin:4px 10px 8px; padding:5px 8px; box-sizing:border-box; width:calc(100% - 20px); font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-ep-list { flex:1; overflow:auto; }
.ap-ep { display:flex; gap:8px; align-items:baseline; padding:5px 10px; cursor:pointer; border-bottom:1px solid var(--line-3); }
.ap-ep:hover { background:var(--accent-soft); }
.ap-ep-m { flex:0 0 auto; font:700 calc(9px*var(--fs,1)) var(--f-mono); padding:2px 5px; border-radius:3px; min-width:34px; text-align:center; color:var(--you-ink); background:var(--ink-4); }
.ap-ep-m.GET{ background:var(--accent); } .ap-ep-m.POST{ background:var(--ok); } .ap-ep-m.PUT,.ap-ep-m.PATCH{ background:var(--caution); } .ap-ep-m.DELETE{ background:var(--warn); }
.ap-ep-b { min-width:0; }
.ap-ep-p { font:600 calc(11px*var(--fs,1)) var(--f-mono); color:var(--ink); word-break:break-all; }
.ap-ep-s { font:500 calc(10px*var(--fs,1)) var(--f-ui); color:var(--ink-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ap-ep-note { padding:10px 12px; font:500 calc(11px*var(--fs,1))/1.5 var(--f-ui); color:var(--ink-3); white-space:normal; word-break:break-word; }
.ap-ep-note.is-err { color:var(--warn); }
.ap-rest-req { flex:0 0 36%; display:flex; flex-direction:column; border-right:1px solid var(--line); overflow:auto; }
.ap-rest-res { flex:1; display:flex; flex-direction:column; min-width:0; overflow:auto; }
.ap-fld { padding:10px 14px; display:flex; flex-direction:column; gap:5px; }
.ap-fld > label { font:600 calc(10px*var(--fs,1)) var(--f-ui); letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3); }
.ap-ta { width:100%; box-sizing:border-box; min-height:90px; padding:8px 10px; font:500 calc(12px*var(--fs,1))/1.5 var(--f-mono); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); resize:vertical; }
.ap-res-status { padding:9px 14px; border-bottom:1px solid var(--line-3); display:flex; align-items:center; gap:10px; font:600 calc(12px*var(--fs,1)) var(--f-ui); }
.ap-res-code { font:700 calc(12px*var(--fs,1)) var(--f-mono); padding:2px 8px; border-radius:99px; }
.ap-res-code.ok { color:var(--ok); background:var(--ok-soft,var(--panel-soft)); }
.ap-res-code.bad { color:var(--warn); background:var(--warn-soft); }
.ap-res-ms { font:500 calc(11px*var(--fs,1)) var(--f-mono); color:var(--ink-3); }
.ap-res-body { flex:1; margin:0; padding:10px 14px; overflow:auto; font:500 calc(12px*var(--fs,1))/1.55 var(--f-mono); color:var(--ink-2); white-space:pre-wrap; word-break:break-word; }
.ap-res-h { padding:8px 14px; border-bottom:1px solid var(--line-3); font:500 calc(11px*var(--fs,1))/1.5 var(--f-mono); color:var(--ink-3); white-space:pre-wrap; word-break:break-all; }
.ap-test-empty { padding:48px 24px; text-align:center; color:var(--ink-3); font:500 calc(13px*var(--fs,1)) var(--f-ui); }
.ap-test-err { color:var(--warn); }

/* ─ A2A / MCP 共通 ─ */
.ap-conn { display:flex; flex-direction:column; min-height:0; flex:1; }
.ap-conn-meta { padding:10px 14px; border-bottom:1px solid var(--line-3); }
.ap-conn-name { font:700 calc(14px*var(--fs,1)) var(--f-display); color:var(--ink); }
.ap-conn-desc { margin-top:3px; font:500 calc(11px*var(--fs,1))/1.5 var(--f-ui); color:var(--ink-3); }
.ap-chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.ap-chip { padding:3px 9px; font:600 calc(11px*var(--fs,1)) var(--f-ui); color:var(--accent-ink); background:var(--accent-soft); border:1px solid var(--accent); border-radius:99px; cursor:pointer; }
.ap-chip:hover { background:var(--accent); color:var(--you-ink); }
.ap-status { padding:6px 14px; font:600 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); }
.ap-status.ok { color:var(--ok); } .ap-status.bad { color:var(--warn); }

/* A2A transcript */
.ap-tx { flex:1; overflow:auto; padding:10px 14px; display:flex; flex-direction:column; gap:8px; }
.ap-msg { max-width:80%; padding:8px 11px; border-radius:10px; font:500 calc(12px*var(--fs,1))/1.5 var(--f-ui); white-space:pre-wrap; word-break:break-word; }
.ap-msg.user { align-self:flex-end; background:var(--accent-soft); color:var(--ink); }
.ap-msg.agent { align-self:flex-start; background:var(--panel-soft); color:var(--ink-2); }
.ap-msg.sys { align-self:center; background:transparent; color:var(--ink-3); font-style:italic; font-size:calc(11px*var(--fs,1)); }
.ap-send { display:flex; gap:8px; padding:10px 14px; border-top:1px solid var(--line); }
.ap-send input { flex:1; padding:7px 10px; font:500 calc(12px*var(--fs,1)) var(--f-ui); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-send button { padding:7px 16px; font:700 calc(12px*var(--fs,1)) var(--f-ui); color:var(--you-ink); background:var(--accent); border:none; border-radius:var(--radius); cursor:pointer; }
.ap-send button[disabled] { opacity:.5; cursor:default; }

/* MCP tools */
.ap-mcp { flex:1; min-height:0; display:flex; }
.ap-mcp-tools { flex:0 0 240px; border-right:1px solid var(--line); overflow:auto; }
.ap-mcp-tool { padding:8px 14px; border-bottom:1px solid var(--line-3); cursor:pointer; }
.ap-mcp-tool:hover { background:var(--panel-soft); }
.ap-mcp-tool.is-on { background:var(--accent-soft); }
.ap-mcp-tool-n { font:600 calc(12px*var(--fs,1)) var(--f-mono); color:var(--ink); }
.ap-mcp-tool-d { margin-top:2px; font:500 calc(10px*var(--fs,1))/1.4 var(--f-ui); color:var(--ink-3); }
.ap-mcp-run { flex:1; display:flex; flex-direction:column; overflow:auto; }
.ap-mcp-arg { padding:8px 14px; display:flex; flex-direction:column; gap:4px; }
.ap-mcp-arg > label { font:600 calc(10px*var(--fs,1)) var(--f-ui); color:var(--ink-3); }
.ap-mcp-arg > label .req { color:var(--warn); }
.ap-mcp-arg input, .ap-mcp-arg textarea { padding:6px 9px; font:500 calc(12px*var(--fs,1)) var(--f-mono); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-mcp-call { margin:10px 14px; padding:7px; font:700 calc(12px*var(--fs,1)) var(--f-ui); color:var(--you-ink); background:var(--accent); border:none; border-radius:var(--radius); cursor:pointer; }
.ap-mcp-call[disabled] { opacity:.5; cursor:default; }
.ap-mcp-out { margin:0 14px 14px; padding:10px; background:var(--paper); border:1px solid var(--line-3); border-radius:var(--radius); font:500 calc(12px*var(--fs,1))/1.55 var(--f-mono); color:var(--ink-2); white-space:pre-wrap; word-break:break-word; overflow:auto; }
`;
  document.head.appendChild(el("style#anypoint-tester-styles", { html: css }));
}

// ════════════════════════════════════════════════════════════
// 埋め込み型: stage には append しない。呼び元が `tester.el` を任意コンテナに差し、
// `render(spec)` で中身を出す。`onClose` は × 押下時のコラプス用フック。
export function createTester({ getContext, onClose } = {}) {
  injectStyles();
  const ctx = () => (getContext ? getContext() : {});

  // 現在開いているテスト対象 + 接続中 adapter (close/切替で破棄)。
  let cur = null;          // { type, title, sub, baseUrl, auth, oas }
  let adapter = null;      // 接続中の A2A/MCP adapter
  let authMode = "none";   // none | identity | custom
  let customAuth = { key: "Authorization", val: "" };
  const restState = { method: "GET", path: "", headers: "", body: "" };

  // ─── header ───────────────────────────────────────────────
  const titleEl = el("div.ap-test-title");
  const tabsEl  = el("div.ap-test-tabs", {}, ...TYPES.map(([k, label]) =>
    el("button.ap-test-tab", { dataset: { t: k }, text: label, on: { click: () => switchType(k) } })));
  const urlEl   = el("input.ap-test-url", { type: "text", placeholder: "https://app.region.cloudhub.io",
    on: { change: e => {
      if (!cur) return;
      cur.baseUrl = e.target.value.trim();
      // A2A/MCP 表示中に URL を直したら張り直す (REST は送信時に都度読むので不要)。
      if (normType(cur.type) !== "rest") { teardownAdapterOnly(); render(); }
    } } });
  const authSel = el("select.ap-test-auth", { on: { change: e => { authMode = e.target.value; syncAuth(); } } },
    el("option", { value: "none", text: "AUTH: none" }),
    el("option", { value: "identity", text: "AUTH: identity Bearer" }),
    el("option", { value: "custom", text: "AUTH: custom header" }));
  const authKey = el("input.ap-test-akv", { type: "text", placeholder: "Header", value: customAuth.key,
    on: { input: e => { customAuth.key = e.target.value; } } });
  const authVal = el("input.ap-test-akv", { type: "text", placeholder: "value",
    on: { input: e => { customAuth.val = e.target.value; } } });
  // タイトルは出さない (アコーディオン側 detail / explorer 列が APP 名を持つので重複回避)。
  // ヘッダは「型タブ + base URL + AUTH」だけのスリムな操作行にする。
  const head = el("div.ap-test-head", {},
    el("div.ap-test-r1", {}, el("span.ap-test-lead", { text: "▶ TEST" }), tabsEl, urlEl),
    el("div.ap-test-r2", {}, authSel, authKey, authVal,
      el("span.ap-spacer", { style: { flex: "1" } }),
      el("button.ap-test-x", { text: "×", title: "close", on: { click: close } })));
  const bodyEl = el("div.ap-test-body");
  const root = el("div.ap-test", {}, head, bodyEl);

  // ─── AUTH 解決 → adapter / proxyFetch に渡す { auth, authHeaders } ──
  function syncAuth() {
    const custom = authMode === "custom";
    authKey.style.display = custom ? "" : "none";
    authVal.style.display = custom ? "" : "none";
  }
  async function resolveAuth() {
    if (authMode === "identity") {
      try { const t = await (ctx().getToken?.()); return { auth: t || null, authHeaders: null }; }
      catch { return { auth: null, authHeaders: null }; }
    }
    if (authMode === "custom" && customAuth.key) {
      const v = customAuth.val || "";
      // "Authorization: Bearer xxx" を素直に header 化。Bearer 前置は付けない (custom は生値)。
      return { auth: null, authHeaders: { [customAuth.key]: v } };
    }
    return { auth: null, authHeaders: null };
  }

  // ─── public open/close ────────────────────────────────────
  function open(spec) {
    teardown();
    cur = { type: "rest", path: "", ...spec };
    restState.method = "GET"; restState.path = ""; restState.headers = ""; restState.body = "";
    urlEl.value = cur.baseUrl || "";
    titleEl.innerHTML = "";
    titleEl.append(cur.title || "test", el("span.sub", { text: cur.sub || "" }));
    syncAuth();
    render();
  }
  function close() { teardown(); if (onClose) onClose(); }
  function teardown() {
    if (adapter) { try { adapter.disconnect?.(); } catch {} adapter = null; }
    bodyEl.innerHTML = "";
  }
  function switchType(t) { if (!cur) return; cur.type = t; teardownAdapterOnly(); render(); }
  function teardownAdapterOnly() { if (adapter) { try { adapter.disconnect?.(); } catch {} adapter = null; } }

  function syncTabs() {
    const n = normType(cur?.type);
    [...tabsEl.children].forEach(b => b.classList.toggle("is-on", b.dataset.t === n));
  }

  function render() {
    syncTabs();
    bodyEl.innerHTML = "";
    if (!cur) return;
    const t = normType(cur.type);
    if (t === "a2a") renderConn("a2a");
    else if (t === "mcp") renderConn("mcp");
    else renderRest();
  }

  // ════════════ REST (mini Postman) ════════════
  function renderRest() {
    const methodSel = el("select.ap-rq-m", { on: { change: e => { restState.method = e.target.value; } } },
      ...["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map(m =>
        el("option", { value: m, text: m, selected: m === restState.method })));
    const pathInp = el("input.ap-rq-p", { type: "text", value: restState.path,
      placeholder: "/path?query=…  (appended to base URL)",
      on: { input: e => { restState.path = e.target.value; },
            keydown: e => { if (e.key === "Enter") send(); } } });
    const sendBtn = el("button.ap-rq-send", { text: "Send ▶", on: { click: () => send() } });

    const hdrTa = el("textarea.ap-ta", { placeholder: '{ "Content-Type": "application/json" }',
      on: { input: e => { restState.headers = e.target.value; } } }, restState.headers);
    const bodyTa = el("textarea.ap-ta", { placeholder: "request body (JSON / text)",
      on: { input: e => { restState.body = e.target.value; } } }, restState.body);

    const resStatus = el("div.ap-res-status", {}, el("span.ap-res-ms", { text: "— not sent —" }));
    const resHead = el("div.ap-res-h", { style: { display: "none" } });
    const resBody = el("pre.ap-res-body");

    // OAS があれば左に endpoint 一覧 (クリックで method+path+body 充填 → Send で投げる)。
    const cols = el("div.ap-rest-cols", {});
    if (cur.loadEndpoints) cols.append(buildEndpointsPane());
    cols.append(
      el("div.ap-rest-req", {},
        el("div.ap-fld", {}, el("label", { text: "Headers (JSON)" }), hdrTa),
        el("div.ap-fld", {}, el("label", { text: "Body" }), bodyTa)),
      el("div.ap-rest-res", {}, resStatus, resHead, resBody));
    bodyEl.append(el("div.ap-rq", {}, methodSel, pathInp, sendBtn), cols);

    // endpoint クリック → 入力を充填 (送信はしない。POST/DELETE の誤爆防止)。
    function applyEndpoint(ep) {
      restState.method = ep.method; methodSel.value = ep.method;
      restState.path = ep.path; pathInp.value = ep.path;
      if (ep.bodyExample && !["GET", "HEAD"].includes(ep.method)) { restState.body = ep.bodyExample; bodyTa.value = ep.bodyExample; }
    }
    function buildEndpointsPane() {
      const list = el("div.ap-ep-list", {}, el("div.ap-ep-note", { text: "loading spec…" }));
      const filter = el("input.ap-ep-filter", { type: "search", placeholder: "filter endpoints…" });
      let all = [];
      const draw = (q) => {
        list.innerHTML = "";
        const items = all.filter(e => !q || `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(q));
        if (!items.length) { list.append(el("div.ap-ep-note", { text: all.length ? "no match" : "no endpoints" })); return; }
        for (const ep of items) list.append(el("div.ap-ep", { title: ep.summary || "", on: { click: () => applyEndpoint(ep) } },
          el("span", { class: `ap-ep-m ${ep.method}`, text: ep.method }),
          el("div.ap-ep-b", {}, el("div.ap-ep-p", { text: ep.path }), ep.summary ? el("div.ap-ep-s", { text: ep.summary }) : null)));
      };
      cur.loadEndpoints().then(r => {
        all = (r && r.endpoints) || [];
        if (all.length) draw("");
        else { const n = (r && r.note) || "no endpoints"; list.innerHTML = ""; list.append(el("div.ap-ep-note", { text: n, title: n })); }
      }).catch(e => { list.innerHTML = ""; list.append(el("div.ap-ep-note.is-err", { text: errMsg(e) })); });
      filter.addEventListener("input", () => draw(filter.value.trim().toLowerCase()));
      return el("div.ap-ep-pane", {}, el("div.ap-ep-h", { text: "Endpoints" }), filter, list);
    }

    async function send() {
      const base = (urlEl.value || cur.baseUrl || "").trim();
      if (!base) { resStatus.innerHTML = ""; resStatus.append(el("span.ap-test-err", { text: "base URL is empty" })); return; }
      const url = joinUrl(base, restState.path);
      sendBtn.disabled = true; sendBtn.textContent = "…";
      resStatus.innerHTML = ""; resStatus.append(el("span.ap-res-ms", { text: "sending…" }));
      resBody.textContent = ""; resHead.style.display = "none";
      try {
        const { auth, authHeaders } = await resolveAuth();
        let headers = {};
        if (restState.headers.trim()) {
          try { headers = JSON.parse(restState.headers); }
          catch { throw new Error("Headers must be valid JSON"); }
        }
        if (auth) headers["Authorization"] = `Bearer ${auth}`;
        if (authHeaders) Object.assign(headers, authHeaders);
        const method = restState.method;
        const hasBody = !["GET", "HEAD"].includes(method) && restState.body.trim();
        const r = await proxyFetch(url, { method, headers, body: hasBody ? restState.body : undefined });
        const tone = r.ok ? "ok" : "bad";
        resStatus.innerHTML = "";
        resStatus.append(
          el("span", { class: `ap-res-code ${tone}`, text: String(r.status) }),
          el("span.ap-res-ms", { text: `${r.ms}ms · ${r.text.length}B` }));
        const hlines = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
        if (hlines) { resHead.textContent = hlines; resHead.style.display = ""; }
        resBody.textContent = pretty(r.text) || "(empty body)";
      } catch (e) {
        resStatus.innerHTML = ""; resStatus.append(el("span.ap-test-err", { text: errMsg(e) }));
      } finally {
        sendBtn.disabled = false; sendBtn.textContent = "Send ▶";
      }
    }
  }

  // ════════════ A2A / MCP (adapter 流用) ════════════
  async function renderConn(kind) {
    const base = (urlEl.value || cur.baseUrl || "").trim();
    if (!base) { bodyEl.append(el("div.ap-test-empty", { text: "Enter a base URL, then re-select this tab" })); return; }
    const status = el("div.ap-status", { text: "connecting…" });
    bodyEl.append(status);
    const { auth, authHeaders } = await resolveAuth();
    const AdapterClass = kind === "mcp" ? MCPAdapter : A2AAdapter;
    adapter = new AdapterClass({ url: base, auth, authHeaders });
    const a = adapter;
    try {
      await a.connect();
      if (adapter !== a) return;  // connect 中に切替/閉じられたら破棄
      status.remove();
      if (kind === "mcp") renderMcp(a);
      else renderA2a(a);
    } catch (e) {
      if (adapter !== a) return;
      status.className = "ap-status bad"; status.textContent = `Connection failed: ${errMsg(e)}`;
    }
  }

  function renderA2a(a) {
    const card = a.agentCard || {};
    const skills = Array.isArray(card.skills) ? card.skills : [];
    const meta = el("div.ap-conn-meta", {},
      el("div.ap-conn-name", { text: card.name || cur.title || "agent" }),
      card.description ? el("div.ap-conn-desc", { text: card.description }) : null,
      skills.length ? el("div.ap-chips", {}, ...skills.slice(0, 12).map(s =>
        el("span.ap-chip", { text: s.name || s.id || "skill", title: s.description || "",
          on: { click: () => { input.value = (s.examples && s.examples[0]) || s.name || ""; input.focus(); } } }))) : null);
    const tx = el("div.ap-tx");
    const input = el("input", { type: "text", placeholder: "Type a message (Enter to send)…",
      on: { keydown: e => { if (e.key === "Enter") fire(); } } });
    const sendBtn = el("button", { text: "Send", on: { click: () => fire() } });
    const conn = el("div.ap-conn", {}, meta, tx, el("div.ap-send", {}, input, sendBtn));
    bodyEl.append(conn);

    const addMsg = (role, text) => { tx.append(el("div", { class: `ap-msg ${role}`, text })); tx.scrollTop = tx.scrollHeight; };
    a.addEventListener("message", e => { const d = e.detail || {}; addMsg(d.role === "user" ? "user" : "agent", d.text || ""); });
    a.addEventListener("status", e => { const d = e.detail || {}; if (d.text) addMsg("sys", d.text); });
    a.addEventListener("error", e => addMsg("sys", "⚠ " + errMsg(e.detail)));

    async function fire() {
      const text = input.value.trim(); if (!text) return;
      addMsg("user", text); input.value = "";
      sendBtn.disabled = true;
      try { await a.send(text); } catch (e) { addMsg("sys", "⚠ " + errMsg(e)); }
      finally { sendBtn.disabled = false; input.focus(); }
    }
  }

  function renderMcp(a) {
    const tools = Array.isArray(a.tools) ? a.tools : [];
    const meta = el("div.ap-conn-meta", {},
      el("div.ap-conn-name", { text: a.serverInfo?.name || cur.title || "MCP server" }),
      el("div.ap-conn-desc", { text: `${tools.length} tools${a.serverInfo?.version ? " · v" + a.serverInfo.version : ""}` }));
    const toolList = el("div.ap-mcp-tools");
    const runPane = el("div.ap-mcp-run", {}, el("div.ap-test-empty", { text: "← select a tool" }));
    bodyEl.append(meta, el("div.ap-mcp", {}, toolList, runPane));

    if (!tools.length) { toolList.append(el("div.ap-status", { text: "no tools" })); return; }
    let selBtn = null;
    for (const t of tools) {
      const btn = el("div.ap-mcp-tool", { on: { click: () => { selBtn?.classList.remove("is-on"); btn.classList.add("is-on"); selBtn = btn; openTool(t); } } },
        el("div.ap-mcp-tool-n", { text: t.name }),
        t.description ? el("div.ap-mcp-tool-d", { text: t.description }) : null);
      toolList.append(btn);
    }

    function openTool(t) {
      runPane.innerHTML = "";
      const schema = t.inputSchema || t.input_schema || {};
      const props = schema.properties || {};
      const required = new Set(schema.required || []);
      const inputs = new Map();  // name → { node, prop }
      for (const [name, prop] of Object.entries(props)) {
        const isBig = prop.type === "object" || prop.type === "array";
        const ctl = isBig
          ? el("textarea", { rows: 3, placeholder: prop.description || "(JSON)" })
          : el("input", { type: "text", placeholder: prop.description || prop.type || "" });
        inputs.set(name, { node: ctl, prop });
        runPane.append(el("div.ap-mcp-arg", {},
          el("label", {}, name, required.has(name) ? el("span.req", { text: " *" }) : null,
            prop.type ? el("span", { style: { color: "var(--ink-4)", fontWeight: "400" }, text: ` (${prop.type})` }) : null),
          ctl));
      }
      if (!inputs.size) runPane.append(el("div.ap-mcp-arg", {}, el("label", { text: "no arguments" })));
      const out = el("pre.ap-mcp-out", { style: { display: "none" } });
      const callBtn = el("button.ap-mcp-call", { text: `▶ Run ${t.name}`, on: { click: () => run() } });
      runPane.append(callBtn, out);

      async function run() {
        const args = {};
        for (const [name, { node, prop }] of inputs) {
          const raw = node.value.trim();
          if (raw === "") { if (required.has(name)) { /* 必須空は送る前にエラー */ } continue; }
          args[name] = coerce(raw, prop.type);
        }
        callBtn.disabled = true; callBtn.textContent = "…";
        out.style.display = ""; out.classList.remove("ap-test-err"); out.textContent = "calling…";
        try {
          const r = await a.callTool(t.name, args);
          const txt = typeof r.parsed === "string" ? r.parsed : JSON.stringify(r.parsed, null, 2);
          out.textContent = txt;
          if (r.isError) out.classList.add("ap-test-err");
        } catch (e) { out.classList.add("ap-test-err"); out.textContent = errMsg(e); }
        finally { callBtn.disabled = false; callBtn.textContent = `▶ Run ${t.name}`; }
      }
    }
  }

  return { open, render: open, close, teardown, el: root };
}

// ─── helpers ────────────────────────────────────────────────
function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  if (!p) return b;
  return p.startsWith("/") ? b + p : `${b}/${p}`;
}
async function proxyFetch(url, { method = "GET", headers = {}, body } = {}) {
  const t0 = performance.now();
  const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, ok: res.ok, ms: Math.round(performance.now() - t0), headers: res.headers, text };
}
// MCP の動的フォーム: 型に応じて文字列を JS 値へ。失敗時は文字列のまま。
function coerce(raw, type) {
  if (type === "number" || type === "integer") { const n = Number(raw); return Number.isNaN(n) ? raw : n; }
  if (type === "boolean") return /^(true|1|yes)$/i.test(raw);
  if (type === "object" || type === "array") { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}
function errMsg(e) { return (e && (e.message || e.toString())) || "error"; }
