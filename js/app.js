// Atelier · Agent Workbench — entry point
// ─────────────────────────────────────────
// ワークスペース(タブ)、サイドバー、接続ダイアログ、フローティングウインドウ管理

import { PROTOCOLS, getProtocol }           from "./protocols/index.js";
import { mockUrl }                          from "./protocols/mock.js";
import { AgentWindow }                      from "./window.js";
import * as persist                         from "./persist.js";
import { modalConfirm, modalAlert, modalPrompt, modalChoice } from "./modal.js";
import { runAuthCodeFlow, redirectUri }     from "./oauth.js";
import { parseScript, parseMocks, ScriptRunner }        from "./script.js";

// /demo用のフォールバック (ブックマーク0件の時のみ使用)
const DEMO_AGENTS = [
  { name: "Atelier Research",      url: "https://atelier.example/agents/research",      host: "atelier.example/agents/research",      proto: "mock", persona: "atelier-research" },
  { name: "Obsidian Orchestrator", url: "https://obsidian.example/agents/orchestrator", host: "obsidian.example/agents/orchestrator", proto: "mock", persona: "obsidian-orchestrator" },
  { name: "Silica Vision",         url: "https://silica.example/agents/vision",         host: "silica.example/agents/vision",         proto: "mock", persona: "silica-vision" }
];

// ─── State ────────────────────────────────────────────
let wsCounter     = 0;
let catCounter    = 0;
let bgCounter     = 0;
let scriptCounter = 0;
let idnCounter    = 0;

// 旧 catalog (cat.businessGroup / cat.assets が直下) を businessGroups[] 配列に変換 (防御的)
function migrateCatalog(c) {
  try {
    if (!c || typeof c !== "object") return c;
    if (Array.isArray(c.businessGroups)) {
      c.businessGroups.forEach(bg => {
        const m = (bg?.id || "").match(/^bg-(\d+)$/);
        if (m) bgCounter = Math.max(bgCounter, parseInt(m[1], 10));
      });
      return c;
    }
    c.businessGroups = [];
    if (c.businessGroup) {
      c.businessGroups.push({
        id:    `bg-${++bgCounter}`,
        input: c.businessGroup,
        bgId:  c.businessGroupId || null,
        bgName: c.businessGroupName || null,
        assets: c.assets || null,
        assetsFetchedAt: c.assetsFetchedAt || null
      });
    }
    delete c.businessGroup;
    delete c.businessGroupId;
    delete c.businessGroupName;
    delete c.assets;
    delete c.assetsFetchedAt;
    return c;
  } catch (e) {
    console.warn("migrateCatalog failed:", e, c);
    if (c && !Array.isArray(c.businessGroups)) c.businessGroups = [];
    return c;
  }
}

const CATALOG_FLOWS = [
  { id: "cc",       label: "Client Credentials",  sub: "oauth2 / cc",   description: "Client credentials grant" },
  { id: "authcode", label: "Authorization Code",  sub: "oauth2 / code", description: "Authorization code + PKCE" }
];

// 現状 Anypoint のみ。ベンダーが増えたらここに追加 + providerセレクタUIを復活させる
const ANYPOINT = {
  id: "anypoint",
  label: "Anypoint Platform",
  authUrl:  "https://anypoint.mulesoft.com/accounts/api/v2/oauth2/authorize",
  tokenUrl: "https://anypoint.mulesoft.com/accounts/api/v2/oauth2/token"
};

const state = {
  workspaces: [],     // [{ id, name, windows: [], events: 0, layer: <div> }]
  activeWs: null,
  selectedProto: "a2a",
  selectedCatalogFlow: "cc",
  selectedIdentityKind: "bearer",
  activeSideCat: "connections",   // サイドバー Activity Bar の選択カテゴリ
  zoom: 1.0,
  sidebarCollapsed: false,
  theme: "light",     // "light" | "dark"
  catalogs: [],       // [{ id, name, flow, baseUrl, orgId, envId, clientId, clientSecret?, scopes, status, createdAt }]
  // 認証プロファイル (IdP credential)。 connection が authRef で参照して使い回す。
  // entry = { id, name, kind, ...kind固有, accessToken?, tokenExpiresAt?, createdAt, updatedAt }
  identities: [],
  // 「コネクション登録」一覧。 ウインドウが 0 個になっても残り、 明示的な DELETE のみで消える。
  // entry = { key, protoId, url, name, auth?, persona?, channel? }
  bookmarks: [],
  scripts: [],        // [{ id, name, body, createdAt, updatedAt }]
  selectedScriptId: null,
  openScriptIds: [],  // panel に open しているタブの順序
  scriptPanelOpen: false,
  scriptPanelHeight: 0,  // 0 = 未設定。 init で canvas の ~50% に決まる
  sidePanelW: 240        // CONNECTIONS パネル領域の幅 (px)。 右端ドラッグで可変
};

function defaultScriptPanelHeight() {
  return Math.round(window.innerHeight * 0.5);
}

// 0 / null は default (50% canvas) にリフト。 旧 hard-coded 480 も migration
// 対象として default に置き換える (user 由来でなく旧 init/scenario 由来なので)。
// それ以外 (user が drag で決めた値) はそのまま尊重する。
function normalizeScriptPanelHeight(saved) {
  if (!saved || saved === 480) return defaultScriptPanelHeight();
  return saved;
}

function bookmarkKey(protoId, url) { return `${protoId}::${url || ""}`; }

// 行末の常時表示ケバブ (⋮) ボタン — 全リスト共通。クリックで openRowMenu。
const KEBAB_BTN_HTML = `<button class="row-kebab" title="More" aria-label="more actions"><svg viewBox="0 0 14 14" width="12" height="12"><circle cx="7" cy="3" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="11" r="1.2" fill="currentColor"/></svg></button>`;

// アンカー要素の近くに小さなメニューを出す。items = [{label, danger?, onClick}]。
// 外側クリック / Esc / スクロールで閉じる。
function openRowMenu(anchorEl, items) {
  closeRowMenu();
  const menu = document.createElement("div");
  menu.className = "row-menu";
  menu.id = "rowMenu";
  items.forEach(it => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row-menu-item" + (it.danger ? " is-danger" : "");
    b.textContent = it.label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeRowMenu();
      it.onClick && it.onClick();
    });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  // 位置決め: アンカーの右下に出し、画面外なら上 / 左に補正
  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.right - mw;
  let top  = r.bottom + 4;
  if (left < 6) left = 6;
  if (top + mh > window.innerHeight - 6) top = r.top - mh - 4;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top  = `${Math.round(top)}px`;
  // 閉じる配線 (次フレームで登録し、開いた click 自身で閉じないように)
  setTimeout(() => {
    document.addEventListener("click", closeRowMenu, { once: true });
    document.addEventListener("keydown", _rowMenuEsc);
    window.addEventListener("scroll", closeRowMenu, { once: true, capture: true });
  }, 0);
}
function _rowMenuEsc(e) { if (e.key === "Escape") closeRowMenu(); }
function closeRowMenu() {
  const m = document.getElementById("rowMenu");
  if (m) m.remove();
  document.removeEventListener("keydown", _rowMenuEsc);
}

const ZOOM_MIN = 0.8;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
const SIDE_PANEL_W_MIN = 160;
const SIDE_PANEL_W_MAX = 560;
const SIDE_PANEL_W_DEF = 240;

const $  = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

// ─── Boot ────────────────────────────────────────────
init();

function init() {
  // ?reset で永続状態をクリア (他のクエリは保持)
  if (location.search.includes("reset") || location.hash.includes("reset")) {
    persist.clear();
  }

  const saved = persist.load();
  if (saved && saved.workspaces?.length) {
    state.zoom             = saved.zoom ?? 1.0;
    state.sidebarCollapsed = !!saved.sidebarCollapsed;
    state.theme            = saved.theme === "dark" ? "dark" : "light";
    state.catalogs         = (saved.catalogs || []).map(migrateCatalog);
    state.identities       = saved.identities || [];
    state.bookmarks        = saved.bookmarks || [];
    // sessionStorage から secrets を引き戻す (持続中のタブのみ)
    persist.hydrateSecrets(state.catalogs, state.bookmarks, state.identities);
    idnCounter    = state.identities.reduce((m, i) => Math.max(m, parseInt(i.id?.split("-")[1] || 0)), 0);
    state.scripts          = saved.scripts   || [];
    state.selectedScriptId = saved.selectedScriptId || null;
    state.openScriptIds    = (saved.openScriptIds || []).filter(id => state.scripts.find(s => s.id === id));
    state.scriptPanelOpen  = !!saved.scriptPanelOpen && state.openScriptIds.length > 0;
    state.scriptPanelHeight = normalizeScriptPanelHeight(saved.scriptPanelHeight);
    state.sidePanelW = normalizeSidePanelW(saved.sidePanelW);
    catCounter    = state.catalogs.reduce((m, c) => Math.max(m, parseInt(c.id?.split("-")[1] || 0)), 0);
    scriptCounter = state.scripts.reduce((m, s) => Math.max(m, parseInt(s.id?.split("-")[1] || 0)), 0);
    restoreFromSaved(saved);
  } else {
    state.sidebarCollapsed = !!saved?.sidebarCollapsed;
    state.theme            = saved?.theme === "dark" ? "dark" : "light";
    state.catalogs  = (saved?.catalogs || []).map(migrateCatalog);
    state.identities = saved?.identities || [];
    state.bookmarks = saved?.bookmarks || [];
    persist.hydrateSecrets(state.catalogs, state.bookmarks, state.identities);
    idnCounter    = state.identities.reduce((m, i) => Math.max(m, parseInt(i.id?.split("-")[1] || 0)), 0);
    state.scripts   = saved?.scripts   || [];
    state.selectedScriptId = saved?.selectedScriptId || null;
    state.openScriptIds    = (saved?.openScriptIds || []).filter(id => state.scripts.find(s => s.id === id));
    state.scriptPanelOpen  = !!saved?.scriptPanelOpen && state.openScriptIds.length > 0;
    state.scriptPanelHeight = normalizeScriptPanelHeight(saved?.scriptPanelHeight);
    state.sidePanelW = normalizeSidePanelW(saved?.sidePanelW);
    scriptCounter = state.scripts.reduce((m, s) => Math.max(m, parseInt(s.id?.split("-")[1] || 0)), 0);
    createWorkspace("default", { focus: true, silent: true });
  }

  const savedCat = saved?.activeSideCat;
  if (["connections","catalogs","authentication","scenarios"].includes(savedCat)) {
    state.activeSideCat = savedCat;
  }

  migrateAuthToIdentities();

  renderBookmarks();
  renderCatalogs();
  renderIdentities();
  renderScripts();
  renderProtoGrid();
  renderTabs();
  wireRail();
  wireSideRail();
  wireIdentityDialog();
  wireDialog();
  wireCatalogDialog();
  wireDrawer();
  wireClock();
  wireKeyboard();
  wireWsTabs();
  wireZoom();
  wireSidebarToggle();
  wireSideResize();
  wireTheme();
  wireWorkspaceBlur();
  wireScriptPanel();
  wireBackup();
  wireConnToggleAll();
  applyZoom();   // 復元値を反映
  applySidebar();
  applySidePanelW();   // 復元値を反映
  applyTheme();
  applyScriptPanel();   // 復元値を反映
  updateStatusLine();
  updateEmptyState();

  // import 直後 (reload を挟む) は restore 後にウインドウを tile する
  if (sessionStorage.getItem("atelier:tileAfterImport")) {
    sessionStorage.removeItem("atelier:tileAfterImport");
    setTimeout(tileWindows, 350);
  }

  // ?demo or #demo で自動的にデモエージェントをロード
  if (location.search.includes("demo") || location.hash.includes("demo")) {
    setTimeout(loadDemo, 200);
  }
  // ?a2a=http://127.0.0.1:5180  で実A2Aエンドポイントへ接続 (動作確認用)
  const a2aMatch = location.search.match(/[?&]a2a=([^&]+)/);
  if (a2aMatch) {
    const url = decodeURIComponent(a2aMatch[1]);
    setTimeout(() => connect({ protoId: "a2a", url, name: hostFromUrl(url) }), 100);
  }
  // ?tab=card|debug|chat|settings  でウインドウの初期タブを指定 (動作確認用)
  const tabMatch = location.search.match(/[?&]tab=(card|debug|chat|settings)/);
  if (tabMatch) {
    const t = tabMatch[1];
    setTimeout(() => activeWorkspace().windows.forEach(w => w.switchTab(t)), 2200);
  }
  // ?msg=hello で自動メッセージ送信は **削除済み**。
  //   - URL 1 つでアクティブウインドウから任意エージェント宛に意図しない要求を流せる
  //     (社内 Slack / メールに `https://atelier.../?msg=...` を貼られると即発火) ため、
  //     security review (2026-05-28) で削除。 動作確認は compose-input への手入力で。
}

// 保存トリガ (debounced)
function dirty() { persist.scheduleSave(state); }

// ═══════════════════════════════════════════════════════
// ZOOM
// ═══════════════════════════════════════════════════════
function applyZoom() {
  // --fs変数でフォントサイズだけスケール (レイアウト寸法は不変)
  document.documentElement.style.setProperty("--fs", String(state.zoom));
  const v = $("#zoomVal");
  if (v) v.textContent = Math.round(state.zoom * 100) + "%";
}
function setZoom(z, opts = {}) {
  z = Math.round(z * 10) / 10;
  z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  if (z === state.zoom) return;
  state.zoom = z;
  applyZoom();
  if (!opts.skipDirty) dirty();
}
function wireZoom() {
  $("#zoomIn") .addEventListener("click", () => setZoom(state.zoom + ZOOM_STEP));
  $("#zoomOut").addEventListener("click", () => setZoom(state.zoom - ZOOM_STEP));
  $("#zoomVal").addEventListener("click", () => setZoom(1.0));
}

// ═══════════════════════════════════════════════════════
// SIDEBAR TOGGLE
// ═══════════════════════════════════════════════════════
function applySidebar() {
  document.body.classList.toggle("is-sidebar-collapsed", !!state.sidebarCollapsed);
}
function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  applySidebar();
  dirty();
  // サイドバー幅が変わると利用可能領域が変わるので、CSSトランジション後にタイリング
  setTimeout(tileWindows, 260);
}
function wireSidebarToggle() {
  $("#sidebarToggle").addEventListener("click", toggleSidebar);
}

// ───────────────────────────────────────────────────────
// SIDEBAR 幅リサイズ (CONNECTIONS パネル領域)
// アイコンレールは固定。 --side-panel-w を動かしてパネル幅だけ可変にする。
// (定数 SIDE_PANEL_W_* はファイル上部の定数群で定義 — init() より前に初期化が必要)
// ───────────────────────────────────────────────────────
function normalizeSidePanelW(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return SIDE_PANEL_W_DEF;
  return Math.max(SIDE_PANEL_W_MIN, Math.min(SIDE_PANEL_W_MAX, Math.round(n)));
}
function applySidePanelW() {
  document.documentElement.style.setProperty("--side-panel-w", state.sidePanelW + "px");
}
function wireSideResize() {
  const handle = $("#sideResize");
  if (!handle) return;
  const begin = (clientX) => {
    const startX = clientX;
    const startW = state.sidePanelW;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.body.classList.add("is-resizing-side");
    const onMove = (ev) => {
      const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
      state.sidePanelW = Math.max(SIDE_PANEL_W_MIN, Math.min(SIDE_PANEL_W_MAX, startW + (x - startX)));
      applySidePanelW();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.body.classList.remove("is-resizing-side");
      dirty();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onUp);
  };
  handle.addEventListener("mousedown", (e) => { e.preventDefault(); begin(e.clientX); });
  handle.addEventListener("touchstart", (e) => { begin(e.touches[0].clientX); }, { passive: true });
  // ダブルクリックで既定幅にリセット
  handle.addEventListener("dblclick", () => {
    state.sidePanelW = SIDE_PANEL_W_DEF;
    applySidePanelW();
    dirty();
  });
}

// ═══════════════════════════════════════════════════════
// SIDEBAR ACTIVITY BAR (rail + panel)
// ═══════════════════════════════════════════════════════
function selectSideCat(cat) {
  state.activeSideCat = cat;
  $$("#sideRail .rail-ico").forEach(b => {
    const on = b.dataset.cat === cat;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  $$(".side-panel .side-cat").forEach(p => {
    p.hidden = p.dataset.cat !== cat;
  });
  dirty();
}
function wireSideRail() {
  $$("#sideRail .rail-ico").forEach(b => {
    b.addEventListener("click", () => selectSideCat(b.dataset.cat));
  });
  selectSideCat(state.activeSideCat || "connections");
}

// ═══════════════════════════════════════════════════════
// THEME (light / dark)
// ═══════════════════════════════════════════════════════
function applyTheme() {
  const dark = state.theme === "dark";
  document.body.classList.toggle("is-dark", dark);
  const lbl = document.querySelector("#themeToggle .theme-label");
  if (lbl) lbl.textContent = dark ? "light" : "dark";
}
function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
  dirty();
}
function wireTheme() {
  const btn = $("#themeToggle");
  if (!btn) return;
  btn.addEventListener("click", toggleTheme);
}

// ウインドウ以外 (ワークスペース余白) を click したら focus を解除する。
// mousedown だと自分自身の resize/drag や empty-state ボタンと競合するので click を使う。
function wireWorkspaceBlur() {
  const layer = $("#windowsLayer");
  if (!layer) return;
  layer.addEventListener("mousedown", (e) => {
    // ウインドウ内でのクリックは AgentWindow の focus() で吸収されるので、
    // 「layer 自身か ws-layer 自身が target のときだけ blur」
    if (e.target === layer || e.target.classList?.contains("ws-layer")) {
      document.querySelectorAll(".agent-window.is-focused")
        .forEach(n => n.classList.remove("is-focused"));
      // script editor が開いていたらキャンバスクリックでクローズ
      if (state.scriptPanelOpen) closeScriptPanel();
    }
  });

  // Scenario editor が開いている間は、 editor 外のどこをクリックしても閉じる。
  // (chat window 内、 ヘッダ、 タイル余白など — editor を「ガラス面」のように扱う)
  // 例外:
  //   - editor 自体 (#scriptPanel) と そこからスポーンされるオーバーレイ (.modal-backdrop)
  //   - sidebar のシナリオ操作 (script-list の項目クリックは select / open のため)
  document.addEventListener("mousedown", (e) => {
    if (!state.scriptPanelOpen) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("#scriptPanel"))    return;   // editor 内クリック
    if (t.closest(".modal-backdrop"))  return;  // confirm/alert/prompt が出ているとき
    if (t.closest("#scriptList"))      return;  // sidebar の script リスト
    if (t.closest("#scriptAdd"))       return;  // sidebar の "+" 新規シナリオボタン
    if (t.closest("#scriptCtxMenu"))   return;  // editor から spawn された右クリックメニュー
    closeScriptPanel();
  }, true);
}

// ═══════════════════════════════════════════════════════
// RESTORE
// ═══════════════════════════════════════════════════════
function restoreFromSaved(saved) {
  // それぞれのワークスペースとウインドウを再構築。connect() を再走させて adapter も復活させる
  saved.workspaces.forEach(wsData => {
    const ws = createWorkspace(wsData.name || "default", { focus: true, silent: true });
    (wsData.windows || []).forEach(winData => {
      // sessionStorage 側に残っている auth を引き戻す (タブ閉で消える)
      const hydrated = persist.hydrateWindowSecrets(winData);
      connect({
        protoId: hydrated.protoId,
        url:     hydrated.config?.url,
        name:    hydrated.config?.name,
        auth:    hydrated.config?.auth,
        authRef: hydrated.config?.authRef,
        persona: hydrated.config?.persona,
        channel: hydrated.config?.channel
      }, { restore: { pos: hydrated.pos, activeTab: hydrated.activeTab }, skipDirty: true });
    });
  });
  // アクティブWSを最後にスイッチ
  const idx = Math.min(Math.max(saved.activeWsIdx ?? 0, 0), state.workspaces.length - 1);
  if (state.workspaces[idx]) switchWorkspace(state.workspaces[idx].id);
}

// ═══════════════════════════════════════════════════════
// WORKSPACES
// ═══════════════════════════════════════════════════════
function activeWorkspace() { return state.workspaces.find(w => w.id === state.activeWs); }

function createWorkspace(name, opts = {}) {
  const id = `ws-${++wsCounter}`;
  const layer = document.createElement("div");
  layer.className = "ws-layer";
  layer.dataset.wsId = id;
  $("#windowsLayer").appendChild(layer);

  const ws = { id, name: name || `workspace ${wsCounter}`, windows: [], events: 0, layer };
  state.workspaces.push(ws);

  if (opts.focus !== false) switchWorkspace(id);
  if (!opts.silent) { renderTabs(); updateStatusLine(); updateEmptyState(); }
  dirty();
  return ws;
}

function switchWorkspace(id) {
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  state.activeWs = id;
  $$(".ws-layer").forEach(l => l.classList.toggle("is-active", l.dataset.wsId === id));
  renderTabs();
  renderBookmarks();   // CONNECTIONS の active workspace ハイライト更新
  updateStatusLine();
  updateEmptyState();
  dirty();
}

async function removeWorkspace(id) {
  const idx = state.workspaces.findIndex(w => w.id === id);
  if (idx < 0) return;
  const ws = state.workspaces[idx];
  if (ws.windows.length > 0) {
    const ok = await modalConfirm({
      title:        `Close "${ws.name}"? (${ws.windows.length} connections will be disconnected)`,
      confirmLabel: "Close workspace",
      danger:       true
    });
    if (!ok) return;
    [...ws.windows].forEach(w => w.close());
  }
  ws.layer.remove();
  state.workspaces.splice(idx, 1);

  // 最低1つは残す
  if (state.workspaces.length === 0) {
    createWorkspace("default", { focus: true });
  } else if (state.activeWs === id) {
    const next = state.workspaces[Math.min(idx, state.workspaces.length - 1)];
    switchWorkspace(next.id);
  }
  renderTabs();
  updateStatusLine();
  dirty();
}

function renameWorkspace(id, newName) {
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  ws.name = newName.trim() || ws.name;
  renderTabs();
  dirty();
}

function renderTabs() {
  const root = $("#wsTabsScroll");
  root.innerHTML = "";
  state.workspaces.forEach(ws => {
    const tab = document.createElement("button");
    tab.className = "ws-tab";
    if (ws.id === state.activeWs) tab.classList.add("is-active");
    if (ws.windows.length > 0)    tab.classList.add("has-windows");
    tab.dataset.wsId = ws.id;
    tab.title = "Double-click to rename";
    tab.innerHTML = `
      <span class="ws-tab-dot"></span>
      <span class="ws-tab-name">${escapeHtml(ws.name)}</span>
      <span class="ws-tab-count">${ws.windows.length}</span>
      <span class="ws-tab-close" title="Close workspace" aria-label="close">
        <svg viewBox="0 0 14 14" width="9" height="9"><line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.4"/><line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.4"/></svg>
      </span>
    `;
    tab.addEventListener("click", (e) => {
      if (e.target.closest(".ws-tab-close")) {
        e.stopPropagation();
        removeWorkspace(ws.id);
        return;
      }
      // 既に active な tab を click した場合は switchWorkspace を呼ばない。
      // 呼ぶと renderTabs() が走って tab DOM が再生成され、 続く dblclick が
      // 発火しなくなるため (dblclick は同一 DOM への 2 連 click を要求)。
      if (ws.id !== state.activeWs) switchWorkspace(ws.id);
    });
    tab.addEventListener("dblclick", (e) => {
      if (e.target.closest(".ws-tab-close")) return;
      const nameEl = tab.querySelector(".ws-tab-name");
      nameEl.contentEditable = "true";
      nameEl.focus();
      const range = document.createRange();
      range.selectNodeContents(nameEl);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);

      const commit = () => {
        nameEl.contentEditable = "false";
        const v = nameEl.textContent.trim();
        if (v && v !== ws.name) renameWorkspace(ws.id, v);
        else nameEl.textContent = ws.name;
        nameEl.removeEventListener("blur", commit);
        nameEl.removeEventListener("keydown", onKey);
      };
      const onKey = (ke) => {
        if (ke.key === "Enter") { ke.preventDefault(); commit(); }
        if (ke.key === "Escape") { nameEl.textContent = ws.name; commit(); }
      };
      nameEl.addEventListener("blur", commit);
      nameEl.addEventListener("keydown", onKey);
    });
    root.appendChild(tab);
  });
}

function wireWsTabs() {
  $("#wsAdd").addEventListener("click", () => createWorkspace(`workspace ${wsCounter + 1}`));
}

// 「コネクション登録」エントリの追加 / 上書き。 ウインドウの open/close と独立。
function upsertBookmark({ protoId, url, name, auth, authRef, persona, channel }) {
  if (!protoId || !url) return;
  const key = bookmarkKey(protoId, url);
  state.bookmarks = state.bookmarks || [];
  const idx = state.bookmarks.findIndex(b => b.key === key);
  const entry = { key, protoId, url, name, auth, authRef, persona, channel };
  if (idx >= 0) {
    // 既存はユーザーが付けた display name 等を尊重しつつ最新値で更新
    const prev = state.bookmarks[idx];
    state.bookmarks[idx] = { ...prev, ...entry, name: name || prev.name };
  } else {
    state.bookmarks.push(entry);
  }
  dirty();
}

function removeBookmark(key) {
  state.bookmarks = (state.bookmarks || []).filter(b => b.key !== key);
  dirty();
}

// CONNECTIONS リストの並び替え。 fromKey の bookmark を targetKey の前/後に挿入する。
function reorderBookmark(fromKey, targetKey, where /* "before" | "after" */) {
  const arr = state.bookmarks || [];
  const fromIdx = arr.findIndex(b => b.key === fromKey);
  if (fromIdx < 0) return;
  const [moved] = arr.splice(fromIdx, 1);
  let targetIdx = arr.findIndex(b => b.key === targetKey);
  if (targetIdx < 0) {
    arr.push(moved);
  } else {
    arr.splice(where === "before" ? targetIdx : targetIdx + 1, 0, moved);
  }
  state.bookmarks = arr;
  dirty();
  renderBookmarks();
}

// CONNECTIONS = 登録済みコネクション (= bookmarks) を主軸に描画。
// その下に「現在開いているウインドウ」を子要素として並べる。 ウインドウが 0 でも親は残る。
function renderBookmarks() {
  const root  = $("#savedAgents");
  const empty = $("#bookmarksEmpty");
  root.innerHTML = "";
  state._connExpanded = state._connExpanded || {};
  state.bookmarks = state.bookmarks || [];

  // 各 bookmark に対応する開いているウインドウを集計
  const winsByKey = new Map();
  state.workspaces.forEach(ws => {
    ws.windows.forEach(win => {
      const k = bookmarkKey(win.protoId, win.adapter.config.url);
      if (!winsByKey.has(k)) winsByKey.set(k, []);
      winsByKey.get(k).push({ win, ws });
    });
  });

  // 念のため: 開いているウインドウに bookmark が無い (旧データ等) なら登録扱い
  winsByKey.forEach((arr, k) => {
    if (!state.bookmarks.find(b => b.key === k)) {
      const { win } = arr[0];
      const cfg = win.adapter.config || {};
      state.bookmarks.push({
        key: k, protoId: win.protoId, url: cfg.url,
        name: cfg.name || win.name,
        auth: cfg.auth, persona: cfg.persona, channel: cfg.channel
      });
    }
  });

  state.bookmarks.forEach(b => {
    const wins = winsByKey.get(b.key) || [];
    const hasMulti = wins.length > 1;
    if (state._connExpanded[b.key] === undefined) state._connExpanded[b.key] = false;
    const expanded = !!state._connExpanded[b.key];

    // ウインドウから取れる最新 display name を優先 (settings での編集を反映)
    const displayName = wins[0]?.win.name || b.name || hostFromUrl(b.url) || b.url;
    const host = hostFromUrl(b.url) || b.url || "";

    const li = document.createElement("li");
    const canExpand = wins.length > 0;
    li.className = "agent-item conn-group"
      + (canExpand ? " is-expandable" : "")
      + (expanded && canExpand ? " is-expanded" : "")
      + (wins.length === 0 ? " is-disconnected" : "");
    li.title = wins.length
      ? `${host}  ·  ${wins.length} window(s)`
      : `${host}  ·  no open window — click + to open`;
    li.draggable = true;
    li.dataset.bookmarkKey = b.key;

    // ── DnD で並び替え ──
    li.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/atelier-bookmark", b.key);
      li.classList.add("is-dragging");
    });
    li.addEventListener("dragend", () => li.classList.remove("is-dragging"));
    li.addEventListener("dragover", (e) => {
      const k = e.dataTransfer.getData("text/atelier-bookmark") ||
                document.querySelector(".agent-item.is-dragging")?.dataset.bookmarkKey;
      if (!k || k === b.key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // hover している側 (上半分 / 下半分) で drop indicator を切替
      const rect = li.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      li.classList.toggle("drop-before", before);
      li.classList.toggle("drop-after",  !before);
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-before", "drop-after");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromKey = e.dataTransfer.getData("text/atelier-bookmark") ||
                      document.querySelector(".agent-item.is-dragging")?.dataset.bookmarkKey;
      const before = li.classList.contains("drop-before");
      li.classList.remove("drop-before", "drop-after");
      if (!fromKey || fromKey === b.key) return;
      reorderBookmark(fromKey, b.key, before ? "before" : "after");
    });
    const protoLabel = (getProtocol(b.protoId)?.label) || b.protoId.toUpperCase();
    li.innerHTML = `
      <button class="conn-toggle" aria-label="${expanded ? 'collapse' : 'expand'} window list" title="${canExpand ? (expanded ? 'collapse' : 'expand') : 'no open windows'}" ${canExpand ? '' : 'disabled'}>
        <svg viewBox="0 0 12 12" width="9" height="9"><polyline points="3,4.5 6,8 9,4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="conn-proto-badge" data-proto="${escapeHtml(b.protoId)}" title="${escapeHtml(protoLabel)} connection">${escapeHtml(protoLabel)}</span>
      <span class="agent-name">${escapeHtml(displayName)}</span>
      <span class="bm-count" title="${wins.length} window(s)">${wins.length}</span>
      <button class="bookmark-new" title="${wins.length ? 'Open another window to the same agent' : 'Open a window'}" aria-label="new window">
        <svg viewBox="0 0 14 14" width="10" height="10"><line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      ${KEBAB_BTN_HTML}
    `;
    const doDelete = async () => {
      if (wins.length > 0) {
        const ok = await modalConfirm({
          title: `Delete "${displayName}"?`,
          message: `${wins.length} open window(s) will be disconnected and the connection will be removed from the sidebar.`,
          confirmLabel: "Delete",
          danger: true
        });
        if (!ok) return;
        wins.forEach(({ win }) => win.close());
      }
      removeBookmark(b.key);
      renderBookmarks();
    };
    li.addEventListener("click", async (e) => {
      if (e.target.closest(".row-kebab")) {
        e.stopPropagation();
        openRowMenu(e.target.closest(".row-kebab"), [
          { label: "Edit",        onClick: () => openDialog({ editBookmark: b }) },
          { label: "New window",  onClick: () => connect({ protoId: b.protoId, url: b.url, name: displayName, auth: b.auth, authRef: b.authRef, persona: b.persona, channel: b.channel }, { lockName: true }) },
          { label: "Delete", danger: true, onClick: doDelete }
        ]);
        return;
      }
      if (e.target.closest(".bookmark-new")) {
        e.stopPropagation();
        connect({
          protoId: b.protoId,
          url:     b.url,
          name:    displayName,
          auth:    b.auth,
          authRef: b.authRef,
          persona: b.persona,
          channel: b.channel
        }, { lockName: true });
        return;
      }
      // 行全体のクリック (`>` chevron / 名前 / count / 余白) は単一の動作にまとめる:
      //   wins=0 → connect、wins=1 → focus、wins>1 → アコーディオン toggle
      if (wins.length === 0) {
        connect({
          protoId: b.protoId, url: b.url, name: displayName,
          auth: b.auth, authRef: b.authRef, persona: b.persona, channel: b.channel
        }, { lockName: true });
        return;
      }
      if (wins.length === 1) {
        const { win, ws } = wins[0];
        if (ws.id !== state.activeWs) { switchWorkspace(ws.id); setTimeout(() => win.focus(), 50); }
        else win.focus();
        // 1 つだけの時もアコーディオンを toggle (focus と両立)
      }
      const cur  = state._connExpanded[b.key] !== false;
      const next = !cur;
      state._connExpanded[b.key] = next;
      animateConnExpand(b.key, next);
    });
    root.appendChild(li);

    if (wins.length > 0) {
      const sub = document.createElement("li");
      sub.className = "bookmark-children" + (expanded ? "" : " is-collapsed");
      sub.dataset.connKey = b.key;
      const inner = document.createElement("div");
      inner.className = "bm-children-inner";
      sub.appendChild(inner);
      wins.forEach(({ win, ws }, i) => {
        const isLast = i === wins.length - 1;
        const isActiveWs = ws.id === state.activeWs;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bookmark-child" + (isActiveWs ? "" : " is-other-ws");
        btn.title = `${ws.name}  ·  ${win.adapter.config.url || ""}`;
        btn.innerHTML = `
          <span class="bc-branch">${isLast ? "└─" : "├─"}</span>
          <span class="bc-id">${win.id}</span>
          <span class="bc-name">${escapeHtml(windowDisplayName(win))}</span>
          <button class="bc-remove" title="Disconnect this window" aria-label="disconnect">
            <svg viewBox="0 0 12 12" width="8" height="8"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.4"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" stroke-width="1.4"/></svg>
          </button>
        `;
        btn.addEventListener("click", (e) => {
          if (e.target.closest(".bc-remove")) {
            e.stopPropagation();
            win.close();
            return;
          }
          if (!isActiveWs) {
            switchWorkspace(ws.id);
            setTimeout(() => win.focus(), 50);
          } else {
            win.focus();
          }
        });
        inner.appendChild(btn);
      });
      root.appendChild(sub);
    }
  });

  const total = state.bookmarks.length;
  $("#savedCount").textContent = String(total);
  empty.classList.toggle("is-hidden", total > 0);

  // Expand/collapse-all toggle button — show only when at least one connection has open windows
  const toggleAllBtn = $("#connToggleAll");
  if (toggleAllBtn) {
    const expandable = state.bookmarks.filter(b => (winsByKey.get(b.key) || []).length > 0);
    if (expandable.length === 0) {
      toggleAllBtn.hidden = true;
    } else {
      toggleAllBtn.hidden = false;
      const allExpanded = expandable.every(b => state._connExpanded[b.key] !== false);
      toggleAllBtn.classList.toggle("is-all-expanded", allExpanded);
      toggleAllBtn.title = allExpanded ? "Collapse all" : "Expand all";
    }
  }
}

function wireConnToggleAll() {
  const btn = $("#connToggleAll");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    state._connExpanded = state._connExpanded || {};
    // 開いているウインドウがある connection だけ対象
    const openWinKeys = new Set();
    state.workspaces.forEach(ws => ws.windows.forEach(win => {
      openWinKeys.add(bookmarkKey(win.protoId, win.adapter.config.url));
    }));
    const targets = state.bookmarks.filter(b => openWinKeys.has(b.key));
    if (targets.length === 0) return;
    const allExpanded = targets.every(b => state._connExpanded[b.key] !== false);
    const next = !allExpanded;
    targets.forEach(b => {
      state._connExpanded[b.key] = next;
      animateConnExpand(b.key, next);
    });
    btn.classList.toggle("is-all-expanded", next);
    btn.title = next ? "Collapse all" : "Expand all";
  });
}

// connection の sub-list を class トグルで開閉アニメーション
function animateConnExpand(connKey, expanded) {
  const sub = document.querySelector(`.bookmark-children[data-conn-key="${CSS.escape(connKey)}"]`);
  if (sub) sub.classList.toggle("is-collapsed", !expanded);
  // 親 .agent-item の chevron 回転 / bm-count ハイライト用クラスも更新
  const items = document.querySelectorAll("#savedAgents .agent-item.conn-group");
  items.forEach(it => {
    const sib = it.nextElementSibling;
    if (sib && sib.classList.contains("bookmark-children") && sib.dataset.connKey === connKey) {
      it.classList.toggle("is-expanded", expanded);
    }
  });
}

// ═══════════════════════════════════════════════════════
// CATALOG OAuth + Exchange assets
// ═══════════════════════════════════════════════════════
async function authenticateCatalog(cat) {
  // identity 一本化: catalog は authRef で AUTHENTICATION の identity を参照する。
  // identity 側で token を取り (CC/authcode 共通)、 cat.accessToken にミラーして
  // 既存の Exchange fetch (Bearer ${cat.accessToken}) をそのまま動かす。
  if (cat.authRef) {
    const idn = identityById(cat.authRef);
    if (!idn) {
      cat.status = "error";
      cat.lastError = "linked identity not found (re-select an identity)";
      return;
    }
    const tok = await ensureIdentityToken(idn);
    if (!tok) {
      cat.status = "error";
      cat.lastError = "identity token fetch failed";
      return;
    }
    cat.accessToken    = idn.accessToken;
    cat.tokenExpiresAt = idn.tokenExpiresAt;
    cat.status    = "connected";
    cat.lastError = null;
    return;
  }
  if (cat.flow === "authcode") {
    try {
      const data = await runAuthCodeFlow(cat);
      cat.accessToken    = data.access_token;
      cat.tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
      if (data.refresh_token) cat.refreshToken = data.refresh_token;
      cat.status    = "connected";
      cat.lastError = null;
    } catch (e) {
      cat.status    = "error";
      cat.lastError = e.message;
    }
    return;
  }
  // Client Credentials
  const params = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     cat.clientId,
    client_secret: cat.clientSecret || ""
  });
  if (cat.scopes) params.set("scope", cat.scopes);

  let res, data;
  try {
    res = await fetch(`/proxy?url=${encodeURIComponent(cat.tokenUrl)}`, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    params.toString()
    });
    data = await res.json();
  } catch (e) {
    cat.status    = "error";
    cat.lastError = `network error: ${e.message}`;
    return;
  }
  if (!res.ok || data.error) {
    cat.status    = "error";
    cat.lastError = data.error_description || data.error || `HTTP ${res.status}`;
    return;
  }
  cat.accessToken    = data.access_token;
  cat.tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
  cat.status         = "connected";
  cat.lastError      = null;
}

// ═══════════════════════════════════════════════════════
// IDENTITY ↔ CONNECTION (authRef 解決 / 自動マイグレーション)
// ═══════════════════════════════════════════════════════

// 旧 auth (bookmark.auth 文字列 / catalog OAuth) を identities[] に移行する。
// init で 1 回。authRef が既にあるものは skip するので冪等。
function migrateAuthToIdentities() {
  state.identities = state.identities || [];
  const byBearerToken = new Map();   // token -> id
  const byCcKey       = new Map();   // `${tokenUrl}::${clientId}` -> id
  for (const idn of state.identities) {
    if (idn.kind === "bearer" && idn.token) byBearerToken.set(idn.token, idn.id);
    if (idn.kind === "oauth2_cc") byCcKey.set(`${idn.tokenUrl}::${idn.clientId}`, idn.id);
  }

  // 1) bookmark.auth (bearer 文字列) → bearer identity
  for (const b of (state.bookmarks || [])) {
    if (b.authRef || !b.auth) continue;
    let id = byBearerToken.get(b.auth);
    if (!id) {
      id = `idn-${++idnCounter}`;
      let label; try { label = `${new URL(b.url).host} · token`; } catch { label = (b.name || "token"); }
      state.identities.push({
        id, name: label, kind: "bearer", scheme: "Bearer", headerName: "Authorization",
        token: b.auth, createdAt: Date.now(), updatedAt: Date.now()
      });
      byBearerToken.set(b.auth, id);
    }
    b.authRef = id;
    // b.auth は後方互換のため残す (resolve は authRef 優先)
  }

  // 2) catalog OAuth → oauth2_cc / oauth2_authcode identity (catalog は複製のみ、破壊しない)
  for (const c of (state.catalogs || [])) {
    if (c.authRef || !c.clientId) continue;
    const key = `${c.tokenUrl}::${c.clientId}`;
    let id = (c.flow === "cc") ? byCcKey.get(key) : null;
    if (!id) {
      id = `idn-${++idnCounter}`;
      const base = {
        id, name: `${c.name} (OAuth)`, clientId: c.clientId, clientSecret: c.clientSecret,
        scopes: c.scopes, tokenUrl: c.tokenUrl,
        accessToken: c.accessToken, tokenExpiresAt: c.tokenExpiresAt,
        createdAt: Date.now(), updatedAt: Date.now()
      };
      if (c.flow === "authcode") {
        state.identities.push({ ...base, kind: "oauth2_authcode", authUrl: c.authUrl,
          refreshToken: c.refreshToken, redirectUri: redirectUri() });
      } else {
        state.identities.push({ ...base, kind: "oauth2_cc" });
        byCcKey.set(key, id);
      }
    }
    c.authRef = id;
  }
}

function identityById(id) { return (state.identities || []).find(i => i.id === id); }

// identity の token を (必要なら取得して) 返す。oauth/jwt は期限切れなら再取得。
async function ensureIdentityToken(idn) {
  if (idn.accessToken && Date.now() < (idn.tokenExpiresAt || 0)) return idn.accessToken;
  try {
    if (idn.kind === "oauth2_cc")        await fetchCcTokenForIdentity(idn);
    else if (idn.kind === "jwt_bearer")  await fetchJwtBearerToken(idn);
    else if (idn.kind === "oauth2_authcode") {
      const data = await runAuthCodeFlow(idn);
      idn.accessToken    = data.access_token;
      idn.tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
      if (data.refresh_token) idn.refreshToken = data.refresh_token;
    }
  } catch (e) {
    console.warn("[identity] token fetch failed:", idn.id, e?.message || e);
    return null;
  }
  dirty();
  return idn.accessToken || null;
}

async function fetchCcTokenForIdentity(idn) {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: idn.clientId, client_secret: idn.clientSecret || ""
  });
  if (idn.scopes) params.set("scope", idn.scopes);
  const res  = await fetch(`/proxy?url=${encodeURIComponent(idn.tokenUrl)}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString()
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
  idn.accessToken    = data.access_token;
  idn.tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
}

async function fetchJwtBearerToken(idn) {
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion:  idn.assertion || ""
  });
  if (idn.scopes) params.set("scope", idn.scopes);
  const res  = await fetch(`/proxy?url=${encodeURIComponent(idn.tokenUrl)}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString()
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
  idn.accessToken    = data.access_token;
  idn.tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
}

// connection ({authRef, auth}) → adapter に渡す { auth, authHeaders }。
// authRef 優先、無ければ旧 auth 文字列 (後方互換)。
async function resolveAuthForConnection(conn) {
  if (!conn.authRef) {
    return conn.auth ? { auth: conn.auth } : {};
  }
  const idn = identityById(conn.authRef);
  if (!idn) return {};
  if (idn.kind === "bearer") {
    const headerName = idn.headerName || "Authorization";
    if (headerName.toLowerCase() === "authorization" && (idn.scheme === "Bearer" || !idn.scheme)) {
      return { auth: idn.token };   // 既存 adapter の Bearer 経路をそのまま使う
    }
    const val = idn.scheme === "raw" ? idn.token : `${idn.scheme || "Bearer"} ${idn.token}`;
    return { authHeaders: { [headerName]: val } };
  }
  // oauth2_cc / oauth2_authcode / jwt_bearer → bearer token を取得
  const tok = await ensureIdentityToken(idn);
  return tok ? { auth: tok } : {};
}

async function fetchBgAssets(cat, bg) {
  if (!cat.accessToken || Date.now() > cat.tokenExpiresAt) {
    await authenticateCatalog(cat);
  }
  if (cat.status !== "connected") {
    throw new Error(cat.lastError || "not connected");
  }

  // BG が未解決なら ID 解決
  if (!bg.bgId) {
    try {
      await resolveBusinessGroupId(cat, bg);
    } catch (e) {
      throw new Error(`Business group resolution failed: ${e.message}`);
    }
  }

  const PAGE = 50;
  const HARD_CAP = 500;
  const assets = [];
  let offset = 0;
  const orgFilter = bg.bgId ? `&organizationId=${encodeURIComponent(bg.bgId)}` : "";
  while (offset < HARD_CAP) {
    const url = `https://anypoint.mulesoft.com/exchange/api/v2/assets?types=agent&limit=${PAGE}&offset=${offset}${orgFilter}`;
    const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${cat.accessToken}` }
    });
    if (!res.ok) throw new Error(`Exchange HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    assets.push(...page);
    if (page.length < PAGE) break;     // 最終ページ
    offset += PAGE;
  }

  // 各アセットの a2a-card.json + asset 詳細 (managed instances) を並列取得
  await Promise.allSettled(assets.map(async (a) => {
    // 1) a2a-card.json (instance URL がテンプレでなければそのまま採用)
    const card = findA2ACardFile(a);
    if (card) {
      try {
        const r = await fetch(`/proxy?url=${encodeURIComponent(card.downloadURL)}`, {
          headers: { Authorization: `Bearer ${cat.accessToken}` }
        });
        if (r.ok) {
          const c = await r.json();
          a._a2aCard = c;
          const u = c?.url;
          if (u && !/\$\{[^}]+\}/.test(u)) a._a2aUrl = u;
        }
      } catch {}
    }
    // 2) instance URL がまだ無い場合、 asset 詳細から managed instances を取得
    //    (Exchange UI の "Managed instances" 相当 = 実稼働 deployment の URL)
    if (!a._a2aUrl) {
      await fetchAssetInstances(cat, a);
    }
  }));

  return assets;
}

// Exchange の asset 詳細 → managed instances の URL を a に注入
async function fetchAssetInstances(cat, a) {
  const gid = a.groupId || a.organizationId || a.organization?.id;
  const aid = a.assetId;
  if (!gid || !aid) return;
  const v   = a.version ? `/${encodeURIComponent(a.version)}` : "";
  // 詳細エンドポイント候補 (Anypoint Exchange API の version 差を吸収)
  const candidates = [
    `https://anypoint.mulesoft.com/exchange/api/v2/assets/${gid}/${aid}${v}`,
    `https://anypoint.mulesoft.com/exchange/api/v2/assets/${gid}/${aid}`
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(`/proxy?url=${encodeURIComponent(url)}`, {
        headers: { Authorization: `Bearer ${cat.accessToken}` }
      });
      if (!r.ok) continue;
      const d = await r.json();
      // response の様々な location をチェック (Exchange UI は "Managed instances")
      const instances =
           d.instances
        || d.managedInstances
        || d.endpoints
        || d.version?.instances
        || d.versions?.[0]?.instances
        || [];
      if (instances.length) {
        a._instances = instances;
        // url または endpointUri 等のキー名のばらつきを吸収
        const first = instances.find(i => i?.url || i?.endpointUri || i?.endpoint);
        if (first) a._a2aUrl = first.url || first.endpointUri || first.endpoint;
        if (a._a2aUrl) return;
      }
      // 一部 deployment 系では asset.detail に直接 endpoint URL があることも
      if (d.endpointUri) { a._a2aUrl = d.endpointUri; return; }
    } catch {}
  }
}

function findA2ACardFile(asset) {
  return asset?.files?.find(f => f.classifier === "a2a-card" && f.packaging === "json");
}

// BG.input が UUID なら直接、 名前なら hierarchy から照合 → bg.bgId / bg.bgName を埋める
async function resolveBusinessGroupId(cat, bg) {
  const raw = (bg.input || "").trim();
  if (!raw) return;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    bg.bgId   = raw;
    bg.bgName = null;
    return;
  }
  const meUrl = "https://anypoint.mulesoft.com/accounts/api/me";
  const meRes = await fetch(`/proxy?url=${encodeURIComponent(meUrl)}`, {
    headers: { Authorization: `Bearer ${cat.accessToken}` }
  });
  if (!meRes.ok) throw new Error(`/me HTTP ${meRes.status}`);
  const me = await meRes.json();
  // password grant では me.user.organization、 client_credentials では me.client.org_id しか無い。
  // どちらも root org の id を取って hierarchy API に渡せばよい (name は要らない)。
  const rootOrgId =
       me.user?.organization?.id
    || me.organization?.id
    || me.user?.organizationId
    || me.client?.org_id;
  if (!rootOrgId) throw new Error("no organization id in /me (password / client_credentials のいずれも未検出)");

  const hUrl = `https://anypoint.mulesoft.com/accounts/api/organizations/${rootOrgId}/hierarchy`;
  const hRes = await fetch(`/proxy?url=${encodeURIComponent(hUrl)}`, {
    headers: { Authorization: `Bearer ${cat.accessToken}` }
  });
  let nodes = [{ id: rootOrgId, name: me.user?.organization?.name || me.organization?.name || "" }];
  if (hRes.ok) {
    const h = await hRes.json();
    nodes = flattenOrgTree(h);
  }
  const target = raw.toLowerCase();
  const hit = nodes.find(o => (o.name || "").toLowerCase() === target)
           || nodes.find(o => (o.name || "").toLowerCase().includes(target));
  if (!hit) throw new Error(`"${raw}" — no matching business group`);
  bg.bgId   = hit.id;
  bg.bgName = hit.name;
}

function flattenOrgTree(node, acc = []) {
  if (!node) return acc;
  acc.push({ id: node.id, name: node.name });
  (node.subOrganizations || node.subOrganization || node.children || []).forEach(s => flattenOrgTree(s, acc));
  return acc;
}

// ─── Drawer ────────────────────────────────────────────
function openBgDrawer(cat, bg) {
  // Script panel と排他
  if (state.scriptPanelOpen) {
    state.scriptPanelOpen = false;
    applyScriptPanel();
    dirty();
  }
  const drawer = $("#assetDrawer");
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  $("#drawerName").textContent = `${cat.name} · ${bg.bgName || bg.input}`;
  $("#drawerMeta").classList.remove("is-error");
  $("#drawerBody").innerHTML = "";
  $("#drawerFilter").value = "";
  $("#drawerFilterClear").hidden = true;
  state._drawerCatalogId = cat.id;
  state._drawerBgId      = bg.id;
  renderCatalogs();

  if (Array.isArray(bg.assets) && bg.assets.length > 0) {
    $("#drawerSpinner").hidden = true;
    renderCachedAssets(cat, bg);
    return;
  }
  loadDrawerAssets(cat, bg);
}
function closeCatalogDrawer() {
  $("#assetDrawer").classList.remove("is-open");
  $("#assetDrawer").setAttribute("aria-hidden", "true");
  state._drawerCatalogId = null;
  state._drawerBgId      = null;
  renderCatalogs();
}

function renderCachedAssets(cat, bg) {
  const withInst = bg.assets.filter(a => a._a2aUrl && !isInternalCh2Url(a._a2aUrl)).length;
  const ageSec = Math.round((Date.now() - (bg.assetsFetchedAt || Date.now())) / 1000);
  $("#drawerMeta").textContent =
    `${bg.assets.length} assets · ${withInst} connectable · cached ${formatAge(ageSec)} · BG: ${bg.bgName || bg.input}`;
  renderAssetList(bg.assets);
  applyDrawerFilter();
}

function formatAge(sec) {
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.round(sec/60)}m ago`;
  if (sec < 86400) return `${Math.round(sec/3600)}h ago`;
  return `${Math.round(sec/86400)}d ago`;
}

async function loadDrawerAssets(cat, bg) {
  const meta    = $("#drawerMeta");
  const body    = $("#drawerBody");
  const spinner = $("#drawerSpinner");
  spinner.hidden = false;
  body.innerHTML = "";
  meta.textContent = "fetching…";
  meta.classList.remove("is-error");
  try {
    const t0 = performance.now();
    const assets = await fetchBgAssets(cat, bg);
    const elapsed = Math.round(performance.now() - t0);
    if (state._drawerBgId !== bg.id) return;
    spinner.hidden = true;
    bg.assets = assets;
    bg.assetsFetchedAt = Date.now();
    const withInst = assets.filter(a => a._a2aUrl && !isInternalCh2Url(a._a2aUrl)).length;
    meta.textContent = `${assets.length} assets · ${withInst} connectable · ${elapsed}ms · BG: ${bg.bgName || bg.input}`;
    renderAssetList(assets);
    applyDrawerFilter();
    renderCatalogs();
    dirty();
  } catch (e) {
    spinner.hidden = true;
    meta.textContent = `error: ${e.message}`;
    meta.classList.add("is-error");
    body.innerHTML = `<div class="drawer-empty">Fetch failed</div>`;
    renderCatalogs();
  }
}

function applyDrawerFilter() {
  const q = ($("#drawerFilter").value || "").trim().toLowerCase();
  $("#drawerFilterClear").hidden = !q;
  const items = $("#drawerBody").querySelectorAll(".asset-item");
  let visible = 0;
  items.forEach(it => {
    const name = it.querySelector(".asset-name")?.textContent.toLowerCase() || "";
    const sub  = it.querySelector(".asset-sub")?.textContent.toLowerCase()  || "";
    const tags = it.querySelector(".asset-tags")?.textContent.toLowerCase() || "";
    const match = !q || name.includes(q) || sub.includes(q) || tags.includes(q);
    it.classList.toggle("is-filtered-out", !match);
    if (match) visible++;
  });
  // empty hit表示
  let empty = $("#drawerBody").querySelector(".drawer-empty-filter");
  if (q && visible === 0) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "drawer-empty drawer-empty-filter";
      empty.textContent = "No matching assets";
      $("#drawerBody").appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}
// CH2 internal DNS (`*.internal-<shard>.cloudhub.io`) は VPC 外から到達できない。
// Atelier (ブラウザ + dev-server) は外部側にいるので、 internal URL は connect 不可。
function isInternalCh2Url(u) {
  if (!u) return false;
  try { return /\.internal-[^/]+\.cloudhub\.io/i.test(new URL(u).host); }
  catch { return false; }
}

function renderAssetList(assets) {
  const body = $("#drawerBody");
  body.innerHTML = "";
  if (!assets?.length) {
    body.innerHTML = `<div class="drawer-empty">No A2A assets</div>`;
    return;
  }
  const cat = state.catalogs.find(c => c.id === state._drawerCatalogId);
  assets.forEach((a, i) => {
    const hasUrl       = !!a._a2aUrl;
    const isInternal   = hasUrl && isInternalCh2Url(a._a2aUrl);
    const hasInstance  = hasUrl && !isInternal;        // 外部到達可能 → connectable
    const hasCard      = !hasUrl && !!a._a2aCard;      // card だけ取れている
    const item = document.createElement("div");
    item.className = "asset-item"
      + (hasInstance ? " has-instance" : "")
      + (isInternal  ? " has-internal" : "")
      + (hasCard     ? " has-card"     : "");
    item.style.animationDelay = `${Math.min(i * 30, 800)}ms`;
    const niceName = (a.name || a.assetId || "").replace(/\s*\(.*?\)\s*$/, "");
    const detail   = (a.name || "").match(/\((.+)\)/)?.[1] || a.description || "";
    const showArrow = hasInstance || hasCard;
    item.innerHTML = `
      ${hasInstance ? `
      <button class="asset-quick-connect" title="Quick connect" aria-label="connect">
        <svg viewBox="0 0 16 16" width="10" height="10"><path d="M2 8 L12 8 M8 4 L12 8 L8 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>connect</span>
      </button>` : ""}
      <div class="asset-row-top">
        <span class="asset-status-dot"></span>
        <span class="asset-name">${escapeHtml(niceName)}</span>
      </div>
      ${detail ? `<span class="asset-sub">${escapeHtml(detail)}</span>` : ""}
      <span class="asset-tags">
        <span class="asset-tag">${escapeHtml(a.type || "?")}</span>
        ${a.version ? `<span class="asset-tag">v${escapeHtml(a.version)}</span>` : ""}
        ${a.assetId ? `<span class="asset-tag">${escapeHtml(a.assetId)}</span>` : ""}
        ${hasInstance ? `<span class="asset-tag is-accent">instance</span>` : ""}
        ${isInternal  ? `<span class="asset-tag is-muted" title="VPC-internal endpoint — Atelier からは接続できません">internal</span>` : ""}
        ${hasCard     ? `<span class="asset-tag">card only</span>`         : ""}
      </span>
      ${showArrow ? `<span class="asset-go" aria-hidden="true">→</span>` : ""}
    `;
    if (hasInstance) {
      item.title = a._a2aUrl;
      item.addEventListener("click", () => openAssetDetail(a, cat));
      item.querySelector(".asset-quick-connect").addEventListener("click", (ev) => {
        ev.stopPropagation();
        connectAsset(a, cat);
      });
    } else if (isInternal) {
      item.title = `Internal CH2 endpoint (${a._a2aUrl}) — VPC 外からは到達できません`;
      // クリックしても detail 開かない (URL を見ても connect できないので静かに)
    } else if (hasCard) {
      item.title = "Agent card available (instance URL unresolved) — detail viewable";
      item.addEventListener("click", () => openAssetDetail(a, cat));
    } else {
      item.title = "No agent card or instance URL";
    }
    body.appendChild(item);
  });
}

// アセットクリック: 詳細パネル(2段目)を開く
function openAssetDetail(asset, cat) {
  const card = asset._a2aCard || {};
  const resolvedUrl = asset._a2aUrl;
  // card.url がテンプレ ${...} の場合は raw 値も参照できるよう保持
  const rawCardUrl = card?.url || "";
  state._detailAsset = asset;
  state._detailCat   = cat;

  const drawer = $("#assetDetailDrawer");
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");

  $("#detailName").textContent = card.name || asset.name || asset.assetId;
  $("#detailBody").innerHTML = renderDetailBody(asset, card);

  // URL input: 既存 (overridden) > resolved > placeholder 表示用 raw
  const urlInput = $("#detailUrlInput");
  const btn = $("#detailConnect");
  const seed = asset._userUrl || resolvedUrl || "";
  urlInput.value = seed;
  if (rawCardUrl && rawCardUrl !== seed) {
    urlInput.placeholder = `card url: ${rawCardUrl}`;
  } else {
    urlInput.placeholder = "https://...example.com/agent  (override / fill if template)";
  }
  const refreshFoot = () => {
    const v = urlInput.value.trim();
    const valid = /^https?:\/\/.+/i.test(v);
    btn.disabled = !valid;
    $("#detailFootMeta").textContent = valid ? v : (v ? "invalid URL" : "no instance URL");
  };
  refreshFoot();
  urlInput.oninput = refreshFoot;

  // managed instances が複数あれば pill で選べる UI を入れる
  renderManagedInstancesPicker(asset, urlInput, refreshFoot);

  // skill 行の展開を toggle
  $("#detailBody").querySelectorAll(".skill-row.has-desc").forEach(row => {
    row.addEventListener("click", () => row.classList.toggle("is-expanded"));
  });
}

function closeAssetDetail() {
  const drawer = $("#assetDetailDrawer");
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  state._detailAsset = null;
  state._detailCat   = null;
}

function renderDetailBody(asset, card) {
  const url        = asset._a2aUrl || "";
  const desc       = card.description || asset.description || "";
  const version    = card.version || asset.version || "—";
  const provider   = card.provider?.organization || card.provider?.name || asset.organization?.name || "—";
  const caps       = card.capabilities || {};
  const inputs     = (card.defaultInputModes  || []).join(", ") || "—";
  const outputs    = (card.defaultOutputModes || []).join(", ") || "—";
  const skills     = card.skills || [];

  const sk = skills.map((s, i) => {
    const isLast = i === skills.length - 1;
    return `
      <div class="skill-row${s.description ? " has-desc" : ""}" data-idx="${i}">
        <span class="skill-branch">${isLast ? "└─" : "├─"}</span>
        <span class="chip-num">${String(i + 1).padStart(2, "0")}</span>
        <span class="chip-name">${escapeHtml(s.name || s.id)}</span>
        ${s.description ? `<span class="chip-arrow">▸</span>` : ""}
        ${s.description ? `<div class="chip-desc">${escapeHtml(s.description)}</div>` : ""}
      </div>`;
  }).join("");

  return `
    <div class="detail-hero">
      <h3 class="detail-hero-name">${escapeHtml(card.name || asset.name || asset.assetId)}</h3>
      ${desc ? `<p class="detail-hero-desc">${escapeHtml(desc)}</p>` : ""}
      ${url ? `<div class="detail-url">${escapeHtml(url)}</div>` : ""}
    </div>

    <div class="detail-grid">
      <div class="card-field"><span class="card-field-label">version</span><span class="card-field-value">${escapeHtml(version)}</span></div>
      <div class="card-field"><span class="card-field-label">provider</span><span class="card-field-value">${escapeHtml(provider)}</span></div>
      <div class="card-field"><span class="card-field-label">streaming</span><span class="card-field-value">${caps.streaming ? "yes" : "no"}</span></div>
      <div class="card-field"><span class="card-field-label">push</span><span class="card-field-value">${caps.pushNotifications ? "yes" : "no"}</span></div>
      <div class="card-field"><span class="card-field-label">input modes</span><span class="card-field-value">${escapeHtml(inputs)}</span></div>
      <div class="card-field"><span class="card-field-label">output modes</span><span class="card-field-value">${escapeHtml(outputs)}</span></div>
    </div>

    ${skills.length ? `<h4 class="detail-section-title">Skills · ${skills.length}</h4><div class="detail-skills">${sk}</div>` : ""}
  `;
}

function renderManagedInstancesPicker(asset, urlInput, refreshFoot) {
  // 既存 picker を撤去 (詳細を開き直す度に再描画)
  $("#assetDetailDrawer").querySelectorAll(".instance-picker").forEach(n => n.remove());

  const list = Array.isArray(asset._instances) ? asset._instances : [];
  if (list.length === 0) return;

  const root = document.createElement("div");
  root.className = "instance-picker";
  root.innerHTML = `<div class="ip-label">managed instances · ${list.length}</div>`;
  const wrap = document.createElement("div");
  wrap.className = "ip-chips";

  list.forEach((inst) => {
    const u = inst?.url || inst?.endpointUri || inst?.endpoint;
    if (!u) return;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ip-chip";
    if (urlInput.value === u) chip.classList.add("is-selected");
    const env  = inst.environment?.name || inst.environment || inst.environmentName || "";
    const org  = inst.organization?.name || inst.organization || "";
    const name = inst.name || inst.instanceName || u.split("/").slice(-2, -1)[0] || "instance";
    chip.title = u;
    chip.innerHTML = `
      <span class="ip-name">${escapeHtml(name)}</span>
      ${env ? `<span class="ip-env">${escapeHtml(env)}</span>` : ""}
      ${org && org !== env ? `<span class="ip-org">${escapeHtml(org)}</span>` : ""}
    `;
    chip.addEventListener("click", () => {
      urlInput.value = u;
      asset._userUrl = u;
      refreshFoot();
      // 選択 highlight 更新
      wrap.querySelectorAll(".ip-chip").forEach(c => c.classList.remove("is-selected"));
      chip.classList.add("is-selected");
    });
    wrap.appendChild(chip);
  });

  root.appendChild(wrap);
  // URL input 行の直前 (footer 内部) に挿入
  const foot = $("#assetDetailDrawer .detail-foot");
  const urlRow = foot.querySelector(".detail-url-row");
  foot.insertBefore(root, urlRow);
}

function connectAsset(asset, cat, overrideUrl) {
  if (!asset || !cat) return;
  const url = overrideUrl || asset._a2aUrl;
  if (!url) return;
  const cardUrl = /\.well-known\/agent-card\.json$/.test(url)
    ? url
    : `${url.replace(/\/+$/, "")}/.well-known/agent-card.json`;
  // 両drawerをClose
  closeAssetDetail();
  closeCatalogDrawer();
  connect({
    protoId: "a2a",
    url:     cardUrl,
    name:    asset._a2aCard?.name || asset.name || asset.assetId
  });
}

async function connectAssetInstance() {
  const asset = state._detailAsset;
  const cat   = state._detailCat;
  const override = $("#detailUrlInput")?.value.trim();
  if (asset && override) asset._userUrl = override;   // 入力を asset に保持
  connectAsset(asset, cat, override);
}

function wireDrawer() {
  $("#drawerBack").addEventListener("click", () => {
    closeAssetDetail();
    closeCatalogDrawer();
  });
  $("#detailBack").addEventListener("click", closeAssetDetail);
  $("#detailConnect").addEventListener("click", connectAssetInstance);
  $("#drawerRefresh").addEventListener("click", () => {
    const cat = state.catalogs.find(c => c.id === state._drawerCatalogId);
    if (!cat) return;
    const bg = cat.businessGroups?.find(b => b.id === state._drawerBgId);
    if (!bg) return;
    bg.assets = null;
    bg.assetsFetchedAt = null;
    loadDrawerAssets(cat, bg);
  });
  $("#drawerDelete").addEventListener("click", async () => {
    const cat = state.catalogs.find(c => c.id === state._drawerCatalogId);
    if (!cat) return;
    const bg = cat.businessGroups?.find(b => b.id === state._drawerBgId);
    if (!bg) return;
    const ok = await modalConfirm({
      title:        `Remove "${bg.bgName || bg.input}" from "${cat.name}"?`,
      confirmLabel: "Remove",
      danger:       true
    });
    if (!ok) return;
    cat.businessGroups = cat.businessGroups.filter(x => x.id !== bg.id);
    closeCatalogDrawer();
    renderCatalogs();
    dirty();
  });
  $("#drawerFilter").addEventListener("input", applyDrawerFilter);
  $("#drawerFilter").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if ($("#drawerFilter").value) {
        $("#drawerFilter").value = "";
        applyDrawerFilter();
      } else {
        closeCatalogDrawer();
      }
    }
  });
  $("#drawerFilterClear").addEventListener("click", () => {
    $("#drawerFilter").value = "";
    applyDrawerFilter();
    $("#drawerFilter").focus();
  });
}

// ═══════════════════════════════════════════════════════
// IDENTITY (Authentication profiles)
// ═══════════════════════════════════════════════════════
const IDENTITY_KINDS = [
  { id:"bearer",          label:"Bearer / API Key", sub:"static token",       icon:"●" },
  { id:"oauth2_cc",       label:"OAuth2 CC",        sub:"client credentials", icon:"⚙" },
  { id:"oauth2_authcode", label:"OAuth2 Code",      sub:"browser login",      icon:"↳" },
  { id:"jwt_bearer",      label:"JWT Bearer",       sub:"signed assertion",   icon:"⚷" },
];

// OAuth/JWT 用の endpoint プリセット。 id=custom は手入力 (url 欄編集可)。
// 増やすときはここに 1 行足すだけ。
const IDENTITY_PROVIDERS = [
  {
    id: "anypoint", label: "Anypoint Platform",
    authUrl:  "https://anypoint.mulesoft.com/accounts/api/v2/oauth2/authorize",
    tokenUrl: "https://anypoint.mulesoft.com/accounts/api/v2/oauth2/token",
    scopes:   "full"
  },
  { id: "custom", label: "Custom (manual)", authUrl: "", tokenUrl: "", scopes: "" }
];
function providerById(id) { return IDENTITY_PROVIDERS.find(p => p.id === id) || IDENTITY_PROVIDERS.find(p => p.id === "custom"); }

function kindBadge(kind) {
  const m = { bearer:"bearer", oauth2_cc:"cc", oauth2_authcode:"code", jwt_bearer:"jwt" };
  return m[kind] || kind;
}

function countAuthRefs(idnId) {
  return (state.bookmarks || []).filter(b => b.authRef === idnId).length;
}

function renderIdentities() {
  const root  = $("#identityList");
  const empty = $("#identitiesEmpty");
  if (!root) return;
  root.innerHTML = "";

  state.identities.forEach(idn => {
    const li = document.createElement("li");
    li.className = "catalog-item";
    li.dataset.idnId = idn.id;
    li.title = `${idn.name} · ${kindBadge(idn.kind)}`;
    li.innerHTML = `
      <span class="catalog-name">${escapeHtml(idn.name)}</span>
      <span class="catalog-meta">
        <span class="catalog-status-dot"></span>
        <span style="font-family:var(--f-mono);font-size:calc(9px * var(--fs,1));color:var(--ink-3);background:var(--paper);border:1px solid var(--line);padding:1px 5px;border-radius:3px;letter-spacing:0.04em;">${escapeHtml(kindBadge(idn.kind))}</span>
      </span>
      ${KEBAB_BTN_HTML}
    `;
    const doDelete = async () => {
      const refs = countAuthRefs(idn.id);
      if (refs > 0) {
        const ok = await modalConfirm({
          title: `Delete "${idn.name}"?`,
          message: `${refs} connection(s) are using this identity. They will lose authentication.`,
          confirmLabel: "Delete",
          danger: true
        });
        if (!ok) return;
      }
      state.identities = state.identities.filter(x => x.id !== idn.id);
      renderIdentities();
      dirty();
    };
    li.addEventListener("click", (e) => {
      if (e.target.closest(".row-kebab")) {
        e.stopPropagation();
        openRowMenu(e.target.closest(".row-kebab"), [
          { label: "Edit",   onClick: () => openIdentityDialog(idn) },
          { label: "Delete", danger: true, onClick: doDelete }
        ]);
        return;
      }
    });
    li.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      openIdentityDialog(idn);
    });
    root.appendChild(li);
  });

  empty.classList.toggle("is-hidden", state.identities.length > 0);
}

function renderIdentityKindSeg() {
  const root = $("#idnKindSeg");
  if (!root) return;
  root.innerHTML = "";
  IDENTITY_KINDS.forEach(k => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "seg-btn";
    btn.dataset.kind = k.id;
    if (k.id === state.selectedIdentityKind) btn.classList.add("is-active");
    btn.innerHTML = `
      <span class="seg-icon">${escapeHtml(k.icon)}</span>
      <span class="seg-body">
        <span class="seg-label">${escapeHtml(k.label)}</span>
        <span class="seg-sub">${escapeHtml(k.sub)}</span>
      </span>
    `;
    btn.addEventListener("click", () => {
      state.selectedIdentityKind = k.id;
      clearIdentityTest();
      refreshIdentityDialog();
    });
    root.appendChild(btn);
  });
}

function renderIdentityProviderSelect() {
  const sel = $("#idnProvider");
  if (!sel) return;
  const cur = state.selectedIdentityProvider || "custom";
  sel.innerHTML = "";
  IDENTITY_PROVIDERS.forEach(p => {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = p.label;
    sel.appendChild(o);
  });
  sel.value = cur;
}

// provider プリセットを url 欄に流し込み、custom 以外は readonly にする。
// clearOnCustom=true (ユーザーが手で Custom に切り替えた時) は前 provider の url を消す。
function applyProviderPreset(clearOnCustom) {
  const kind = state.selectedIdentityKind;
  const p = providerById(state.selectedIdentityProvider || "custom");
  const locked = p.id !== "custom";
  // kind ごとの token/auth url 入力欄
  const tokenInputs = {
    oauth2_cc: $("#idnTokenUrlCc"), oauth2_authcode: $("#idnTokenUrlCode"), jwt_bearer: $("#idnTokenUrlJwt")
  };
  const tIn = tokenInputs[kind];
  const aIn = (kind === "oauth2_authcode") ? $("#idnAuthUrl") : null;
  if (locked) {
    if (tIn) tIn.value = p.tokenUrl;
    if (aIn) aIn.value = p.authUrl;
    // scope はプリセットがあり、かつ空のときだけ補完 (既存値は尊重)
    const sc = $("#idnScopes");
    if (sc && p.scopes && !sc.value.trim()) sc.value = p.scopes;
  } else if (clearOnCustom) {
    // Custom に切り替え → 前 provider のプリセット値を消して手入力させる
    if (tIn) tIn.value = "";
    if (aIn) aIn.value = "";
  }
  [tIn, aIn].forEach(inp => {
    if (!inp) return;
    inp.readOnly = locked;
    inp.classList.toggle("is-readonly", locked);
  });
}

function refreshIdentityDialog() {
  renderIdentityKindSeg();
  const kind = state.selectedIdentityKind;

  // data-only フィールドを kind ごとに表示切替
  document.querySelectorAll("#identityDialog [data-only]").forEach(el => {
    el.style.display = (el.dataset.only === kind) ? "" : "none";
  });

  // provider セレクトは OAuth/JWT のときだけ表示 (bearer は不要)
  const provField = $("#idnProviderField");
  const showProvider = (kind === "oauth2_cc" || kind === "oauth2_authcode" || kind === "jwt_bearer");
  if (provField) provField.style.display = showProvider ? "" : "none";
  if (showProvider) { renderIdentityProviderSelect(); applyProviderPreset(); }

  // redirectUri を authcode 用フィールドにセット
  const redirectInput = $("#idnRedirect");
  if (redirectInput) redirectInput.value = redirectUri();
}

function detectProvider(editing) {
  if (!editing) return "anypoint";   // 新規は Anypoint を既定 (最頻ユースケース)
  if (editing.provider && providerById(editing.provider)) return editing.provider;
  const match = IDENTITY_PROVIDERS.find(p => p.id !== "custom" &&
    (p.tokenUrl === editing.tokenUrl) && (!editing.authUrl || p.authUrl === editing.authUrl));
  return match ? match.id : "custom";
}

function openIdentityDialog(editing) {
  $("#identityDialog").hidden = false;
  clearIdentityTest();
  state.selectedIdentityKind = editing?.kind || "bearer";
  state.selectedIdentityProvider = detectProvider(editing);
  state._editingIdentityId   = editing?.id   || null;

  $("#idnName").value = editing?.name || "";

  // bearer
  $("#idnToken").value     = editing?.token ? "•".repeat(12) : "";
  $("#idnScheme").value    = editing?.scheme || "Bearer";
  $("#idnHeaderName").value = editing?.headerName || "";

  // oauth2_cc
  $("#idnTokenUrlCc").value       = editing?.tokenUrl || "";
  $("#idnClientIdCc").value       = editing?.clientId || "";
  $("#idnClientSecretCc").value   = editing?.clientSecret ? "•".repeat(12) : "";

  // oauth2_authcode
  $("#idnAuthUrl").value          = editing?.authUrl || "";
  $("#idnTokenUrlCode").value     = editing?.tokenUrl || "";
  $("#idnClientIdCode").value     = editing?.clientId || "";
  $("#idnClientSecretCode").value = editing?.clientSecret ? "•".repeat(12) : "";

  // jwt_bearer
  $("#idnAssertion").value  = editing?.assertion ? "•".repeat(12) : "";
  $("#idnTokenUrlJwt").value = editing?.tokenUrl || "";

  // scopes (共通 advanced)
  $("#idnScopes").value = editing?.scopes || "";

  refreshIdentityDialog();
  setTimeout(() => $("#idnName").focus(), 50);
}

function closeIdentityDialog() {
  $("#identityDialog").hidden = true;
  state._editingIdentityId = null;
  clearIdentityTest();
}

function clearIdentityTest() {
  const row = $("#idnTestRow"), st = $("#idnTestStatus");
  if (row) row.hidden = true;
  if (st) { st.textContent = ""; st.className = "dialog-test-status"; }
}
function setIdentityTest(kind, html) {
  const row = $("#idnTestRow"), st = $("#idnTestStatus");
  if (!row || !st) return;
  row.hidden = false;
  st.className = `dialog-test-status is-${kind}`;
  st.innerHTML = html;
}

// 入力中の値で「一時 identity」を組み立てる (保存しない)。masked secret は編集中の既存値で補完。
function buildTempIdentityFromForm() {
  const kind = state.selectedIdentityKind;
  const scopes = $("#idnScopes").value.trim() || undefined;
  const isMask = (v) => v && /^•+$/.test(v);
  const existing = state._editingIdentityId ? identityById(state._editingIdentityId) : null;
  const idn = { id: "idn-test", name: "test", kind, scopes };
  if (kind === "oauth2_cc") {
    idn.clientId = $("#idnClientIdCc").value.trim();
    idn.tokenUrl = $("#idnTokenUrlCc").value.trim();
    const s = $("#idnClientSecretCc").value;
    idn.clientSecret = isMask(s) ? existing?.clientSecret : (s || undefined);
  } else if (kind === "oauth2_authcode") {
    idn.clientId = $("#idnClientIdCode").value.trim();
    idn.authUrl  = $("#idnAuthUrl").value.trim();
    idn.tokenUrl = $("#idnTokenUrlCode").value.trim();
    idn.redirectUri = redirectUri();
    const s = $("#idnClientSecretCode").value;
    idn.clientSecret = isMask(s) ? existing?.clientSecret : (s || undefined);
  } else if (kind === "jwt_bearer") {
    idn.tokenUrl = $("#idnTokenUrlJwt").value.trim();
    const a = $("#idnAssertion").value.trim();
    idn.assertion = isMask(a) ? existing?.assertion : a;
  }
  return idn;
}

async function testIdentityDialog() {
  const kind = state.selectedIdentityKind;
  if (kind === "bearer") {
    setIdentityTest("info", "Bearer / API Key は静的トークンのため取得テストは不要です。");
    return;
  }
  const idn = buildTempIdentityFromForm();
  // 必須チェック
  if (!idn.tokenUrl) { setIdentityTest("err", "token url を入力してください。"); return; }
  if (kind === "oauth2_cc" && !idn.clientId) { setIdentityTest("err", "client id を入力してください。"); return; }
  if (kind === "oauth2_authcode" && (!idn.clientId || !idn.authUrl)) { setIdentityTest("err", "client id と auth url を入力してください。"); return; }
  if (kind === "jwt_bearer" && !idn.assertion) { setIdentityTest("err", "assertion (署名済み JWT) を入力してください。"); return; }

  const btn = $("#idnTest");
  btn.disabled = true;
  setIdentityTest("info", "<span class='dts-dot'></span> Requesting token…");
  const t0 = performance.now();
  try {
    // 強制取得 (キャッシュ無視): tokenExpiresAt をクリアしてから ensureIdentityToken
    idn.accessToken = undefined; idn.tokenExpiresAt = 0;
    const tok = await ensureIdentityToken(idn);
    const ms = Math.round(performance.now() - t0);
    if (!tok) throw new Error("no access_token returned");
    const exp = idn.tokenExpiresAt ? Math.max(0, Math.round((idn.tokenExpiresAt - Date.now()) / 1000)) : null;
    const preview = `${String(tok).slice(0, 6)}…${String(tok).slice(-4)}`;
    setIdentityTest("ok",
      `<span class='dts-dot'></span> token OK · <code>${escapeHtml(preview)}</code>` +
      (exp != null ? ` · expires in ~${exp}s` : "") + ` · ${ms}ms`);
  } catch (e) {
    setIdentityTest("err", `<span class='dts-dot'></span> ${escapeHtml(e?.message || String(e))}`);
  } finally {
    btn.disabled = false;
  }
}

function submitIdentityDialog() {
  const name = $("#idnName").value.trim();
  const kind = state.selectedIdentityKind;
  const scopes = $("#idnScopes").value.trim();

  if (!name) { $("#idnName").focus(); return; }

  const editingId = state._editingIdentityId;
  const existing  = editingId ? state.identities.find(i => i.id === editingId) : null;

  // isMask helper
  const isMask = (val) => val && /^•+$/.test(val);

  let idn = existing || {};
  idn.id   = existing?.id || `idn-${++idnCounter}`;
  idn.name = name;
  idn.kind = kind;
  idn.createdAt = existing?.createdAt || Date.now();
  idn.updatedAt = Date.now();

  if (kind === "bearer") {
    const tokenInput = $("#idnToken").value;
    if (!tokenInput) { $("#idnToken").focus(); return; }
    idn.token = isMask(tokenInput) ? existing?.token : tokenInput;
    idn.scheme = $("#idnScheme").value || "Bearer";
    idn.headerName = $("#idnHeaderName").value.trim() || undefined;
  } else if (kind === "oauth2_cc") {
    const clientIdInput = $("#idnClientIdCc").value.trim();
    const tokenUrlInput = $("#idnTokenUrlCc").value.trim();
    if (!clientIdInput) { $("#idnClientIdCc").focus(); return; }
    if (!tokenUrlInput) { $("#idnTokenUrlCc").focus(); return; }
    idn.clientId = clientIdInput;
    idn.tokenUrl = tokenUrlInput;
    idn.provider = state.selectedIdentityProvider || "custom";
    const secretInput = $("#idnClientSecretCc").value;
    idn.clientSecret = isMask(secretInput) ? existing?.clientSecret : (secretInput || undefined);
    idn.scopes = scopes || undefined;
  } else if (kind === "oauth2_authcode") {
    const clientIdInput = $("#idnClientIdCode").value.trim();
    const authUrlInput  = $("#idnAuthUrl").value.trim();
    const tokenUrlInput = $("#idnTokenUrlCode").value.trim();
    if (!clientIdInput) { $("#idnClientIdCode").focus(); return; }
    if (!authUrlInput)  { $("#idnAuthUrl").focus(); return; }
    if (!tokenUrlInput) { $("#idnTokenUrlCode").focus(); return; }
    idn.clientId = clientIdInput;
    idn.authUrl  = authUrlInput;
    idn.tokenUrl = tokenUrlInput;
    idn.provider = state.selectedIdentityProvider || "custom";
    const secretInput = $("#idnClientSecretCode").value;
    idn.clientSecret = isMask(secretInput) ? existing?.clientSecret : (secretInput || undefined);
    idn.scopes = scopes || undefined;
    idn.redirectUri = redirectUri();
  } else if (kind === "jwt_bearer") {
    const assertionInput = $("#idnAssertion").value.trim();
    const tokenUrlInput  = $("#idnTokenUrlJwt").value.trim();
    if (!assertionInput) { $("#idnAssertion").focus(); return; }
    if (!tokenUrlInput)  { $("#idnTokenUrlJwt").focus(); return; }
    idn.assertion = isMask(assertionInput) ? existing?.assertion : assertionInput;
    idn.tokenUrl  = tokenUrlInput;
    idn.provider = state.selectedIdentityProvider || "custom";
    idn.scopes = scopes || undefined;
  }

  if (!existing) {
    state.identities.push(idn);
  } else {
    Object.assign(existing, idn);
  }

  renderIdentities();
  dirty();
  closeIdentityDialog();

  // connect ダイアログから「+ new identity…」で開かれていた場合、新 identity を選択状態に戻す
  const ret = state._authRefReturn;
  state._authRefReturn = null;
  if (ret) ret(idn.id);
}

function wireIdentityDialog() {
  $("#identityAdd").addEventListener("click", () => openIdentityDialog());
  $("#idnClose").addEventListener("click", closeIdentityDialog);
  $("#idnCancel").addEventListener("click", closeIdentityDialog);
  $("#idnSubmit").addEventListener("click", submitIdentityDialog);
  $("#idnTest").addEventListener("click", testIdentityDialog);

  const provSel = $("#idnProvider");
  if (provSel) {
    provSel.addEventListener("change", () => {
      state.selectedIdentityProvider = provSel.value;
      applyProviderPreset(true);   // 手動切替: Custom にしたら前プリセット url をクリア
    });
  }

  // toggle buttons for token/secret fields
  const togglePairs = [
    { input: "#idnToken",           toggle: "#idnTokenToggle" },
    { input: "#idnClientSecretCc",  toggle: "#idnSecretToggleCc" },
    { input: "#idnClientSecretCode", toggle: "#idnSecretToggleCode" }
  ];
  togglePairs.forEach(({ input, toggle }) => {
    const inp = $(input);
    const btn = $(toggle);
    if (btn && inp) {
      btn.addEventListener("click", () => {
        const showing = inp.type === "text";
        inp.type = showing ? "password" : "text";
        btn.setAttribute("aria-pressed", showing ? "false" : "true");
        btn.classList.toggle("is-revealed", !showing);
      });
    }
  });
}

// ─── Sidebar: catalogs ─────────────────────────────────
function renderCatalogs() {
  const root  = $("#catalogList");
  const empty = $("#catalogsEmpty");
  if (!root) return;
  root.innerHTML = "";

  // catalog 開閉状態 (bookmark と同じパターン)
  state._catalogExpanded = state._catalogExpanded || {};

  state.catalogs.forEach(c => {
    if (!c.businessGroups) c.businessGroups = [];
    const hasChildren = c.businessGroups.length > 0;
    if (state._catalogExpanded[c.id] === undefined) state._catalogExpanded[c.id] = true;
    const expanded = !!state._catalogExpanded[c.id];

    const statusCls = c.status === "connected" ? "is-connected"
                    : c.status === "error"     ? "is-error"
                    : c.status === "connecting"? "is-connecting"
                    : "";
    const linkedIdn = c.authRef ? identityById(c.authRef) : null;
    const sourceUrl = linkedIdn?.authUrl || linkedIdn?.tokenUrl || c.authUrl || c.tokenUrl;
    const host = hostFromUrl(sourceUrl) || (c.type === "anypoint" ? "anypoint.mulesoft.com" : "");
    const authLabel = linkedIdn ? `${linkedIdn.name} · ${kindBadge(linkedIdn.kind)}` : "no identity";

    // 親 (catalog) — bookmark item と同形式: name + count + + + ×
    const li = document.createElement("li");
    li.className = "catalog-item"
      + (hasChildren ? " is-expandable" : "")
      + (hasChildren && expanded ? " is-expanded" : "");
    li.dataset.catId = c.id;
    li.title = `${host}  ·  ${authLabel}  ·  ${c.status || "idle"}`;
    li.innerHTML = `
      <span class="catalog-name" title="Click to toggle">${escapeHtml(c.name)}</span>
      <span class="catalog-meta">
        <span class="catalog-status-dot ${statusCls}" title="${escapeHtml(c.status || "idle")}"></span>
        <span class="bm-count" title="${c.businessGroups.length} BG">${c.businessGroups.length}</span>
      </span>
      <button class="bookmark-new" title="Add business group" aria-label="add bg">
        <svg viewBox="0 0 14 14" width="10" height="10"><line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      ${KEBAB_BTN_HTML}
    `;
    const doDelete = async () => {
      const ok = await modalConfirm({
        title:        `Delete "${c.name}"? (${c.businessGroups.length} business groups will also be deleted)`,
        confirmLabel: "Delete",
        danger:       true
      });
      if (!ok) return;
      state.catalogs = state.catalogs.filter(x => x.id !== c.id);
      delete state._catalogExpanded[c.id];
      if (state._drawerCatalogId === c.id) closeCatalogDrawer();
      renderCatalogs();
      dirty();
    };
    li.addEventListener("click", async (e) => {
      if (e.target.closest(".row-kebab")) {
        e.stopPropagation();
        openRowMenu(e.target.closest(".row-kebab"), [
          { label: "Edit",   onClick: () => openCatalogDialog(c) },
          { label: "Add business group", onClick: () => addBusinessGroupToCatalog(c) },
          { label: "Delete", danger: true, onClick: doDelete }
        ]);
        return;
      }
      if (e.target.closest(".bookmark-new")) {
        e.stopPropagation();
        addBusinessGroupToCatalog(c);
        return;
      }
      // name / count クリック → 開閉トグル (子があれば)
      if (e.target.closest(".catalog-name, .bm-count")) {
        if (!hasChildren) {
          // 子なしの場合は即 BG 追加 UI を出す
          addBusinessGroupToCatalog(c);
          return;
        }
        state._catalogExpanded[c.id] = !state._catalogExpanded[c.id];
        renderCatalogs();
      }
    });
    li.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      openCatalogDialog(c);
    });
    root.appendChild(li);

    // 子 BG tree
    if (hasChildren && expanded) {
      const sub = document.createElement("li");
      sub.className = "bookmark-children";
      c.businessGroups.forEach((bg, i) => {
        const isLast = i === c.businessGroups.length - 1;
        const isActive = state._drawerCatalogId === c.id && state._drawerBgId === bg.id;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bookmark-child" + (isActive ? " is-active" : "");
        btn.title = `${bg.bgName || bg.input}${bg.bgId ? " · " + bg.bgId : ""}`;
        btn.innerHTML = `
          <span class="bc-branch">${isLast ? "└─" : "├─"}</span>
          <span class="bc-name">${escapeHtml(bg.bgName || bg.input)}</span>
          <button class="bc-remove" title="Remove this business group" aria-label="remove bg">
            <svg viewBox="0 0 12 12" width="8" height="8"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.4"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" stroke-width="1.4"/></svg>
          </button>
        `;
        btn.addEventListener("click", async (e) => {
          if (e.target.closest(".bc-remove")) {
            e.stopPropagation();
            const ok = await modalConfirm({
              title: `Remove "${bg.bgName || bg.input}" from catalog?`,
              confirmLabel: "Remove",
              danger: true
            });
            if (!ok) return;
            c.businessGroups = c.businessGroups.filter(x => x.id !== bg.id);
            if (state._drawerBgId === bg.id) closeCatalogDrawer();
            renderCatalogs();
            dirty();
            return;
          }
          // トグル: 同じ bg を開いてたらClose
          if (state._drawerCatalogId === c.id && state._drawerBgId === bg.id) {
            closeAssetDetail();
            closeCatalogDrawer();
          } else {
            openBgDrawer(c, bg);
          }
        });
        sub.appendChild(btn);
      });
      root.appendChild(sub);
    }
  });
  empty.classList.toggle("is-hidden", state.catalogs.length > 0);
}

// + ボタンから BG を追加する modal フロー
async function addBusinessGroupToCatalog(cat) {
  const input = await modalPrompt({
    title:        `Add business group to "${cat.name}"`,
    label:        "business group name or ID",
    placeholder:  "e.g. btd  or  0fc4eaf1-5697-4cef-9c1b-3b96e3a52ee2",
    confirmLabel: "Add"
  });
  if (!input) return;
  // 重複チェック
  if (cat.businessGroups.some(x => x.input.toLowerCase() === input.toLowerCase())) {
    await modalAlert({ title: "Already added", message: `"${input}" is already registered in this catalog.` });
    return;
  }
  const bg = {
    id:    `bg-${++bgCounter}`,
    input,
    bgId:  null,
    bgName: null,
    assets: null,
    assetsFetchedAt: null
  };
  cat.businessGroups.push(bg);
  state._catalogExpanded[cat.id] = true;
  renderCatalogs();
  dirty();
  // 直ちに drawer を開いて取得
  openBgDrawer(cat, bg);
}

// ─── Auth flow セグメント ───
// catalog ダイアログの identity セレクトを埋める (oauth2_cc / oauth2_authcode のみ;
// catalog の Exchange API は OAuth トークンを要求するため bearer/jwt は対象外)。
function renderCatAuthRefSelect(selectedId) {
  const sel = $("#catAuthRef");
  if (!sel) return;
  const cur = selectedId !== undefined ? selectedId : sel.value;
  sel.innerHTML = "";
  const head = document.createElement("option");
  head.value = ""; head.textContent = "— select identity —";
  sel.appendChild(head);
  (state.identities || [])
    .filter(idn => idn.kind === "oauth2_cc" || idn.kind === "oauth2_authcode")
    .forEach(idn => {
      const o = document.createElement("option");
      o.value = idn.id;
      o.textContent = `${idn.name} · ${kindBadge(idn.kind)}`;
      sel.appendChild(o);
    });
  const neu = document.createElement("option");
  neu.value = "__new__"; neu.textContent = "+ new identity…";
  sel.appendChild(neu);
  sel.value = (cur && identityById(cur)) ? cur : "";
}

function openCatalogDialog(editing) {
  $("#catalogDialog").hidden = false;
  state._editingCatalogId = editing?.id || null;

  $("#catName").value          = editing?.name || "";
  $("#catBusinessGroup").value = "";   // 編集時は既存 BGs に追加する形なので空 (初回のみ使用)
  renderCatAuthRefSelect(editing?.authRef || "");

  setTimeout(() => $("#catName").focus(), 50);
}

function closeCatalogDialog() {
  $("#catalogDialog").hidden = true;
  state._editingCatalogId = null;
}

async function submitCatalogDialog() {
  const name     = $("#catName").value.trim();
  const authRef  = $("#catAuthRef")?.value || "";
  const bgInput  = $("#catBusinessGroup").value.trim();

  if (!name)    { $("#catName").focus(); return; }
  if (!authRef || authRef === "__new__") {
    await modalAlert({ title: "Identity required", message: "AUTHENTICATION の identity を選択してください (OAuth2 CC か Authorization Code)。" });
    return;
  }

  const editingId = state._editingCatalogId;
  const existing  = editingId ? state.catalogs.find(c => c.id === editingId) : null;

  const cat = existing || { businessGroups: [] };
  Object.assign(cat, {
    id:        existing?.id || `cat-${++catCounter}`,
    name,
    type:      "anypoint",
    authRef,
    status:    existing?.status || "idle",
    createdAt: existing?.createdAt || Date.now()
  });
  if (!cat.businessGroups) cat.businessGroups = [];
  if (!existing) state.catalogs.push(cat);

  // CC/Auth Code どちらもここで認証
  const btn = $("#catSubmit");
  btn.disabled = true;
  cat.status = "connecting";
  renderCatalogs();
  await authenticateCatalog(cat);
  btn.disabled = false;

  renderCatalogs();
  dirty();

  if (cat.status === "error") {
    await modalAlert({
      title:   "Connection failed",
      message: cat.lastError || "Unknown error from Anypoint"
    });
    return; // ダイアログは閉じない (再入力できるように)
  }
  closeCatalogDialog();

  if (cat.status !== "connected") return;

  // ダイアログで BG が入力された + まだ未登録 → 追加 + drawer を即開く
  if (bgInput && !cat.businessGroups.some(b => (b.input || "").toLowerCase() === bgInput.toLowerCase())) {
    const bg = {
      id:    `bg-${++bgCounter}`,
      input: bgInput,
      bgId:  null,
      bgName: null,
      assets: null,
      assetsFetchedAt: null
    };
    cat.businessGroups.push(bg);
    state._catalogExpanded[cat.id] = true;
    renderCatalogs();
    dirty();
    openBgDrawer(cat, bg);
    return;
  }

  // BG 未指定で初回作成 → 追加 modal を即出す
  if ((!cat.businessGroups || cat.businessGroups.length === 0)) {
    addBusinessGroupToCatalog(cat);
  }
}

function wireCatalogDialog() {
  $("#catalogAdd").addEventListener("click", () => openCatalogDialog());
  $("#catClose").addEventListener("click", closeCatalogDialog);
  $("#catCancel").addEventListener("click", closeCatalogDialog);
  $("#catSubmit").addEventListener("click", submitCatalogDialog);

  const authSel = $("#catAuthRef");
  if (authSel) {
    authSel.addEventListener("change", () => {
      if (authSel.value !== "__new__") return;
      authSel.value = "";
      // catalog は OAuth2 CC を既定にして identity ダイアログを開く。保存後この select に反映。
      state._authRefReturn = (newId) => { renderCatAuthRefSelect(newId); };
      openIdentityDialog();
      state.selectedIdentityKind = "oauth2_cc";
      refreshIdentityDialog();
    });
  }
}

// ═══════════════════════════════════════════════════════
// SCRIPTS (sidebar)
// ═══════════════════════════════════════════════════════
function createScript({ name, body, select = true } = {}) {
  const id = `scr-${++scriptCounter}`;
  const s = {
    id,
    name: name || `script ${scriptCounter}`,
    body: body ?? "# example\n> Atelier Bistro: hello\n< Atelier Bistro\n",
    autoLoop: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.scripts.push(s);
  renderScripts();
  dirty();
  if (select) selectScript(s.id, { openPanel: true });
  return s;
}

function findScript(id) { return state.scripts.find(s => s.id === id); }

function selectScript(id, opts = {}) {
  state.selectedScriptId = id;
  renderScripts();
  dirty();
  if (opts.openPanel) openScriptInPanel(id);
}

async function deleteScript(id) {
  const s = findScript(id);
  if (!s) return;
  const ok = await modalConfirm({
    title:        `Delete "${s.name}"?`,
    confirmLabel: "Delete",
    danger:       true
  });
  if (!ok) return;
  state.scripts = state.scripts.filter(x => x.id !== id);
  // open tabs からも除外
  state.openScriptIds = state.openScriptIds.filter(x => x !== id);
  if (state.selectedScriptId === id) {
    state.selectedScriptId = state.openScriptIds[0] || state.scripts[0]?.id || null;
  }
  if (state.openScriptIds.length === 0) state.scriptPanelOpen = false;
  renderScripts();
  applyScriptPanel();
  dirty();
}

function toggleScriptLoop(id) {
  const s = findScript(id);
  if (!s) return;
  s.autoLoop = !s.autoLoop;
  s.updatedAt = Date.now();
  renderScripts();
  dirty();
  // 既に loop で走っている場合、 off にしたら現在の iteration 終了後に止める
  // (state._script.loopActive を見て while を抜ける)
  if (!s.autoLoop && state._script?.loopScriptId === id) {
    state._script.loopShouldStop = true;
    state._script.runner?.stop();
  }
}

function renameScript(id, newName) {
  const s = findScript(id);
  if (!s) return;
  s.name = newName.trim() || s.name;
  s.updatedAt = Date.now();
  renderScripts();
  renderScriptTabs();
  if (state.selectedScriptId === id) {
    $("#scriptSavedAt").textContent = `${s.name} · saved just now`;
  }
  dirty();
}

function renderScripts() {
  const root  = $("#scriptList");
  const empty = $("#scriptsEmpty");
  if (!root) return;
  root.innerHTML = "";
  state.scripts.forEach(s => {
    const li = document.createElement("li");
    li.className = "script-item";
    if (s.id === state.selectedScriptId) li.classList.add("is-active");
    li.dataset.scriptId = s.id;
    const lines = (s.body || "").split(/\r?\n/);
    const lineCount = lines.filter(l => l.trim() && !l.trim().startsWith("#")).length;
    // body の先頭コメント (連続する `# …` 行) を description として拾う。
    // 見出し風の罫線 (`# ────`, `# ====` など) や空 `#` 行はスキップ。
    const descLines = [];
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) { if (descLines.length) break; else continue; }
      if (!t.startsWith("#")) break;
      const stripped = t.replace(/^#+\s*/, "").trim();
      if (!stripped) { if (descLines.length) break; else continue; }
      if (/^[─-▟=\-_*]{3,}$/.test(stripped)) continue; // 罫線
      descLines.push(stripped);
      if (descLines.length >= 3) break;
    }
    const desc = descLines.join("  ");
    const ts = (typeof s.updatedAt === "number") ? s.updatedAt
             : (s.updatedAt ? Date.parse(s.updatedAt) : 0)
             || (typeof s.createdAt === "number" ? s.createdAt : Date.parse(s.createdAt || ""));
    const ageSec = (Number.isFinite(ts) && ts > 0)
      ? Math.max(0, Math.round((Date.now() - ts) / 1000))
      : null;
    const meta = `${lineCount} ops${ageSec != null ? ` · edited ${formatAge(ageSec)}` : ""}${s.autoLoop ? " · auto loop ON" : ""}`;
    li.title = desc ? `${desc}\n\n${meta}` : meta;
    const isRunningThis = !!(state._script && state._script.loopScriptId === s.id);
    // 他の script が実行中 — この script の run ボタンは押せなくする (見た目も無効化)
    const isBusyOther = !!(state._script && !isRunningThis);
    li.innerHTML = `
      <span class="script-name">${escapeHtml(s.name)}</span>
      <button class="script-run ${isRunningThis ? "is-stop" : ""}"
              ${isBusyOther ? "disabled" : ""}
              title="${isRunningThis ? "Stop this script" : isBusyOther ? "別のシナリオを実行中です" : "Run this script (no panel open)"}"
              aria-label="${isRunningThis ? "stop script" : "run script"}">
        ${isRunningThis
          ? `<svg viewBox="0 0 12 12" width="8" height="8"><circle cx="6" cy="6" r="4" fill="currentColor"/></svg>`
          : `<svg viewBox="0 0 12 12" width="9" height="9"><path d="M3 2 L10 6 L3 10 Z" fill="currentColor"/></svg>`}
      </button>
      <button class="script-loop ${s.autoLoop ? "is-on" : ""} ${(state._script && state.selectedScriptId === s.id && s.autoLoop) ? "is-running" : ""}"
              title="${s.autoLoop ? "auto loop ON (click to stop)" : "auto loop mode (repeat run)"}"
              aria-label="toggle auto loop">
        <svg viewBox="0 0 16 16" width="11" height="11"><path d="M3 7 a5 5 0 0 1 9 -2.5 M13 9 a5 5 0 0 1 -9 2.5 M3 2 v3 h3 M13 14 v-3 h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      ${KEBAB_BTN_HTML}
    `;
    // inline rename (dblclick / 鉛筆ボタン 共通)
    const beginRename = () => {
      const nameEl = li.querySelector(".script-name");
      nameEl.contentEditable = "true";
      nameEl.focus();
      const range = document.createRange();
      range.selectNodeContents(nameEl);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      const commit = () => {
        nameEl.contentEditable = "false";
        const v = nameEl.textContent.trim();
        if (v && v !== s.name) renameScript(s.id, v);
        else nameEl.textContent = s.name;
        nameEl.removeEventListener("blur", commit);
        nameEl.removeEventListener("keydown", onKey);
      };
      const onKey = (ke) => {
        if (ke.key === "Enter")  { ke.preventDefault(); commit(); }
        if (ke.key === "Escape") { nameEl.textContent = s.name; commit(); }
      };
      nameEl.addEventListener("blur", commit);
      nameEl.addEventListener("keydown", onKey);
    };
    li.addEventListener("click", (e) => {
      if (e.target.closest(".row-kebab")) {
        e.stopPropagation();
        openRowMenu(e.target.closest(".row-kebab"), [
          { label: "Rename", onClick: () => beginRename() },
          { label: "Delete", danger: true, onClick: () => deleteScript(s.id) }
        ]);
        return;
      }
      if (e.target.closest(".script-run")) {
        e.stopPropagation();
        // この script が走っているなら STOP ボタンとして機能 (panel を開かずに止める)。
        if (state._script && state._script.loopScriptId === s.id) {
          state._script.loopShouldStop = true;   // loop モードなら次 iter で抜ける
          state._script.runner?.stop();           // 実行中の runner を中断
          return;
        }
        if (state._script) return;   // 別の script が走っている
        runScript({ text: s.body || "", scriptId: s.id });
        return;
      }
      if (e.target.closest(".script-loop")) {
        e.stopPropagation();
        toggleScriptLoop(s.id);
        return;
      }
      // トグル動作: 既に active + panel open ならClose、 そうでなければ open + activate
      const isActiveOpen = state.scriptPanelOpen
                       && state.selectedScriptId === s.id
                       && state.openScriptIds.includes(s.id);
      if (isActiveOpen) {
        closeScriptPanel();
      } else {
        selectScript(s.id, { openPanel: true });
      }
    });
    li.addEventListener("dblclick", (e) => {
      if (e.target.closest(".row-kebab")) return;
      e.stopPropagation();
      beginRename();
    });
    root.appendChild(li);
  });
  empty.classList.toggle("is-hidden", state.scripts.length > 0);
}

// ─── Sidebar: protocols ────────────────────────────────
function renderProtoList() {
  const root = $("#protoList");
  root.innerHTML = "";
  PROTOCOLS.forEach(p => {
    const li = document.createElement("li");
    li.className = "proto-pill";
    li.dataset.proto = p.id;
    li.innerHTML = `
      <span class="proto-dot"></span>
      <span class="proto-name">${escapeHtml(p.label)}</span>
      <span class="proto-status">${p.status === "ready" ? "ready" : "soon"}</span>
    `;
    root.appendChild(li);
  });
}

// ─── Dialog: protocol grid ─────────────────────────────
function renderProtoGrid() {
  const root = $("#dlgProtoGrid");
  root.innerHTML = "";
  PROTOCOLS.forEach(p => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "proto-card";
    if (p.id === state.selectedProto) card.classList.add("is-active");
    if (p.status !== "ready") card.disabled = true, card.style.opacity = "0.5";
    card.innerHTML = `
      <span class="proto-card-name">${escapeHtml(p.label)}</span>
      <span class="proto-card-meta">${escapeHtml(p.sub)}</span>
    `;
    card.addEventListener("click", () => {
      if (p.status !== "ready") return;
      state.selectedProto = p.id;
      renderProtoGrid();
      applyProtoSpecificFields();
    });
    root.appendChild(card);
  });
  applyProtoSpecificFields();
}

function applyProtoSpecificFields() {
  const proto = state.selectedProto;
  const isSlack = proto === "slack";
  const isMcp   = proto === "mcp";
  const isMock  = proto === "mock";
  const channelField = $("#dlgSlackChannelField");
  if (channelField) channelField.hidden = !isSlack;

  // ── mock: URL は不要。代わりに「agent name」を主役にする ──
  // url field を name 入力に転用し、auth / test / advanced を隠す。
  const urlField   = $("#dlgUrl")?.closest(".field");
  const urlLabel   = $("#dlgUrl")?.closest(".field")?.querySelector(".field-label span:first-child");
  const urlHint    = $("#dlgUrl")?.closest(".field")?.querySelector(".field-hint");
  const urlPrefix  = $("#dlgUrl")?.closest(".input-wrap")?.querySelector(".input-prefix");
  const nameField  = $("#dlgName")?.closest(".field");
  const authField  = $("#dlgAuthRef")?.closest(".field");
  const testBtn    = $("#dlgTest");
  const advanced   = document.querySelector("#connectDialog .advanced");
  if (urlLabel)  urlLabel.textContent  = isMock ? "agent name" : "discovery url";
  if (urlHint)   urlHint.textContent   = isMock ? "この名前だけが役割を表します (例: 与信審査 / 不正検知 / インシデント)"
                                                : "A2A: base URL → AgentCard 解釈 / MCP: /mcp endpoint";
  if (urlPrefix) urlPrefix.textContent = isMock ? "name" : "url";
  // mock では display name 行・auth 行・test ボタン・advanced を畳む。
  // ただし編集モードでは url(=mock:// key) が readonly なので、rename 用に name 行は残す。
  const isEditing = !!state._editingBookmarkKey;
  if (urlLabel && isMock && isEditing) urlLabel.textContent = "agent id";
  if (urlHint  && isMock && isEditing) urlHint.textContent  = "mock connection key (readonly)";
  if (nameField) nameField.hidden = isMock && !isEditing;
  if (authField) authField.hidden = isMock;
  if (testBtn)   testBtn.hidden   = isMock;
  if (advanced)  advanced.hidden  = isMock;

  // placeholder の切替
  const urlInput  = $("#dlgUrl");
  if (urlInput) {
    if (isMock) {
      urlInput.placeholder = "e.g. 与信審査エージェント   ·   Fraud Detection   ·   Incident";
      urlInput.title = "疑似エージェントの表示名。実通信はせず、Script Editor の台本 (`<` 送信 / `$>` 応答) を再生します。";
    } else if (isSlack) {
      urlInput.placeholder = "https://slack.com   ·   https://slack.example.com   (compatible server)";
      urlInput.title = "";
    } else if (isMcp) {
      urlInput.placeholder = "https://example.com/mcp   (MCP JSON-RPC endpoint)";
      urlInput.title = "Point at the MCP server's JSON-RPC endpoint (e.g., https://atelier-mcp-mdm-znutqp.pnwfdv.jpn-e1.cloudhub.io/mcp).";
    } else {
      urlInput.placeholder = "https://api.example.com";
      urlInput.title = "Base URL is fine — Atelier appends /.well-known/agent-card.json automatically (falls back to /.well-known/agent.json for the legacy spec).";
    }
  }
}

// connect ダイアログの auth セレクトを identities で埋める。
function renderAuthRefSelect(selectedId) {
  const sel = $("#dlgAuthRef");
  if (!sel) return;
  const cur = selectedId !== undefined ? selectedId : sel.value;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "none";
  sel.appendChild(none);
  (state.identities || []).forEach(idn => {
    const o = document.createElement("option");
    o.value = idn.id;
    o.textContent = `${idn.name} · ${kindBadge(idn.kind)}`;
    sel.appendChild(o);
  });
  const neu = document.createElement("option");
  neu.value = "__new__"; neu.textContent = "+ new identity…";
  sel.appendChild(neu);
  sel.value = (cur && (cur === "" || identityById(cur))) ? cur : "";
}

// ─── Rail ─────────────────────────────────────────────
function wireRail() {
  $("#btnConnect").addEventListener("click", openDialog);
  $("#btnConnectEmpty").addEventListener("click", openDialog);
  $("#btnDemo").addEventListener("click", openImportPicker);
  $("#btnLayout").addEventListener("click", cycleTileMode);
  const btnSnap = $("#btnSnap");
  if (btnSnap) btnSnap.addEventListener("click", () => tileWindows("fit"));
  const btnCloseAll = $("#btnCloseAll");
  if (btnCloseAll) btnCloseAll.addEventListener("click", closeAllWindows);
  $("#scriptAdd").addEventListener("click", () => createScript({}));
}

// 現ワークスペースの全ウインドウを閉じる (接続も切断)。確認あり。
async function closeAllWindows() {
  const ws = activeWorkspace();
  if (!ws || ws.windows.length === 0) return;
  const ok = await modalConfirm({
    title:        `Close all windows? (${ws.windows.length} connection${ws.windows.length === 1 ? "" : "s"} will be disconnected)`,
    confirmLabel: "Close all",
    danger:       true
  });
  if (!ok) return;
  [...ws.windows].forEach(w => w.close());
}

// ═══════════════════════════════════════════════════════
// SCRIPT
// ═══════════════════════════════════════════════════════
function windowDisplayName(w) {
  return `${w.name || ""}${w.instanceSuffix || ""}`;
}

function findWindowByQuery(q) {
  const query = String(q || "").trim().toLowerCase();
  if (!query) return null;
  const all = state.workspaces.flatMap(w => w.windows);
  const dn = w => windowDisplayName(w).toLowerCase();
  // ID 完全一致
  let w = all.find(x => x.id === query);
  if (w) return w;
  // display name 完全一致 ("SCRS Broker #2" のような名前+suffix)
  w = all.find(x => dn(x) === query);
  if (w) return w;
  // display name 前方一致
  w = all.find(x => dn(x).startsWith(query));
  if (w) return w;
  // display name 部分一致
  w = all.find(x => dn(x).includes(query));
  return w || null;
}

// script の window 参照 (名前) に一致する bookmark (= 登録済み connection) を探す。
// findWindowByQuery と同じ「完全一致 → 前方一致 → 部分一致」の優先順位。
// 未オープンの window を Run 時に自動で開くために使う。
function findBookmarkByQuery(q) {
  const query = String(q || "").trim().toLowerCase();
  if (!query) return null;
  const bms = state.bookmarks || [];
  const nameOf = b => String(b.name || hostFromUrl(b.url) || b.url || "").toLowerCase();
  let b = bms.find(x => nameOf(x) === query);
  if (b) return b;
  b = bms.find(x => nameOf(x).startsWith(query));
  if (b) return b;
  b = bms.find(x => nameOf(x).includes(query));
  return b || null;
}

// ═══════════════════════════════════════════════════════
// SCRIPT BOTTOM PANEL
// ═══════════════════════════════════════════════════════
function applyScriptPanel() {
  const panel = $("#scriptPanel");
  panel.style.setProperty("--script-panel-h", state.scriptPanelHeight + "px");
  if (state.scriptPanelOpen && state.openScriptIds.length > 0) {
    panel.classList.add("is-open");
    renderScriptTabs();
    renderCommandChips();
    loadActiveScriptIntoPanel();
  } else {
    panel.classList.remove("is-open");
  }
}

function openScriptInPanel(scriptId) {
  // Catalog drawer と排他: 開いていればClose (detail も)
  closeAssetDetail();
  closeCatalogDrawer();
  let sid = scriptId || state.selectedScriptId;
  if (!sid) {
    const s = createScript({ select: false });
    sid = s.id;
  }
  if (!state.openScriptIds.includes(sid)) state.openScriptIds.push(sid);
  state.selectedScriptId = sid;
  state.scriptPanelOpen  = true;
  applyScriptPanel();
  renderScripts();
  refreshScriptChips();
  setTimeout(() => $("#scriptEditor").focus(), 60);
  dirty();
}

function closeScriptTab(sid) {
  const idx = state.openScriptIds.indexOf(sid);
  if (idx < 0) return;
  state.openScriptIds.splice(idx, 1);
  if (state.selectedScriptId === sid) {
    state.selectedScriptId = state.openScriptIds[Math.min(idx, state.openScriptIds.length - 1)] || null;
  }
  if (state.openScriptIds.length === 0) {
    state.scriptPanelOpen = false;
  }
  applyScriptPanel();
  renderScripts();
  dirty();
}

function toggleScriptPanel() {
  if (state.scriptPanelOpen) {
    state.scriptPanelOpen  = false;
    state.selectedScriptId = null;
  } else {
    // Catalog drawer と排他: 開いていればClose
    closeAssetDetail();
    closeCatalogDrawer();
    if (state.openScriptIds.length === 0) {
      // open に何もなければ最後の script or 新規
      const sid = state.selectedScriptId
                || state.scripts[state.scripts.length - 1]?.id;
      if (sid) state.openScriptIds.push(sid);
      else { createScript({ select: false }); }   // createScript で openScriptIds に追加される
    }
    state.scriptPanelOpen = state.openScriptIds.length > 0;
    if (!state.selectedScriptId) state.selectedScriptId = state.openScriptIds[0];
  }
  applyScriptPanel();
  renderScripts();
  dirty();
}

function setActiveScript(sid) {
  if (!state.openScriptIds.includes(sid)) state.openScriptIds.push(sid);
  state.selectedScriptId = sid;
  renderScriptTabs();
  loadActiveScriptIntoPanel();
  renderScripts();
  refreshScriptChips();
  setTimeout(() => $("#scriptEditor").focus(), 30);
  dirty();
}

function loadActiveScriptIntoPanel() {
  const s = findScript(state.selectedScriptId);
  const editor = $("#scriptEditor");
  if (!s) {
    editor.value = "";
    $("#scriptSavedAt").textContent = "—";
    updateScriptHighlight();
    return;
  }
  editor.value = s.body || "";
  // value 代入直後はキャレットが末尾に行き scroll もそこに飛ぶ。 先頭に戻す。
  editor.selectionStart = editor.selectionEnd = 0;
  editor.scrollTop  = 0;
  editor.scrollLeft = 0;
  const ts = (typeof s.updatedAt === "number") ? s.updatedAt
           : (s.updatedAt ? Date.parse(s.updatedAt) : 0)
           || (typeof s.createdAt === "number" ? s.createdAt : Date.parse(s.createdAt || ""));
  const ageSec = (Number.isFinite(ts) && ts > 0)
    ? Math.max(0, Math.round((Date.now() - ts) / 1000))
    : null;
  $("#scriptSavedAt").textContent = ageSec != null
    ? `${s.name} · saved ${formatAge(ageSec)}`
    : s.name;
  setScriptStatus("", "");
  updateScriptHighlight();
}

function renderScriptTabs() {
  const root = $("#scriptTabs");
  root.innerHTML = "";
  if (state.openScriptIds.length === 0) {
    root.innerHTML = `<div class="script-tab-empty">no script open</div>`;
    return;
  }
  state.openScriptIds.forEach(sid => {
    const s = findScript(sid);
    if (!s) return;
    const tab = document.createElement("div");
    tab.className = "script-tab" + (sid === state.selectedScriptId ? " is-active" : "");
    tab.dataset.scriptId = sid;
    tab.innerHTML = `
      <span class="script-tab-dot"></span>
      <span class="script-tab-name">${escapeHtml(s.name)}</span>
      <button class="script-tab-close" title="Close" aria-label="close">
        <svg viewBox="0 0 14 14" width="8" height="8"><line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.6"/><line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.6"/></svg>
      </button>
    `;
    tab.addEventListener("click", (e) => {
      if (e.target.closest(".script-tab-close")) {
        e.stopPropagation();
        closeScriptTab(sid);
        return;
      }
      setActiveScript(sid);
    });
    tab.addEventListener("dblclick", (e) => {
      if (e.target.closest(".script-tab-close")) return;
      const nameEl = tab.querySelector(".script-tab-name");
      nameEl.contentEditable = "true";
      nameEl.focus();
      const range = document.createRange();
      range.selectNodeContents(nameEl);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      const commit = () => {
        nameEl.contentEditable = "false";
        const v = nameEl.textContent.trim();
        if (v && v !== s.name) renameScript(sid, v);
        else nameEl.textContent = s.name;
      };
      nameEl.addEventListener("blur", commit, { once: true });
      nameEl.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter")  { ke.preventDefault(); nameEl.blur(); }
        if (ke.key === "Escape") { nameEl.textContent = s.name; nameEl.blur(); }
      });
    });
    root.appendChild(tab);
  });
}

// ─── DSL syntax highlighting ─────────────────────────
function escapeHtmlInline(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// `${varname}` を <span class="tk-var"> でハイライトしつつ、 周囲は escape する
function highlightVarRefs(s) {
  const out = [];
  const text = String(s ?? "");
  const re = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(escapeHtmlInline(text.slice(last, m.index)));
    out.push(`<span class="tk-var">${escapeHtmlInline(m[0])}</span>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(escapeHtmlInline(text.slice(last)));
  return out.join("");
}
function highlightDslLine(raw) {
  const trimmed = raw.trimStart();
  const lead = raw.slice(0, raw.length - trimmed.length);
  if (!trimmed) return escapeHtmlInline(raw);
  if (trimmed.startsWith("#")) {
    return escapeHtmlInline(lead) + `<span class="tk-comment">${escapeHtmlInline(trimmed)}</span>`;
  }
  let m;
  // ^ operator: hint -> var   (operator-agent directive、 wait + capture を 1 directive で)
  if ((m = trimmed.match(/^(\^)(\s+)(.+?)(\s*)(:)(\s*)(.+?)\s*(->|→)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*$/))) {
    return escapeHtmlInline(lead)
      + `<span class="tk-cmd">${escapeHtmlInline(m[1])}</span>${escapeHtmlInline(m[2])}`
      + `<span class="tk-name">${escapeHtmlInline(m[3])}</span>${escapeHtmlInline(m[4])}`
      + `<span class="tk-punct">${escapeHtmlInline(m[5])}</span>${escapeHtmlInline(m[6])}`
      + `<span class="tk-text">${highlightVarRefs(m[7])}</span>`
      + ` <span class="tk-punct">${escapeHtmlInline(m[8])}</span> `
      + `<span class="tk-var">${escapeHtmlInline(m[9])}</span>`;
  }
  // < name: text   (send to agent) — ${var} を強調
  if ((m = trimmed.match(/^(<)(\s+)(.+?)(\s*)(:)(\s*)(.*)$/))) {
    return escapeHtmlInline(lead)
      + `<span class="tk-cmd">${escapeHtmlInline(m[1])}</span>${escapeHtmlInline(m[2])}`
      + `<span class="tk-name">${escapeHtmlInline(m[3])}</span>${escapeHtmlInline(m[4])}`
      + `<span class="tk-punct">${escapeHtmlInline(m[5])}</span>${escapeHtmlInline(m[6])}`
      + `<span class="tk-text">${highlightVarRefs(m[7])}</span>`;
  }
  // $> window: 応答 — mock 応答 (`<` と対称)。
  // mock ON: mock 色で強調 / OFF: コメント色 dim (実行されない行なので目立たせない)。
  // ※ 空文字を返すと overlay の行が消えて textarea と行高がずれるので、 必ず 1 行描画する。
  if ((m = trimmed.match(/^(\$>)(\s*)(.+?)(\s*)(:)(\s*)([\s\S]*)$/))) {
    if (!state.scriptMock) {
      // OFF 時はコメント扱い。 絵文字 (✅⚖️📦 等) は固有色を持ち dim グレーでも目立つので
      // tk-mock-off クラス側で grayscale+低不透明度にして沈める。
      return escapeHtmlInline(lead) + `<span class="tk-comment tk-mock-off">${escapeHtmlInline(trimmed)}</span>`;
    }
    return escapeHtmlInline(lead)
      + `<span class="tk-mock">${escapeHtmlInline(m[1])}</span>${escapeHtmlInline(m[2])}`
      + `<span class="tk-name">${escapeHtmlInline(m[3])}</span>${escapeHtmlInline(m[4])}`
      + `<span class="tk-punct">${escapeHtmlInline(m[5])}</span>${escapeHtmlInline(m[6])}`
      + `<span class="tk-mock-text">${escapeHtmlInline(m[7])}</span>`;
  }
  // > name [timeout] [as var]  (wait for agent reply)
  if ((m = trimmed.match(/^(>)(\s+)(.+?)(?:(\s+)(\d+(?:\.\d+)?)\s*s?)?(?:(\s+)(as)(\s+)([a-zA-Z_][a-zA-Z0-9_]*))?$/))) {
    // mock モード時は応答源が直後の $> なので wait 行は無関係。 dim にして沈める
    // ($> OFF 時と対称)。 空文字では消さない (overlay の行が消えて行高がずれるため)。
    if (state.scriptMock) {
      return escapeHtmlInline(lead) + `<span class="tk-comment tk-mock-off">${escapeHtmlInline(trimmed)}</span>`;
    }
    let out = escapeHtmlInline(lead)
      + `<span class="tk-cmd">${escapeHtmlInline(m[1])}</span>${escapeHtmlInline(m[2])}`
      + `<span class="tk-name">${escapeHtmlInline(m[3])}</span>`;
    if (m[5]) out += escapeHtmlInline(m[4]) + `<span class="tk-num">${escapeHtmlInline(m[5])}s</span>`;
    if (m[10]) {
      out += escapeHtmlInline(m[6])
        + `<span class="tk-cmd">${escapeHtmlInline(m[7])}</span>${escapeHtmlInline(m[8])}`
        + `<span class="tk-var">${escapeHtmlInline(m[10])}</span>`;
    }
    return out;
  }
  // sleep N s
  if ((m = trimmed.match(/^(sleep)(\s+)(\d+(?:\.\d+)?)(\s*s?)$/i))) {
    return escapeHtmlInline(lead)
      + `<span class="tk-cmd">${escapeHtmlInline(m[1])}</span>${escapeHtmlInline(m[2])}`
      + `<span class="tk-num">${escapeHtmlInline(m[3] + m[4])}</span>`;
  }
  // clear [name]
  if ((m = trimmed.match(/^(clear)(\s+(.+))?$/i))) {
    let out = escapeHtmlInline(lead) + `<span class="tk-cmd">${escapeHtmlInline(m[1])}</span>`;
    if (m[2]) out += escapeHtmlInline(m[2].slice(0, m[2].length - m[3].length)) + `<span class="tk-name">${escapeHtmlInline(m[3])}</span>`;
    return out;
  }
  // unknown line: 赤波線
  return escapeHtmlInline(lead) + `<span class="tk-err">${escapeHtmlInline(trimmed)}</span>`;
}
function updateScriptHighlight() {
  const ed = $("#scriptEditor");
  const hl = $("#scriptHighlight");
  if (!ed || !hl) return;
  const lines = (ed.value + "\n").split("\n");
  hl.innerHTML = lines.map(highlightDslLine).join("\n");
  // scroll 同期
  hl.scrollTop  = ed.scrollTop;
  hl.scrollLeft = ed.scrollLeft;
  updateScriptGutter();
}

// 行番号 gutter の更新。 行数 +1 (末尾改行ぶん) を出力し、
// 現在カーソル行に is-cursor を付けてアクセントカラーで強調。
// カーソル行ハイライトバーも併せて配置 (常時ハイライト、 flash なし)。
function updateScriptGutter() {
  const ed = $("#scriptEditor");
  const g  = $("#scriptGutter");
  if (!ed || !g) return;
  const lines = (ed.value + "\n").split("\n");
  const visibleCount = Math.max(1, lines.length - 1);
  const before = ed.value.slice(0, ed.selectionStart);
  const cursorLine = (before.match(/\n/g) || []).length + 1;
  let html = "";
  for (let i = 1; i <= visibleCount; i++) {
    const cls = i === cursorLine ? "ln is-cursor" : "ln";
    // 改行は spans 間に入れない: \n が text node として描画され番号が 2 行飛びになる。
    html += `<span class="${cls}">${i}</span>`;
  }
  g.innerHTML = html;
  g.scrollTop = ed.scrollTop;

  // cursor bar 位置: textarea の computed line-height / padding-top を直接読む。
  // CSS 変数 (--line-h) は calc() 文字列で返るので parseFloat が壊れる ため不可。
  const bar = $("#scriptCursorBar");
  if (bar) {
    const cs = getComputedStyle(ed);
    const lineH = parseFloat(cs.lineHeight) || 20;
    const padTop = parseFloat(cs.paddingTop) || 14;
    const top = padTop + (cursorLine - 1) * lineH - ed.scrollTop;
    bar.style.top = top + "px";
    bar.style.height = lineH + "px";
    bar.hidden = false;
  }
}

// debounced auto-save
let _scriptSaveTimer = null;
function autoSaveScript() {
  if (_scriptSaveTimer) clearTimeout(_scriptSaveTimer);
  _scriptSaveTimer = setTimeout(() => {
    _scriptSaveTimer = null;
    const s = findScript(state.selectedScriptId);
    if (!s) return;
    s.body = $("#scriptEditor").value;
    s.updatedAt = Date.now();
    $("#scriptSavedAt").textContent = `${s.name} · saved just now`;
    renderScripts();
    dirty();
  }, 300);
}

// DSL コマンド一覧
const DSL_COMMANDS = [
  { glyph: "<",     label: "send",     insert: "< ",        cursor: "end",  title: "Send to window — < name: text  (use ${var} for capture)" },
  { glyph: ">",     label: "wait",     insert: "> ",        cursor: "end",  title: "Wait for reply — > name [30s] [as var]" },
  { glyph: "^",     label: "operator", insert: "^ operator: ", cursor: "end", title: "Operator-agent directive — ^ name: hint -> var" },
  { glyph: "sleep", label: "pause",    insert: "sleep 1s",  cursor: "end",  title: "Pause — sleep Ns" },
  { glyph: "clear", label: "reset",    insert: "clear",     cursor: "end",  title: "Clear chat — clear [name]" },
  { glyph: "#",     label: "comment",  insert: "# ",        cursor: "end",  title: "Comment line — # ..." }
];

function renderCommandChips() {
  const root = $("#scriptCommandChips");
  if (!root) return;
  root.innerHTML = "";
  DSL_COMMANDS.forEach(c => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swc-cmd";
    btn.title = c.title;
    btn.innerHTML = `<span class="swc-cmd-glyph">${escapeHtml(c.glyph)}</span><span class="swc-cmd-label">${escapeHtml(c.label)}</span>`;
    btn.addEventListener("click", () => insertCommandTemplate(c));
    root.appendChild(btn);
  });
}

function insertCommandTemplate(c) {
  const ed = $("#scriptEditor");
  const cursor = ed.selectionStart;
  const before = ed.value.slice(0, cursor);
  const after  = ed.value.slice(ed.selectionEnd);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineUpToCursor = before.slice(lineStart);
  const lineEmpty = !lineUpToCursor.trim();
  // 空行なら現在行に直接挿入、 そうでなければ改行 + 挿入
  const prefix = lineEmpty ? "" : "\n";
  const text = prefix + c.insert;
  ed.value = before + text + after;
  ed.selectionStart = ed.selectionEnd = before.length + text.length;
  ed.focus();
  autoSaveScript();
  refreshScriptChips();
  updateScriptHighlight();
}

// chips は常に全 windows を固定表示。編集中の行に該当する chip を is-match でハイライト。
function refreshScriptChips() {
  const ed = $("#scriptEditor");
  const chipsRoot = $("#scriptWindowChips");
  chipsRoot.innerHTML = "";

  const allWindows = state.workspaces.flatMap(w => w.windows);
  if (allWindows.length === 0) {
    chipsRoot.innerHTML = `<span class="swc-empty">no open windows</span>`;
    return;
  }

  // カーソル行が `> partial` or `< partial` なら補完候補をハイライト
  const cursor = ed ? ed.selectionStart : 0;
  const before = ed ? ed.value.slice(0, cursor) : "";
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineUpToCursor = before.slice(lineStart);
  const m = lineUpToCursor.match(/^[><]\s+(.*?):?$/);
  const query = m ? m[1].toLowerCase().trim() : "";
  const matchMode = !!m;

  allWindows.forEach(w => {
    const display = windowDisplayName(w);
    const isMatch = matchMode && query && display.toLowerCase().includes(query);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swc-chip" + (isMatch ? " is-match" : "");
    btn.innerHTML = `<span>${escapeHtml(display)}</span><span class="swc-chip-id">${w.id}</span>`;
    btn.addEventListener("click", () => insertWindowName(w, matchMode));
    chipsRoot.appendChild(btn);
  });
}

// chip クリック: "> Name#N: " (send 行は : まで) を挿入
function insertWindowName(win, matchMode) {
  const ed = $("#scriptEditor");
  const display = windowDisplayName(win);
  const cursor = ed.selectionStart;
  const before = ed.value.slice(0, cursor);
  const after  = ed.value.slice(ed.selectionEnd);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineUpToCursor = before.slice(lineStart);

  if (matchMode) {
    // `> partial` を `> Full Name#N: ` (send) または `< Full Name#N ` (wait) に置換
    const marker = lineUpToCursor.match(/^([><])\s+/)[1];
    const tail   = marker === ">" ? ": " : " ";
    const newLineUpToCursor = `${marker} ${display}${tail}`;
    const newBefore = ed.value.slice(0, lineStart) + newLineUpToCursor;
    ed.value = newBefore + after;
    ed.selectionStart = ed.selectionEnd = newBefore.length;
  } else {
    // 空行 → send テンプレ。途中なら display name だけ
    const lineEmpty = !lineUpToCursor.trim();
    const insertText = lineEmpty ? `> ${display}: ` : display;
    ed.value = before + insertText + after;
    ed.selectionStart = ed.selectionEnd = before.length + insertText.length;
  }
  ed.focus();
  refreshScriptChips();
  autoSaveScript();
  updateScriptHighlight();
}
function closeScriptPanel() {
  // 注: 走っている script は止めない (panel と実行は独立)
  // 停止したい時は sidebar の loop トグル OFF か、 panel 再表示して stop ボタン
  state.scriptPanelOpen   = false;
  state.selectedScriptId  = null;   // sidebar の is-active も解除
  applyScriptPanel();
  renderScripts();
  dirty();
}

// status を toolbar に表示 (output column 廃止後の代替)
function setScriptStatus(text, kind = "") {
  const el = $("#scriptStatus");
  if (!text) { el.hidden = true; el.textContent = ""; el.className = "script-status"; return; }
  el.hidden = false;
  el.textContent = text;
  el.className = "script-status" + (kind ? ` is-${kind}` : "");
}
// runner からのログを最後の一件だけ status に流す。エラーは赤、recv は緑 (累積はしない)
function appendScriptLog({ level, text }) {
  const t = text || "";
  if (level === "err") {
    setScriptStatus(t.slice(0, 80), "err");
  } else if (level === "info" || level === "send" || level === "recv" || level === "dim") {
    setScriptStatus(t.slice(0, 80), state._script ? "running" : "");
  }
}

// カーソル行 (1 行) だけ抜き出して runScript に流し込む。
// 空行 / コメントは何もしない。 副作用 tool まで含めた script DSL の通常規則で実行。
function runCurrentLine() {
  const ed = $("#scriptEditor");
  if (!ed) return;
  const value = ed.value;
  const before = value.slice(0, ed.selectionStart);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd   = (() => {
    const idx = value.indexOf("\n", lineStart);
    return idx === -1 ? value.length : idx;
  })();
  const line = value.slice(lineStart, lineEnd);
  const trimmed = line.trim();
  if (!trimmed) {
    setScriptStatus("empty line", "err");
    setTimeout(() => setScriptStatus("", ""), 2000);
    return;
  }
  if (trimmed.startsWith("#")) {
    setScriptStatus("comment line — skipped", "err");
    setTimeout(() => setScriptStatus("", ""), 2000);
    return;
  }
  // loop モードを無効にして 1 行だけ走らせる
  runScript({ text: line, scriptId: null, _ephemeral: true });
}

// 台本 ops が参照する window 名を集め、 未オープンのものは bookmark から開く。
// 開いた window は AgentCard 取得 (adapter "open") まで待ってから返るので、
// 直後の send/wait が「接続前」で空振りしない。
async function ensureScriptWindowsOpen(ops) {
  // ops から参照される window 名 (send / wait / operator / clear<win>) を重複なく集める
  const names = [];
  const seen = new Set();
  for (const op of ops) {
    if (!op.win) continue;
    if (!["send", "wait", "operator", "clear", "mock"].includes(op.kind)) continue;
    const key = op.win.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(op.win);
  }

  // まだ開いていない & bookmark がある名前だけを対象に connect
  // (複数の名前が同じ bookmark に解決される場合は key で重複排除)
  const toOpen = [];
  const missing = [];
  const openedKeys = new Set();
  for (const name of names) {
    if (findWindowByQuery(name)) continue;     // 既に開いている
    const bm = findBookmarkByQuery(name);
    if (bm) {
      if (openedKeys.has(bm.key)) continue;
      openedKeys.add(bm.key);
      toOpen.push({ name, bm });
    } else {
      missing.push(name);
    }
  }

  if (missing.length) {
    appendScriptLog({ level: "dim", text: `· "${missing.join('", "')}" は未オープンで登録 connection も無し — 該当 op はスキップされます` });
  }
  if (!toOpen.length) return;

  appendScriptLog({ level: "info", text: `· ${toOpen.length} window を自動オープン: ${toOpen.map(t => t.bm.name || t.name).join(", ")}` });
  for (const { bm } of toOpen) {
    try {
      // lockName: bookmark の display name を維持 (AgentCard.name で上書きしない)
      await connect({
        protoId: bm.protoId, url: bm.url, name: bm.name,
        auth: bm.auth, authRef: bm.authRef, persona: bm.persona, channel: bm.channel
      }, { lockName: true });
    } catch (e) {
      appendScriptLog({ level: "err", text: `auto-open "${bm.name || bm.url}" failed: ${e?.message || e}` });
    }
  }
}

async function runScript(opts = {}) {
  // 既に別の script が実行中なら多重実行しない (サイドバー run / Ctrl+Enter / line 実行
  // など複数の入口があるため、 ここで一括ガード)。 停止は stop ボタン経由で。
  if (state._script) {
    appendScriptLog({ level: "err", text: "別のシナリオを実行中です。停止してから実行してください。" });
    return;
  }
  // opts.text + opts.scriptId でサイドバーから呼べる。引数なしならエディタの内容を使う。
  const text = opts.text != null ? opts.text : $("#scriptEditor").value;
  const ops  = parseScript(text);
  const script = findScript(opts.scriptId || state.selectedScriptId);
  const loopMode = !!script?.autoLoop;

  // run したらエディタ (script panel) を閉じて、 ウインドウ側の実行が見えるようにする。
  // script の実行は panel と独立なので、 閉じても走り続ける。
  if (state.scriptPanelOpen) closeScriptPanel();

  // ─── 未オープン window の自動オープン ───
  // 台本が参照する window 名で、 まだ開いていないが bookmark (登録済み connection) が
  // あるものは、 実行前にここで開いておく。 mock モード時は実通信しないので skip。
  if (!state.scriptMock) {
    await ensureScriptWindowsOpen(ops);
  }

  // ─── モックモード: ON なら対象 window の adapter を mock に乗っ取る ───
  // 台本インラインの `$> 応答` を { "<window名>": ["応答1", ...] } に畳んでローカル応答に。 実通信なし。
  const mockWins = [];
  if (state.scriptMock) {
    const mocks = parseMocks(text);
    if (!Object.keys(mocks).length) {
      appendScriptLog({ level: "err", text: `mock mode ON だが "${script?.name || '?'}" に mock 応答 ($> 行) がありません — 通常実行します` });
    } else {
      for (const winName of Object.keys(mocks)) {
        const w = findWindowByQuery(winName);
        if (w && w.adapter?.mockInstall) {
          w.adapter.mockInstall(mocks[winName]);
          mockWins.push(w);
        } else {
          appendScriptLog({ level: "err", text: `mock: window "${winName}" が見つかりません (接続して名前を一致させてください)` });
        }
      }
      if (mockWins.length) appendScriptLog({ level: "dim", text: `· MOCK モード: ${mockWins.length} window をローカル応答に切替` });
    }
  }

  $("#scriptRun").disabled  = true;
  $("#scriptStop").disabled = false;
  state._script = { runner: null, loopScriptId: script?.id || null, loopShouldStop: false };
  renderScripts();   // loop アイコンを running 状態に

  let iter = 0;
  const t0 = performance.now();
  try {
    do {
      iter++;
      const runner = new ScriptRunner({
        findWindow: findWindowByQuery,
        getAllWindows: () => state.workspaces.flatMap(w => w.windows),
        onLog: appendScriptLog
      });
      state._script.runner = runner;
      setScriptStatus(loopMode ? `↻ loop #${iter} · parsed ${ops.length} ops` : `▶ parsed ${ops.length} ops`, "running");
      await runner.run(ops);
      if (runner.cancelled || state._script.loopShouldStop) break;
      if (!loopMode) break;
      // iteration 間に少し休む (busy loop 回避 + 操作の余地)
      await new Promise(r => setTimeout(r, 500));
    } while (loopMode && state._script);
  } finally {
    // mock で乗っ取った adapter を元に戻す (実通信に復帰)
    mockWins.forEach(w => { try { w.adapter.mockRestore(); } catch {} });
    $("#scriptRun").disabled  = false;
    $("#scriptStop").disabled = true;
    const elapsed = Math.round(performance.now() - t0);
    const stopped = state._script?.runner?.cancelled || state._script?.loopShouldStop;
    if (stopped)      setScriptStatus(loopMode ? `■ loop stopped after ${iter} iter` : "■ stopped", "err");
    else if (loopMode) setScriptStatus(`✓ loop done · ${iter} iter · ${elapsed}ms`, "done");
    else               setScriptStatus(`✓ done in ${elapsed}ms`, "done");
    state._script = null;
    renderScripts();
    setTimeout(() => { if (!state._script) setScriptStatus("", ""); }, 4000);
  }
}

// editor 上の右クリックメニュー。 マウス位置に対応する行へカーソルを動かしてから menu 表示。
// 「Run this line」 を主役にして、 マウスを toolbar に上げに行かなくて済むようにする。
function showScriptContextMenu(ev) {
  ev.preventDefault();
  const ed = $("#scriptEditor");
  const menu = $("#scriptCtxMenu");
  if (!ed || !menu) return;

  // クリック位置の行にキャレットを移動 — caretPositionFromPoint 系を試して、
  // 失敗したら現状の selection を尊重する。
  let pos = null;
  if (typeof document.caretPositionFromPoint === "function") {
    const cp = document.caretPositionFromPoint(ev.clientX, ev.clientY);
    if (cp && cp.offsetNode === ed) pos = cp.offset;
  } else if (typeof document.caretRangeFromPoint === "function") {
    const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
    if (r) pos = r.startOffset;
  }
  if (pos != null) {
    ed.focus();
    ed.selectionStart = ed.selectionEnd = pos;
    refreshScriptChips();
    updateScriptHighlight();
  }

  // 位置決め: viewport 内に収める。 panel 外には出ない (overflow hidden の中でも
  // body 直下に配置するので問題ない)。
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top  = "0px";
  // 一旦表示してサイズ取得
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let x = ev.clientX;
  let y = ev.clientY;
  if (x + w > window.innerWidth)  x = Math.max(4, window.innerWidth  - w - 4);
  if (y + h > window.innerHeight) y = Math.max(4, window.innerHeight - h - 4);
  menu.style.left = x + "px";
  menu.style.top  = y + "px";
}

function hideScriptContextMenu() {
  const menu = $("#scriptCtxMenu");
  if (menu) menu.hidden = true;
}

function dispatchScriptContextAction(act) {
  const ed = $("#scriptEditor");
  if (!ed) return;
  switch (act) {
    case "run-line":
      runCurrentLine();
      return;
    case "run-all":
      runScript();
      return;
    case "cut":
      ed.focus();
      document.execCommand("cut");
      return;
    case "copy":
      ed.focus();
      document.execCommand("copy");
      return;
    case "paste":
      ed.focus();
      // ブラウザは contextmenu 由来 click でも paste 権限を出さない場合がある
      navigator.clipboard?.readText().then(t => {
        if (t == null) return;
        const s = ed.selectionStart, e = ed.selectionEnd;
        ed.value = ed.value.slice(0, s) + t + ed.value.slice(e);
        ed.selectionStart = ed.selectionEnd = s + t.length;
        autoSaveScript();
        updateScriptHighlight();
      }).catch(() => { /* 権限なし: 黙って諦める */ });
      return;
    case "select-line": {
      const value = ed.value;
      const before = value.slice(0, ed.selectionStart);
      const start = before.lastIndexOf("\n") + 1;
      const nl = value.indexOf("\n", start);
      const end = nl === -1 ? value.length : nl;
      ed.focus();
      ed.selectionStart = start;
      ed.selectionEnd = end;
      updateScriptHighlight();
      return;
    }
    case "delete-line": {
      const value = ed.value;
      const before = value.slice(0, ed.selectionStart);
      const start = before.lastIndexOf("\n") + 1;
      const nl = value.indexOf("\n", start);
      const end = nl === -1 ? value.length : nl + 1;
      ed.focus();
      ed.selectionStart = start;
      ed.selectionEnd = end;
      // execCommand で消すと undo に乗る
      const ok = document.execCommand("delete");
      if (!ok) {
        ed.value = value.slice(0, start) + value.slice(end);
        ed.selectionStart = ed.selectionEnd = start;
      }
      autoSaveScript();
      updateScriptHighlight();
      return;
    }
  }
}

function wireScriptPanel() {
  $("#scriptCollapse").addEventListener("click", closeScriptPanel);
  $("#scriptRun").addEventListener("click",  runScript);
  $("#scriptStop").addEventListener("click", () => state._script?.runner?.stop());
  // mock トグル: セッション内のみ (persist しない)。 ON で実通信せずローカル応答。
  $("#scriptMock").addEventListener("click", (e) => {
    state.scriptMock = !state.scriptMock;
    const btn = e.currentTarget;
    btn.classList.toggle("is-on", state.scriptMock);
    btn.setAttribute("aria-pressed", state.scriptMock ? "true" : "false");
    setScriptStatus(state.scriptMock ? "MOCK モード ON (ローカル応答・実通信なし)" : "MOCK モード OFF", state.scriptMock ? "running" : "");
    // ハイライトを mock ON/OFF で切替: $> は ON=mock 色 / OFF=dim、 > は ON=dim / OFF=通常
    updateScriptHighlight();
    setTimeout(() => { if (!state._script) setScriptStatus("", ""); }, 2500);
  });
  $("#scriptClear").addEventListener("click", () => {
    const ed = $("#scriptEditor");
    if (!ed.value) return;
    ed.focus();
    ed.setSelectionRange(0, ed.value.length);
    // execCommand("delete") leaves the deletion on the textarea's undo stack
    // so the user can recover the content with Cmd/Ctrl+Z. value="" doesn't.
    const ok = document.execCommand("delete");
    if (!ok) {
      ed.value = "";
      autoSaveScript();
      refreshScriptChips();
      updateScriptHighlight();
    }
  });

  // editor: 入力で chip 再filter + highlight 更新 + 自動保存
  ["input", "keyup", "click"].forEach(ev =>
    $("#scriptEditor").addEventListener(ev, () => { refreshScriptChips(); updateScriptHighlight(); })
  );
  $("#scriptEditor").addEventListener("input", autoSaveScript);
  $("#scriptEditor").addEventListener("scroll", () => {
    const ed = $("#scriptEditor");
    const hl = $("#scriptHighlight");
    const g  = $("#scriptGutter");
    hl.scrollTop  = ed.scrollTop;
    hl.scrollLeft = ed.scrollLeft;
    if (g) g.scrollTop = ed.scrollTop;
    // cursor-bar の絶対位置を再計算しないと、 textarea スクロールだけ動いて
    // bar が取り残される。 gutter 番号の再描画も走るが、 これがバーの top も更新する。
    updateScriptGutter();
  });
  $("#scriptRunLine").addEventListener("click", runCurrentLine);

  // editor 上で右クリック → 独自メニュー
  $("#scriptEditor").addEventListener("contextmenu", showScriptContextMenu);
  // メニュー外をクリック / scroll / Escape で閉じる
  document.addEventListener("click", (e) => {
    const menu = $("#scriptCtxMenu");
    if (!menu || menu.hidden) return;
    if (!e.target.closest("#scriptCtxMenu")) hideScriptContextMenu();
  });
  document.addEventListener("scroll", hideScriptContextMenu, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideScriptContextMenu();
  });
  $("#scriptCtxMenu").addEventListener("click", (e) => {
    const item = e.target.closest(".ctx-item");
    if (!item) return;
    hideScriptContextMenu();
    dispatchScriptContextAction(item.dataset.act);
  });
  $("#scriptEditor").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runScript();
      return;
    }
    if (e.altKey && e.key === "Enter") {
      e.preventDefault();
      runCurrentLine();
      return;
    }
    if (e.key === "Tab") {
      const chip = $("#scriptWindowChips .swc-chip.is-match");
      if (chip) { e.preventDefault(); chip.click(); }
      return;
    }
    // 素の Enter: 現在行が `< name: text` (text 有り) なら `\n> name\n` を挿入
    // (送信のあとに自動で wait を補完)
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ed = e.target;
      const cursor = ed.selectionStart;
      const before = ed.value.slice(0, cursor);
      const after  = ed.value.slice(ed.selectionEnd);
      const lineStart = before.lastIndexOf("\n") + 1;
      const currentLine = before.slice(lineStart);
      const m = currentLine.match(/^<\s+(.+?)\s*:\s*(\S.*?)\s*$/);
      if (m) {
        const name = m[1].trim();
        e.preventDefault();
        const insert = `\n> ${name}\n`;
        ed.value = before + insert + after;
        ed.selectionStart = ed.selectionEnd = before.length + insert.length;
        autoSaveScript();
        refreshScriptChips();
        updateScriptHighlight();
      }
    }
  });

  // 上端ドラッグで panel 高さ調整
  const panel  = $("#scriptPanel");
  const handle = $("#scriptResize");
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = state.scriptPanelHeight;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    const onMove = (ev) => {
      const h = Math.max(140, Math.min(window.innerHeight - 120, startH + (startY - ev.clientY)));
      state.scriptPanelHeight = h;
      panel.style.setProperty("--script-panel-h", h + "px");
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      dirty();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

}

// ═══════════════════════════════════════════════════════
// BACKUP — export / import the full saved snapshot
// ═══════════════════════════════════════════════════════
async function openImportPicker() {
  const choice = await modalChoice({
    title: "Import configuration",
    message: "Load a saved snapshot. This replaces the current connections, catalogs and scripts.",
    choices: [
      { id: "file",   label: "From file…",        description: "Pick a .json file from this device" },
      { id: "remote", label: "From remote site…", description: "Fetch from the scenario repository or a direct URL" }
    ]
  });
  if (choice === "file") {
    $("#importFile").click();
  } else if (choice === "remote") {
    await importFromRemoteSiteFlow();
  }
}

// Import from remote site — repository (bundled snapshots) か direct URL かを選ばせてから
// それぞれの既存フローに分岐する。
async function importFromRemoteSiteFlow() {
  const where = await modalChoice({
    title: "Import from remote site",
    message: "Where should the snapshot come from?",
    choices: [
      { id: "repo", label: "Repository", description: "Pick from the bundled scenario list" },
      { id: "url",  label: "Direct URL", description: "Fetch a JSON snapshot from an HTTP(S) URL" }
    ]
  });
  if (where === "repo") {
    await importFromRepositoryFlow();
  } else if (where === "url") {
    await importFromUrlFlow();
  }
}

function wireBackup() {
  $("#btnExport").addEventListener("click", async () => {
    const ok = await modalConfirm({
      title:        "Export configuration?",
      message:      "The file will contain connections, catalogs and scripts — including OAuth client secrets and access tokens. Treat it as sensitive.",
      confirmLabel: "Continue"
    });
    if (!ok) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultName = `atelier-export-${stamp}`;
    const inputName = await modalPrompt({
      title:        "Name this export",
      label:        "File name (.json appended automatically)",
      placeholder:  defaultName,
      defaultValue: defaultName,
      confirmLabel: "Export"
    });
    if (!inputName) return;
    const safe = inputName.replace(/\.json$/i, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || defaultName;
    try {
      // Ensure pending debounced save is flushed so the export reflects the latest state
      persist.save(state);
      const json = persist.exportJson();
      const blob = new Blob([json], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${safe}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      await modalAlert({ title: "Export failed", message: err?.message || String(err) });
    }
  });

  $("#btnReset").addEventListener("click", async () => {
    const ok = await modalConfirm({
      title:        "Reset all settings?",
      message:      "Connections, catalogs, scripts, workspaces をすべて消去し、ページを再読み込みします。Undo できません。",
      confirmLabel: "Reset",
      danger:       true
    });
    if (!ok) return;
    try {
      // localStorage の atelier:* と sessionStorage の atelier:* をすべて削除
      const lsKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("atelier:")) lsKeys.push(k);
      }
      lsKeys.forEach(k => localStorage.removeItem(k));
      const ssKeys = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith("atelier:")) ssKeys.push(k);
      }
      ssKeys.forEach(k => sessionStorage.removeItem(k));
    } catch (e) {
      console.warn("reset failed:", e);
    }
    location.reload();
  });

  $("#btnImport").addEventListener("click", openImportPicker);

  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";   // reset so picking the same file twice re-triggers
    if (!file) return;
    try {
      const text = await file.text();
      await applyImport(text, `“${file.name}”`);
    } catch (err) {
      await modalAlert({ title: "Import failed", message: err?.message || String(err) });
    }
  });
}

// ─── shared import dispatcher ───────────────────────────
// Ask user for scope (all / scripts-only) and apply.
async function chooseImportScope() {
  return await modalChoice({
    title:   "What to import?",
    message: "Pick the scope of this import.",
    choices: [
      { id: "all",     label: "Everything",     description: "Replace connections, catalogs and scenarios — page will reload" },
      { id: "scripts", label: "Scenarios only", description: "Merge scenarios into the current set — no reload, current connections kept" }
    ]
  });
}

// Returns true if import happened (so caller can persist URL history etc.).
async function applyImport(text, sourceLabel, presetScope) {
  // presetScope が渡されたら scope ダイアログを省略 (repository フローが
  // "Scenarios only" チェックボックスで既に決めているケース)。
  const scope = presetScope || await chooseImportScope();
  if (!scope) return false;
  if (scope === "all") {
    const ok = await modalConfirm({
      title:        "Replace everything?",
      message:      `Replace current connections, catalogs and scenarios with ${sourceLabel}? The page will reload.`,
      confirmLabel: "Replace",
      danger:       true
    });
    if (!ok) return false;
    try {
      persist.importJson(text);
    } catch (e) {
      if (e.code === "IMPORT_UNSAFE") {
        const proceed = await modalConfirm({
          title:        "Snapshot に注意点があります",
          message:      "次の項目が検出されました。 信頼できる発行元の snapshot か確認してください:\n\n  - " +
                        (e.warnings || []).join("\n  - ") +
                        "\n\nそれでも import しますか？",
          confirmLabel: "import を続行",
          danger:       true
        });
        if (!proceed) return false;
        persist.importJson(text, { allowOverride: true });
      } else {
        await modalAlert({ title: "Import に失敗しました", message: String(e.message || e) });
        return false;
      }
    }
    sessionStorage.setItem("atelier:tileAfterImport", "1");
    location.reload();
    return true;
  }
  if (scope === "scripts") {
    const n = importScriptsOnly(text);
    await modalAlert({
      title:   "Scenarios imported",
      message: `${n} scenario${n === 1 ? "" : "s"} added from ${sourceLabel}.`
    });
    return true;
  }
  return false;
}

// Merge `scripts[]` from a snapshot into state.scripts without touching anything else.
// 名前が衝突したら "name (2)", "name (3)" ... と suffix を付ける。
function importScriptsOnly(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON: not an object");
  const inner = parsed.state ?? parsed;
  const incoming = Array.isArray(inner?.scripts) ? inner.scripts : [];
  if (!incoming.length) throw new Error("No scenarios found in the snapshot");
  const taken = new Set(state.scripts.map(s => s.name));
  const uniqueName = (n) => {
    if (!taken.has(n)) return n;
    let i = 2;
    while (taken.has(`${n} (${i})`)) i++;
    return `${n} (${i})`;
  };
  let added = 0;
  for (const sc of incoming) {
    const name = uniqueName(sc.name || `imported scenario ${scriptCounter + 1}`);
    taken.add(name);
    const id = `scr-${++scriptCounter}`;
    state.scripts.push({
      id, name,
      body:      typeof sc.body === "string" ? sc.body : "",
      autoLoop:  false,
      createdAt: typeof sc.createdAt === "number" ? sc.createdAt : Date.now(),
      updatedAt: Date.now()
    });
    added++;
  }
  renderScripts();
  dirty();
  return added;
}

// ─── URL から import ─────────────────────────────────────
const IMPORT_URL_HISTORY_KEY = "atelier:importUrlHistory:v1";
function loadImportUrlHistory() {
  try { return JSON.parse(localStorage.getItem(IMPORT_URL_HISTORY_KEY) || "[]"); }
  catch { return []; }
}
function saveImportUrlHistory(list) {
  try { localStorage.setItem(IMPORT_URL_HISTORY_KEY, JSON.stringify(list.slice(0, 5))); } catch {}
}
async function importFromUrlFlow() {
  const history = loadImportUrlHistory();
  const placeholder = history[0] || "https://example.com/scenarios/scrs-step2.json";
  const url = await modalPrompt({
    title:        "Import from URL",
    label:        "JSON snapshot URL",
    placeholder,
    defaultValue: history[0] || "",
    confirmLabel: "Fetch"
  });
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    await modalAlert({ title: "Invalid URL", message: "URL は http:// または https:// で始めてください。" });
    return;
  }
  try {
    // 同一オリジン (=relative path / dev-server 上の /scenarios/...) は直接 fetch、
    // 外部オリジンは dev-server の /proxy?url=... 経由で CORS を回避。
    let target = url;
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin) target = `/proxy?url=${encodeURIComponent(u.toString())}`;
      else target = u.pathname + u.search;
    } catch {}
    const res = await fetch(target, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    JSON.parse(text);   // sanity
    const ok = await applyImport(text, `"${url}"`);
    if (ok) saveImportUrlHistory([url, ...history.filter(u => u !== url)]);
  } catch (err) {
    await modalAlert({ title: "Import failed", message: err?.message || String(err) });
  }
}

// scenarios リポジトリの取得元。
//   1) 同一オリジン (/scenarios/...) — atelier-static / dev-server が静的配信する場合
//   2) GitHub raw — どこで開いていても、 push 済みの最新ファイルを直接読む (再デプロイ不要)
// raw.githubusercontent.com は CORS 許可 (ACAO:*) なのでブラウザから直接 fetch 可能。
const SCENARIO_REPO_RAW = "https://raw.githubusercontent.com/tmiya4ta/agent-atelier/feat/mdm-list-suppliers";

// index の item.url は同一オリジン相対パス (/scenarios/xxx.json) なので、
// GitHub raw から読むときは base を付け替える。
function resolveScenarioUrl(url, base) {
  if (!base) return url;                       // 同一オリジン: そのまま
  if (/^https?:\/\//.test(url)) return url;     // 絶対 URL はそのまま
  return base + (url.startsWith("/") ? url : "/" + url);
}

// ─── Repository (scenarios/index.json) から import ───
async function importFromRepositoryFlow() {
  // **GitHub raw を優先**: push 済みの最新シナリオを、 アプリを再デプロイせずに読む。
  // raw が取れないとき (オフライン等) だけ同一オリジン (atelier-static / dev-server 同梱) に
  // フォールバックする。
  let items, repoBase = SCENARIO_REPO_RAW;
  try {
    const res = await fetch(`${SCENARIO_REPO_RAW}/scenarios/index.json`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const idx = await res.json();
    items = Array.isArray(idx?.items) ? idx.items : [];
  } catch (errRaw) {
    try {
      const res = await fetch("/scenarios/index.json", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const idx = await res.json();
      items = Array.isArray(idx?.items) ? idx.items : [];
      repoBase = "";   // 同一オリジン: item.url をそのまま使う
    } catch (errLocal) {
      await modalAlert({
        title:   "Repository not available",
        message: `scenarios/index.json を取得できませんでした。\n- GitHub raw: ${errRaw?.message || errRaw}\n- 同一オリジン: ${errLocal?.message || errLocal}`
      });
      return;
    }
  }
  if (!items.length) {
    await modalAlert({ title: "Repository is empty", message: "Bundled snapshot がありません。" });
    return;
  }
  // snapshot 選択 + "Scenarios only" チェックボックスを 1 ダイアログにまとめる。
  // チェック ON → scenarios のみ merge / OFF → everything 置換。
  // これで scope を聞く 2 つ目のダイアログ (chooseImportScope) を省略でき、 クリック数が減る。
  const result = await modalChoice({
    title:   "Import from repository",
    message: "Pick a snapshot to import.",
    choices: items.map(it => ({
      id:          it.url,
      label:       it.name || it.id || it.url,
      description: it.description || it.url
    })),
    extras: [
      { id: "scriptsOnly", label: "Scenarios only", description: "Merge scenarios only — keep current connections, no reload", defaultChecked: true }
    ]
  });
  const pick = result?.id;
  if (!pick) return;
  const scope = result?.extras?.scriptsOnly ? "scripts" : "all";
  try {
    const fetchUrl = resolveScenarioUrl(pick, repoBase);
    const res = await fetch(fetchUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    JSON.parse(text);   // sanity
    const picked = items.find(it => it.url === pick);
    const label = picked?.name || picked?.id || pick;
    await applyImport(text, `"${label}"${repoBase ? " (GitHub)" : ""}`, scope);
  } catch (err) {
    await modalAlert({ title: "Import failed", message: err?.message || String(err) });
  }
}

function loadDemo() {
  updateEmptyState();
  DEMO_AGENTS.forEach((a, i) => {
    setTimeout(() => {
      connect({ protoId: a.proto, url: a.url, name: a.name, persona: a.persona }, { skipDialog: true });
    }, i * 180);
  });
  setTimeout(tileWindows, DEMO_AGENTS.length * 180 + 200);
}

// Tiling: 現在の各ウインドウの サイズと位置を見て、 もっとも自然な配置に揃える。
//
// アルゴリズム選択:
//   1. ウインドウが 1 個 → 全画面
//   2. main + stack: 1 つだけ突出して大きく、 かつ左寄りなら左 main + 右 stack
//   3. fallback: 等分グリッド (n=2:1x2, n=3:1x3, n>=4:2 行 col=ceil(n/2))
//
// stack の上下順序は、 元の y 座標が小さい (上にある) ものから採用。
// 最終的に各ウインドウの el.style.{left,top,width,height} を更新し dirty() で永続化。
// tile ボタンで cycle するのは「ユーザの配置を上書きする」3 モードだけ。
// fit モード ("snap to current") は別ボタンに分離 — 既存配置を尊重するので意味が逆。
const TILE_MODES = ["smart", "uniform", "columns"];
let _tileModeIdx = -1;
// tile 計算中、 unpinned を配置する空き矩形の原点ずれ。 applyTile が最終座標に加算する。
let _layoutOffset = { x: 0, y: 0 };

// ピン留めウィンドウの占有領域を避けた最大の空き矩形を返す。
// レイヤ全体 (W×H) から、 ピン群の bounding box を引いた上/下/左/右の 4 ストリップのうち
// 面積最大のものを採用する (ピンが端に寄っているデモ用途では完全に回避できる)。
// ピンが無ければレイヤ全体をそのまま返す。
function freeLayoutRect(pinned, W, H, gap) {
  if (!pinned || pinned.length === 0) return { x: 0, y: 0, w: W, h: H };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pinned.forEach(p => {
    const x = parseFloat(p.el.style.left) || 0;
    const y = parseFloat(p.el.style.top)  || 0;
    const w = p.el.offsetWidth  || 0;
    const h = p.el.offsetHeight || 0;
    minX = Math.min(minX, x);     minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  });
  // 4 候補ストリップ (ピン bbox の外側、 gap ぶん離す)
  const candidates = [
    { x: 0,          y: 0,          w: W,                  h: minY - gap },          // 上
    { x: 0,          y: maxY + gap, w: W,                  h: H - (maxY + gap) },    // 下
    { x: 0,          y: 0,          w: minX - gap,         h: H },                   // 左
    { x: maxX + gap, y: 0,          w: W - (maxX + gap),   h: H }                    // 右
  ];
  let best = null, bestArea = -1;
  candidates.forEach(c => {
    if (c.w <= 80 || c.h <= 80) return;   // 狭すぎるストリップは無効
    const area = c.w * c.h;
    if (area > bestArea) { bestArea = area; best = c; }
  });
  // どのストリップも狭すぎる (ピンが中央を大きく占有) 場合は全面に重ねるしかない → 全体を返す
  return best || { x: 0, y: 0, w: W, h: H };
}
function cycleTileMode() {
  _tileModeIdx = (_tileModeIdx + 1) % TILE_MODES.length;
  const mode = TILE_MODES[_tileModeIdx];
  tileWindows(mode);
  flashTileLabel(mode);
}
function flashTileLabel(mode) {
  const btn = $("#btnLayout");
  if (!btn) return;
  btn.dataset.tileMode = mode;
  btn.title = `Layout: ${mode} (click to cycle)`;
}

function tileWindows(mode) {
  const realWs = activeWorkspace();
  if (!realWs) return;
  // ピン留めウィンドウはレイアウト対象から除外し、その場に固定する。
  // 以降の tile ロジックは ws.windows しか参照しないので、 unpinned だけの shim を渡せば
  // 全モード (uniform / columns / fit / smart / 5-grid) が自動的にピンを尊重する。
  const pinned = realWs.windows.filter(w => w.pinned);
  const ws = { windows: realWs.windows.filter(w => !w.pinned) };
  const rect = $("#windowsLayer").getBoundingClientRect();
  const n = ws.windows.length;
  if (n === 0) { _layoutOffset = { x: 0, y: 0 }; return; }

  const gap = 16;
  // ピン留め領域を避けた「空き矩形」を求め、 unpinned はその中だけに並べる。
  // 全 tile ヘルパは gap 基準で (0,0)〜(W,H) に配置するので、 空き矩形ぶんの原点ずれを
  // _layoutOffset に積み、 applyTile が最終座標に加算する。
  const free = freeLayoutRect(pinned, rect.width, rect.height, gap);
  _layoutOffset = { x: free.x, y: free.y };
  const W = free.w, H = free.h;

  if (mode === "uniform") return tileUniform(ws, W, H, gap);
  if (mode === "columns") return tileColumns(ws, W, H, gap);
  if (mode === "fit")     return tileFit(ws, W, H, gap);
  // mode === "smart" or undefined → 既存ロジック

  // --- 1) 単独 → 全画面 ---
  if (n === 1) {
    applyTile([{ win: ws.windows[0], x: gap, y: gap, w: W - 2*gap, h: H - 2*gap }]);
    return;
  }

  // --- 1.5) 5 windows → 2x3 grid + feature cell (tile2.png pattern) ---
  if (n === 5) {
    const measured = ws.windows.map(win => {
      const x = parseFloat(win.el.style.left) || 0;
      const y = parseFloat(win.el.style.top)  || 0;
      const w = win.el.offsetWidth  || 0;
      const h = win.el.offsetHeight || 0;
      return { win, x, y, w, h, area: w*h, cx: x + w/2, cy: y + h/2 };
    });
    const main   = [...measured].sort((a, b) => b.area - a.area)[0];
    const others = measured.filter(o => o !== main);

    const cellW = Math.floor((W - 4 * gap) / 3);
    const cellH = Math.floor((H - 3 * gap) / 2);
    const cell  = (row, col, rowSpan = 1, colSpan = 1) => ({
      x: gap + col * (cellW + gap),
      y: gap + row * (cellH + gap),
      w: colSpan * cellW + (colSpan - 1) * gap,
      h: rowSpan * cellH + (rowSpan - 1) * gap
    });

    const inTop  = main.cy < H * 0.5;
    const inLeft = main.cx < W * 0.5;

    let mainCell, smallCells;
    if (inTop && inLeft) {
      // Feature TL: 上段 [LARGE×2, small] / 下段 [s, s, s]
      mainCell   = cell(0, 0, 1, 2);
      smallCells = [cell(0, 2), cell(1, 0), cell(1, 1), cell(1, 2)];
    } else if (inTop && !inLeft) {
      // Feature TR: 上段 [small, LARGE×2] / 下段 [s, s, s]
      mainCell   = cell(0, 1, 1, 2);
      smallCells = [cell(0, 0), cell(1, 0), cell(1, 1), cell(1, 2)];
    } else if (!inTop && inLeft) {
      // Feature BL: 上段 [s, s, s] / 下段 [LARGE×2, small]
      mainCell   = cell(1, 0, 1, 2);
      smallCells = [cell(0, 0), cell(0, 1), cell(0, 2), cell(1, 2)];
    } else {
      // Feature BR (tile2.png デフォルト): 上段 [s, s, s] / 下段 [small, LARGE×2]
      mainCell   = cell(1, 1, 1, 2);
      smallCells = [cell(0, 0), cell(0, 1), cell(0, 2), cell(1, 0)];
    }

    // 残りウインドウは現在位置の reading order (上→下、左→右) で割り当て
    others.sort((a, b) => {
      if (Math.abs(a.cy - b.cy) > 60) return a.cy - b.cy;
      return a.cx - b.cx;
    });

    const placements = [{ win: main.win, ...mainCell }];
    others.forEach((o, i) => placements.push({ win: o.win, ...smallCells[i] }));
    applyTile(placements);
    return;
  }

  // --- 2) main + stack 判定 ---
  const wins = ws.windows.map(win => {
    const x = parseFloat(win.el.style.left)   || 0;
    const y = parseFloat(win.el.style.top)    || 0;
    const w = win.el.offsetWidth  || 0;
    const h = win.el.offsetHeight || 0;
    return { win, x, y, w, h, area: w * h, cx: x + w/2 };
  });
  const sorted = [...wins].sort((a, b) => b.area - a.area);
  const main = sorted[0];
  const others = sorted.slice(1);
  const otherAvgArea = others.reduce((s, x) => s + x.area, 0) / others.length;
  const isMainBig    = main.area >= otherAvgArea * 1.3;
  const isMainLeft   = main.cx < W * 0.5;
  const isMainRight  = main.cx >= W * 0.5;

  if (isMainBig && isMainLeft) {
    // 左 main + 右 stack
    const colW = Math.floor((W - 3 * gap) / 2);
    const stackSorted = others.sort((a, b) => a.y - b.y);
    const stackH = Math.floor((H - (stackSorted.length + 1) * gap) / stackSorted.length);
    const placements = [
      { win: main.win, x: gap, y: gap, w: colW, h: H - 2 * gap }
    ];
    stackSorted.forEach((o, i) => {
      placements.push({
        win: o.win,
        x: gap + colW + gap,
        y: gap + i * (stackH + gap),
        w: colW,
        h: stackH
      });
    });
    applyTile(placements);
    return;
  }
  if (isMainBig && isMainRight) {
    // 右 main + 左 stack (mirror)
    const colW = Math.floor((W - 3 * gap) / 2);
    const stackSorted = others.sort((a, b) => a.y - b.y);
    const stackH = Math.floor((H - (stackSorted.length + 1) * gap) / stackSorted.length);
    const placements = [
      { win: main.win, x: gap + colW + gap, y: gap, w: colW, h: H - 2 * gap }
    ];
    stackSorted.forEach((o, i) => {
      placements.push({
        win: o.win,
        x: gap,
        y: gap + i * (stackH + gap),
        w: colW,
        h: stackH
      });
    });
    applyTile(placements);
    return;
  }

  // --- 3) fallback grid ---
  const cols = n <= 3 ? n : Math.ceil(n / 2);
  const rows = Math.ceil(n / cols);
  const w = Math.floor((W - gap * (cols + 1)) / cols);
  const h = Math.floor((H - gap * (rows + 1)) / rows);
  const placements = ws.windows.map((win, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { win, x: gap + col * (w + gap), y: gap + row * (h + gap), w, h };
  });
  applyTile(placements);
}

// すべてのウインドウを同じサイズで grid 配置 (画面全体を均等に埋める)
function tileUniform(ws, W, H, gap) {
  const n = ws.windows.length;
  // 縦横比に近い分割を選ぶ (cols × rows >= n を満たす中で w/h が画面比に近いもの)
  const aspect = W / H;
  let bestCols = 1, bestScore = -Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = (W - gap * (cols + 1)) / cols;
    const h = (H - gap * (rows + 1)) / rows;
    if (w <= 0 || h <= 0) continue;
    const cellAspect = w / h;
    // 画面のアスペクトに近いほど高得点 (1 に近いほど square cell)
    const score = -Math.abs(Math.log(cellAspect / aspect));
    if (score > bestScore) { bestScore = score; bestCols = cols; }
  }
  const cols = bestCols;
  const rows = Math.ceil(n / cols);
  const w = Math.floor((W - gap * (cols + 1)) / cols);
  const h = Math.floor((H - gap * (rows + 1)) / rows);
  const placements = ws.windows.map((win, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { win, x: gap + col * (w + gap), y: gap + row * (h + gap), w, h };
  });
  applyTile(placements);
}

// 既存ウインドウの位置・サイズを尊重して、行/列構造に snap する fit モード
//   - 縦方向に行を検出（cy が上下範囲に重なるなら同じ row）
//   - 各 row 内は X 順、widths は現在幅に比例させて画面幅いっぱいに伸ばす
//   - 行の高さは row 最大高に比例（高い行はそのまま大きく、低い行は小さく）
function tileFit(ws, W, H, gap) {
  const items = ws.windows.map(win => {
    const x = parseFloat(win.el.style.left) || 0;
    const y = parseFloat(win.el.style.top)  || 0;
    const w = win.el.offsetWidth  || 0;
    const h = win.el.offsetHeight || 0;
    return { win, x, y, w, h, cx: x + w/2, cy: y + h/2, top: y, bottom: y + h };
  });
  if (items.length === 0) return;

  // ── 行クラスタリング: cy 順に走査して、現 row の範囲に center-y が入れば同じ row へ ──
  const byY = [...items].sort((a, b) => a.cy - b.cy);
  const rows = [];
  byY.forEach(it => {
    const cur = rows[rows.length - 1];
    if (cur) {
      const rowTop    = Math.min(...cur.map(p => p.top));
      const rowBottom = Math.max(...cur.map(p => p.bottom));
      const overlapTol = 24; // 多少のずれは許容
      if (it.cy < rowBottom - overlapTol && it.cy > rowTop - overlapTol) {
        cur.push(it);
        return;
      }
    }
    rows.push([it]);
  });

  // 行高は「row 内の最大 h」に比例配分
  const rowHeights = rows.map(r => Math.max(...r.map(p => p.h)));
  const sumH = rowHeights.reduce((s, h) => s + h, 0) || 1;
  const availH = H - gap * (rows.length + 1);

  let yCursor = gap;
  const placements = [];
  rows.forEach((row, ri) => {
    row.sort((a, b) => a.cx - b.cx);
    const cellH = (ri === rows.length - 1)
      ? (H - gap - yCursor)                        // 最終行は端数を吸収
      : Math.floor(availH * rowHeights[ri] / sumH);
    const sumW = row.reduce((s, p) => s + p.w, 0) || 1;
    const availW = W - gap * (row.length + 1);
    let xCursor = gap;
    row.forEach((it, ci) => {
      const cellW = (ci === row.length - 1)
        ? (W - gap - xCursor)                      // 行内の最後は端数吸収
        : Math.floor(availW * it.w / sumW);
      placements.push({ win: it.win, x: xCursor, y: yCursor, w: cellW, h: cellH });
      xCursor += cellW + gap;
    });
    yCursor += cellH + gap;
  });
  applyTile(placements);
}

// 縦に並べる column 配置 — N 個の縦長カラムに均等配分
function tileColumns(ws, W, H, gap) {
  const n = ws.windows.length;
  const cols = Math.min(n, Math.max(2, Math.round(W / 380)));
  const colW = Math.floor((W - gap * (cols + 1)) / cols);
  // 各カラムへの割り振り (left-to-right)
  const per = Array.from({ length: cols }, () => []);
  ws.windows.forEach((win, i) => per[i % cols].push(win));
  const placements = [];
  per.forEach((col, ci) => {
    const k = col.length;
    const cellH = Math.floor((H - gap * (k + 1)) / k);
    col.forEach((win, ri) => {
      placements.push({
        win,
        x: gap + ci * (colW + gap),
        y: gap + ri * (cellH + gap),
        w: colW,
        h: cellH
      });
    });
  });
  applyTile(placements);
}

function applyTile(placements) {
  const ox = _layoutOffset?.x || 0;
  const oy = _layoutOffset?.y || 0;
  placements.forEach(({ win, x, y, w, h }) => {
    win.el.style.transition = "left .3s ease, top .3s ease, width .3s ease, height .3s ease";
    win.el.style.left   = (x + ox) + "px";
    win.el.style.top    = (y + oy) + "px";
    win.el.style.width  = w + "px";
    win.el.style.height = h + "px";
    setTimeout(() => win.el.style.transition = "", 320);
  });
  dirty();
}

// ─── Dialog ─────────────────────────────────────────
function wireDialog() {
  $("#dlgClose").addEventListener("click", closeDialog);
  $("#dlgCancel").addEventListener("click", closeDialog);
  // 背景クリックでClose挙動は廃止 (誤操作で入力が消えるのを防ぐ)
  $("#dlgSubmit").addEventListener("click", submitDialog);
  $("#dlgTest").addEventListener("click", testDialog);
  $("#dlgUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitDialog();
  });
  $("#dlgUrl").addEventListener("input", clearDialogTest);

  const authSel = $("#dlgAuthRef");
  if (authSel) {
    authSel.addEventListener("change", () => {
      if (authSel.value !== "__new__") return;
      // 「+ new identity…」→ identity ダイアログを開く。保存後この select に反映。
      authSel.value = "";
      state._authRefReturn = (newId) => { renderAuthRefSelect(newId); };
      openIdentityDialog();
    });
  }
}

function openDialog(opts = {}) {
  const editB = opts.editBookmark || null;
  state._editingBookmarkKey = editB ? editB.key : null;

  $("#connectDialog").hidden = false;
  if (editB) state.selectedProto = editB.protoId;
  renderProtoGrid();
  renderAuthRefSelect(editB ? (editB.authRef || "") : "");
  clearDialogTest();

  // 値のプリフィル
  $("#dlgUrl").value  = editB ? (editB.url || "") : "";
  $("#dlgName").value = editB ? (editB.name || "") : "";
  if ($("#dlgChannel")) $("#dlgChannel").value = editB ? (editB.channel || "") : "";

  // 編集モードの見た目: title / CTA / proto と url をロック
  const eyebrow = document.querySelector("#connectDialog .dialog-eyebrow");
  const title   = $("#dlgTitle");
  const submitLabel = $("#dlgSubmit")?.querySelector("span");
  if (editB) {
    if (eyebrow) eyebrow.textContent = "edit connection";
    if (title)   title.innerHTML = "Edit <em>connection</em>";
    if (submitLabel) submitLabel.textContent = "save";
    $("#dlgUrl").readOnly = true;
    $("#dlgUrl").classList.add("is-readonly");
    document.querySelectorAll("#dlgProtoGrid .proto-card").forEach(el => el.disabled = true);
  } else {
    if (eyebrow) eyebrow.textContent = "new connection";
    if (title)   title.innerHTML = "Connect to an <em>agent</em>";
    if (submitLabel) submitLabel.textContent = "connect";
    $("#dlgUrl").readOnly = false;
    $("#dlgUrl").classList.remove("is-readonly");
  }

  setTimeout(() => $(editB ? "#dlgName" : "#dlgUrl").focus(), 50);
}
function closeDialog() {
  $("#connectDialog").hidden = true;
  state._editingBookmarkKey = null;
  clearDialogTest();
}

function clearDialogTest() {
  const row = $("#dlgTestRow");
  const status = $("#dlgTestStatus");
  if (row) row.hidden = true;
  if (status) { status.textContent = ""; status.className = "dialog-test-status"; }
}

function setDialogTestStatus(kind, html) {
  const row = $("#dlgTestRow");
  const status = $("#dlgTestStatus");
  if (!row || !status) return;
  row.hidden = false;
  status.className = `dialog-test-status is-${kind}`;
  status.innerHTML = html;
}

// connect しない接続テスト。 A2A は AgentCard 取得を、 MCP は initialize 応答を確かめる。
async function testDialog() {
  const raw = $("#dlgUrl").value.trim();
  if (!raw) { $("#dlgUrl").focus(); return; }
  const url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
  const protoId = state.selectedProto;
  const authRef = $("#dlgAuthRef")?.value || "";
  const resolved = await resolveAuthForConnection({ authRef: (authRef && authRef !== "__new__") ? authRef : undefined });
  const auth = resolved.auth || "";
  const authHeaders = resolved.authHeaders || null;
  const btn = $("#dlgTest");
  btn.disabled = true;
  setDialogTestStatus("info", "<span class='dts-dot'></span> Testing…");
  const t0 = performance.now();
  try {
    if (protoId === "mcp") {
      const result = await testMcp(url, auth, authHeaders);
      const ms = Math.round(performance.now() - t0);
      setDialogTestStatus("ok",
        `<span class='dts-dot'></span> initialize OK · <code>${escapeHtml(result.serverName || "(no name)")}</code>` +
        (result.protocolVersion ? ` · proto <code>${escapeHtml(result.protocolVersion)}</code>` : "") +
        ` · ${ms}ms`);
    } else if (protoId === "a2a") {
      const result = await testA2a(url, auth, authHeaders);
      const ms = Math.round(performance.now() - t0);
      const cardUrl = result.card?.url;
      const mismatch = cardUrl && !sameOrigin(cardUrl, url);
      setDialogTestStatus(mismatch ? "warn" : "ok",
        `<span class='dts-dot'></span> AgentCard OK · <code>${escapeHtml(result.card?.name || "(no name)")}</code>` +
        ` · ${result.card?.skills?.length || 0} skill${(result.card?.skills?.length || 0) === 1 ? "" : "s"}` +
        ` · ${ms}ms` +
        (mismatch ? `<br/><span class='dts-warn'>⚠ AgentCard.url (<code>${escapeHtml(cardUrl)}</code>) is on a different origin than the discovery URL. Messages will be sent to that URL.</span>` : ""));
    } else {
      setDialogTestStatus("info", `Test for protocol <code>${escapeHtml(protoId)}</code> is not supported yet.`);
    }
  } catch (e) {
    setDialogTestStatus("err", `<span class='dts-dot'></span> ${escapeHtml(e?.message || String(e))}`);
  } finally {
    btn.disabled = false;
  }
}

function sameOrigin(a, b) {
  try {
    const A = new URL(a), B = new URL(b);
    return A.origin === B.origin;
  } catch { return false; }
}

function proxifyForTest(target) {
  try {
    const t = new URL(target);
    if (t.origin === location.origin) return target;
  } catch { /* fallthrough */ }
  return `/proxy?url=${encodeURIComponent(target)}`;
}

async function testMcp(endpoint, auth, authHeaders) {
  const headers = { "Content-Type": "application/json", "Accept": "application/json" };
  if (auth) headers["Authorization"] = `Bearer ${auth}`;
  if (authHeaders) Object.assign(headers, authHeaders);
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "atelier-test", version: "1.0" } }
  });
  const res = await fetch(proxifyForTest(endpoint), { method: "POST", headers, body });
  if (!res.ok) throw new Error(`HTTP ${res.status} on initialize`);
  const data = await res.json();
  if (data.error) throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
  const r = data.result || {};
  return {
    serverName:      r.serverInfo?.name,
    protocolVersion: r.protocolVersion
  };
}

async function testA2a(baseUrl, auth, authHeaders) {
  const headers = { "Accept": "application/json" };
  if (auth) headers["Authorization"] = `Bearer ${auth}`;
  if (authHeaders) Object.assign(headers, authHeaders);
  const candidates = [];
  if (/\/\.well-known\/agent-card\.json\b/.test(baseUrl)) candidates.push(baseUrl);
  else if (/\/\.well-known\/agent\.json\b/.test(baseUrl)) candidates.push(baseUrl);
  else {
    const base = baseUrl.replace(/\/+$/, "");
    candidates.push(`${base}/.well-known/agent-card.json`);
    candidates.push(`${base}/.well-known/agent.json`);
  }
  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await fetch(proxifyForTest(url), { headers });
      if (res.status === 404) { lastErr = new Error(`404 at ${url}`); continue; }
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} at ${url}`); continue; }
      const card = await res.json();
      return { card, candidate: url };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`AgentCard not found at ${candidates.join(", ")}`);
}

async function submitDialog() {
  const raw  = $("#dlgUrl").value.trim();
  const isMock = state.selectedProto === "mock";
  // mock では url field に「agent name」を入れている。display name 行は隠している。
  const name = isMock ? raw : $("#dlgName").value.trim();
  const authRef = $("#dlgAuthRef")?.value || "";
  const channel = $("#dlgChannel")?.value.trim().replace(/^#/, "") || "";
  if (!raw) {
    $("#dlgUrl").focus();
    return;
  }
  const url = isMock
    ? mockUrl(raw)
    : (raw ? (/^https?:\/\//i.test(raw) ? raw : "https://" + raw) : "");
  const cleanAuthRef = (authRef && authRef !== "__new__") ? authRef : undefined;

  // ── 編集モード: 既存 bookmark を更新し、開いているウインドウを新設定で再接続 ──
  const editKey = state._editingBookmarkKey;
  if (editKey) {
    const b = (state.bookmarks || []).find(x => x.key === editKey);
    if (b) {
      const newName = name || b.name;
      b.name = newName;
      b.authRef = cleanAuthRef;
      if (state.selectedProto === "slack") b.channel = channel || "general";
      // 開いているウインドウを新しい auth/name で再接続
      const wins = state.workspaces.flatMap(w => w.windows)
        .filter(w => w.protoId === b.protoId && w.adapter.config.url === b.url);
      const resolved = await resolveAuthForConnection({ authRef: cleanAuthRef, auth: b.auth });
      for (const win of wins) {
        win.adapter.config.name = newName;
        win.adapter.config.authRef = cleanAuthRef;
        win.adapter.config.auth = resolved.auth;
        win.adapter.config.authHeaders = resolved.authHeaders;
        try { await win.adapter.connect(); } catch (e) { console.warn("reconnect after edit failed:", e); }
      }
    }
    state._editingBookmarkKey = null;
    renderBookmarks();
    dirty();
    closeDialog();
    return;
  }

  // submit ボタンを連打防止 + 進行表示
  const btn = $("#dlgSubmit");
  btn.disabled = true;
  const ok = await connect({
    protoId: state.selectedProto,
    url,
    name: name || hostFromUrl(url) || "Untitled",
    authRef: cleanAuthRef,
    channel: state.selectedProto === "slack" ? (channel || "general") : undefined
  });
  btn.disabled = false;

  if (ok) closeDialog();
  // 失敗時はダイアログを残して再入力できるようにする
  else setTimeout(() => $("#dlgUrl").focus(), 50);
}

// ─── Connect ────────────────────────────────────────
async function connect({ protoId, url, name, auth, authRef, persona, channel }, opts = {}) {
  const proto = getProtocol(protoId);
  if (!proto || !proto.AdapterClass) {
    await modalAlert({
      title:   "Protocol not supported yet",
      message: `The ${protoId} adapter is not implemented yet.`
    });
    return false;
  }

  const ws = activeWorkspace();
  // 同じ proto + url の既存ウインドウから「使われている番号」を集めて、最小の空き番号を割り当てる
  // (#2 を削除して再作成しても #3 と衝突せず #2 が再利用される)
  const existing = state.workspaces
    .flatMap(w => w.windows)
    .filter(w => w.protoId === protoId && w.adapter.config.url === url);
  const usedNums = new Set(existing.map(w => {
    const m = (w.instanceSuffix || "").match(/#(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }));
  let n = 1;
  while (usedNums.has(n)) n++;
  const instanceSuffix = n === 1 ? "" : ` #${n}`;

  // authRef があれば identity から実トークン/ヘッダを解決 (無ければ旧 auth 文字列を後方互換で使用)
  const resolved = await resolveAuthForConnection({ authRef, auth });
  const adapter = new proto.AdapterClass({
    url, name, persona, channel,
    auth: resolved.auth,
    authHeaders: resolved.authHeaders,
    authRef
  });

  // ── 接続を先に試す: 失敗時はウインドウを作らず modal で通知 ──
  // (復元時は元々開いてた接続なので、 失敗しても ウインドウだけは作って後で再接続できるようにする)
  if (!opts.restore) {
    try {
      await adapter.connect();
    } catch (e) {
      await modalAlert({
        title:   "Connection failed",
        message: `${name || url}\n\n${e?.message || String(e)}`
      });
      return false;
    }
  }

  const win = new AgentWindow({
    adapter,
    layer: ws.layer,
    onClose: removeWindow,
    onFocus: () => {},
    onChange: () => { dirty(); renderBookmarks(); },  // display name 変更等を左サイドバーに即反映
    instanceSuffix,
    restore: opts.restore,
    // ユーザが connect dialog で display name を明示入力した場合、 AgentCard.name で上書きしない
    lockName: !!opts.lockName || !!(name && name.trim())
  });
  win._wsId = ws.id;
  ws.windows.push(win);

  // bookmark 登録: 同じ proto+url が無ければ追加、 あれば最新の name/authRef/etc に更新
  upsertBookmark({
    protoId, url, name, auth, authRef, persona, channel
  });

  renderTabs();
  renderBookmarks();
  updateStatusLine();
  updateEmptyState();

  adapter.addEventListener("rpc",     () => { ws.events += 1; updateStatusLine(); });
  adapter.addEventListener("message", () => { ws.events += 1; updateStatusLine(); });

  if (!opts.skipDirty) dirty();

  if (!opts.restore) {
    tileWindows();
  } else {
    // 復元時のみここで接続 (失敗してもウインドウは残す)
    try {
      await adapter.connect();
    } catch (e) {
      console.warn("restore reconnect failed:", e);
    }
  }
  return true;
}

function removeWindow(win) {
  const ws = state.workspaces.find(w => w.id === win._wsId);
  if (!ws) return;
  ws.windows = ws.windows.filter(w => w !== win);
  renderTabs();
  renderBookmarks();   // bookmark tree からも除外
  updateStatusLine();
  updateEmptyState();
  dirty();
}

// ─── Status / empty ──────────────────────────────────────
function updateStatusLine() {
  const ws = activeWorkspace();
  $("#statusConns").textContent       = String(ws?.windows.length ?? 0);
  $("#statusEvents").textContent      = String(ws?.events ?? 0);
  $("#statusWorkspaces").textContent  = String(state.workspaces.length);
}

function updateEmptyState() {
  const ws = activeWorkspace();
  $("#emptyState").classList.toggle("is-hidden", !ws || ws.windows.length > 0);
}

// ─── Clock ──────────────────────────────────────────
function wireClock() {
  const tick = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    $("#sideClock").textContent = `${hh}:${mm}:${ss}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ─── Keyboard ────────────────────────────────────────
function wireKeyboard() {
  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;

    // Ctrl+N / Ctrl+T はブラウザの新ウインドウ / 新タブに予約されており横取り不可。
    // openDialog / createWorkspace はそれぞれサイドバーの "+ new connection" ボタン
    // と ws-add ボタンから操作する前提に変更 (UI からショートカット表示も削除済み)。
    if (meta && e.shiftKey && (e.key === "{" || e.key === "[")) {
      e.preventDefault();
      switchWorkspaceRel(-1);
      return;
    }
    if (meta && e.shiftKey && (e.key === "}" || e.key === "]")) {
      e.preventDefault();
      switchWorkspaceRel(+1);
      return;
    }
    if (e.key === "Escape") {
      if (!$("#connectDialog").hidden) closeDialog();
      if (!$("#catalogDialog").hidden) closeCatalogDialog();
      return;
    }
    // ⌘⇧K で script panel toggle
    if (meta && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      toggleScriptPanel();
      return;
    }
    // ⌘W で現在の script tab をClose (panel 開いてる時 + editor フォーカス時のみ)
    if (meta && e.key.toLowerCase() === "w" && state.scriptPanelOpen
        && document.activeElement?.id === "scriptEditor") {
      e.preventDefault();
      if (state.selectedScriptId) closeScriptTab(state.selectedScriptId);
      return;
    }
    // ⌘. で stop
    if (meta && e.key === "." && state.scriptPanelOpen) {
      e.preventDefault();
      state._script?.runner?.stop();
      return;
    }
    if (meta && /^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const win = activeWorkspace()?.windows[idx];
      if (win) { win.focus(); e.preventDefault(); }
    }
  });
}

function switchWorkspaceRel(delta) {
  const idx = state.workspaces.findIndex(w => w.id === state.activeWs);
  const next = (idx + delta + state.workspaces.length) % state.workspaces.length;
  switchWorkspace(state.workspaces[next].id);
}

// ─── helpers ─────────────────────────────────────────
function hostFromUrl(u) {
  try {
    const x = new URL(/^https?:\/\//.test(u) ? u : "https://" + u);
    return x.host;
  } catch { return ""; }
}
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
