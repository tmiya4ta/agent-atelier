// Atelier i18n — 言語切替の基盤
//
//   import { t, setLang } from "./i18n.js";
//   t("empty.headline")         → "Talk to <em>any</em> agent, …"
//   t("ws.close.confirm", { name, n }) → "Close \"{name}\"? ({n} connections will be cut)"
//   setLang("ja")               → 言語切替 + 'atelier:lang' イベント発火
//
// 当面は英語が完備、 日本語は段階的に追加 (空 key は en にフォールバック)。

export const SUPPORTED = ["en", "ja"];

let currentLang = (typeof localStorage !== "undefined" && localStorage.getItem("atelier:lang")) || "en";
if (!SUPPORTED.includes(currentLang)) currentLang = "en";

export function getLang() { return currentLang; }

export function setLang(lang) {
  if (!SUPPORTED.includes(lang) || lang === currentLang) return;
  currentLang = lang;
  try { localStorage.setItem("atelier:lang", lang); } catch {}
  document.documentElement.lang = lang;
  document.dispatchEvent(new CustomEvent("atelier:lang", { detail: { lang } }));
}

export function t(key, params) {
  const dict = STRINGS[currentLang] || STRINGS.en;
  let s = dict[key];
  if (s == null) s = STRINGS.en[key];
  if (s == null) s = key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export const STRINGS = {
  en: {
    // ── empty state ──
    "empty.status":    "no agents connected",
    "empty.headline":  "Talk to <em>any</em> agent,<br/>from <em>one</em> workbench.",
    "empty.lede":      "Built around A2A. Protocol-agnostic concurrent multi-agent connections.<br/>Chat, debug, and AgentCard metadata side by side across windows.",
    "empty.connect":   "connect an agent",
    "empty.demo":      "load demo agents",
    "empty.f1.title":  "Multi-window",
    "empty.f1.text":   "Multiple concurrent sessions in floating windows",
    "empty.f2.title":  "Protocol-agnostic",
    "empty.f2.text":   "Switch between A2A / Slack / MCP / OpenAI adapters",
    "empty.f3.title":  "Inspect everything",
    "empty.f3.text":   "Live JSON-RPC traffic and AgentCard inspection",

    // ── rail ──
    "rail.connections": "connections",
    "rail.events":      "events",
    "rail.workspaces":  "workspaces",
    "rail.zoom.out":    "zoom out",
    "rail.zoom.in":     "zoom in",
    "rail.zoom.reset":  "reset to 100%",
    "rail.sidebar":     "toggle sidebar",
    "rail.tile":        "tile",
    "rail.tile.tooltip": "Re-tile windows",

    // ── sidebar ──
    "side.newConn":         "new connection",
    "side.newConn.tip":     "New connection (⌘N)",
    "side.bookmarks":       "BOOKMARKS",
    "side.catalogs":        "CATALOGS",
    "side.scripts":         "SCRIPTS",
    "side.protocols":       "PROTOCOLS",
    "side.bookmarks.empty": "Bookmark via the ☆ on each window header",
    "side.catalogs.empty":  "+ to add a catalog (Anypoint Platform)",
    "side.scripts.empty":   "+ to create a script (manage multiple)",
    "side.localTime":       "local time",
    "side.kbd.newConn":     "new connection",
    "side.kbd.palette":     "palette",
    "side.kbd.window":      "window",
    "side.bm.toggleTip":    "Click to toggle tree",
    "side.bm.removeTip":    "Remove bookmark",
    "side.bm.newTip":       "New connection",
    "side.cat.addBg":       "Add business group",
    "side.cat.delete":      "Delete catalog",
    "side.script.add":      "New script",
    "side.script.loop.on":  "auto loop ON (click to stop)",
    "side.script.loop.off": "auto loop mode (repeat run)",
    "side.script.delete":   "Delete script",

    // ── workspace tabs ──
    "ws.add":         "New workspace (⌘T)",
    "ws.tabs.hint":   "{kbd1} add &nbsp;·&nbsp; {kbd2} / {kbd3} switch",
    "ws.close.tip":   "Close workspace",
    "ws.close.confirm.title": "Close \"{name}\"? ({n} connections will be disconnected)",
    "ws.close.confirm.btn":   "Close workspace",

    // ── connect dialog ──
    "dlg.connect.eyebrow": "new connection",
    "dlg.connect.title":   "Connect to an <em>agent</em>",
    "dlg.connect.protocol":     "protocol",
    "dlg.connect.protocol.hint":"transport protocol",
    "dlg.connect.endpoint":     "endpoint",
    "dlg.connect.endpoint.hint":"HTTP(S) URL · AgentCard or RPC base",
    "dlg.connect.url.ph.a2a":   "http://127.0.0.1:5180  ·  https://api.example.com/.well-known/agent.json",
    "dlg.connect.url.ph.slack": "https://slack.com   ·   https://slack.example.com   (compatible server)",
    "dlg.connect.name":         "display name",
    "dlg.connect.name.hint":    "optional",
    "dlg.connect.name.ph":      "e.g. Research Agent",
    "dlg.connect.auth":         "auth",
    "dlg.connect.auth.hint":    "bearer token / none",
    "dlg.connect.auth.ph":      "optional",
    "dlg.connect.auth.ph.slack":"xoxb-...  (bot token)  ·  xoxp-...  (user token)",
    "dlg.connect.channel":      "channel",
    "dlg.connect.channel.hint": "Posting channel (omit #)",
    "dlg.connect.advanced":     "advanced",
    "dlg.connect.timeout":      "timeout",
    "dlg.connect.streaming":    "streaming",
    "dlg.connect.foot":         "{kbd1} to connect &nbsp;·&nbsp; {kbd2} to dismiss",
    "dlg.connect.cancel":       "cancel",
    "dlg.connect.submit":       "connect",
    "dlg.connect.failed.title": "Connection failed",

    // ── catalog dialog ──
    "dlg.cat.eyebrow":      "new catalog",
    "dlg.cat.title":        "Connect to <em>Anypoint</em>",
    "dlg.cat.auth":         "authentication",
    "dlg.cat.name":         "display name",
    "dlg.cat.name.hint":    "Sidebar label",
    "dlg.cat.name.ph":      "e.g. Production · Sandbox",
    "dlg.cat.clientId":     "client id",
    "dlg.cat.clientId.hint":"Connected App's client_id",
    "dlg.cat.secret":       "client secret",
    "dlg.cat.secret.hint.cc":"Required for service authentication",
    "dlg.cat.secret.hint.code":"Web app type only · leave empty for SPA",
    "dlg.cat.scopes":       "scopes",
    "dlg.cat.scopes.hint":  "space-separated",
    "dlg.cat.redirect":     "redirect uri",
    "dlg.cat.redirect.hint":"Register this URL in the Connected App",
    "dlg.cat.foot":         "OAuth not connected (UI only)",
    "dlg.cat.cancel":       "cancel",
    "dlg.cat.save":         "Save catalog",
    "dlg.cat.continue":     "Continue with Anypoint",
    "dlg.cat.seg.interactive": "Interactive",
    "dlg.cat.seg.interactive.sub": "auth code · browser",
    "dlg.cat.seg.service":     "Service",
    "dlg.cat.seg.service.sub": "client credentials",
    "dlg.cat.connFail.title":  "Connection failed",

    // ── catalog drawer ──
    "drawer.eyebrow":      "catalog",
    "drawer.refresh.tip":  "Hard refresh (bypass cache)",
    "drawer.delete.tip":   "Remove this business group from the catalog",
    "drawer.filter.ph":    "filter by name…",
    "drawer.filter.clear": "clear filter",
    "drawer.spinner":      "fetching from Exchange…",
    "drawer.fetching":     "fetching…",
    "drawer.empty.assets": "No A2A assets",
    "drawer.empty.filter": "No matching assets",
    "drawer.fetchError":   "Fetch failed",
    "drawer.bg.label":     "BG",

    // ── asset detail ──
    "detail.eyebrow":      "agent",
    "detail.back":         "back",
    "detail.connect":      "Connect",
    "detail.noUrl":        "no instance URL",
    "detail.skills":       "Skills",
    "detail.field.version":   "version",
    "detail.field.provider":  "provider",
    "detail.field.streaming": "streaming",
    "detail.field.push":      "push",
    "detail.field.inputs":    "input modes",
    "detail.field.outputs":   "output modes",

    // ── asset card ──
    "asset.tag.instance":     "instance",
    "asset.tag.cardOnly":     "card only",
    "asset.quickConnect":     "connect",
    "asset.quickConnect.tip": "Quick connect",
    "asset.tip.instance":     "{url}",
    "asset.tip.cardOnly":     "Agent card available (instance URL unresolved) — detail viewable",
    "asset.tip.none":         "No agent card or instance URL",

    // ── window header ──
    "win.bookmark.on":  "Bookmarked (click to remove)",
    "win.bookmark.off": "Bookmark",
    "win.close":        "Disconnect",

    // ── window tabs ──
    "win.tab.chat":     "chat",
    "win.tab.debug":    "debug",
    "win.tab.settings": "settings",
    "win.tab.card":     "agent card",

    // ── chat ──
    "chat.started":      "conversation started",
    "chat.compose.ph":   "Type a message…",
    "chat.compose.send": "send",
    "chat.compose.role": "role",
    "chat.compose.user": "user",
    "chat.compose.stream": "stream",
    "chat.compose.on":   "on",
    "chat.compose.hint": "{kbd1} send &nbsp;{kbd2} newline",
    "chat.connecting":   "Connecting to {name}…",
    "chat.connected":    "Connected · agent card loaded",
    "chat.disconnected": "Disconnected.",
    "chat.error":        "Error: {message}",
    "chat.sendFailed":   "send failed: {message}",
    "chat.you":          "you",
    "chat.system":       "system",

    // ── debug ──
    "dbg.clear":  "clear",
    "dbg.pause":  "pause",
    "dbg.frames": "{n} frames",

    // ── settings ──
    "settings.identity":     "Identity",
    "settings.displayName":  "Display name",
    "settings.displayName.sub": "Shown as window title",
    "settings.connection":   "Connection",
    "settings.endpoint":     "Endpoint",
    "settings.endpoint.sub": "Agent HTTP base URL",
    "settings.auth":         "Authorization",
    "settings.auth.sub":     "Bearer token (optional)",
    "settings.about":        "About",
    "settings.windowId":     "Window ID",
    "settings.windowId.sub": "Session-only",
    "settings.protocol":     "Protocol",
    "settings.protocol.sub": "Transport protocol",

    // ── agent card pane ──
    "card.unnamed":       "Unnamed Agent",
    "card.field.version":   "version",
    "card.field.provider":  "provider",
    "card.field.streaming": "streaming",
    "card.field.push":      "push",
    "card.field.inputs":    "input modes",
    "card.field.outputs":   "output modes",
    "card.skills":          "Skills",
    "card.rawJson":         "JSON",
    "card.rawJson.bytes":   "{n} bytes",

    // ── script panel ──
    "script.tab.empty":      "no script open",
    "script.tip.stop":       "Stop (⌘.)",
    "script.tip.run":        "Run (⌘⏎)",
    "script.tip.close":      "Close panel (⌘⇧K)",
    "script.tip.clear":      "Clear editor",
    "script.tab.close":      "Close",
    "script.windows.label":  "windows",
    "script.commands.label": "commands",
    "script.cmd.send":       "send",
    "script.cmd.wait":       "wait",
    "script.cmd.pause":      "pause",
    "script.cmd.reset":      "reset",
    "script.cmd.comment":    "comment",
    "script.cmd.tip.send":   "Send to window — > name: text",
    "script.cmd.tip.wait":   "Wait for reply — < name [30s]",
    "script.cmd.tip.pause":  "Pause — sleep Ns",
    "script.cmd.tip.reset":  "Clear chat — clear [name]",
    "script.cmd.tip.comment":"Comment line — # ...",
    "script.swc.empty":      "no open windows",
    "script.editor.ph": "# example\n> Atelier Bistro: hello\n< Atelier Bistro\nsleep 1s\nclear\n> Atelier Bistro: what skills do you have?\n< Atelier Bistro 30s",
    "script.clear.confirm.title": "Clear editor content?",
    "script.clear.confirm.btn":   "Clear",
    "script.status.parsed":  "▶ parsed {n} ops",
    "script.status.loop":    "↻ loop #{i} · parsed {n} ops",
    "script.status.done":    "✓ done in {ms}ms",
    "script.status.loopDone":"✓ loop done · {i} iter · {ms}ms",
    "script.status.stopped": "■ stopped",
    "script.status.loopStop":"■ loop stopped after {i} iter",

    // ── prompts / modals ──
    "modal.notice":   "Notice",
    "modal.confirm":  "Confirm",
    "modal.ok":       "OK",
    "modal.cancel":   "Cancel",
    "modal.delete":   "Delete",
    "modal.input":    "input",
    "bg.add.title":   "Add business group to \"{name}\"",
    "bg.add.label":   "business group name or ID",
    "bg.add.ph":      "e.g. btd  or  0fc4eaf1-5697-4cef-9c1b-3b96e3a52ee2",
    "bg.add.btn":     "Add",
    "bg.add.dup.title":   "Already added",
    "bg.add.dup.message": "\"{input}\" is already registered in this catalog.",
    "bg.remove.title":    "Remove \"{name}\" from catalog?",
    "bg.remove.btn":      "Remove",
    "cat.delete.title":   "Delete \"{name}\"? ({n} business groups will also be deleted)",
    "cat.delete.btn":     "Delete",
    "script.delete.title":"Delete \"{name}\"?",
    "script.delete.btn":  "Delete",
    "bookmark.host.tip":  "{host}",

    // ── window template (catalog/drawer) ──
    "drawer.bg.removeConfirm.title": "Remove \"{name}\" from \"{catalog}\"?",
    "drawer.bg.removeConfirm.btn":   "Remove",

    // ── oauth callback ──
    "oauth.cb.title":   "Anypoint",
    "oauth.cb.success": "Authentication complete",
    "oauth.cb.failure": "Authentication failed",
    "oauth.cb.note":    "You can close this window."
  },

  ja: {
    // ── 段階的に翻訳予定 (空 key は en にフォールバック) ──
    "rail.connections": "接続",
    "rail.events":      "イベント",
    "rail.workspaces":  "ワークスペース",
    "side.newConn":     "新規接続",
    "side.bookmarks":   "ブックマーク",
    "side.catalogs":    "カタログ",
    "side.scripts":     "スクリプト",
    "side.protocols":   "プロトコル",
    "side.localTime":   "ローカル時刻",
    "empty.status":     "未接続",
    "empty.headline":   "<em>あらゆる</em>エージェントと、<br/><em>ひとつ</em>の作業台から。",
    "empty.lede":       "A2A を中核に、 プロトコル非依存で複数エージェントへ同時接続。<br/>各ウインドウで会話・デバッグ・AgentCard メタを横断的に確認。",
    "empty.connect":    "エージェントに接続",
    "empty.demo":       "デモエージェントを読み込む",
    "win.tab.chat":     "チャット",
    "win.tab.debug":    "デバッグ",
    "win.tab.settings": "設定",
    "win.tab.card":     "エージェントカード",
    "chat.compose.ph":  "メッセージを送信…",
    "chat.connecting":  "{name} に接続中…",
    "chat.connected":   "接続済み · エージェントカード取得済み",
    "chat.disconnected":"切断しました。"
  }
};
