// localStorage 永続化レイヤ
// ワークスペース・ウインドウの構造/位置/タブ状態を保存し、リロード時に復元する。
// チャット履歴とDebugフレームは保存しない (再接続でやり直す)。

const KEY = "atelier:state:v1";
const VERSION = 1;

// ─── snapshot ────────────────────────────────
function snapshotWindow(win) {
  return {
    protoId: win.protoId,
    config: {
      url:     win.adapter.config.url,
      name:    win.adapter.config.name,
      auth:    win.adapter.config.auth,
      persona: win.adapter.config.persona
    },
    pos: {
      left:   win.el.style.left,
      top:    win.el.style.top,
      width:  win.el.style.width,
      height: win.el.style.height,
      zIndex: win.el.style.zIndex
    },
    activeTab: win.el.querySelector(".aw-tab.is-active")?.dataset.tab || "chat"
  };
}

export function save(state) {
  try {
    const data = {
      v: VERSION,
      zoom: state.zoom ?? 1.0,
      sidebarCollapsed: !!state.sidebarCollapsed,
      bookmarks: state.bookmarks || [],
      catalogs:  state.catalogs  || [],
      scripts:   state.scripts   || [],
      selectedScriptId: state.selectedScriptId || null,
      activeWsIdx: Math.max(0, state.workspaces.findIndex(w => w.id === state.activeWs)),
      workspaces: state.workspaces.map(ws => ({
        name: ws.name,
        windows: ws.windows.map(snapshotWindow)
      }))
    };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("[persist] save failed:", e);
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.v !== VERSION) return null;
    return data;
  } catch (e) {
    console.warn("[persist] load failed:", e);
    return null;
  }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch {}
}

// debounced save — 連続的な変更 (ドラッグ等) でも安く済ませる
let _timer = null;
export function scheduleSave(state, ms = 80) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { _timer = null; save(state); }, ms);
}
