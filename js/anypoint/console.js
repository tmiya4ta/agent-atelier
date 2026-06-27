// Anypoint console — Runtime Manager (RTF + CloudHub 2.0) 置き換え UI (P1)
//
// 自己完結モジュール。app.js への侵襲は「mount 呼び出し + selectSideCat に 1 行」だけ。
// DOM とスタイルは自前注入 (剥がすときは js/anypoint/ 削除 + 数行除去で済む)。
//
//   import { mountAnypointConsole } from "./anypoint/console.js";
//   const ctl = mountAnypointConsole({
//     railPanel,    // .side-cat[data-cat="platform"] (org/env コンテキスト rail を入れる)
//     stage,        // #anypointConsole (一覧 + detail drawer を入れる)
//     identities,   // () => state.identities       (live getter)
//     makeClient,   // (idn) => new AnypointClient({...})
//   });
//   // selectSideCat("platform") 時に ctl.onShow() を呼ぶ
//
// 対象は RTF + CloudHub 2.0 (Application Manager v2)。一覧は env を複数選んで横断 merge できる
// (公式 UI に無い差別化)。書き込みは Restart のみ (confirm + prod ガード)。

import { modalConfirm } from "../modal.js";
import { createExplorer } from "./explorer.js";
import { createTester } from "./tester.js";

const $  = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

// 軽量 DOM ビルダ: el("div.cls#id", { attrs }, ...children)
function el(spec, props = {}, ...kids) {
  const m = String(spec).match(/^([a-z0-9]+)?(.*)$/i);
  const tag = m[1] || "div";
  const node = document.createElement(tag);
  for (const tok of (m[2].match(/[.#][^.#]+/g) || [])) {
    if (tok[0] === "#") node.id = tok.slice(1);
    else node.classList.add(tok.slice(1));
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

// ─── status → 色クラス / ラベル ────────────────────────────
function statusTone(s) {
  const t = String(s || "").toUpperCase();
  if (/RUNNING|STARTED|DEPLOYED|APPLIED/.test(t)) return "ok";
  if (/APPLYING|UPDATING|PENDING|DEPLOYING|STARTING|BUILDING/.test(t)) return "busy";
  if (/STOP/.test(t)) return "idle";
  if (/FAIL|ERROR|UNDEPLOY|UNAVAILABLE/.test(t)) return "bad";
  return "idle";
}
// provider → 短ラベル。実データでは CH2/RTF 双方が provider="MC" のため判別不可。
// MC 等は空を返し、判別は targetKind(runtimeTargets の type) に委ねる。
function providerLabel(p) {
  const t = String(p || "").toUpperCase();
  if (/FABRIC|RTF|RF/.test(t)) return "RTF";
  if (/CLOUDHUB|SHARED|PRIVATE/.test(t)) return "CH2";
  return "";
}
// runtime target の type → 短ラベル。
function targetKind(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("fabric")) return "RTF";        // runtime-fabric
  if (t.includes("space"))  return "CH2";        // shared-space / private-space
  return "";
}
function fmtVCores(v) { return v == null ? "—" : (Number.isInteger(v) ? String(v) : v.toFixed(2)); }
function fmtAgo(ts) {
  if (!ts) return "—";
  const d = Date.now() - Number(ts);
  if (Number.isNaN(d)) return "—";
  const m = Math.floor(d / 60000), h = Math.floor(m / 60), day = Math.floor(h / 24);
  if (day > 0) return `${day}d`;
  if (h > 0)   return `${h}h`;
  if (m > 0)   return `${m}m`;
  return "now";
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts)); const p = n => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// ─── スタイル (1 回だけ注入・app のテーマ変数を流用 = dark 自動追従) ──
let _styled = false;
function injectStyles() {
  if (_styled) return; _styled = true;
  const css = `
.ap-rail { display:flex; flex-direction:column; gap:14px; padding:14px 12px; }
.ap-rail h4 { margin:0 0 6px; font:600 calc(11px*var(--fs,1))/1 var(--f-ui); letter-spacing:.08em; color:var(--ink-3); }
.ap-field { display:flex; flex-direction:column; gap:5px; }
.ap-field > label { font:600 calc(10px*var(--fs,1))/1 var(--f-ui); letter-spacing:.06em; color:var(--ink-3); text-transform:uppercase; }
.ap-field select { width:100%; padding:6px 8px; font:500 calc(12px*var(--fs,1)) var(--f-ui); color:var(--ink); background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); }
.ap-persp { display:flex; gap:3px; padding:3px; background:var(--panel-soft); border:1px solid var(--line); border-radius:var(--radius); }
.ap-persp-btn { flex:1; padding:6px 8px; font:600 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); background:transparent; border:none; border-radius:calc(var(--radius) - 2px); cursor:pointer; white-space:nowrap; }
.ap-persp-btn:hover { color:var(--ink); }
.ap-persp-btn.is-on { background:var(--ink-navy); color:var(--you-ink); }
.ap-envs { display:flex; flex-direction:column; gap:3px; max-height:42vh; overflow:auto; }
.ap-env { display:flex; align-items:center; gap:7px; padding:5px 7px; border-radius:var(--radius); cursor:pointer; font:500 calc(12px*var(--fs,1)) var(--f-ui); color:var(--ink-2); }
.ap-env:hover { background:var(--panel-soft); }
.ap-env input { accent-color:var(--accent); margin:0; }
.ap-env .ap-prod { margin-left:auto; font:700 calc(9px*var(--fs,1))/1 var(--f-ui); letter-spacing:.05em; color:var(--warn); background:var(--warn-soft); padding:2px 5px; border-radius:99px; }
.ap-note { font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); }
.ap-note.is-err { color:var(--warn); }

#anypointConsole.ap-console { position:absolute; inset:0; display:none; flex-direction:column; background:var(--paper); z-index:2; }
body[data-side-cat="platform"] #anypointConsole.ap-console { display:flex; }
/* platform モード中はチャット窓 (フォーカスで z-index が上がる) と empty-state を隠す */
body[data-side-cat="platform"] #windowsLayer,
body[data-side-cat="platform"] #emptyState { display:none; }
.ap-toolbar { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
.ap-crumb { font:600 calc(12px*var(--fs,1)) var(--f-ui); color:var(--ink); display:flex; align-items:center; gap:6px; min-width:0; }
.ap-crumb .sep { color:var(--ink-4); }
.ap-crumb .dim { color:var(--ink-3); font-weight:500; }
.ap-spacer { flex:1; }
.ap-filter { width:200px; padding:5px 9px; font:500 calc(12px*var(--fs,1)) var(--f-ui); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-btn { display:inline-flex; align-items:center; gap:5px; padding:5px 10px; font:600 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-2); background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); cursor:pointer; }
.ap-btn:hover { border-color:var(--accent); color:var(--accent-ink); }
.ap-btn.is-on { background:var(--accent-soft); border-color:var(--accent); color:var(--accent-ink); }
.ap-btn.is-danger { color:var(--warn); }
.ap-btn.is-danger:hover { background:var(--warn-soft); border-color:var(--warn); color:var(--warn); }
.ap-btn[disabled] { opacity:.45; cursor:default; }
.ap-lin-act { margin-top:8px; }
.ap-btn.is-explore { width:100%; justify-content:center; color:var(--accent-ink); border-color:var(--accent); background:var(--accent-soft); }
.ap-btn.is-explore:hover { background:var(--accent); color:var(--you-ink); }
.ap-count { font:600 calc(11px*var(--fs,1)) var(--f-mono); color:var(--ink-3); }

.ap-body { flex:1; display:flex; min-height:0; }
.ap-tablewrap { flex:1; overflow:auto; }
table.ap-table { width:100%; border-collapse:collapse; font:500 calc(12px*var(--fs,1)) var(--f-ui); }
.ap-table thead th { position:sticky; top:0; z-index:1; text-align:left; padding:8px 12px; font:600 calc(10px*var(--fs,1))/1 var(--f-ui); letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3); background:var(--panel); border-bottom:1px solid var(--line); cursor:pointer; white-space:nowrap; user-select:none; }
.ap-table thead th .ar { color:var(--accent); margin-left:3px; }
.ap-table tbody td { padding:7px 12px; border-bottom:1px solid var(--line-3); color:var(--ink-2); white-space:nowrap; }
.ap-table tbody tr { cursor:pointer; }
.ap-table tbody tr:hover { background:var(--panel-soft); }
.ap-table tbody tr.is-sel { background:var(--accent-soft); }
.ap-table tbody tr.is-busy { opacity:.55; }
@keyframes apflash { from { background:var(--caution-soft); } to { background:transparent; } }
.ap-table tbody tr.is-changed td { animation:apflash 1.6s ease-out; }
.ap-name { font-weight:600; color:var(--ink); }
.ap-dot { display:inline-block; width:8px; height:8px; border-radius:99px; margin-right:7px; vertical-align:middle; }
.ap-dot.ok{ background:var(--ok);} .ap-dot.busy{ background:var(--caution); animation:appulse 1.1s ease-in-out infinite;} .ap-dot.idle{ background:var(--ink-4);} .ap-dot.bad{ background:var(--warn);}
@keyframes appulse { 0%,100%{opacity:1;} 50%{opacity:.35;} }
.ap-tag { font:600 calc(10px*var(--fs,1))/1 var(--f-mono); padding:2px 5px; border-radius:99px; background:var(--paper-2); color:var(--ink-3); }
.ap-empty { padding:48px 24px; text-align:center; color:var(--ink-3); font:500 calc(13px*var(--fs,1)) var(--f-ui); }
.ap-mono { font-family:var(--f-mono); color:var(--ink-3); }

.ap-drawer { width:0; flex:0 0 auto; overflow:hidden; border-left:1px solid var(--line); background:var(--panel); transition:width .14s ease; }
.ap-drawer.is-open { width:380px; }
.ap-dr-inner { width:380px; height:100%; overflow:auto; display:flex; flex-direction:column; }
.ap-dr-head { padding:14px 16px; border-bottom:1px solid var(--line); }
.ap-dr-title { font:700 calc(15px*var(--fs,1)) var(--f-display); color:var(--ink); display:flex; align-items:center; gap:8px; }
.ap-dr-sub { margin-top:4px; font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); }
.ap-dr-x { float:right; cursor:pointer; color:var(--ink-3); border:none; background:none; font-size:calc(18px*var(--fs,1)); line-height:1; }
.ap-sec { padding:12px 16px; border-bottom:1px solid var(--line-3); }
.ap-sec h5 { margin:0 0 8px; font:600 calc(10px*var(--fs,1))/1 var(--f-ui); letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); }
.ap-kv { display:grid; grid-template-columns:auto 1fr; gap:5px 12px; font:500 calc(12px*var(--fs,1)) var(--f-ui); }
.ap-kv dt { color:var(--ink-3); } .ap-kv dd { margin:0; color:var(--ink); text-align:right; font-family:var(--f-mono); font-size:calc(11px*var(--fs,1)); }
.ap-replica { display:flex; align-items:center; gap:7px; padding:4px 0; font:500 calc(11px*var(--fs,1)) var(--f-mono); color:var(--ink-2); }
.ap-actions { padding:12px 16px; display:flex; gap:8px; flex-wrap:wrap; }

.ap-lin { display:flex; gap:10px; padding:3px 0; font:500 calc(12px*var(--fs,1)) var(--f-ui); align-items:baseline; }
.ap-lin-k { flex:0 0 56px; color:var(--ink-3); font-size:calc(11px*var(--fs,1)); text-transform:uppercase; letter-spacing:.04em; }
.ap-lin-v { color:var(--ink); display:flex; align-items:center; gap:5px; flex-wrap:wrap; min-width:0; }
.ap-lin-v.dim { color:var(--ink-3); }
.ap-ex { color:var(--accent-ink); text-decoration:none; font-weight:700; }
.ap-ex:hover { color:var(--accent); }

.ap-logs { position:absolute; inset:0; z-index:3; display:none; flex-direction:column; background:var(--panel); }
.ap-logs.is-open { display:flex; }
.ap-logs-head { display:flex; align-items:center; gap:10px; padding:9px 14px; border-bottom:1px solid var(--line); background:var(--panel-soft); flex-wrap:wrap; }
.ap-logs-title { font:700 calc(13px*var(--fs,1)) var(--f-display); color:var(--ink); }
.ap-logs-title .dim { font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); margin-left:7px; }
.ap-logs-body { flex:1; overflow:auto; padding:8px 0; background:var(--paper); font:500 calc(12px*var(--fs,1))/1.55 var(--f-mono); }
.ap-log { display:flex; gap:10px; padding:1px 14px; white-space:pre-wrap; word-break:break-word; }
.ap-log:hover { background:var(--panel-soft); }
.ap-log-ts { color:var(--ink-4); flex:0 0 auto; }
.ap-log-lv { flex:0 0 46px; font-weight:700; }
.ap-log-lv.INFO{color:var(--ink-3);} .ap-log-lv.WARN{color:var(--caution);} .ap-log-lv.ERROR{color:var(--warn);} .ap-log-lv.DEBUG,.ap-log-lv.TRACE{color:var(--ink-4);}
.ap-log-msg { color:var(--ink-2); flex:1 1 auto; }
.ap-log-lg { color:var(--accent-ink); }
.ap-logs-empty { padding:40px; text-align:center; color:var(--ink-3); font-family:var(--f-ui); }
.ap-logs-empty.is-err { color:var(--warn); }
.ap-sel { padding:4px 7px; font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink); background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); }
`;
  document.head.appendChild(el("style#anypoint-console-styles", { html: css }));
}

// ════════════════════════════════════════════════════════════
export function mountAnypointConsole({ railPanel, stage, identities, makeClient, bgTabsHost }) {
  injectStyles();
  // styles.css に [hidden]{display:none !important} があり、CSS の display:flex では
  // 上書きできない。hidden 属性自体を外し、表示は .ap-console の display ルール
  // (body[data-side-cat="platform"] で flex / それ以外 none) に委ねる。
  stage.hidden = false;
  stage.removeAttribute("hidden");
  stage.classList.add("ap-console");

  const ctx = {
    idnId: null, client: null,
    bgId: null, bgName: "", bgs: [], persp: "runtime", envs: [], selEnv: new Set(),
    targets: new Map(),   // targetId → { id, name, type } (CH2/RTF 判別 + 名前解決)
    rows: [], prevStatus: new Map(),
    filter: "", sort: { key: "name", dir: 1 },
    selId: null, busy: new Set(),
    logRow: null, logLines: [], logSeen: new Set(), logFilter: "ALL", logSearch: "", logPaused: false, logPoll: null,
    apiCache: new Map(), assetCache: new Map(),   // lineage: env→API instances / asset→info
    typeCache: new Map(),   // tester: deploymentId → { type, baseUrl, oas }
    poll: null, autoRefresh: false, loaded: false,
    _exploreEnv: null,   // Explorer が辿る env (drawer の row から設定)
  };

  // ─── Lineage Explorer (横フィルムストリップのグラフナビゲータ) ───
  const explorer = createExplorer({
    stage,
    getContext: () => ({
      orgId: ctx.bgId,
      envId: ctx._exploreEnv,
      targetName: (id) => ctx.targets.get(id)?.name || id,
      client: ctx.client,
    }),
    getDeployments: () => ctx.rows,
    // consumer 枠は型/URL 確定済みで直 open、deployment ノードは型を解決してから open。
    openTester: (spec) => spec && spec.deployment ? openTester(spec.deployment) : tester.open(spec),
  });

  // ─── App Tester (全面オーバーレイ: REST/A2A/MCP を即テスト) ───
  // identity の Bearer を AUTH に使えるよう getToken を渡す (client が内部に持つ getter)。
  const tester = createTester({
    stage,
    getContext: () => ({ getToken: () => ctx.client?._getToken?.() }),
  });

  // ─── rail (サイドバー: identity → perspective → env 多選択) ──────────
  // BG (business group) は上部タブへ移したので rail からは外す。
  const selIdn = el("select", { on: { change: e => setIdentity(e.target.value) } });
  const envBox = el("div.ap-envs");
  const railNote = el("div.ap-note");
  // perspective 切替: Runtime (Fleet) ↔ Lineage (Explorer)。
  const PERSPS = [["runtime", "⊞ Runtime"], ["lineage", "⬡ Lineage"]];
  const perspBtns = PERSPS.map(([k, label]) =>
    el("button.ap-persp-btn", { dataset: { persp: k }, text: label, on: { click: () => setPersp(k) } }));
  const perspSeg = el("div.ap-persp", {}, ...perspBtns);
  const envField = el("div.ap-field", {}, el("label", { text: "Environments" }), envBox);
  railPanel.append(el("div.ap-rail", {},
    el("h4", { text: "PLATFORM" }),
    el("div.ap-field", {}, el("label", { text: "Identity" }), selIdn),
    el("div.ap-field", {}, el("label", { text: "Perspective" }), perspSeg),
    envField,
    railNote,
  ));

  // ─── toolbar ───────────────────────────────────────────────
  const crumb  = el("div.ap-crumb");
  const filter = el("input.ap-filter", { type: "search", placeholder: "filter by name…",
    on: { input: e => { ctx.filter = e.target.value.trim().toLowerCase(); renderTable(); } } });
  const count  = el("span.ap-count", { text: "" });
  const refreshBtn = el("button.ap-btn", { text: "↻ refresh", on: { click: () => loadDeployments() } });
  const autoBtn = el("button.ap-btn", { text: "auto", title: "auto-refresh (10s)",
    on: { click: () => toggleAuto() } });
  const toolbar = el("div.ap-toolbar", {}, crumb, el("span.ap-spacer"), filter, count, refreshBtn, autoBtn);

  // ─── table + drawer ───────────────────────────────────────
  const tbody = el("tbody");
  // 列は一覧 (list) endpoint で取れるフィールドのみ。replicas/version/vCores は
  // 一覧に無く detail 由来なので drawer に置く。
  const COLS = [
    { key: "name", label: "App" }, { key: "envName", label: "Env" },
    { key: "_status", label: "Status" }, { key: "_target", label: "Target" },
    { key: "runtime", label: "Runtime" }, { key: "updatedAt", label: "Updated" },
  ];
  const thead = el("thead", {}, el("tr", {}, ...COLS.map(c =>
    el("th", { dataset: { key: c.key }, on: { click: () => setSort(c.key) } }, c.label, el("span.ar")))));
  const table = el("table.ap-table", {}, thead, tbody);
  const tablewrap = el("div.ap-tablewrap", {}, table);
  const drawer = el("div.ap-drawer", {}, el("div.ap-dr-inner"));

  // ─── logs tail overlay (table+drawer を覆う) ───────────────
  const logTitle = el("div.ap-logs-title");
  const logBody  = el("div.ap-logs-body");
  const logLevelSel = el("select.ap-sel", { on: { change: e => { ctx.logFilter = e.target.value; renderLogs(); } } },
    ...["ALL", "ERROR", "WARN", "INFO", "DEBUG"].map(l => el("option", { value: l, text: l })));
  const logSearchInp = el("input.ap-filter", { type: "search", placeholder: "search logs…",
    on: { input: e => { ctx.logSearch = e.target.value.trim().toLowerCase(); renderLogs(); } } });
  const logPauseBtn = el("button.ap-btn", { text: "⏸ pause", on: { click: () => toggleLogPause() } });
  const logsOverlay = el("div.ap-logs", {},
    el("div.ap-logs-head", {},
      el("button.ap-dr-x", { text: "×", on: { click: closeLogs } }),
      logTitle, el("span.ap-spacer"), logLevelSel, logSearchInp, logPauseBtn),
    logBody);

  stage.append(toolbar, el("div.ap-body", {}, tablewrap, drawer), logsOverlay);
  syncPerspUI();   // 既定 perspective (Runtime) を mount 時点で反映 (onShow 前でも active 表示)

  // ─── identity → BG → env の連鎖ロード ─────────────────────
  function fillIdentities() {
    const list = (identities() || []);
    selIdn.innerHTML = "";
    selIdn.append(el("option", { value: "", text: list.length ? "— select identity —" : "(no identities)" }));
    for (const idn of list) selIdn.append(el("option", { value: idn.id, text: `${idn.name || idn.id} · ${idn.kind || ""}` }));
    if (ctx.idnId) selIdn.value = ctx.idnId;
  }

  async function setIdentity(idnId) {
    ctx.idnId = idnId || null; ctx.client = null;
    ctx.bgs = []; ctx.bgId = null; renderBgTabs();
    envBox.innerHTML = ""; ctx.envs = []; ctx.selEnv.clear();
    ctx.rows = []; renderTable(); closeDrawer();
    if (!idnId) { note(""); return; }
    const idn = (identities() || []).find(i => i.id === idnId);
    if (!idn) return;
    note("connecting…");
    try {
      ctx.client = makeClient(idn);
      ctx.bgs = await ctx.client.businessGroups();
      renderBgTabs();
      note(ctx.bgs.length ? "pick a business group (top tabs ↑)" : "no business groups");
      if (ctx.bgs.length === 1) setBusinessGroup(ctx.bgs[0].id);
    } catch (e) { note(errMsg(e), true); }
  }

  // ─── 上部タブ = ビジネスグループ (Platform モード時のみ表示・CSS で切替) ──
  function renderBgTabs() {
    if (!bgTabsHost) return;
    bgTabsHost.innerHTML = "";
    for (const b of ctx.bgs) {
      const tab = el("button.bg-tab", { dataset: { bgId: b.id },
        on: { click: () => { if (b.id !== ctx.bgId) setBusinessGroup(b.id); } } },
        el("span.bg-tab-dot"), el("span.bg-tab-name", { text: b.name || b.id }));
      if (b.id === ctx.bgId) tab.classList.add("is-active");
      bgTabsHost.append(tab);
    }
  }

  async function setBusinessGroup(bgId) {
    ctx.bgId = bgId || null; ctx.bgName = ctx.bgs.find(b => b.id === bgId)?.name || bgId || "";
    renderBgTabs();
    explorer.clearCache();   // env/BG が変わると lineage の cache は無効
    envBox.innerHTML = ""; ctx.envs = []; ctx.selEnv.clear(); ctx.rows = []; renderTable(); closeDrawer();
    if (!bgId || !ctx.client) { note(""); return; }
    note("loading environments…");
    try {
      // env と runtime target を並行取得 (target は CH2/RTF 判別 + 名前解決に使う)
      const [envs, targets] = await Promise.all([
        ctx.client.environments(bgId),
        ctx.client.runtimeTargets(bgId).catch(() => []),
      ]);
      ctx.envs = envs;
      ctx.targets = new Map(targets.map(t => [t.id, t]));
      // 既定: 非 prod を選択 (prod は明示選択させる)。全部非 prod / env 1個なら全選択。
      const nonProd = envs.filter(e => !e.isProduction);
      const initial = nonProd.length ? nonProd : envs;
      initial.forEach(e => ctx.selEnv.add(e.id));
      renderEnvs();
      note(`${envs.length} environments`);
      await loadDeployments();
      // Lineage 表示中に BG を切替えたら explore env を追従させ、入口を開き直す。
      if (ctx.persp === "lineage") { ctx._exploreEnv = [...ctx.selEnv][0] || null; explorer.open(null); }
    } catch (e) { note(errMsg(e), true); }
  }

  function renderEnvs() {
    envBox.innerHTML = "";
    for (const e of ctx.envs) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = ctx.selEnv.has(e.id);
      cb.addEventListener("change", () => {
        if (cb.checked) ctx.selEnv.add(e.id); else ctx.selEnv.delete(e.id);
        loadDeployments();
        // Lineage は単一 env を辿るので、選択先頭に追従して開き直す (cache は env 跨ぎで無効)。
        if (ctx.persp === "lineage") {
          const first = [...ctx.selEnv][0] || null;
          if (first !== ctx._exploreEnv) { ctx._exploreEnv = first; explorer.clearCache(); explorer.open(null); }
        }
      });
      envBox.append(el("label.ap-env", {}, cb, e.name || e.id,
        e.isProduction ? el("span.ap-prod", { text: "PROD" }) : null));
    }
  }

  // ─── deployments: 選択 env を横断 merge ───────────────────
  async function loadDeployments() {
    if (!ctx.client || !ctx.bgId) return;
    const envs = ctx.envs.filter(e => ctx.selEnv.has(e.id));
    updateCrumb();
    if (!envs.length) { ctx.rows = []; renderTable(); count.textContent = ""; return; }
    refreshBtn.disabled = true;
    const results = await Promise.allSettled(envs.map(e => ctx.client.deployments(ctx.bgId, e.id)));
    const rows = []; const failed = [];
    results.forEach((r, i) => {
      const e = envs[i];
      if (r.status === "fulfilled") {
        for (const d of r.value) rows.push({ ...d, envName: e.name || e.id, isProd: e.isProduction });
      } else failed.push(`${e.name}: ${errMsg(r.reason)}`);
    });
    // 差分ハイライト用に前回 status を退避
    const prev = ctx.prevStatus;
    ctx.prevStatus = new Map(rows.map(r => [r.id, r.status]));
    ctx.rows = rows.map(r => ({ ...r, _changed: prev.has(r.id) && prev.get(r.id) !== r.status }));
    refreshBtn.disabled = false;
    renderTable();
    note(failed.length ? `⚠ ${failed.join(" · ")}` : `${ctx.envs.length} environments`, failed.length > 0);
  }

  function setSort(key) {
    if (ctx.sort.key === key) ctx.sort.dir *= -1; else ctx.sort = { key, dir: 1 };
    renderTable();
  }

  // 計算列 (_status / _target) の sort 値を解決。
  function sortVal(r, key) {
    if (key === "_status") return rowStatusText(r);
    if (key === "_target") return targetOf(r).name;
    return r[key];
  }
  function visibleRows() {
    let rows = ctx.rows;
    if (ctx.filter) rows = rows.filter(r => (r.name || "").toLowerCase().includes(ctx.filter));
    const { key, dir } = ctx.sort;
    return rows.slice().sort((a, b) => {
      let av = sortVal(a, key), bv = sortVal(b, key);
      if (key === "updatedAt") { av = av ?? -1; bv = bv ?? -1; return (av - bv) * dir; }
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }

  // ─── 行の状態/ターゲット解決 ──────────────────────────────
  function rowStatusText(r) {
    if (/FAIL|ERROR/i.test(r.deployStatus)) return "FAILED";
    return r.appStatus || r.deployStatus || "—";
  }
  function rowTone(r) {
    if (/FAIL|ERROR/i.test(r.deployStatus)) return "bad";
    if (/APPLYING|UPDATING|PENDING|DEPLOYING/i.test(r.deployStatus)) return "busy";
    return statusTone(r.appStatus || r.deployStatus);
  }
  function targetOf(r) {
    const t = ctx.targets.get(r.targetId);
    const name = t?.name || (r.targetId ? r.targetId.slice(0, 8) : "—");
    const kind = (t && targetKind(t.type)) || providerLabel(r.provider) || "";
    return { name, kind };
  }

  function renderTable() {
    $$("th", thead).forEach(th => {
      const ar = $(".ar", th);
      ar.textContent = th.dataset.key === ctx.sort.key ? (ctx.sort.dir > 0 ? "▲" : "▼") : "";
    });
    tbody.innerHTML = "";
    const rows = visibleRows();
    count.textContent = ctx.rows.length ? `${rows.length}/${ctx.rows.length}` : "";
    if (!ctx.rows.length) {
      tbody.append(el("tr", {}, el("td", { colspan: COLS.length },
        el("div.ap-empty", { text: ctx.client ? "select environment(s) to list deployments" : "select an identity in the rail →" }))));
      return;
    }
    for (const r of rows) {
      const tgt = targetOf(r);
      const tr = el("tr", { dataset: { id: r.id }, on: { click: () => selectDeployment(r) } },
        el("td", {}, el("span.ap-name", {},
          el("span", { class: `ap-dot ${rowTone(r)}` }), r.name || r.id)),
        el("td", { text: r.envName }),
        el("td", { text: rowStatusText(r) }),
        el("td", {}, el("span.ap-tag", { text: tgt.kind || "—" }), " " + tgt.name),
        el("td.ap-mono", { text: r.runtime || "—" }),
        el("td.ap-mono", { text: fmtAgo(r.updatedAt) }),
      );
      if (r.id === ctx.selId) tr.classList.add("is-sel");
      if (ctx.busy.has(r.id)) tr.classList.add("is-busy");
      if (r._changed) tr.classList.add("is-changed");
      tbody.append(tr);
    }
  }

  function updateCrumb() {
    crumb.innerHTML = "";
    const idn = (identities() || []).find(i => i.id === ctx.idnId);
    const nEnv = ctx.envs.filter(e => ctx.selEnv.has(e.id)).length;
    crumb.append(
      el("span", { text: idn?.name || "—" }), el("span.sep", { text: "›" }),
      el("span", { text: ctx.bgName || "—" }), el("span.sep", { text: "›" }),
      el("span.dim", { text: `${nEnv} env${nEnv === 1 ? "" : "s"}` }),
    );
  }

  // ─── detail drawer ─────────────────────────────────────────
  async function selectDeployment(row) {
    ctx.selId = row.id; renderTable();
    const inner = $(".ap-dr-inner", drawer); inner.innerHTML = "";
    drawer.classList.add("is-open");
    const tgt = targetOf(row);
    inner.append(
      el("div.ap-dr-head", {},
        el("button.ap-dr-x", { text: "×", on: { click: closeDrawer } }),
        el("div.ap-dr-title", {}, el("span", { class: `ap-dot ${rowTone(row)}` }), row.name || row.id,
          el("span.ap-tag#ap-type-badge", { text: "…", title: "app type (detecting)" })),
        el("div.ap-dr-sub", { text: `${row.envName} · ${tgt.kind || "?"} · ${tgt.name}` }),
      ),
      el("div.ap-sec", {}, el("h5", { text: "Overview" }), el("dl.ap-kv#ap-overview", {}, ...overviewKvs(row))),
      el("div.ap-sec#ap-lineage", {}, el("h5", { text: "Lineage" }), el("div.ap-note", { text: "resolving…" })),
      el("div.ap-sec#ap-replicas", {}, el("h5", { text: "Replicas" }), el("div.ap-note", { text: "loading…" })),
      el("div.ap-sec#ap-specs", {}, el("h5", { text: "Specs (versions)" }),
        el("button.ap-btn", { text: "load specs", on: { click: ev => loadSpecs(row, ev.target) } })),
      el("div.ap-actions", {},
        el("button.ap-btn#ap-test-btn", { text: "▶ Test", title: "Test this app now", on: { click: () => openTester(row) } }),
        el("button.ap-btn", { text: "≡ Logs", on: { click: () => openLogs(row) } }),
        el("button.ap-btn.is-danger", { text: "↻ Restart", on: { click: () => doRestart(row) } }),
      ),
    );
    // 一覧 item には version/replicas/desired/resources が無いので detail を取り直し、
    // overview と replica 一覧を埋め直す。
    try {
      const det = await ctx.client.deployment(ctx.bgId, row.envId, row.id);
      row._raw = det._raw || row._raw;   // restart の PATCH body 用に最新 raw を退避
      loadLineage(row, inner);           // asset/spec/API Manager の系譜を非同期で埋める
      // 型判定 (rest/a2a/mcp/http) は detail 取得後 (ref が埋まってから) に非同期で。
      resolveTest(row).then(t => {
        if (ctx.selId !== row.id) return;
        const badge = $("#ap-type-badge", inner);
        if (badge) { badge.textContent = typeLabel(t.type); badge.title = `app type: ${typeLabel(t.type)}${t.baseUrl ? " · " + t.baseUrl : ""}`; }
        const tb = $("#ap-test-btn", inner);
        if (tb) tb.textContent = `▶ Test · ${typeLabel(t.type)}`;
      }).catch(() => {});
      const ov = $("#ap-overview", inner);
      if (ov) { ov.innerHTML = ""; overviewKvs(det).forEach(f => ov.append(f)); }
      const box = $("#ap-replicas", inner); if (!box) return;
      box.innerHTML = ""; box.append(el("h5", { text: "Replicas" }));
      const list = det.replicaList || [];
      if (!list.length) box.append(el("div.ap-note", { text: "no replica detail" }));
      for (const rep of list) box.append(el("div.ap-replica", {},
        el("span", { class: `ap-dot ${statusTone(rep.state)}` }),
        rep.state || "—", el("span.ap-mono", { text: rep.version || "" })));
    } catch (e) {
      const box = $("#ap-replicas", inner);
      if (box) { box.innerHTML = ""; box.append(el("h5", { text: "Replicas" }), el("div.ap-note.is-err", { text: errMsg(e) })); }
    }
  }
  function overviewKvs(r) {
    const resource = r.vCores != null ? `${fmtVCores(r.vCores)} vCores`
      : (r.cpu || r.mem) ? `${r.cpu || "—"} cpu · ${r.mem || "—"} mem` : "—";
    return [
      kv("App", rowStatusText(r)), kv("Deploy", r.deployStatus || "—"),
      kv("Desired", r.desired || "—"), kv("Runtime", r.runtime || "—"),
      kv("Replicas", r.replicas == null ? "—" : String(r.replicas)),
      kv("Resources", resource), kv("Version", r.version || "—"),
      kv("Clustered", r.clustered ? "yes" : "no"),
    ];
  }

  // ─── Lineage: 走ってるデプロイ → asset / spec / API Manager を 1 枚に ───
  // Anypoint はこれらを画面跨ぎで散らすので、辿れるものを集約する (自動マッチに頼り切らない)。
  function exLink(url) {
    return el("a.ap-ex", { href: url, target: "_blank", rel: "noopener noreferrer", title: "Open in Exchange", text: "↗" });
  }
  async function loadLineage(row, inner) {
    const box = $("#ap-lineage", inner); if (!box) return;
    const ref = row._raw?.application?.ref;
    box.innerHTML = ""; box.append(el("h5", { text: "Lineage" }));
    // 1) deployed asset → Exchange (jar を展開せず中身/依存を見る入口)
    if (ref?.artifactId) {
      box.append(el("div.ap-lin", {}, el("span.ap-lin-k", { text: "asset" }),
        el("span.ap-lin-v", {}, `${ref.artifactId}:${ref.version}`,
          exLink(ctx.client.exchangeUrl(ref.groupId, ref.artifactId, ref.version)))));
    }
    // 2) spec via pom 依存 (Exchange asset の dependencies から)
    let info;
    if (ref?.artifactId) {
      const key = `${ref.groupId}/${ref.artifactId}/${ref.version}`;
      try {
        info = ctx.assetCache.get(key) || await ctx.client.assetInfo(ref.groupId, ref.artifactId, ref.version);
        ctx.assetCache.set(key, info);
      } catch {}
    }
    if (ctx.selId !== row.id) return;   // 切替後の遅延描画を防ぐ
    const specRow = el("div.ap-lin", {}, el("span.ap-lin-k", { text: "spec" }));
    if (info?.specs?.length) {
      const v = el("span.ap-lin-v");
      info.specs.forEach(s => v.append(`${s.assetId}:${s.version}`, exLink(ctx.client.exchangeUrl(s.groupId, s.assetId, s.version))));
      specRow.append(v);
    } else {
      specRow.append(el("span.ap-lin-v.dim", { text: "— no API spec in pom dependencies" }));
    }
    box.append(specRow);
    // 3) ここから先 (API instance → FGW → consumer URL) は再描画なしで辿りたいので
    //    Explorer (横フィルムストリップ) に渡す。drawer には入口ボタンだけ置く。
    box.append(el("div.ap-lin-act", {},
      el("button.ap-btn.is-explore", { text: "⬡ Explore lineage →",
        on: { click: () => openExplorer(row) } })));
  }
  // drawer の「Explore →」: Lineage perspective へ切替え、この row を起点に開く。
  function openExplorer(row) {
    ctx._exploreEnv = row.envId;
    setPersp("lineage", { seed: { type: "deployment", id: row.id, title: row.name || row.id, sub: "deploy", data: row } });
  }

  // ─── perspective 切替: Runtime (Fleet) ↔ Lineage (Explorer) ──
  function syncPerspUI() {
    perspBtns.forEach(b => b.classList.toggle("is-on", b.dataset.persp === ctx.persp));
    // Runtime は env 複数選択、Lineage は単一 explore env。env field は両方で意味があるので出す。
    stage.dataset.persp = ctx.persp;
  }
  async function setPersp(p, opts = {}) {
    ctx.persp = p; syncPerspUI();
    if (p !== "lineage") { explorer.close(); return; }
    // Lineage は単一 env を辿る。明示 seed が無ければ選択 env の先頭 (無ければ env 先頭)。
    if (opts.seed) ctx._exploreEnv = opts.seed.data?.envId || ctx._exploreEnv;
    else ctx._exploreEnv = ctx._exploreEnv || [...ctx.selEnv][0] || ctx.envs[0]?.id || null;
    explorer.open(opts.seed || null);
    // Deployments 入口を埋めるため rows が空なら一度ロードして開き直す (Specs/Gateways は env/org 直引きで先に使える)。
    if (!opts.seed && !ctx.rows.length && ctx.selEnv.size) { await loadDeployments(); explorer.open(null); }
  }
  function kv(k, v) {
    // dl.ap-kv の grid (auto 1fr) を保つため、dt/dd を直接子にする fragment を返す。
    const f = document.createDocumentFragment();
    f.append(el("dt", { text: k }), el("dd", { text: String(v) }));
    return f;
  }
  function closeDrawer() { drawer.classList.remove("is-open"); ctx.selId = null; renderTable(); }

  // ─── App Tester: 型判定 + base URL 解決 ────────────────────
  // 型 (rest/a2a/mcp/http) は選択時に遅延判定し ctx.typeCache に載せる。
  //   1) base URL (consumer) を解決
  //   2) Exchange asset の spec 依存に rest-api/oas/raml → rest
  //   3) rest でなければ base URL を agent-card / mcp initialize でプローブ → a2a/mcp
  //   4) いずれも不能なら http (generic·手入力で叩ける)
  function typeLabel(t) { return ({ rest: "REST", http: "HTTP", a2a: "A2A", mcp: "MCP" })[t] || "HTTP"; }
  function joinUrl(base, path) {
    const b = String(base || "").replace(/\/+$/, ""); const p = String(path || "");
    if (!p) return b; return p.startsWith("/") ? b + p : `${b}/${p}`;
  }
  async function cachedApis(envId) {
    if (ctx.apiCache.has(envId)) return ctx.apiCache.get(envId);
    const apis = await ctx.client.apiInstances(ctx.bgId, envId);
    ctx.apiCache.set(envId, apis);
    return apis;
  }
  // CH2 直公開アプリ向けヒューリスティック: raw に紛れる公開 URL を拾う。
  function guessUrlFromRaw(raw) {
    try {
      const m = JSON.stringify(raw).match(/https?:\/\/[a-z0-9.\-]+\.(?:cloudhub\.io|mulesoft\.com)[^"'\\ ]*/i);
      return m ? m[0] : "";
    } catch { return ""; }
  }
  async function resolveBaseUrl(row) {
    // 1) デプロイ自身が公開する URL を最優先。generate-default-public-url=true のとき
    //    Application Manager v2 の raw に直接入る (= そのアプリの権威ある public endpoint)。
    //    API Manager 照会も URL 推測も不要。CH2 / 公開 URL 付き RTF を一発で解決する。
    const inb = row._raw?.target?.deploymentSettings?.http?.inbound || {};
    const pub = inb.publicUrl || inb["public-url"];   // 生 API は camelCase。kebab も一応見る
    if (pub) return String(pub).replace(/\/+$/, "");
    // 2) API Manager 管理下なら consumer URL (FGW publicUrl + basePath)。
    //    アプリ直の public URL を持たず、FGW 越しでのみ叩けるケース。
    try {
      const apis = await cachedApis(row.envId);
      const inst = apis.find(a => a.applicationId && a.applicationId === row.id);
      if (inst) {
        const det = await ctx.client.apiInstance(ctx.bgId, row.envId, inst.id);
        if (det.gatewayId) {
          const gw = await ctx.client.gateway(ctx.bgId, row.envId, det.gatewayId);
          if (gw.publicUrl) return gw.publicUrl + (det.basePath === "/" ? "/" : det.basePath);
        }
        if (inst.endpointUri) return inst.endpointUri;
      }
    } catch {}
    // 3) raw から公開 URL を拾うヒューリスティック (最後の砦)。
    return guessUrlFromRaw(row._raw);
  }
  // base URL を 1〜2 リクエストで叩いて a2a/mcp を判定 (discovery は通常 auth 不要)。
  async function probeType(base) {
    try {
      const r = await fetch(`/proxy?url=${encodeURIComponent(joinUrl(base, "/.well-known/agent-card.json"))}`);
      if (r.ok) { const j = await r.json().catch(() => null); if (j && (j.name || j.skills || j.capabilities || j.url)) return "a2a"; }
    } catch {}
    try {
      const r = await fetch(`/proxy?url=${encodeURIComponent(joinUrl(base, "/mcp"))}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "atelier", version: "1.0" } } }),
      });
      if (r.ok) { const t = await r.text(); if (/"result"|"serverInfo"|"protocolVersion"/.test(t)) return "mcp"; }
    } catch {}
    return null;
  }
  async function resolveTest(row) {
    if (ctx.typeCache.has(row.id)) return ctx.typeCache.get(row.id);
    const out = { type: "http", baseUrl: "", oas: null };
    try { out.baseUrl = await resolveBaseUrl(row); } catch {}
    // spec 依存から REST 判定 (loadLineage と同じ assetInfo・cache 共有)
    const ref = row._raw?.application?.ref;
    if (ref?.artifactId) {
      const key = `${ref.groupId}/${ref.artifactId}/${ref.version}`;
      let info = ctx.assetCache.get(key);
      if (!info) { try { info = await ctx.client.assetInfo(ref.groupId, ref.artifactId, ref.version); ctx.assetCache.set(key, info); } catch {} }
      const oas = (info?.specs || []).find(s => /rest-api|oas|raml/i.test(s.type || ""));
      if (oas) { out.type = "rest"; out.oas = oas; }
    }
    // REST と確定しなかった場合のみ agent/mcp をプローブ (REST 確定アプリの無駄打ちを避ける)
    if (out.type === "http" && out.baseUrl) {
      const probed = await probeType(out.baseUrl);
      if (probed) out.type = probed;
    }
    ctx.typeCache.set(row.id, out);
    return out;
  }
  async function openTester(row) {
    const tb = $("#ap-test-btn", drawer); if (tb) { tb.disabled = true; tb.textContent = "▶ …"; }
    let t;
    try { t = await resolveTest(row); }
    finally { if (tb) tb.disabled = false; }
    tester.open({
      type: t.type, baseUrl: t.baseUrl, oas: t.oas,
      title: row.name || row.id, sub: `${row.envName} · ${typeLabel(t.type)}`,
    });
    if (tb) tb.textContent = `▶ Test · ${typeLabel(t.type)}`;
  }

  async function loadSpecs(row, btn) {
    btn.disabled = true; btn.textContent = "loading…";
    try {
      const specs = await ctx.client.specs(ctx.bgId, row.envId, row.id);
      const arr = Array.isArray(specs) ? specs : (specs?.items || specs?.data || []);
      const box = btn.parentElement; box.innerHTML = ""; box.append(el("h5", { text: "Specs (versions)" }));
      if (!arr.length) { box.append(el("div.ap-note", { text: "no specs" })); return; }
      for (const s of arr.slice(0, 20)) box.append(el("div.ap-replica", {},
        el("span.ap-mono", { text: s.version || s.id || "" }),
        el("span.ap-note", { text: s.createdAt ? fmtAgo(Date.parse(s.createdAt)) : "" })));
    } catch (e) { btn.disabled = false; btn.textContent = "retry"; btn.parentElement.append(el("div.ap-note.is-err", { text: errMsg(e) })); }
  }

  // ─── Restart (confirm + prod ガード) ──────────────────────
  async function doRestart(row) {
    const isProd = !!row.isProd;
    const ok = await modalConfirm({
      title: isProd ? "⚠ PRODUCTION — Restart" : "Restart deployment",
      message: `Restart ${row.name} in “${row.envName}”.`
        + `\nIt will be redeployed with updateStrategy=rolling (minimal downtime).`
        + (isProd ? `\n\n⚠ This is a production environment. Please confirm before proceeding.` : ""),
      danger: isProd, confirmLabel: "Restart", cancelLabel: "Cancel",
    });
    if (!ok) return;
    ctx.busy.add(row.id); renderTable();
    try {
      await ctx.client.restart(ctx.bgId, row.envId, row.id, row._raw);
      note(`${row.name}: restart requested`);
      setTimeout(() => loadDeployments(), 1500);
    } catch (e) {
      note(`restart failed: ${errMsg(e)}`, true);
    } finally {
      ctx.busy.delete(row.id); renderTable();
    }
  }

  // ─── logs tail (read-only: poll → docId dedup → 追記) ─────
  function openLogs(row) {
    ctx.logRow = row; ctx.logLines = []; ctx.logSeen = new Set(); ctx.logPaused = false;
    logPauseBtn.textContent = "⏸ pause"; logPauseBtn.classList.remove("is-on");
    logTitle.innerHTML = ""; logTitle.append(row.name || row.id, el("span.dim", { text: `${row.envName} · live tail` }));
    logsOverlay.classList.add("is-open");
    logBody.innerHTML = ""; logBody.append(el("div.ap-logs-empty", { text: "loading…" }));
    pollLogs(true);
    if (ctx.logPoll) clearInterval(ctx.logPoll);
    ctx.logPoll = setInterval(() => { if (!ctx.logPaused && isVisible()) pollLogs(false); }, 4000);
  }
  function closeLogs() {
    logsOverlay.classList.remove("is-open");
    if (ctx.logPoll) { clearInterval(ctx.logPoll); ctx.logPoll = null; }
    ctx.logRow = null;
  }
  function toggleLogPause() {
    ctx.logPaused = !ctx.logPaused;
    logPauseBtn.textContent = ctx.logPaused ? "▶ resume" : "⏸ pause";
    logPauseBtn.classList.toggle("is-on", ctx.logPaused);
  }
  async function pollLogs(first) {
    const row = ctx.logRow; if (!row) return;
    let lines;
    try { lines = await ctx.client.logs(ctx.bgId, row.envId, row.id); }
    catch (e) { if (first) { logBody.innerHTML = ""; logBody.append(el("div.ap-logs-empty.is-err", { text: errMsg(e) })); } return; }
    if (ctx.logRow !== row) return;   // 切替後の遅延レスポンスは破棄
    let added = 0;
    for (const ln of lines) {
      const key = ln.docId || `${ln.ts}-${ln.msg}`;
      if (ctx.logSeen.has(key)) continue;
      ctx.logSeen.add(key); ctx.logLines.push(ln); added++;
    }
    if (added || first) { ctx.logLines.sort((a, b) => (a.ts || 0) - (b.ts || 0)); renderLogs(); }
  }
  function renderLogs() {
    const atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 48;
    const lines = ctx.logLines.filter(ln =>
      (ctx.logFilter === "ALL" || (ln.level || "").toUpperCase() === ctx.logFilter) &&
      (!ctx.logSearch || (ln.msg || "").toLowerCase().includes(ctx.logSearch) || (ln.logger || "").toLowerCase().includes(ctx.logSearch)));
    logBody.innerHTML = "";
    if (!lines.length) {
      logBody.append(el("div.ap-logs-empty", { text: ctx.logLines.length ? "no lines match filter" : "no recent logs (this app may have none)" }));
      return;
    }
    for (const ln of lines) logBody.append(el("div.ap-log", {},
      el("span.ap-log-ts", { text: fmtTime(ln.ts) }),
      el("span", { class: `ap-log-lv ${(ln.level || "").toUpperCase()}`, text: ln.level || "" }),
      el("span.ap-log-msg", {}, ln.logger ? el("span.ap-log-lg", { text: `[${ln.logger}] ` }) : null, ln.msg || ""),
    ));
    if (atBottom) logBody.scrollTop = logBody.scrollHeight;
  }

  // ─── auto-refresh ──────────────────────────────────────────
  function toggleAuto() {
    ctx.autoRefresh = !ctx.autoRefresh;
    autoBtn.classList.toggle("is-on", ctx.autoRefresh);
    if (ctx.poll) { clearInterval(ctx.poll); ctx.poll = null; }
    if (ctx.autoRefresh) ctx.poll = setInterval(() => { if (isVisible()) loadDeployments(); }, 10000);
  }
  function isVisible() { return stage.offsetParent !== null; }

  // ─── helpers ───────────────────────────────────────────────
  function note(msg, isErr = false) { railNote.textContent = msg || ""; railNote.classList.toggle("is-err", !!isErr); }
  function errMsg(e) { return (e && (e.message || e.toString())) || "error"; }

  // 初回表示時に identity リストを埋める。以後の onShow は idle なら何もしない。
  return {
    onShow() {
      fillIdentities();
      syncPerspUI();      // perspective seg の active 反映
      renderBgTabs();     // 上部タブ = BG (Platform 表示時に CSS で出る)
      if (!ctx.loaded) { ctx.loaded = true; }
      else if (ctx.client && ctx.bgId && ctx.persp === "runtime") loadDeployments();
    },
  };
}
