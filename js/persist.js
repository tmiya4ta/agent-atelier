// localStorage 永続化レイヤ
// ワークスペース・ウインドウの構造/位置/タブ状態を保存し、リロード時に復元する。
// チャット履歴とDebugフレームは保存しない (再接続でやり直す)。
//
// セキュリティ:
//   - 機微情報 (Bearer token / OAuth clientSecret / accessToken / refreshToken) は
//     **localStorage には保存しない**。 sessionStorage (タブ閉で消える) に分離する。
//   - export JSON / import JSON は secrets を含まない。 共有 snapshot を
//     渡しあっても token が漏れない。
//   - localStorage は XSS 1 発で全部読まれるので、 公開ホスティングに上げる際は
//     さらに index.html の CSP + DOMPurify 経由で一次経路を塞いでおくこと (済)。

const KEY = "atelier:state:v1";
const SECRETS_KEY = "atelier:secrets:v1";
const VERSION = 1;

// 機微フィールドのキー名 (catalogs / window config / bookmarks / oauth state 共通)
const SENSITIVE_FIELDS = ["auth", "token", "assertion", "password", "clientSecret", "accessToken", "refreshToken", "tokenExpiresAt"];

// オブジェクトから secrets を分離して { sanitized, secrets } を返す。
// secrets は元 obj を識別するキー (cat-id / bookmark-key / window-key) で索引する。
function extractSecrets(obj, idKey) {
  const secrets = {};
  let touched = false;
  for (const k of SENSITIVE_FIELDS) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== "" && obj[k] != null) {
      secrets[k] = obj[k];
      touched = true;
    }
  }
  if (!touched) return null;
  return { idKey, secrets };
}

// sanitized obj を作る — SENSITIVE_FIELDS を空文字に書き換えたシャローコピー
function stripSecrets(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of SENSITIVE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(out, k) && out[k]) out[k] = "";
  }
  return out;
}

// secrets store: sessionStorage に { [scope]: { [idKey]: { auth, clientSecret, ... } } }
function loadSecrets() {
  try {
    const raw = sessionStorage.getItem(SECRETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveSecrets(store) {
  try { sessionStorage.setItem(SECRETS_KEY, JSON.stringify(store)); } catch {}
}
function setSecretEntry(scope, idKey, secrets) {
  const s = loadSecrets();
  s[scope] = s[scope] || {};
  if (secrets && Object.keys(secrets).length) s[scope][idKey] = secrets;
  else delete s[scope][idKey];
  saveSecrets(s);
}
function getSecretEntry(scope, idKey) {
  const s = loadSecrets();
  return s[scope]?.[idKey] || null;
}
export function clearSecrets() {
  try { sessionStorage.removeItem(SECRETS_KEY); } catch {}
}

// ─── snapshot ────────────────────────────────
function snapshotWindow(win) {
  // window の secret は (protoId + url) でキー化して sessionStorage 行きにする。
  const idKey = `${win.protoId}::${win.adapter.config.url || ""}`;
  const cfg = win.adapter.config || {};
  const winSecret = extractSecrets(cfg, idKey);
  if (winSecret) setSecretEntry("windows", idKey, winSecret.secrets);
  return {
    protoId: win.protoId,
    config: {
      url:     cfg.url,
      name:    cfg.name,
      // auth は sessionStorage 行き — localStorage には空文字で残す (load 側で再合流)
      auth:    "",
      authRef: cfg.authRef,   // identity 参照 (非 secret)
      persona: cfg.persona,
      channel: cfg.channel,
      emulate:   cfg.emulate,    // mock が装うプロトコル (a2a/mcp)
      mockTools: cfg.mockTools,  // mock(mcp) のツール定義
      mockReply: cfg.mockReply,  // mock 手入力時の定型応答 (担当範囲 + 振り先)
      database:  cfg.database,    // DB (clouderby) — 非 secret
      user:      cfg.user         // DB user — 非 secret (password は上で sessionStorage 行き)
    },
    pos: {
      left:   win.el.style.left,
      top:    win.el.style.top,
      width:  win.el.style.width,
      height: win.el.style.height,
      zIndex: win.el.style.zIndex
    },
    activeTab: win.el.querySelector(".aw-tab.is-active")?.dataset.tab || "chat",
    // DB window はエディタ内容を復元時に戻す
    sql: typeof win.currentSql === "function" ? win.currentSql() : undefined,
    pinned: !!win.pinned
  };
}

export function save(state) {
  try {
    // catalogs / bookmarks の secrets を sessionStorage に逃がす
    const sanitizedCatalogs = (state.catalogs || []).map(c => {
      const idKey = c.id;
      const sec = extractSecrets(c, idKey);
      if (sec) setSecretEntry("catalogs", idKey, sec.secrets);
      return stripSecrets(c);
    });
    const sanitizedIdentities = (state.identities || []).map(idn => {
      const idKey = idn.id;
      const sec = extractSecrets(idn, idKey);
      if (sec) setSecretEntry("identities", idKey, sec.secrets);
      return stripSecrets(idn);
    });
    const sanitizedBookmarks = (state.bookmarks || []).map(b => {
      const idKey = b.key || `${b.protoId}::${b.url || ""}`;
      const sec = extractSecrets(b, idKey);
      if (sec) setSecretEntry("bookmarks", idKey, sec.secrets);
      return stripSecrets(b);
    });

    const data = {
      v: VERSION,
      zoom: state.zoom ?? 1.0,
      sidebarCollapsed: !!state.sidebarCollapsed,
      sidePanelW: state.sidePanelW ?? 240,
      theme: state.theme === "dark" ? "dark" : "light",
      activeSideCat: state.activeSideCat || "connections",
      identities: sanitizedIdentities,
      catalogs:  sanitizedCatalogs,
      scripts:   state.scripts   || [],
      selectedScriptId: state.selectedScriptId || null,
      scriptPinned: !!state.scriptPinned,   // PIN: run でパネルを閉じない設定 (セッション跨ぎで保持)
      // 「閉じても残るコネクション登録」。 各 entry は { key, protoId, url, name, persona?, channel? }
      // (auth/secret は sessionStorage 側)。
      bookmarks: sanitizedBookmarks,
      // 閉じた window スロット (名前+authRef 等の config のみ。secret は含まない)。
      // window を閉じても設定を失わず、再オープンできるようにする。
      closedWindows: (state.closedWindows || []).map(stripSecrets),
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

// 機微情報 hydration: load 時に sessionStorage から secrets を取り出して state に再合流する。
// app.js の restore フローから明示呼び出し。
export function hydrateSecrets(catalogs, bookmarks, identities) {
  for (const c of (catalogs || [])) {
    const sec = getSecretEntry("catalogs", c.id);
    if (sec) Object.assign(c, sec);
  }
  for (const idn of (identities || [])) {
    const sec = getSecretEntry("identities", idn.id);
    if (sec) Object.assign(idn, sec);
  }
  for (const b of (bookmarks || [])) {
    const idKey = b.key || `${b.protoId}::${b.url || ""}`;
    const sec = getSecretEntry("bookmarks", idKey);
    if (sec) Object.assign(b, sec);
  }
}

// window 復元時に呼ばれる。 protoId+url から sessionStorage の secret を取り出して config に詰める。
export function hydrateWindowSecrets(snap) {
  const idKey = `${snap.protoId}::${snap.config?.url || ""}`;
  const sec = getSecretEntry("windows", idKey);
  if (sec && snap.config) Object.assign(snap.config, sec);
  return snap;
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
  clearSecrets();
}

// debounced save — 連続的な変更 (ドラッグ等) でも安く済ませる
let _timer = null;
export function scheduleSave(state, ms = 80) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { _timer = null; save(state); }, ms);
}

// ─── export / import ─────────────────────────
// Snapshot file format:
// { app: "atelier", exportedAt: ISO, state: <raw state object — secrets stripped> }
// opts.includeSecrets=true で client_secret / token 等のクレデンシャルも含める
// (引っ越し/完全バックアップ用。 出力ファイルはパスワード級の機密になる)。
// 既定 (false) は従来どおり secret を strip した「雛形」。
export function exportJson(opts = {}) {
  const raw = localStorage.getItem(KEY);
  const state = raw ? JSON.parse(raw) : { v: VERSION };
  if (opts.includeSecrets) {
    // sessionStorage に逃がしてある secrets を構造へ再合流する。
    hydrateSecrets(state.catalogs, state.bookmarks, state.identities);
    (state.workspaces || []).forEach(ws => (ws.windows || []).forEach(w => hydrateWindowSecrets(w)));
  } else {
    // 既定: secret を strip (共有しても安全な雛形)。
    if (Array.isArray(state.catalogs))   state.catalogs   = state.catalogs.map(stripSecrets);
    if (Array.isArray(state.identities)) state.identities = state.identities.map(stripSecrets);
    if (Array.isArray(state.bookmarks))  state.bookmarks  = state.bookmarks.map(stripSecrets);
    if (Array.isArray(state.workspaces)) {
      state.workspaces.forEach(ws => (ws.windows || []).forEach(w => {
        if (w.config) w.config = stripSecrets(w.config);
      }));
    }
  }
  return JSON.stringify({
    app: "atelier",
    exportedAt: new Date().toISOString(),
    includesSecrets: !!opts.includeSecrets,
    state
  }, null, 2);
}

// ユーザーが設定した「資格情報」系の secret フィールド (runtime トークンの
// accessToken/refreshToken/tokenExpiresAt は含めない — 再取得できるため)。
const CONFIGURED_SECRET_FIELDS = ["auth", "token", "assertion", "password", "clientSecret"];

// 「元々 secret を持っていたが sessionStorage 揮発 (タブ/ブラウザを閉じた) で
// 失われた」項目を列挙する。localStorage の値が "" (= strip された痕跡 = 元値あり)
// なのに sessionStorage に実値が無いものを「失われた secret」とみなす。
// include-secrets export 前にこれを警告して、 空のまま export されるのを防ぐ。
// 戻り値: [{ scope, label, fields: string[] }]
export function findMissingSecrets() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  let state; try { state = JSON.parse(raw); } catch { return []; }
  const store = loadSecrets();
  const missing = [];
  const check = (scope, idKey, label, obj) => {
    if (!obj) return;
    const sec = store[scope]?.[idKey] || {};
    const lost = CONFIGURED_SECRET_FIELDS.filter(k => obj[k] === "" && !sec[k]);
    if (lost.length) missing.push({ scope, label: label || idKey, fields: lost });
  };
  (state.identities || []).forEach(i => check("identities", i.id, i.name, i));
  (state.catalogs   || []).forEach(c => check("catalogs", c.id, c.name, c));
  (state.bookmarks  || []).forEach(b => check("bookmarks", b.key || `${b.protoId}::${b.url || ""}`, b.name || b.url, b));
  (state.workspaces || []).forEach(ws => (ws.windows || []).forEach(w => {
    const k = `${w.protoId}::${w.config?.url || ""}`;
    check("windows", k, w.config?.name || w.config?.url, w.config);
  }));
  return missing;
}

// import 時に「危険な書き換え」を検出する。 共有 snapshot に細工された場合の警告材料。
// 戻り値: { warnings: string[] }
function inspectImport(state) {
  const warnings = [];
  // OAuth endpoint 書換 (anypoint.mulesoft.com 以外を catalog に仕込んでいる)
  for (const c of (state.catalogs || [])) {
    const allow = ["anypoint.mulesoft.com"];
    const probe = (u) => {
      try {
        const h = new URL(u).hostname;
        return !allow.some(a => h === a || h.endsWith("." + a));
      } catch { return false; }
    };
    if (c.authUrl && probe(c.authUrl))
      warnings.push(`catalog "${c.name || c.id}" の authUrl が Anypoint 以外: ${c.authUrl}`);
    if (c.tokenUrl && probe(c.tokenUrl))
      warnings.push(`catalog "${c.name || c.id}" の tokenUrl が Anypoint 以外: ${c.tokenUrl}`);
  }
  // snapshot に secret が含まれている (export 元が strip し忘れ or 外部由来)
  const hasSecret = (o) => o && SENSITIVE_FIELDS.some(k => o[k]);
  if ((state.catalogs || []).some(hasSecret))
    warnings.push("snapshot に catalog の secret (clientSecret / accessToken 等) が含まれています");
  if ((state.bookmarks || []).some(hasSecret))
    warnings.push("snapshot に bookmark の auth token が含まれています");
  // prototype pollution 経由
  const dangerKeys = (o) => o && Object.keys(o).some(k => k === "__proto__" || k === "constructor" || k === "prototype");
  const scan = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 4) return false;
    if (dangerKeys(obj)) return true;
    for (const v of Object.values(obj)) if (scan(v, depth + 1)) return true;
    return false;
  };
  if (scan(state)) warnings.push("snapshot に __proto__ / constructor / prototype キーが含まれています");
  return { warnings };
}

export function importJson(str, opts = {}) {
  const parsed = JSON.parse(str);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid JSON: not an object");
  }
  // Accept either a wrapped { app, state } file or a bare state object
  const state = parsed.state ?? parsed;
  if (typeof state !== "object" || state === null) {
    throw new Error("Missing state payload");
  }
  if (state.v !== VERSION) {
    throw new Error(`Unsupported snapshot version: ${state.v} (expected ${VERSION})`);
  }
  if (!Array.isArray(state.workspaces)) {
    throw new Error("Snapshot missing workspaces[]");
  }
  // 危険な書き換え検査。 opts.allowOverride=true (UI 側で確認済み) でなければ throw。
  const { warnings } = inspectImport(state);
  if (warnings.length && !opts.allowOverride) {
    const e = new Error("Import safety warnings:\n  - " + warnings.join("\n  - "));
    e.warnings = warnings;
    e.code = "IMPORT_UNSAFE";
    throw e;
  }
  // theme は「ユーザー設定」であって snapshot の中身ではない。 import で上書きすると
  // ダークモードのユーザーが light の snapshot を読んだ瞬間ライトに飛ぶ。 現在値を保持する。
  try {
    const cur = JSON.parse(localStorage.getItem(KEY) || "null");
    if (cur && (cur.theme === "dark" || cur.theme === "light")) state.theme = cur.theme;
  } catch {}

  // opts.keepSecrets=true (ユーザーが自分の完全バックアップと確認済み) なら、
  // secret を sessionStorage 側へ移して復元する。 localStorage には決して平文で残さない。
  if (opts.keepSecrets) {
    (state.catalogs   || []).forEach(c   => { const s = extractSecrets(c,   c.id); if (s) setSecretEntry("catalogs",   c.id, s.secrets); });
    (state.identities || []).forEach(idn => { const s = extractSecrets(idn, idn.id); if (s) setSecretEntry("identities", idn.id, s.secrets); });
    (state.bookmarks  || []).forEach(b   => { const k = b.key || `${b.protoId}::${b.url || ""}`; const s = extractSecrets(b, k); if (s) setSecretEntry("bookmarks", k, s.secrets); });
    (state.workspaces || []).forEach(ws => (ws.windows || []).forEach(w => {
      const k = `${w.protoId}::${w.config?.url || ""}`;
      const s = w.config ? extractSecrets(w.config, k) : null; if (s) setSecretEntry("windows", k, s.secrets);
    }));
  }
  // localStorage には常に strip 版を書く (secret はディスクに残さない)。 keepSecrets の時は
  // 上で sessionStorage に逃がしてあるので、 reload 後 hydrateSecrets で復元される。
  if (Array.isArray(state.catalogs))   state.catalogs   = state.catalogs.map(stripSecrets);
  if (Array.isArray(state.identities)) state.identities = state.identities.map(stripSecrets);
  if (Array.isArray(state.bookmarks))  state.bookmarks  = state.bookmarks.map(stripSecrets);
  if (Array.isArray(state.workspaces)) {
    state.workspaces.forEach(ws => (ws.windows || []).forEach(w => {
      if (w.config) w.config = stripSecrets(w.config);
    }));
  }
  localStorage.setItem(KEY, JSON.stringify(state));
}
