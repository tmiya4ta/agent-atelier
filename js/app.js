// Atelier · Agent Workbench — entry point
// ─────────────────────────────────────────
// ワークスペース(タブ)、サイドバー、接続ダイアログ、フローティングウインドウ管理

import { PROTOCOLS, getProtocol }           from "./protocols/index.js";
import { AgentWindow }                      from "./window.js";
import * as persist                         from "./persist.js";
import { modalConfirm, modalAlert, modalPrompt } from "./modal.js";
import { runAuthCodeFlow, redirectUri }     from "./oauth.js";
import { parseScript, ScriptRunner }        from "./script.js";

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
  selectedCatalogFlow: "authcode",
  zoom: 1.0,
  sidebarCollapsed: false,
  catalogs: [],       // [{ id, name, flow, baseUrl, orgId, envId, clientId, clientSecret?, scopes, status, createdAt }]
  scripts: [],        // [{ id, name, body, createdAt, updatedAt }]
  selectedScriptId: null,
  openScriptIds: [],  // panel に open しているタブの順序
  scriptPanelOpen: false,
  scriptPanelHeight: 480
};

const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;

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
    state.catalogs         = (saved.catalogs || []).map(migrateCatalog);
    state.scripts          = saved.scripts   || [];
    state.selectedScriptId = saved.selectedScriptId || null;
    state.openScriptIds    = (saved.openScriptIds || []).filter(id => state.scripts.find(s => s.id === id));
    state.scriptPanelOpen  = !!saved.scriptPanelOpen && state.openScriptIds.length > 0;
    state.scriptPanelHeight = saved.scriptPanelHeight || 480;
    catCounter    = state.catalogs.reduce((m, c) => Math.max(m, parseInt(c.id?.split("-")[1] || 0)), 0);
    scriptCounter = state.scripts.reduce((m, s) => Math.max(m, parseInt(s.id?.split("-")[1] || 0)), 0);
    restoreFromSaved(saved);
  } else {
    state.sidebarCollapsed = !!saved?.sidebarCollapsed;
    state.catalogs  = (saved?.catalogs || []).map(migrateCatalog);
    state.scripts   = saved?.scripts   || [];
    state.selectedScriptId = saved?.selectedScriptId || null;
    state.openScriptIds    = (saved?.openScriptIds || []).filter(id => state.scripts.find(s => s.id === id));
    state.scriptPanelOpen  = !!saved?.scriptPanelOpen && state.openScriptIds.length > 0;
    state.scriptPanelHeight = saved?.scriptPanelHeight || 480;
    scriptCounter = state.scripts.reduce((m, s) => Math.max(m, parseInt(s.id?.split("-")[1] || 0)), 0);
    createWorkspace("default", { focus: true, silent: true });
  }

  renderBookmarks();
  renderCatalogs();
  renderScripts();
  renderProtoList();
  renderProtoGrid();
  renderTabs();
  wireRail();
  wireDialog();
  wireCatalogDialog();
  wireDrawer();
  wireClock();
  wireKeyboard();
  wireWsTabs();
  wireZoom();
  wireSidebarToggle();
  wireScriptPanel();
  wireBackup();
  applyZoom();   // 復元値を反映
  applySidebar();
  applyScriptPanel();   // 復元値を反映
  updateStatusLine();
  updateEmptyState();

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
  // ?msg=hello  で自動的にメッセージ送信 (動作確認用)
  const msgMatch = location.search.match(/[?&]msg=([^&]+)/);
  if (msgMatch) {
    const m = decodeURIComponent(msgMatch[1]);
    setTimeout(() => activeWorkspace().windows.forEach(w => {
      w.el.querySelector(".compose-input").value = m;
      w._sendFromCompose();
    }), 2400);
  }
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

// ═══════════════════════════════════════════════════════
// RESTORE
// ═══════════════════════════════════════════════════════
function restoreFromSaved(saved) {
  // それぞれのワークスペースとウインドウを再構築。connect() を再走させて adapter も復活させる
  saved.workspaces.forEach(wsData => {
    const ws = createWorkspace(wsData.name || "default", { focus: true, silent: true });
    (wsData.windows || []).forEach(winData => {
      connect({
        protoId: winData.protoId,
        url:     winData.config?.url,
        name:    winData.config?.name,
        auth:    winData.config?.auth,
        persona: winData.config?.persona,
        channel: winData.config?.channel
      }, { restore: { pos: winData.pos, activeTab: winData.activeTab }, skipDirty: true });
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
      switchWorkspace(ws.id);
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

// 現存する全 window をサイドバーに一覧表示 (proto + url で group)
function renderBookmarks() {
  const root  = $("#savedAgents");
  const empty = $("#bookmarksEmpty");
  root.innerHTML = "";
  state._connExpanded = state._connExpanded || {};

  // group by protoId + url、 順序維持
  const groups = new Map();
  state.workspaces.forEach(ws => {
    ws.windows.forEach(win => {
      const key = `${win.protoId}::${win.adapter.config.url || ""}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          name:    win.name,
          host:    hostFromUrl(win.adapter.config.url) || win.adapter.config.url || "",
          url:     win.adapter.config.url,
          windows: []
        });
      }
      groups.get(key).windows.push({ win, ws });
    });
  });

  const groupList = [...groups.values()];
  groupList.forEach(g => {
    const hasMulti = g.windows.length > 1;
    if (state._connExpanded[g.key] === undefined) state._connExpanded[g.key] = true;
    const expanded = !!state._connExpanded[g.key];

    // 親 (group)
    const li = document.createElement("li");
    li.className = "agent-item conn-group"
      + (hasMulti ? " is-expandable" : "")
      + (expanded ? " is-expanded" : "");
    li.title = `${g.host}  ·  ${g.windows.length} window(s)`;
    li.innerHTML = `
      <span class="agent-name">${escapeHtml(g.name)}</span>
      <span class="bm-count" title="${g.windows.length} window(s)">${g.windows.length}</span>
      <button class="bookmark-new" title="Open another window to the same agent" aria-label="new window">
        <svg viewBox="0 0 14 14" width="10" height="10"><line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <button class="agent-remove" title="Disconnect all" aria-label="disconnect all">
        <svg viewBox="0 0 14 14" width="9" height="9">
          <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.4"/>
          <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.4"/>
        </svg>
      </button>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".agent-remove")) {
        e.stopPropagation();
        g.windows.forEach(({ win }) => win.close());
        return;
      }
      if (e.target.closest(".bookmark-new")) {
        e.stopPropagation();
        // 同 URL / proto / auth / persona / channel で新規 window
        const first = g.windows[0]?.win;
        if (!first) return;
        const cfg = first.adapter.config || {};
        connect({
          protoId: first.protoId,
          url:     cfg.url,
          name:    cfg.name || g.name,
          auth:    cfg.auth,
          persona: cfg.persona,
          channel: cfg.channel
        });
        return;
      }
      // name / count クリック: 子があれば toggle、 単独ならその window へ focus
      if (e.target.closest(".agent-name, .bm-count")) {
        if (g.windows.length === 1) {
          const { win, ws } = g.windows[0];
          if (ws.id !== state.activeWs) { switchWorkspace(ws.id); setTimeout(() => win.focus(), 50); }
          else win.focus();
        } else {
          state._connExpanded[g.key] = !expanded;
          renderBookmarks();
        }
      }
    });
    root.appendChild(li);

    // 子ツリー (展開時のみ)
    if (expanded) {
      const sub = document.createElement("li");
      sub.className = "bookmark-children";
      g.windows.forEach(({ win, ws }, i) => {
        const isLast = i === g.windows.length - 1;
        const isActiveWs = ws.id === state.activeWs;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bookmark-child" + (isActiveWs ? "" : " is-other-ws");
        btn.title = `${ws.name}  ·  ${win.adapter.config.url || ""}`;
        btn.innerHTML = `
          <span class="bc-branch">${isLast ? "└─" : "├─"}</span>
          <span class="bc-id">${win.id}</span>
          <span class="bc-name">${escapeHtml(windowDisplayName(win))}</span>
          <button class="bc-remove" title="Disconnect" aria-label="disconnect">
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
        sub.appendChild(btn);
      });
      root.appendChild(sub);
    }
  });

  const total = state.workspaces.reduce((n, w) => n + w.windows.length, 0);
  $("#savedCount").textContent = String(total);
  empty.classList.toggle("is-hidden", total > 0);
}

// ═══════════════════════════════════════════════════════
// CATALOG OAuth + Exchange assets
// ═══════════════════════════════════════════════════════
async function authenticateCatalog(cat) {
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
  const rootOrg = me.user?.organization || me.organization;
  if (!rootOrg) throw new Error("no organization in /me");

  const hUrl = `https://anypoint.mulesoft.com/accounts/api/cs/organizations/${rootOrg.id}/hierarchy`;
  const hRes = await fetch(`/proxy?url=${encodeURIComponent(hUrl)}`, {
    headers: { Authorization: `Bearer ${cat.accessToken}` }
  });
  let nodes = [rootOrg];
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
  const withInst = bg.assets.filter(a => a._a2aUrl).length;
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
    const withInst = assets.filter(a => a._a2aUrl).length;
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
function renderAssetList(assets) {
  const body = $("#drawerBody");
  body.innerHTML = "";
  if (!assets?.length) {
    body.innerHTML = `<div class="drawer-empty">No A2A assets</div>`;
    return;
  }
  const cat = state.catalogs.find(c => c.id === state._drawerCatalogId);
  assets.forEach((a, i) => {
    const hasInstance = !!a._a2aUrl;       // 実 URL に解決済み → 青で connectable
    const hasCard     = !hasInstance && !!a._a2aCard;   // card だけ取れている (URL は ${...} 未解決等)
    const item = document.createElement("div");
    item.className = "asset-item"
      + (hasInstance ? " has-instance" : "")
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
    const sourceUrl = c.authUrl || c.tokenUrl;
    const host = hostFromUrl(sourceUrl) || (c.type === "anypoint" ? "anypoint.mulesoft.com" : "");

    // 親 (catalog) — bookmark item と同形式: name + count + + + ×
    const li = document.createElement("li");
    li.className = "catalog-item"
      + (hasChildren ? " is-expandable" : "")
      + (hasChildren && expanded ? " is-expanded" : "");
    li.dataset.catId = c.id;
    li.title = `${host}  ·  ${c.flow === "cc" ? "Client Credentials" : "Authorization Code"}  ·  ${c.status || "idle"}`;
    li.innerHTML = `
      <span class="catalog-name" title="Click to toggle">${escapeHtml(c.name)}</span>
      <span class="catalog-meta">
        <span class="catalog-status-dot ${statusCls}" title="${escapeHtml(c.status || "idle")}"></span>
        <span class="bm-count" title="${c.businessGroups.length} BG">${c.businessGroups.length}</span>
      </span>
      <button class="bookmark-new" title="Add business group" aria-label="add bg">
        <svg viewBox="0 0 14 14" width="10" height="10"><line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <button class="agent-remove" title="Delete catalog" aria-label="remove">
        <svg viewBox="0 0 14 14" width="9" height="9">
          <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.4"/>
          <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.4"/>
        </svg>
      </button>
    `;
    li.addEventListener("click", async (e) => {
      if (e.target.closest(".agent-remove")) {
        e.stopPropagation();
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
function renderCatalogFlowSeg() {
  const root = $("#catFlowSeg");
  if (!root) return;
  root.innerHTML = "";
  const segs = [
    { id: "authcode", label: "Interactive", sub: "auth code · browser", icon: "↳" },
    { id: "cc",       label: "Service",     sub: "client credentials",  icon: "⚙" }
  ];
  segs.forEach(s => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "seg-btn";
    btn.dataset.flow = s.id;
    if (s.id === state.selectedCatalogFlow) btn.classList.add("is-active");
    btn.innerHTML = `
      <span class="seg-icon">${escapeHtml(s.icon)}</span>
      <span class="seg-body">
        <span class="seg-label">${escapeHtml(s.label)}</span>
        <span class="seg-sub">${escapeHtml(s.sub)}</span>
      </span>
    `;
    btn.addEventListener("click", () => {
      state.selectedCatalogFlow = s.id;
      refreshCatalogDialog();
    });
    root.appendChild(btn);
  });
}

// ─── 表示切替 + read-only値 + CTA を一括更新 ───
function refreshCatalogDialog() {
  renderCatalogFlowSeg();

  // data-only でフロー依存フィールドを切替
  document.querySelectorAll("#catalogDialog [data-only]").forEach(el => {
    el.style.display = (el.dataset.only === state.selectedCatalogFlow) ? "" : "none";
  });

  // Anypoint URL表示 (read-only)
  $("#catAuthUrlRo").textContent  = ANYPOINT.authUrl;
  $("#catTokenUrlRo").textContent = ANYPOINT.tokenUrl;

  // client_secret の hint をフローごとに切替
  const secretHint = $("#catSecretHint");
  if (secretHint) {
    secretHint.textContent = state.selectedCatalogFlow === "authcode"
      ? "Web app type only · leave empty for SPA"
      : "Required for service authentication";
  }

  // CTA動的化
  const btn   = $("#catSubmit");
  const glyph = btn.querySelector(".cat-cta-glyph");
  const label = btn.querySelector(".cat-cta-label");
  if (state.selectedCatalogFlow === "authcode") {
    btn.classList.add("is-oauth");
    glyph.textContent = "A";
    label.textContent = "Continue with Anypoint";
  } else {
    btn.classList.remove("is-oauth");
    glyph.textContent = "+";
    label.textContent = "Save catalog";
  }
}

function openCatalogDialog(editing) {
  $("#catalogDialog").hidden = false;
  state.selectedCatalogFlow = editing?.flow || "authcode";
  state._editingCatalogId   = editing?.id   || null;

  $("#catName").value         = editing?.name        || "";
  $("#catClientId").value     = editing?.clientId    || "";
  $("#catClientSecret").value = editing?.clientSecret ? "•".repeat(12) : "";
  $("#catScopes").value       = editing?.scopes      || "";
  $("#catBusinessGroup").value = "";   // 編集時は既存 BGs に追加する形なので空 (初回のみ使用)
  $("#catRedirect").value     = redirectUri();

  refreshCatalogDialog();
  setTimeout(() => $("#catName").focus(), 50);
}

function closeCatalogDialog() {
  $("#catalogDialog").hidden = true;
  state._editingCatalogId = null;
}

async function submitCatalogDialog() {
  const name     = $("#catName").value.trim();
  const flow     = state.selectedCatalogFlow;
  const clientId = $("#catClientId").value.trim();
  const secretInput = $("#catClientSecret").value;
  const scopes   = $("#catScopes").value.trim();
  const bgInput  = $("#catBusinessGroup").value.trim();

  if (!name)     { $("#catName").focus(); return; }
  if (!clientId) { $("#catClientId").focus(); return; }

  const editingId = state._editingCatalogId;
  const existing  = editingId ? state.catalogs.find(c => c.id === editingId) : null;
  const isMask = secretInput && /^•+$/.test(secretInput);
  const clientSecret = isMask
    ? existing?.clientSecret
    : (secretInput || undefined);

  const cat = existing || { businessGroups: [] };
  Object.assign(cat, {
    id:        existing?.id || `cat-${++catCounter}`,
    name,
    type:      "anypoint",
    flow,
    authUrl:   ANYPOINT.authUrl,
    tokenUrl:  ANYPOINT.tokenUrl,
    clientId, clientSecret, scopes,
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
    const lineCount = (s.body || "").split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#")).length;
    const ageSec = Math.max(0, Math.round((Date.now() - (s.updatedAt || s.createdAt)) / 1000));
    li.title = `${lineCount} ops · edited ${formatAge(ageSec)}${s.autoLoop ? " · auto loop ON" : ""}`;
    const isRunningThis = !!(state._script && state._script.loopScriptId === s.id);
    li.innerHTML = `
      <span class="script-name">${escapeHtml(s.name)}</span>
      <button class="script-run ${isRunningThis ? "is-running" : ""}"
              title="${isRunningThis ? "running…" : "Run this script (no panel open)"}"
              aria-label="run script"
              ${isRunningThis ? "disabled" : ""}>
        <svg viewBox="0 0 12 12" width="9" height="9"><path d="M3 2 L10 6 L3 10 Z" fill="currentColor"/></svg>
      </button>
      <button class="script-loop ${s.autoLoop ? "is-on" : ""} ${(state._script && state.selectedScriptId === s.id && s.autoLoop) ? "is-running" : ""}"
              title="${s.autoLoop ? "auto loop ON (click to stop)" : "auto loop mode (repeat run)"}"
              aria-label="toggle auto loop">
        <svg viewBox="0 0 16 16" width="11" height="11"><path d="M3 7 a5 5 0 0 1 9 -2.5 M13 9 a5 5 0 0 1 -9 2.5 M3 2 v3 h3 M13 14 v-3 h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="agent-remove" title="Delete" aria-label="remove">
        <svg viewBox="0 0 14 14" width="9" height="9">
          <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.4"/>
          <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.4"/>
        </svg>
      </button>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".agent-remove")) {
        e.stopPropagation();
        deleteScript(s.id);
        return;
      }
      if (e.target.closest(".script-run")) {
        e.stopPropagation();
        if (state._script) return;   // 既に何か走ってる
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
      if (e.target.closest(".agent-remove")) return;
      e.stopPropagation();
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
  const isSlack = state.selectedProto === "slack";
  const channelField = $("#dlgSlackChannelField");
  if (channelField) channelField.hidden = !isSlack;
  // placeholder の切替
  const urlInput  = $("#dlgUrl");
  const authInput = $("#dlgAuth");
  if (urlInput) {
    urlInput.placeholder = isSlack
      ? "https://slack.com   ·   https://slack.example.com   (compatible server)"
      : "http://127.0.0.1:5180  ·  https://api.example.com/.well-known/agent.json";
  }
  if (authInput) {
    authInput.placeholder = isSlack
      ? "xoxb-...  (bot token)  ·  xoxp-...  (user token)"
      : "optional";
  }
}

// ─── Rail ─────────────────────────────────────────────
function wireRail() {
  $("#btnConnect").addEventListener("click", openDialog);
  $("#btnConnectEmpty").addEventListener("click", openDialog);
  $("#btnDemo").addEventListener("click", loadDemo);
  $("#btnLayout").addEventListener("click", tileWindows);
  $("#scriptAdd").addEventListener("click", () => createScript({}));
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
  $("#scriptSavedAt").textContent = `${s.name} · saved ${formatAge(Math.max(0, Math.round((Date.now() - s.updatedAt) / 1000)))}`;
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
function highlightDslLine(raw) {
  const trimmed = raw.trimStart();
  const lead = raw.slice(0, raw.length - trimmed.length);
  if (!trimmed) return escapeHtmlInline(raw);
  if (trimmed.startsWith("#")) {
    return escapeHtmlInline(lead) + `<span class="tk-comment">${escapeHtmlInline(trimmed)}</span>`;
  }
  let m;
  // > name: text
  if ((m = trimmed.match(/^(>)(\s+)(.+?)(\s*)(:)(\s*)(.*)$/))) {
    return escapeHtmlInline(lead)
      + `<span class="tk-cmd">${escapeHtmlInline(m[1])}</span>${escapeHtmlInline(m[2])}`
      + `<span class="tk-name">${escapeHtmlInline(m[3])}</span>${escapeHtmlInline(m[4])}`
      + `<span class="tk-punct">${escapeHtmlInline(m[5])}</span>${escapeHtmlInline(m[6])}`
      + `<span class="tk-text">${escapeHtmlInline(m[7])}</span>`;
  }
  // < name [timeout]
  if ((m = trimmed.match(/^(<)(\s+)(.+?)(\s+(\d+(?:\.\d+)?)\s*s?)?$/))) {
    let out = escapeHtmlInline(lead)
      + `<span class="tk-cmd">${escapeHtmlInline(m[1])}</span>${escapeHtmlInline(m[2])}`
      + `<span class="tk-name">${escapeHtmlInline(m[3])}</span>`;
    if (m[4]) out += `<span class="tk-num">${escapeHtmlInline(m[4])}</span>`;
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
  { glyph: ">",     label: "send",    insert: "> ",        cursor: "end",  title: "Send to window — > name: text" },
  { glyph: "<",     label: "wait",    insert: "< ",        cursor: "end",  title: "Wait for reply — < name [30s]" },
  { glyph: "sleep", label: "pause",   insert: "sleep 1s",  cursor: "end",  title: "Pause — sleep Ns" },
  { glyph: "clear", label: "reset",   insert: "clear",     cursor: "end",  title: "Clear chat — clear [name]" },
  { glyph: "#",     label: "comment", insert: "# ",        cursor: "end",  title: "Comment line — # ..." }
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

async function runScript(opts = {}) {
  // opts.text + opts.scriptId でサイドバーから呼べる。引数なしならエディタの内容を使う。
  const text = opts.text != null ? opts.text : $("#scriptEditor").value;
  const ops  = parseScript(text);
  const script = findScript(opts.scriptId || state.selectedScriptId);
  const loopMode = !!script?.autoLoop;

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

function wireScriptPanel() {
  $("#scriptCollapse").addEventListener("click", closeScriptPanel);
  $("#scriptRun").addEventListener("click",  runScript);
  $("#scriptStop").addEventListener("click", () => state._script?.runner?.stop());
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
    const hl = $("#scriptHighlight");
    hl.scrollTop  = $("#scriptEditor").scrollTop;
    hl.scrollLeft = $("#scriptEditor").scrollLeft;
  });
  $("#scriptEditor").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runScript();
      return;
    }
    if (e.key === "Tab") {
      const chip = $("#scriptWindowChips .swc-chip.is-match");
      if (chip) { e.preventDefault(); chip.click(); }
      return;
    }
    // 素の Enter: 現在行が `> name: text` (text 有り) なら `\n< name\n` を挿入
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ed = e.target;
      const cursor = ed.selectionStart;
      const before = ed.value.slice(0, cursor);
      const after  = ed.value.slice(ed.selectionEnd);
      const lineStart = before.lastIndexOf("\n") + 1;
      const currentLine = before.slice(lineStart);
      const m = currentLine.match(/^>\s+(.+?)\s*:\s*(\S.*?)\s*$/);
      if (m) {
        const name = m[1].trim();
        e.preventDefault();
        const insert = `\n< ${name}\n`;
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
function wireBackup() {
  $("#btnExport").addEventListener("click", async () => {
    const ok = await modalConfirm({
      title:        "Export configuration?",
      message:      "The file will contain connections, catalogs and scripts — including OAuth client secrets and access tokens. Treat it as sensitive.",
      confirmLabel: "Export"
    });
    if (!ok) return;
    try {
      // Ensure pending debounced save is flushed so the export reflects the latest state
      persist.save(state);
      const json = persist.exportJson();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const blob = new Blob([json], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `atelier-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      await modalAlert({ title: "Export failed", message: err?.message || String(err) });
    }
  });

  $("#btnImport").addEventListener("click", () => $("#importFile").click());

  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";   // reset so picking the same file twice re-triggers
    if (!file) return;
    const ok = await modalConfirm({
      title:        "Import configuration?",
      message:      `Replace current connections, catalogs and scripts with “${file.name}”? The page will reload.`,
      confirmLabel: "Import",
      danger:       true
    });
    if (!ok) return;
    try {
      const text = await file.text();
      persist.importJson(text);
      location.reload();
    } catch (err) {
      await modalAlert({ title: "Import failed", message: err?.message || String(err) });
    }
  });
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

function tileWindows() {
  const ws = activeWorkspace();
  const layer = ws.layer;
  const rect = $("#windowsLayer").getBoundingClientRect();
  const n = ws.windows.length;
  if (n === 0) return;

  const cols = n <= 3 ? n : Math.ceil(n / 2);
  const rows = Math.ceil(n / cols);
  const gap = 16;
  const w = Math.floor((rect.width  - gap * (cols + 1)) / cols);
  const h = Math.floor((rect.height - gap * (rows + 1)) / rows);

  ws.windows.forEach((win, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    win.el.style.transition = "left .3s ease, top .3s ease, width .3s ease, height .3s ease";
    win.el.style.left   = (gap + col * (w + gap)) + "px";
    win.el.style.top    = (gap + row * (h + gap)) + "px";
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
  $("#dlgUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitDialog();
  });
}

function openDialog() {
  $("#connectDialog").hidden = false;
  renderProtoGrid();
  setTimeout(() => $("#dlgUrl").focus(), 50);
}
function closeDialog() {
  $("#connectDialog").hidden = true;
}

async function submitDialog() {
  const raw  = $("#dlgUrl").value.trim();
  const name = $("#dlgName").value.trim();
  const auth = $("#dlgAuth").value.trim();
  const channel = $("#dlgChannel")?.value.trim().replace(/^#/, "") || "";
  if (!raw) {
    $("#dlgUrl").focus();
    return;
  }
  const url = raw ? (/^https?:\/\//i.test(raw) ? raw : "https://" + raw) : "";

  // submit ボタンを連打防止 + 進行表示
  const btn = $("#dlgSubmit");
  btn.disabled = true;
  const ok = await connect({
    protoId: state.selectedProto,
    url,
    name: name || hostFromUrl(url) || "Untitled",
    auth: auth || undefined,
    channel: state.selectedProto === "slack" ? (channel || "general") : undefined
  });
  btn.disabled = false;

  if (ok) closeDialog();
  // 失敗時はダイアログを残して再入力できるようにする
  else setTimeout(() => $("#dlgUrl").focus(), 50);
}

// ─── Connect ────────────────────────────────────────
async function connect({ protoId, url, name, auth, persona, channel }, opts = {}) {
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

  const adapter = new proto.AdapterClass({ url, name, auth, persona, channel });

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
    restore: opts.restore
  });
  win._wsId = ws.id;
  ws.windows.push(win);

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

    if (meta && e.key.toLowerCase() === "n") {
      e.preventDefault();
      openDialog();
      return;
    }
    if (meta && e.key.toLowerCase() === "t") {
      e.preventDefault();
      createWorkspace(`workspace ${wsCounter + 1}`);
      return;
    }
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
