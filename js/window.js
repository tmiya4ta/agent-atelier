// AgentWindow — フローティングウインドウ
// 1接続=1ウインドウ。Chat / Agent Card / Debug / Settings の4タブ。
import { t } from "./i18n.js";

let zCounter = 10;
let idCounter = 0;

// MCP tool のカテゴリ別グリフ (read / write / other)
const TOOL_GLYPH = {
  read:  `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="3" cy="4" r="1" fill="currentColor"/><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/><path d="M6 4h7M6 8h7M6 12h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  write: `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M10.5 2.5 L13.5 5.5 L6 13 L3 13 L3 10 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="9" y1="4" x2="12" y2="7" stroke="currentColor" stroke-width="1.3"/></svg>`,
  other: `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1" fill="currentColor"/></svg>`
};
function toolCategory(name) {
  const verb = String(name || "").split(/[_\-]/)[0].toLowerCase();
  if (/^(list|get|find|resolve|search|read|fetch|query|describe)$/.test(verb)) return "read";
  if (/^(update|create|delete|set|add|remove|write|put|post|patch|insert|upsert)$/.test(verb)) return "write";
  return "other";
}

export class AgentWindow {
  constructor({ adapter, layer, onClose, onFocus, onChange, instanceSuffix, restore, lockName, authApi }) {
    this.id = `aw-${++idCounter}`;
    this.adapter = adapter;
    this.layer    = layer;
    this.onClose  = onClose;
    this.onFocus  = onFocus;
    this.onChange = onChange;
    this.authApi  = authApi || null;   // settings の Authorization を identity から選ぶ用
    this.instanceSuffix = instanceSuffix || "";   // 重複ウインドウ用 " #2" など
    this.restore  = restore || null;

    this.protoId = adapter.constructor.id;
    // protoMode = 実際の挙動/見た目を決めるプロトコル。
    // mock は本物の A2A / MCP を「装う」ので、adapter.emulates を採用する。
    // (protoId は "mock" のまま — bookmark のキー化と一覧の色分けに使う)
    this.protoMode = (this.protoId === "mock" && adapter.emulates) ? adapter.emulates : this.protoId;
    // バッジ表示は装っているプロトコル名 (mock であることは出さない)
    this.protoLabel = (this.protoId === "mock")
      ? (this.protoMode === "mcp" ? "MCP" : "A2A")
      : adapter.constructor.label;
    this.name = adapter.config.name || adapter.config.url || "Unnamed";

    // restore (persisted snapshot or import) の場合、 config.name は意図して付けられた値
    // (ユーザ編集 or import の display name)。 AgentCard 取得時に上書きしないよう lock。
    // lockName が明示的に渡された場合 (bookmark 再オープン等) も同様に lock。
    if ((this.restore || lockName) && adapter.config.name) this._nameLocked = true;

    this.debugFrames = [];
    this.debugPaused = false;
    this.startedAt = Date.now();
    this.lastLatency = null;
    this.lastSendAt = null;
    // ピン留め: true の間は drag / resize を無効化し位置・サイズを固定する。
    this.pinned = !!(this.restore && this.restore.pinned);

    this._buildDom();
    this._wireAdapter();
  }

  // ───────────────────────────────────────────
  // DOM construction
  // ───────────────────────────────────────────
  _buildDom() {
    const tpl = document.getElementById("tplWindow");
    const node = tpl.content.firstElementChild.cloneNode(true);
    this.el = node;
    node.id = this.id;
    // mock (疑似) 接続はチャットの配色等を本物と変える目印 (protoId は "mock" のまま保持)
    if (this.protoId === "mock") node.classList.add("is-mock");

    // Initial position: restore → 復元, それ以外は cascade
    if (this.restore?.pos?.left) {
      const p = this.restore.pos;
      node.style.left   = p.left;
      node.style.top    = p.top;
      node.style.width  = p.width  || "560px";
      node.style.height = p.height || "560px";
      // zIndex は重なり順を維持するため、保存値を保ちつつカウンタも進める
      const z = parseInt(p.zIndex, 10);
      if (!isNaN(z)) { zCounter = Math.max(zCounter, z); node.style.zIndex = z; }
      else           { node.style.zIndex = ++zCounter; }
    } else {
      const idx = this.layer.children.length;
      const baseX = 32 + idx * 26;
      const baseY = 32 + idx * 22;
      node.style.left = baseX + "px";
      node.style.top  = baseY + "px";
      node.style.width  = "560px";
      node.style.height = "560px";
      node.style.zIndex = ++zCounter;
    }

    // Head bits
    node.querySelector(".aw-title").textContent = this.name + this.instanceSuffix;
    const wm = node.querySelector(".aw-watermark");
    if (wm) wm.textContent = this.name + this.instanceSuffix;
    const badge = node.querySelector(".aw-proto-badge");
    badge.textContent = this.protoLabel;
    // 見た目の色は装っているプロトコル基準 (mock でも A2A/MCP の色で表示)
    badge.dataset.proto = this.protoMode;

    // Close / clear / maximize
    node.querySelector(".aw-btn-clear")?.addEventListener("click", () => this.clearChat());
    node.querySelector(".aw-btn-close").addEventListener("click", () => this.close());
    node.querySelector('.aw-traffic-dot[data-act="close"]').addEventListener("click", () => this.close());
    node.querySelector(".aw-btn-max")?.addEventListener("click", () => this.toggleMaximize());
    node.querySelector(".aw-btn-pin")?.addEventListener("click", () => this.togglePin());
    // ヘッダーをダブルクリックで最大化トグル (icon-btn 等のボタン上は除外)
    node.querySelector(".aw-head").addEventListener("dblclick", (e) => {
      if (e.target.closest("button") || e.target.closest(".aw-traffic-dot")) return;
      this.toggleMaximize();
    });

    // user が手動 scroll-up したら以降の自動 scroll を一時停止 (新メッセージで再追従)
    const cs = node.querySelector(".chat-scroll");
    cs.addEventListener("scroll", () => {
      const dist = cs.scrollHeight - cs.scrollTop - cs.clientHeight;
      this._userPinnedToBottom = dist < 30;
    });
    this._userPinnedToBottom = true;

    // Drag
    const head = node.querySelector(".aw-head");
    head.addEventListener("mousedown", (e) => this._beginDrag(e));

    // Focus
    node.addEventListener("mousedown", () => this.focus());

    // Tabs
    node.querySelectorAll(".aw-tab").forEach(tab => {
      tab.addEventListener("click", () => this.switchTab(tab.dataset.tab));
    });

    // Chat compose
    const ta = node.querySelector(".compose-input");
    const sendBtn = node.querySelector(".compose-send");
    // 入力履歴 (ターミナル風の up/down)。 1 ウインドウあたり最大 10 件、 古い順から押し出し。
    this._inputHistory = [];
    this._historyCursor = -1;     // -1 = 履歴外 (現在 typing 中の draft)
    this._historyDraft = "";       // 履歴を辿り始めた時点の入力中テキスト
    this.MAX_INPUT_HISTORY = 10;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._sendFromCompose();
        return;
      }
      if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        // カーソルが先頭行に居る時だけ履歴遡上 (複数行 textarea の編集を妨げない)
        const before = ta.value.slice(0, ta.selectionStart);
        if (before.includes("\n")) return;
        if (this._inputHistory.length === 0) return;
        e.preventDefault();
        if (this._historyCursor === -1) {
          this._historyDraft = ta.value;
          this._historyCursor = this._inputHistory.length - 1;
        } else if (this._historyCursor > 0) {
          this._historyCursor--;
        }
        this._setComposeValue(this._inputHistory[this._historyCursor]);
        return;
      }
      if (e.key === "ArrowDown" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (this._historyCursor === -1) return;
        const after = ta.value.slice(ta.selectionStart);
        if (after.includes("\n")) return;
        e.preventDefault();
        if (this._historyCursor < this._inputHistory.length - 1) {
          this._historyCursor++;
          this._setComposeValue(this._inputHistory[this._historyCursor]);
        } else {
          // 末尾より下: draft に戻る
          this._historyCursor = -1;
          this._setComposeValue(this._historyDraft || "");
        }
        return;
      }
    });
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
    });
    this._sendBtn = sendBtn;
    this._busy = false;
    // busy 中 (応答待ち) は停止ボタンとして動作。 それ以外は通常送信。
    sendBtn.addEventListener("click", () => {
      if (this._busy) this._stopInflight();
      else this._sendFromCompose();
    });

    // Capabilities overlay (compose toolbar の capabilities ボタン)
    const capsBtn = node.querySelector(".compose-caps");
    const capsOverlay = node.querySelector(".caps-overlay");
    const capsClose = node.querySelector(".caps-overlay-close");
    capsBtn.addEventListener("click", () => this._toggleCapsOverlay());
    capsClose.addEventListener("click", () => this._closeCapsOverlay());
    // 外側クリック (overlay の背景部) で閉じる挙動はなし — 入力中に消えると邪魔なので明示 close のみ。
    capsOverlay.addEventListener("click", (e) => e.stopPropagation());

    // Debug toolbar
    node.querySelector('.debug-tool[data-act="clear"]').addEventListener("click", () => {
      this.debugFrames = [];
      this._renderDebug();
    });
    const pauseBtn = node.querySelector('.debug-tool[data-act="pause"]');
    pauseBtn.addEventListener("click", () => {
      this.debugPaused = !this.debugPaused;
      pauseBtn.textContent = this.debugPaused ? "resume" : "pause";
    });
    // Debug: 右クリックで「JWT Decode」コンテキストメニュー
    // (カーソル位置 or 選択範囲の文字列から JWT を取り出して decode し popover 表示)
    const debugScroll = node.querySelector(".debug-scroll");
    if (debugScroll) debugScroll.addEventListener("contextmenu", (e) => this._onDebugContextMenu(e));

    // Settings pane content (static for now)
    this._renderSettings();

    // 右下リサイズグリップ (視覚的な目印)
    const grip = document.createElement("div");
    grip.className = "aw-resize-grip";
    grip.title = "Drag to resize";
    grip.addEventListener("mousedown", (e) => this._beginResize(e, "se"));
    node.appendChild(grip);

    // 4 辺 + 4 角 (SE 以外) の不可視リサイズハンドル。 SE はグリップが既にカバー。
    ["n","s","e","w","ne","nw","sw"].forEach(dir => {
      const h = document.createElement("div");
      h.className = "aw-resize-edge aw-resize-" + dir;
      h.addEventListener("mousedown", (ev) => this._beginResize(ev, dir));
      node.appendChild(h);
    });

    this.layer.appendChild(node);
    this.focus();

    // 復元時に pinned だった場合は見た目に反映 (drag/resize は _beginDrag/_beginResize 側でガード)
    this._applyPinnedState();

    // MCP モード: tools タブを露出し、 chat タブを使わない構成に切り替える。
    if (this.protoMode === "mcp") this._setupMcpMode(node);

    // 既に open 済み adapter を渡された場合は、 open event 相当の初期描画を即時実行
    if (this.adapter.state === "open" && this.adapter.agentCard) {
      this._setStatus("live");
      this._renderCard(this.adapter.agentCard);
      this._renderSettings();
      this._addSystemMessage(`Connected · agent card loaded`);
      const cardName = this.adapter.agentCard.name;
      if (cardName && !this._nameLocked) {
        this.name = cardName;
        this.adapter.config.name = cardName;
        this.el.querySelector(".aw-title").textContent = cardName + this.instanceSuffix;
        const wm = this.el.querySelector(".aw-watermark");
        if (wm) wm.textContent = cardName + this.instanceSuffix;
        this.onChange?.();
      }
      if (this.restore?.activeTab && this.restore.activeTab !== "chat") {
        this.switchTab(this.restore.activeTab);
        this.restore = null;
      }
    } else {
      this._addSystemMessage(`Connecting to ${this.name}…`);
    }
  }

  _wireAdapter() {
    this.adapter.addEventListener("open", (e) => {
      this._setStatus("live");
      this._addSystemMessage(`Connected · agent card loaded`);
      this._renderCard(e.detail.card);
      // agentCard で取れた effective endpoint を Settings にも反映
      this._renderSettings();
      // ウインドウタイトルを AgentCard.name で上書き (ユーザーが settings で変更してない時のみ)
      const cardName = e.detail.card?.name;
      if (cardName && !this._nameLocked) {
        this.name = cardName;
        this.adapter.config.name = cardName;
        this.el.querySelector(".aw-title").textContent = cardName + this.instanceSuffix;
        const wm = this.el.querySelector(".aw-watermark");
        if (wm) wm.textContent = cardName + this.instanceSuffix;
        this.onChange?.();
      }
      // 復元タブを反映 (open後にカード/設定が描画されてからの方が安全)
      if (this.restore?.activeTab && this.restore.activeTab !== "chat") {
        this.switchTab(this.restore.activeTab);
        this.restore = null;
      }
    });

    this.adapter.addEventListener("message", (e) => {
      const { role, text, final } = e.detail;
      this._handleAgentMessage(text, final);
      if (this.lastSendAt && final) {
        this.lastLatency = Date.now() - this.lastSendAt;
        this._stampLatency(this.lastLatency);
        this.lastSendAt = null;
      }
    });

    // streaming (SSE) の中間進捗。 status-update の working 等を逐次 system 行で表示。
    this.adapter.addEventListener("status", (e) => {
      const { text } = e.detail || {};
      if (text) this._handleStatusUpdate(text);
    });

    this.adapter.addEventListener("rpc", (e) => {
      if (this.debugPaused) return;
      const f = {
        ...e.detail,
        ts: Date.now()
      };
      this.debugFrames.push(f);
      this._renderDebug();
      // tab count
      const t = this.el.querySelector('.aw-tab[data-tab="debug"] .tab-count');
      t.textContent = String(this.debugFrames.length);
    });

    this.adapter.addEventListener("error", (e) => {
      this._setStatus("error");
      this._addSystemMessage(`Error: ${e.detail?.message || e.detail}`);
    });

    this.adapter.addEventListener("close", () => {
      this._setStatus("idle");
      this._addSystemMessage(`Disconnected.`);
    });

    // 認証セッション切れ (Authorization Code 等で対話的再認証が必要) → クールな再認証バナーを出す
    this.adapter.addEventListener("auth-required", (e) => {
      this._showReauthBanner(e.detail || {});
    });
  }

  // 期限切れ → ユーザーに再認証を促す光るバナー。 クリックで OAuth フローを起動。
  _showReauthBanner(detail) {
    if (!this.el) return;
    this.el.querySelector(".aw-reauth")?.remove();
    const bar = document.createElement("div");
    bar.className = "aw-reauth";
    bar.innerHTML = `
      <span class="aw-reauth-pulse" aria-hidden="true"></span>
      <span class="aw-reauth-text">${escapeHtml(detail.name ? `"${detail.name}" ` : "")}session expired</span>
      <button type="button" class="aw-reauth-btn">Re-authenticate <span class="arrow">→</span></button>`;
    const btn = bar.querySelector(".aw-reauth-btn");
    btn.addEventListener("click", async () => {
      if (typeof this.adapter.config.reauth !== "function") return;
      btn.disabled = true;
      btn.textContent = "authenticating…";
      try {
        const a = await this.adapter.config.reauth(this.adapter.config.authRef);
        if (a) { this.adapter.config.auth = a.auth; this.adapter.config.authHeaders = a.authHeaders; }
        bar.classList.add("is-done");
        this._addSystemMessage("Re-authenticated. You can retry now.");
        setTimeout(() => bar.remove(), 900);
        this.onChange?.();
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = `Retry sign-in <span class="arrow">→</span>`;
        this._addSystemMessage(`Re-authentication failed: ${err?.message || err}`);
      }
    });
    // chat ペインの先頭に差し込む (無ければウインドウ本体に)
    const host = this.el.querySelector(".pane-chat") || this.el.querySelector(".aw-body") || this.el;
    host.insertBefore(bar, host.firstChild);
  }

  // ───────────────────────────────────────────
  // Window ops
  // ───────────────────────────────────────────
  focus() {
    this.el.style.zIndex = ++zCounter;
    document.querySelectorAll(".agent-window.is-focused").forEach(n => n.classList.remove("is-focused"));
    this.el.classList.add("is-focused");
    this.onFocus?.(this);
  }

  close() {
    this._closeJwtMenu?.();        // 右クリックメニュー/popover が body に残らないように
    this._closeJwtPopover?.();
    this.adapter.disconnect?.();
    this.el.remove();
    this.onClose?.(this);
  }

  switchTab(tab) {
    this.el.querySelectorAll(".aw-tab").forEach(t => t.classList.toggle("is-active", t.dataset.tab === tab));
    this.el.querySelectorAll(".pane").forEach(p => p.classList.toggle("is-active", p.dataset.pane === tab));
    this.onChange?.();
  }

  _setStatus(s) {
    const dot = this.el.querySelector(".aw-status-dot");
    dot.classList.remove("is-live", "is-error");
    if (s === "live")  dot.classList.add("is-live");
    if (s === "error") dot.classList.add("is-error");
  }

  // 応答が確定したら、 直近の agent メッセージ吹き出しの右下に所要時間を刻む。
  _stampLatency(ms) {
    if (ms == null) return;
    const stream = this.el.querySelector(".chat-stream");
    if (!stream) return;
    // 最後の agent メッセージ (今 final になった吹き出し) を探す
    const agents = stream.querySelectorAll(".msg-agent .msg-bubble");
    const bubble = agents[agents.length - 1];
    if (!bubble) return;
    let badge = bubble.querySelector(".msg-latency");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "msg-latency";
      bubble.appendChild(badge);
    }
    const txt = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
    badge.textContent = txt;
    badge.title = `応答時間 ${ms} ms`;
  }

  // ───────────────────────────────────────────
  // Drag
  // ───────────────────────────────────────────
  _beginDrag(e) {
    if (this.pinned) return;   // ピン留め中は移動不可
    if (e.target.closest("button") || e.target.closest(".aw-traffic-dot")) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = this.el.getBoundingClientRect();
    const layerRect = this.layer.getBoundingClientRect();
    const offsetX = startX - rect.left;
    const offsetY = startY - rect.top;

    const onMove = (ev) => {
      const x = ev.clientX - layerRect.left - offsetX;
      const y = ev.clientY - layerRect.top  - offsetY;
      this.el.style.left = Math.max(0, x) + "px";
      this.el.style.top  = Math.max(0, y) + "px";
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.onChange?.();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ピン留めトグル: 位置・サイズを固定 (drag/resize 無効) する。
  togglePin() {
    this.pinned = !this.pinned;
    this._applyPinnedState();
    this.onChange?.();
  }

  // pinned 状態を DOM に反映 (クラス + ボタンの active 表示 + tooltip)。
  _applyPinnedState() {
    if (!this.el) return;
    this.el.classList.toggle("is-pinned", this.pinned);
    const btn = this.el.querySelector(".aw-btn-pin");
    if (btn) {
      btn.classList.toggle("is-active", this.pinned);
      btn.title = this.pinned ? "Unpin window (allow move/resize)" : "Pin window in place (lock position/size)";
      btn.setAttribute("aria-pressed", this.pinned ? "true" : "false");
    }
  }

  // 4 辺 + 4 角でリサイズ。 dir = "n"|"s"|"e"|"w"|"ne"|"nw"|"se"|"sw"
  // n/w 側を引っ張ったときは left/top も動かす必要がある。
  _beginResize(e, dir = "se") {
    if (this.pinned) return;   // ピン留め中はリサイズ不可
    if (this.el.classList.contains("is-maximized")) return;
    e.preventDefault();
    e.stopPropagation();
    this.focus();
    const startX = e.clientX, startY = e.clientY;
    const startW = this.el.offsetWidth;
    const startH = this.el.offsetHeight;
    const startL = this.el.offsetLeft;
    const startT = this.el.offsetTop;
    const minW = parseInt(getComputedStyle(this.el).minWidth, 10) || 380;
    const minH = parseInt(getComputedStyle(this.el).minHeight, 10) || 320;
    const cursorMap = {
      n: "ns-resize", s: "ns-resize",
      e: "ew-resize", w: "ew-resize",
      ne: "nesw-resize", sw: "nesw-resize",
      nw: "nwse-resize", se: "nwse-resize"
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = cursorMap[dir] || "nwse-resize";

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let w = startW, h = startH, l = startL, t = startT;
      if (dir.includes("e")) w = Math.max(minW, startW + dx);
      if (dir.includes("s")) h = Math.max(minH, startH + dy);
      if (dir.includes("w")) {
        w = Math.max(minW, startW - dx);
        l = startL + (startW - w);
      }
      if (dir.includes("n")) {
        h = Math.max(minH, startH - dy);
        t = startT + (startH - h);
      }
      this.el.style.width  = w + "px";
      this.el.style.height = h + "px";
      this.el.style.left   = Math.max(0, l) + "px";
      this.el.style.top    = Math.max(0, t) + "px";
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      this.onChange?.();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ───────────────────────────────────────────
  // Chat
  // ───────────────────────────────────────────
  _sendFromCompose() {
    const ta = this.el.querySelector(".compose-input");
    const text = ta.value.trim();
    if (!text || this.adapter.state !== "open") return;
    this._pushInputHistory(text);
    ta.value = "";
    ta.style.height = "auto";
    // 手入力はユーザーが既に打ち終えているので、 入力エリアへの自動タイプ演出はスキップ。
    this.sendProgrammatic(text, { typeIntoCompose: false });
  }

  // ───────────────────────────────────────────
  // Capabilities overlay
  // ───────────────────────────────────────────
  _toggleCapsOverlay() {
    const ov = this.el.querySelector(".caps-overlay");
    if (!ov) return;
    if (ov.classList.contains("is-visible")) {
      this._closeCapsOverlay();
    } else {
      this._openCapsOverlay();
    }
  }
  _openCapsOverlay() {
    const ov = this.el.querySelector(".caps-overlay");
    const btn = this.el.querySelector(".compose-caps");
    if (!ov) return;
    this._renderCapsOverlay();
    ov.hidden = false;
    ov.setAttribute("aria-hidden", "false");
    btn?.setAttribute("aria-expanded", "true");
    // 次フレームで is-visible を立てて transition を発火 (display:none → 表示の同フレームだと効かない)
    requestAnimationFrame(() => ov.classList.add("is-visible"));
  }
  _closeCapsOverlay() {
    const ov = this.el.querySelector(".caps-overlay");
    const btn = this.el.querySelector(".compose-caps");
    if (!ov) return;
    ov.classList.remove("is-visible");
    btn?.setAttribute("aria-expanded", "false");
    const onEnd = () => {
      ov.removeEventListener("transitionend", onEnd);
      if (!ov.classList.contains("is-visible")) {
        ov.hidden = true;
        ov.setAttribute("aria-hidden", "true");
      }
    };
    ov.addEventListener("transitionend", onEnd);
  }
  _renderCapsOverlay() {
    const body = this.el.querySelector(".caps-overlay-body");
    if (!body) return;
    const card = this.adapter.agentCard;
    if (!card) {
      body.innerHTML = `<div class="caps-empty">agent card not loaded yet</div>`;
      return;
    }
    const skills = card.skills || [];
    if (!skills.length) {
      body.innerHTML = `<div class="caps-empty">no skills declared</div>`;
      return;
    }
    // skill 名だけ並べる。 description は title 属性 (OS native tooltip) で hover 時に表示。
    body.innerHTML = `<div class="caps-skill-list">` +
      skills.map(s => {
        const name = s.name || s.id || "";
        const desc = s.description || "";
        return `<div class="caps-skill-item" title="${escapeHtml(desc)}">${escapeHtml(name)}</div>`;
      }).join("") +
      `</div>`;
  }

  // 入力履歴に push。 直前と同一なら重複しない。 上限超過分は先頭から落とす。
  _pushInputHistory(text) {
    const last = this._inputHistory[this._inputHistory.length - 1];
    if (text !== last) {
      this._inputHistory.push(text);
      if (this._inputHistory.length > this.MAX_INPUT_HISTORY) {
        this._inputHistory.shift();
      }
    }
    this._historyCursor = -1;
    this._historyDraft = "";
  }

  // 履歴から呼び戻すときの textarea 同期。 高さ自動調整 + キャレットを末尾へ。
  _setComposeValue(v) {
    const ta = this.el.querySelector(".compose-input");
    ta.value = v;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }

  // Script から呼び出される。chat-stream を空にする + adapter の contextId を reroll
  // (= サーバ側 memory との紐付けを切って、次のターンから初対面扱い)
  clearChat() {
    const stream = this.el.querySelector(".chat-stream");
    if (stream) stream.innerHTML = "";
    if (typeof this.adapter.resetContext === "function") {
      this.adapter.resetContext();
    }
  }

  // Script から呼び出される。返り値は adapter.send の Promise。
  // opts.typeIntoCompose (既定 true): 下の入力エリアに 1 文字ずつ「人間が打っている」風に
  //   流し込んでから送信する。 手入力 (_sendFromCompose) からは false で呼ぶ (二重タイプ防止)。
  sendProgrammatic(text, opts = {}) {
    if (!text || this.adapter.state !== "open") return Promise.reject(new Error("not connected"));
    const typeInto = opts.typeIntoCompose !== false;
    const doSend = () => {
      this._showTyping(true);
      this.lastSendAt = Date.now();
      return this.adapter.send(text, { stream: true }).catch(err => {
        // 停止ボタンによる中断は _stopInflight 側で表示済みなので、 ここでは何も出さない
        if (err?.name === "AbortError") { this._showTyping(false); throw err; }
        this._showTyping(false);
        this._addSystemMessage(`send failed: ${err.message}`);
        throw err;
      });
    };
    if (typeInto) {
      // 人間が打っているように: まず下の入力エリアに 1 文字ずつタイプ → 入力欄をクリアして
      // ユーザーバブルを即時表示 (バブル側ではタイプしない) → 送信。
      return this._typeIntoCompose(text).then(() => {
        const ta = this.el.querySelector(".compose-input");
        if (ta) { ta.value = ""; ta.style.height = "auto"; }
        this._addUserMessage(text, { instant: true });
        return doSend();
      });
    }
    // 手入力時: 従来どおりストリームにユーザーバブルをタイプライター表示してから送信。
    const userDone = this._addUserMessage(text);
    if (this.adapter._mockActive) return userDone.then(doSend);
    return doSend();
  }

  // 次の最終応答を待つ Promise を返す
  // (script DSL の `< Agent` 用) — message 受信後、typewriter 完了まで待ってから resolve
  waitForReply({ timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.adapter.removeEventListener("message", onMsg);
        reject(new Error(`timeout after ${Math.round(timeout/1000)}s`));
      }, timeout);
      const onMsg = (e) => {
        const d = e.detail;
        if (d && d.role === "agent" && d.final) {
          this.adapter.removeEventListener("message", onMsg);
          // typewriter が走っている間は次のメッセージを流さない
          this._waitForTypewriterDone().then(() => {
            clearTimeout(timer);
            resolve(d);
          });
        }
      };
      this.adapter.addEventListener("message", onMsg);
    });
  }

  // 直近の agent メッセージの typewriter が終わるまで待つ
  _waitForTypewriterDone() {
    return new Promise(resolve => {
      const isTyping = () => !!this.el.querySelector('.msg-agent[data-typing="1"], .msg-agent[data-streaming="1"]');
      if (!isTyping()) { resolve(); return; }
      const tick = () => {
        if (!isTyping()) { resolve(); return; }
        setTimeout(tick, 60);
      };
      // typewriter 開始は次マイクロタスク。少し待ってから poll 開始
      setTimeout(tick, 80);
    });
  }

  // 返り値: 入力 typewriter が完了する Promise。
  // opts.instant = true なら、 タイプライターせず本文を即時表示して整形する
  // (入力エリア側で既にタイプ演出済みのケース — sendProgrammatic から)。
  _addUserMessage(text, opts = {}) {
    const stream = this.el.querySelector(".chat-stream");
    const node = this._renderMsg("user", "you", "");
    stream.appendChild(node);
    const body = node.querySelector(".msg-body");
    if (opts.instant) {
      this._renderUserBody(body, text);
      this._scrollChat(true);
      return Promise.resolve();
    }
    const done = this._typewriteUser(body, text);
    this._scrollChat(true);
    return done;
  }

  // user バブル本文を protocol に応じて整形して即時セット (タイプなし)。
  // _typewriteUser の finalize と同じ整形ロジックを共有する。
  _renderUserBody(body, fullText) {
    const normalized = String(fullText).replace(/\\n/g, "\n");
    if (this.protoMode === "slack") {
      body.innerHTML = safeHtml(mrkdwnToHtml(normalized));
      body.dataset.md = "1";
    } else if (this.protoMode === "a2a" && window.marked) {
      try {
        window.marked.setOptions({ gfm: true, breaks: true });
        body.innerHTML = safeHtml(window.marked.parse(normalized));
        body.dataset.md = "1";
      } catch (e) {
        body.textContent = normalized;
      }
    } else {
      body.textContent = normalized;
    }
  }

  _addSystemMessage(text) {
    const stream = this.el.querySelector(".chat-stream");
    stream.appendChild(this._renderMsg("system", "system", text));
    this._scrollChat(true);
  }

  // streaming の中間進捗 (status-update working)。 system 行として逐次積み上げる。
  // typing スピナーは消さない (最終 message が来るまで思考中の演出を維持)。
  _handleStatusUpdate(text) {
    const stream = this.el.querySelector(".chat-stream");
    const node = this._renderMsg("system", "status", text);
    node.classList.add("msg-status");
    // a2a の進捗ステップは Markdown (太字・表) を含むことがあるので HTML 化して読みやすく。
    // 複数行を許容するため msg-step クラスで pill の nowrap を解除する。
    if (this.protoMode === "a2a" && window.marked) {
      const body = node.querySelector(".msg-body");
      if (body) {
        try {
          window.marked.setOptions({ gfm: true, breaks: true });
          body.innerHTML = safeHtml(window.marked.parse(text));
          body.dataset.md = "1";
          node.classList.add("msg-step");
        } catch { /* keep plain text on parse error */ }
      }
    }
    stream.appendChild(node);
    // 思考中スピナーが出ていれば最下部へ移動 (常に「最新ステップの下で考えている」見た目に)
    const typing = stream.querySelector(".msg-typing");
    if (typing) stream.appendChild(typing);
    this._scrollChat(true);
  }

  _handleAgentMessage(text, final) {
    this._showTyping(false);
    const stream = this.el.querySelector(".chat-stream");
    let last = stream.lastElementChild;
    let body;
    if (last?.classList.contains("msg-agent") && last?.dataset.streaming === "1") {
      body = last.querySelector(".msg-body");
    } else {
      // display name (this.name) を優先。ユーザが import / settings で付けた日本語名が
      // あればそれを使い、無い時だけ AgentCard.name にフォールバック。
      const author = this.name || this.adapter.agentCard?.name || "agent";
      const node = this._renderMsg("agent", author, "");
      node.dataset.streaming = "1";
      stream.appendChild(node);
      body = node.querySelector(".msg-body");
    }
    // ChatGPT 風 typewriter で逐次表示 (現在の長さから差分を append)
    this._typewrite(body, text, final);
  }

  // 文字を 1 〜 数文字ずつ append して滑らかに表示
  _typewrite(body, fullText, final) {
    if (this._typeTimer) {
      clearTimeout(this._typeTimer);
      this._typeTimer = null;
    }
    // body.parentElement は .msg-bubble (copy ボタンの親)。 dataset 用には .msg まで遡る。
    const msg = body.closest(".msg") || body.parentElement;
    const current = body.textContent || "";
    const finalize = () => {
      if (final) msg.dataset.streaming = "0";
      // Slack: typewriter 完了後に mrkdwn を HTML 化
      if (final && this.protoMode === "slack") {
        body.innerHTML = safeHtml(mrkdwnToHtml(fullText));
        body.dataset.md = "1";
      }
      // a2a: Markdown (GFM) を HTML 化
      // breaks:true で単一 "\n" も <br> 改行にする。 broker の統合レポートは各
      // 【○○エージェント】を単一改行で区切るので、 breaks:false だと 1 段落に潰れて
      // 非常に読みづらい (実機応答で確認)。 table 構文は breaks 設定の影響を受けず
      // 壊れないことを検証済み (marked 11.2.0)。
      else if (final && this.protoMode === "a2a" && window.marked) {
        try {
          window.marked.setOptions({ gfm: true, breaks: true });
          // broker 統合レポートは整形してから Markdown 化 (それ以外はそのまま)
          body.innerHTML = safeHtml(window.marked.parse(formatBrokerReport(fullText)));
          body.dataset.md = "1";
        } catch (e) {
          // fallback to plain text on parse error
          console.warn("[window] marked.parse failed:", e);
        }
      }
    };
    if (fullText.length <= current.length) {
      body.textContent = fullText;
      finalize();
      this._scrollChat();
      return;
    }
    msg.dataset.typing = "1";
    let i = current.length;
    const total = fullText.length;
    const stepSize = total > 400 ? 3 : total > 120 ? 2 : 1;
    const interval = 30;
    const tick = () => {
      if (i >= total) {
        msg.dataset.typing = "0";
        finalize();
        this._typeTimer = null;
        this._scrollChat();
        return;
      }
      const next = Math.min(i + stepSize, total);
      body.textContent = fullText.slice(0, next);
      i = next;
      this._scrollChat();
      this._typeTimer = setTimeout(tick, interval);
    };
    tick();
  }

  // user 側の typewriter (agent と同じ感覚で少し速め)。 typewriter 中は textContent
  // (literal \n を含む input が改行に見えるよう pre-line で表示) で逐次表示し、 完了後に
  // protocol に応じた markdown / mrkdwn 整形を innerHTML で適用する。
  // 入力 (user 発言) を typewriter 表示。 表示が完了したら resolve する Promise を返す
  // (mock モードで「入力表示が終わってから応答遅延を開始」するために使う)。
  // 入力エリア (compose-input) に 1 文字ずつ「人間が打っている」ように流し込む演出。
  // script 実行時、 ストリームに直接バブルを出す代わりに、 まずここで下の入力欄に
  // ぱちぱちタイプして見せる。 完了したら resolve (呼び出し側が clear + 送信)。
  // 速度は 1 文字ごとに 40〜80ms のゆらぎ + 空白/句読点で軽く溜め (自然さ)。
  _typeIntoCompose(fullText) {
    return new Promise((resolve) => {
      const ta = this.el.querySelector(".compose-input");
      if (!ta) { resolve(); return; }
      if (this._composeTypeTimer) { clearTimeout(this._composeTypeTimer); this._composeTypeTimer = null; }
      const normalized = String(fullText).replace(/\\n/g, "\n");
      const total = normalized.length;
      ta.value = "";
      ta.classList.add("is-autotyping");   // タイプ中の見た目 (キャレット点滅)
      let i = 0;
      const autosize = () => {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
      };
      // 1 文字あたりの待ち時間: ベース 40〜80ms。 直前文字が空白/句読点なら少し溜める。
      const delayFor = (ch) => {
        let d = 40 + Math.random() * 40;
        if (/[\s、。,.!?！？]/.test(ch)) d += 60 + Math.random() * 90;
        return d;
      };
      const finish = () => { ta.classList.remove("is-autotyping"); this._composeTypeTimer = null; resolve(); };
      const tick = () => {
        // 停止されたら途中でも打ち切り、 打てた分はそのまま resolve (呼び出し側が処理)
        if (this._composeTypeAborted) { this._composeTypeAborted = false; finish(); return; }
        if (i >= total) { finish(); return; }
        const ch = normalized[i];
        ta.value = normalized.slice(0, i + 1);
        autosize();
        i += 1;
        this._composeTypeTimer = setTimeout(tick, delayFor(ch));
      };
      tick();
    });
  }

  _typewriteUser(body, fullText) {
    return new Promise((resolve) => {
      if (this._userTypeTimer) {
        clearTimeout(this._userTypeTimer);
        this._userTypeTimer = null;
      }
      // literal "\n" sequence (script DSL から渡る "\\n") を実改行に正規化
      const normalized = String(fullText).replace(/\\n/g, "\n");
      const msg = body.closest(".msg") || body.parentElement;
      msg.dataset.typing = "1";
      let i = 0;
      const total = normalized.length;
      const stepSize = total > 400 ? 3 : total > 120 ? 2 : 1;
      const interval = 26;
      const finalize = () => {
        msg.dataset.typing = "0";
        this._userTypeTimer = null;
        // protocol に応じた整形
        if (this.protoMode === "slack") {
          body.innerHTML = safeHtml(mrkdwnToHtml(normalized));
          body.dataset.md = "1";
        } else if (this.protoMode === "a2a" && window.marked) {
          try {
            window.marked.setOptions({ gfm: true, breaks: true });
            body.innerHTML = safeHtml(window.marked.parse(normalized));
            body.dataset.md = "1";
          } catch (e) {
            console.warn("[window] marked.parse (user) failed:", e);
          }
        }
        this._scrollChat();
        resolve();
      };
      const tick = () => {
        if (i >= total) { finalize(); return; }
        const next = Math.min(i + stepSize, total);
        body.textContent = normalized.slice(0, next);
        i = next;
        this._scrollChat();
        this._userTypeTimer = setTimeout(tick, interval);
      };
      tick();
    });
  }

  _renderMsg(role, author, text) {
    const wrap = document.createElement("div");
    wrap.className = `msg msg-${role}`;
    if (role !== "system") {
      const head = document.createElement("div");
      head.className = "msg-head";
      head.innerHTML = `<span class="msg-author">${escapeHtml(author)}</span><span class="msg-time">${timeStr()}</span>`;
      wrap.appendChild(head);
    }
    if (role !== "system") {
      // bubble = body + copy ボタンを relative ラップ。 body の innerHTML を marked が
      // 書き換えるので、 ボタンは body の外 (= bubble 直下) に置いて消えないようにする。
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      const body = document.createElement("div");
      body.className = "msg-body";
      body.textContent = text;
      bubble.appendChild(body);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg-copy";
      btn.title = "Copy message";
      btn.setAttribute("aria-label", "Copy message");
      btn.textContent = "copy";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const src = body.textContent || "";
        const done = () => {
          btn.classList.add("is-copied");
          btn.textContent = "copied";
          setTimeout(() => {
            btn.classList.remove("is-copied");
            btn.textContent = "copy";
          }, 1200);
        };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(src).then(done).catch(() => {
            fallbackCopy(src);
            done();
          });
        } else {
          fallbackCopy(src);
          done();
        }
      });
      bubble.appendChild(btn);
      wrap.appendChild(bubble);
    } else {
      const body = document.createElement("div");
      body.className = "msg-body";
      body.textContent = text;
      wrap.appendChild(body);
    }
    return wrap;
  }

  // 送信ボタンを「送信」⇄「停止」に切り替える。
  // busy=true: ◼ 停止アイコン + is-stop クラス。 busy=false: 通常の送信矢印に戻す。
  _setBusy(on) {
    this._busy = !!on;
    const btn = this._sendBtn;
    if (!btn) return;
    if (on) {
      btn.classList.add("is-stop");
      btn.title = "停止";
      btn.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>`;
    } else {
      btn.classList.remove("is-stop");
      btn.title = "send";
      btn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 8 L14 8 M9 3 L14 8 L9 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
  }

  // 停止ボタン押下: 進行中の adapter 送信を中断し、 実行中シナリオも止め、 typing 表示を消す。
  _stopInflight() {
    if (typeof this.adapter.abort === "function") this.adapter.abort();
    // 入力エリアへのタイプ演出が走っていれば中断し、 入力欄をクリア。
    if (this._composeTypeTimer) {
      this._composeTypeAborted = true;
      const ta = this.el.querySelector(".compose-input");
      if (ta) { ta.value = ""; ta.style.height = "auto"; ta.classList.remove("is-autotyping"); }
    }
    // 実行中のシナリオ (ScriptRunner / loop) も停止する。 app 側が listen。
    document.dispatchEvent(new CustomEvent("atelier:stop-scenario"));
    this._showTyping(false);
    this._setBusy(false);
    this._addSystemMessage("⏹ 停止しました");
  }

  _showTyping(on) {
    if (on) this._setBusy(true); else this._setBusy(false);
    const stream = this.el.querySelector(".chat-stream");
    let typingEl = stream.querySelector(".msg-typing");
    if (on && !typingEl) {
      const author = this.name || this.adapter.agentCard?.name || "agent";
      const node = document.createElement("div");
      node.className = "msg msg-agent msg-typing";
      // 通常のメッセージと同じ構造: 名前は枠の外 (msg-head)、 ドットだけ枠内
      node.innerHTML = `
        <div class="msg-head">
          <span class="msg-author">${escapeHtml(author)}</span>
        </div>
        <div class="msg-body">
          <span class="msg-thinking">${escapeHtml(t("chat.thinking"))}</span>
        </div>
      `;
      stream.appendChild(node);
      this._scrollChat();
    } else if (!on && typingEl) {
      typingEl.remove();
    }
  }

  _scrollChat(force) {
    const s = this.el.querySelector(".chat-scroll");
    // force=true: 強制 (新規 user/system メッセージ送信時)
    // force=false (default): user が bottom 付近にいる時だけ追従。
    // 過去ログを scroll-up で読んでいる最中は触らない。
    if (force) {
      s.scrollTop = s.scrollHeight;
      this._userPinnedToBottom = true;
      return;
    }
    if (this._userPinnedToBottom) s.scrollTop = s.scrollHeight;
  }

  toggleMaximize() {
    // 連打中はアニメをスキップ (transitionend を待たずに次が来た場合の保険)
    if (this._maxAnimTimer) {
      clearTimeout(this._maxAnimTimer);
      this._maxAnimTimer = null;
    }

    const willMax = !this.el.classList.contains("is-maximized");

    if (willMax) {
      // 元の pos/size を退避
      this._preMaxPos = {
        left:   this.el.style.left,
        top:    this.el.style.top,
        width:  this.el.style.width,
        height: this.el.style.height,
        zIndex: this.el.style.zIndex,
      };
      // アニメ用に transition を一時 ON。
      // この時点では inline left/top/width/height は固定値なので、
      // 次フレームで is-maximized クラスを足すと !important で 0/100% に補間される。
      this.el.classList.add("is-animating");
      requestAnimationFrame(() => this.el.classList.add("is-maximized"));
    } else {
      // 復元: アニメ ON のまま is-maximized を外すと inline 値に向けて補間される。
      this.el.classList.add("is-animating");
      this.el.classList.remove("is-maximized");
      if (this._preMaxPos) {
        Object.assign(this.el.style, this._preMaxPos);
        this._preMaxPos = null;
      }
    }

    // transitionend で is-animating を外す。 transitionend は複数 property で複数回
    // 発火するので、 タイマーで保険を掛けつつ最後の 1 回で外す。
    const cleanup = () => {
      this.el.classList.remove("is-animating");
      this.el.removeEventListener("transitionend", cleanup);
      this._maxAnimTimer = null;
    };
    this.el.addEventListener("transitionend", cleanup);
    this._maxAnimTimer = setTimeout(cleanup, 400);

    this.focus();
    if (this.onChange) this.onChange();
  }

  // ───────────────────────────────────────────
  // Card
  // ───────────────────────────────────────────
  _renderCard(card) {
    if (!card) return;   // adapter が agent-card を発行しない (e.g., MCP) ときはスキップ
    const box = this.el.querySelector(".card-scroll");
    const initial = (card.name || "?").charAt(0).toUpperCase();

    const skills = (card.skills || []).map(s => `
      <div class="card-skill">
        <div class="skill-name">
          ${escapeHtml(s.name || s.id)}
          ${(s.tags || []).map(t => `<span class="skill-tag">${escapeHtml(t)}</span>`).join("")}
        </div>
        <div class="skill-desc">${escapeHtml(s.description || "")}</div>
      </div>
    `).join("");

    const caps = card.capabilities || {};
    const capsRow = (k, v) => `<div class="card-field"><span class="card-field-label">${k}</span><span class="card-field-value">${v === true ? "yes" : v === false ? "no" : (v || "—")}</span></div>`;

    const cardUrl = card.url || this.adapter.config.url || "";
    const discoveryUrl = this.adapter.config.url || "";
    const showUrlMismatch = cardUrl && discoveryUrl && !cardUrl.startsWith(stripTrailingSlash(discoveryUrl)) && !discoveryUrl.startsWith(stripTrailingSlash(cardUrl));
    box.innerHTML = `
      <div class="card-hero">
        <div class="card-avatar">${escapeHtml(initial)}</div>
        <div>
          <h3 class="card-name">${escapeHtml(card.name || "Unnamed Agent")}</h3>
          <p class="card-desc">${escapeHtml(card.description || "")}</p>
        </div>
      </div>

      <div class="card-url-row" title="AgentCard が宣言する URL。 メッセージ送信はこの URL に対して行われます。">
        <span class="card-url-label">endpoint url</span>
        <code class="card-url-val${showUrlMismatch ? " is-warn" : ""}">${escapeHtml(cardUrl || "—")}</code>
      </div>
      ${showUrlMismatch ? `<div class="card-url-warn">⚠ Discovery URL (<code>${escapeHtml(discoveryUrl)}</code>) と異なります。 メッセージは上の endpoint url に送信されます。</div>` : ""}

      <div class="card-grid">
        ${capsRow("version", escapeHtml(card.version || "—"))}
        ${capsRow("provider", escapeHtml(card.provider?.organization || "—"))}
        ${capsRow("streaming", caps.streaming)}
        ${capsRow("push", caps.pushNotifications)}
        ${capsRow("input modes", (card.defaultInputModes || []).join(", ") || "—")}
        ${capsRow("output modes", (card.defaultOutputModes || []).join(", ") || "—")}
      </div>

      ${skills ? `<h4 class="card-section-title">Skills · ${(card.skills || []).length}</h4>
      <div class="card-skills">${skills}</div>` : ""}

      <div class="card-raw-head">
        <button class="card-raw-toggle" type="button" aria-expanded="false">
          <span class="crt-branch">├─</span>
          <span class="crt-caret">▸</span>
          <span class="crt-bracket-l">[</span>
          <span class="crt-label">JSON</span>
          <span class="crt-bracket-r">]</span>
          <span class="crt-meta">${JSON.stringify(card).length} bytes</span>
        </button>
        <span class="card-raw-actions">
          <button class="card-copy" type="button" title="AgentCard JSON をコピー">copy</button>
          <button class="card-download" type="button" title="AgentCard JSON をダウンロード">download</button>
        </span>
      </div>
      <pre class="card-raw" hidden>${syntaxJson(card)}</pre>
    `;

    // raw json toggle
    const tBtn = box.querySelector(".card-raw-toggle");
    const tPre = box.querySelector(".card-raw");
    if (tBtn && tPre) {
      const branchEl = tBtn.querySelector(".crt-branch");
      const caretEl  = tBtn.querySelector(".crt-caret");
      tBtn.addEventListener("click", () => {
        const opening = tPre.hidden;
        tPre.hidden = !opening;
        tBtn.setAttribute("aria-expanded", String(opening));
        caretEl.textContent  = opening ? "▾" : "▸";
        branchEl.textContent = opening ? "└─" : "├─";
      });
    }

    // AgentCard JSON の copy / download
    const jsonStr = JSON.stringify(card, null, 2);
    const slug = String(card.name || "agent").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

    const copyBtn = box.querySelector(".card-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const done = () => { copyBtn.textContent = "copied"; setTimeout(() => copyBtn.textContent = "copy", 1200); };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(jsonStr).then(done).catch(() => { fallbackCopy(jsonStr); done(); });
        } else { fallbackCopy(jsonStr); done(); }
      });
    }

    const dlBtn = box.querySelector(".card-download");
    if (dlBtn) {
      dlBtn.addEventListener("click", () => {
        const blob = new Blob([jsonStr], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${slug}-agent-card.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
    }
  }

  // ───────────────────────────────────────────
  // Debug
  // ───────────────────────────────────────────
  _renderDebug() {
    const box = this.el.querySelector(".debug-scroll");
    const count = this.debugFrames.length;
    this.el.querySelector(".debug-meta-count").textContent = String(count);

    // append-only render for performance
    const existing = box.children.length;
    for (let i = existing; i < count; i++) {
      const f = this.debugFrames[i];
      const entry = document.createElement("div");
      entry.className = "dbg-entry";
      const dirCls = f.dir === "out" ? "is-out" : f.dir === "in" ? "is-in" : "is-err";
      // 矢印の向き: in (受信) を → 、 out (送信) を ← とする。
      const dirLbl = f.dir === "out" ? "← out" : f.dir === "in" ? "→ in" : "× err";
      const meta = f.payload?.id ? `id=${f.payload.id}` : "";
      // 展開部は header / payload の 2 サブタブ。 header が無い frame は payload だけ。
      const hasHeaders = f.headers && Object.keys(f.headers).length > 0;
      const bodyHtml = f.payload ? syntaxJson(f.payload) : escapeHtml(f.raw || "");
      const headersHtml = hasHeaders ? syntaxJson(f.headers) : "";
      entry.innerHTML = `
        <span class="dbg-time">${timeStr(f.ts)}</span>
        <span class="dbg-dir ${dirCls}">${dirLbl}</span>
        <span class="dbg-summary">${escapeHtml(f.method)}</span>
        <span class="dbg-meta">${meta}</span>
        <div class="dbg-detail">
          ${hasHeaders ? `<div class="dbg-subtabs">
            <button type="button" class="dbg-subtab" data-sub="headers">headers</button>
            <button type="button" class="dbg-subtab is-active" data-sub="payload">payload</button>
          </div>` : ""}
          <div class="dbg-pane-wrap dbg-pane-payload is-active">
            <button type="button" class="dbg-copy" title="Copy" aria-label="Copy">copy</button>
            <pre class="dbg-body">${bodyHtml}</pre>
          </div>
          ${hasHeaders ? `<div class="dbg-pane-wrap dbg-pane-headers">
            <button type="button" class="dbg-copy" title="Copy" aria-label="Copy">copy</button>
            <pre class="dbg-body">${headersHtml}</pre>
          </div>` : ""}
        </div>
      `;
      // 行クリックで開閉。 サブタブのクリックは開閉させず pane だけ切り替える。
      entry.addEventListener("click", (e) => {
        const copyBtn = e.target.closest(".dbg-copy");
        if (copyBtn) {
          e.stopPropagation();
          const pre = copyBtn.parentElement?.querySelector(".dbg-body");
          const src = pre ? pre.textContent || "" : "";
          if (src) {
            const done = () => {
              copyBtn.classList.add("is-copied"); copyBtn.textContent = "copied";
              setTimeout(() => { copyBtn.classList.remove("is-copied"); copyBtn.textContent = "copy"; }, 1200);
            };
            if (navigator.clipboard?.writeText) navigator.clipboard.writeText(src).then(done).catch(() => { fallbackCopy(src); done(); });
            else { fallbackCopy(src); done(); }
          }
          return;
        }
        const subBtn = e.target.closest(".dbg-subtab");
        if (subBtn) {
          e.stopPropagation();
          const sub = subBtn.dataset.sub;
          entry.querySelectorAll(".dbg-subtab").forEach(b => b.classList.toggle("is-active", b === subBtn));
          entry.querySelector(".dbg-pane-payload")?.classList.toggle("is-active", sub === "payload");
          entry.querySelector(".dbg-pane-headers")?.classList.toggle("is-active", sub === "headers");
          return;
        }
        // 展開部(.dbg-detail)内のクリックでは開閉しない (部分テキスト選択を妨げないため)。
        if (e.target.closest(".dbg-detail")) return;
        // ドラッグでテキスト選択した直後のクリックでも開閉しない (mouseup が外で離れたケース)。
        if (window.getSelection && String(window.getSelection() || "").trim()) return;
        entry.classList.toggle("is-open");
      });
      box.appendChild(entry);
    }
    box.scrollTop = box.scrollHeight;
  }

  // ── Debug の右クリック「JWT Decode」 ───────────────────
  // クリック位置 (選択があれば選択範囲) の文字列から JWT を取り出してメニューを出す。
  _onDebugContextMenu(e) {
    const pre = e.target.closest(".dbg-body");
    if (!pre) return;   // JSON/テキスト本文の上でのみ反応 (それ以外は通常メニュー)
    e.preventDefault();
    const token = this._jwtTokenAtPoint(e, pre);
    this._openJwtMenu(e.clientX, e.clientY, token);
  }

  // base64url + ドットだけを JWT 文字とみなす
  _extractJwt(str) {
    const m = String(str || "").match(/[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/);
    return m ? m[0] : "";
  }

  // クリック位置 (なければ選択範囲) の token を返す。
  _jwtTokenAtPoint(e, pre) {
    // 1) 選択範囲があれば最優先
    const sel = (typeof window.getSelection === "function") ? String(window.getSelection() || "").trim() : "";
    if (sel) { const t = this._extractJwt(sel); if (t) return t; }
    // 2) クリック位置の caret から text node + offset を得る
    let node = null, offset = 0;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) { node = p.offsetNode; offset = p.offset; }
    }
    const text = (node && node.nodeType === 3) ? (node.textContent || "") : (pre.textContent || "");
    if (!text) return "";
    // 3) offset 周辺を JWT 文字 ([A-Za-z0-9._-]) で左右に広げて候補を切り出す
    const isTok = (c) => /[A-Za-z0-9._-]/.test(c);
    let s = Math.min(Math.max(offset, 0), text.length), ei = s;
    while (s > 0 && isTok(text[s - 1])) s--;
    while (ei < text.length && isTok(text[ei])) ei++;
    return this._extractJwt(text.slice(s, ei)) || this._extractJwt(text);
  }

  _closeJwtMenu() {
    if (this._jwtMenuEl) { this._jwtMenuEl.remove(); this._jwtMenuEl = null; }
    if (this._jwtMenuOff) { document.removeEventListener("click", this._jwtMenuOff, true); this._jwtMenuOff = null; }
  }

  _openJwtMenu(x, y, token) {
    this._closeJwtMenu();
    const menu = document.createElement("div");
    menu.className = "row-menu jwt-ctx-menu";
    const item = document.createElement("button");
    item.type = "button";
    item.className = "row-menu-item";
    item.textContent = token ? "JWT Decode" : "JWT Decode (no token here)";
    if (!token) item.disabled = true;
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._closeJwtMenu();
      this._showJwtPopover(token, x, y);
    });
    menu.appendChild(item);
    document.body.appendChild(menu);
    // 画面内にクランプ
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.min(x, window.innerWidth  - mw - 6);
    let top  = Math.min(y, window.innerHeight - mh - 6);
    menu.style.left = `${Math.max(6, Math.round(left))}px`;
    menu.style.top  = `${Math.max(6, Math.round(top))}px`;
    this._jwtMenuEl = menu;
    // 外側クリックで閉じる (次フレームで登録)
    this._jwtMenuOff = () => this._closeJwtMenu();
    setTimeout(() => document.addEventListener("click", this._jwtMenuOff, true), 0);
  }

  _closeJwtPopover() {
    if (this._jwtPopEl) { this._jwtPopEl.remove(); this._jwtPopEl = null; }
    if (this._jwtPopOff) { document.removeEventListener("mousedown", this._jwtPopOff, true); this._jwtPopOff = null; }
    if (this._jwtPopEsc) { document.removeEventListener("keydown", this._jwtPopEsc, true); this._jwtPopEsc = null; }
  }

  _showJwtPopover(token, x, y) {
    this._closeJwtPopover();
    const dec = token ? decodeJwt(token) : null;
    const pop = document.createElement("div");
    pop.className = "jwt-popover";
    pop.innerHTML = `
      <div class="jwt-pop-head">
        <span class="jwt-pop-title">JWT Decode</span>
        <button type="button" class="jwt-pop-copy" title="Copy token">copy</button>
        <button type="button" class="jwt-pop-close" aria-label="close">×</button>
      </div>
      <div class="jwt-pop-body">${dec ? `<pre class="jwt-pop-pre">${formatJwt(dec)}</pre>` : `<span class="jwt-pop-err">JWT としてデコードできません</span>`}</div>
    `;
    document.body.appendChild(pop);
    // 位置: クリック付近だが少し上めに出す (クリック位置が popover の下寄りに来る)。
    // 画面外に出ないようクランプ。
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.min(x, window.innerWidth  - pw - 8);
    let top  = y - Math.round(ph * 0.55);   // クリックより上に持ち上げる
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    pop.style.left = `${Math.max(8, Math.round(left))}px`;
    pop.style.top  = `${Math.round(top)}px`;
    this._jwtPopEl = pop;
    // copy / close
    pop.querySelector(".jwt-pop-close").addEventListener("click", () => this._closeJwtPopover());
    const copyBtn = pop.querySelector(".jwt-pop-copy");
    copyBtn.addEventListener("click", () => {
      if (!token) return;
      const done = () => { copyBtn.classList.add("is-copied"); copyBtn.textContent = "copied";
        setTimeout(() => { copyBtn.classList.remove("is-copied"); copyBtn.textContent = "copy"; }, 1200); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(token).then(done).catch(() => { fallbackCopy(token); done(); });
      else { fallbackCopy(token); done(); }
    });
    if (!token) copyBtn.style.display = "none";
    // 外側クリック / Esc で閉じる (popover 内は除外)
    this._jwtPopOff = (ev) => { if (!pop.contains(ev.target)) this._closeJwtPopover(); };
    this._jwtPopEsc = (ev) => { if (ev.key === "Escape") this._closeJwtPopover(); };
    setTimeout(() => {
      document.addEventListener("mousedown", this._jwtPopOff, true);
      document.addEventListener("keydown", this._jwtPopEsc, true);
    }, 0);
  }

  // ───────────────────────────────────────────
  // Settings (static prototype)
  // ───────────────────────────────────────────
  _renderSettings() {
    const box = this.el.querySelector(".settings-scroll");
    const configuredUrl = this.adapter.config.url || "";
    const card          = this.adapter.agentCard || null;
    const effectiveUrl  = card?.url || "";
    const urlMismatch   = effectiveUrl && configuredUrl && !effectiveUrl.startsWith(stripTrailingSlash(configuredUrl)) && !configuredUrl.startsWith(stripTrailingSlash(effectiveUrl));
    const cardTip = this.protoMode === "mcp"
      ? "MCP では agent card は提供されないため、 接続先はそのまま Discovery URL です。"
      : "AgentCard の url フィールド。 メッセージはこの URL に POST されます (Discovery URL ではなく)。 Discovery URL と異なる場合があるので注意してください。";

    // Authorization: identity から選べる場合は select、 そうでなければ readonly のマスク表示。
    const cfg = this.adapter.config;
    const curRef = cfg.authRef || "";
    // 現在送信中の Bearer (encode 文字列) を常に表示する。
    //   identity 由来 (curRef あり) → 表示専用 (readonly)、 手入力 (curRef 無し) → 編集可。
    const tokenVal = cfg.auth || "";
    const tokenReadonly = !!curRef;
    let authControl;
    if (this.authApi) {
      const ids = this.authApi.list();
      const hasRawToken = !curRef && !!cfg.auth;
      const opts = [`<option value=""${!curRef && !hasRawToken ? " selected" : ""}>manual</option>`];
      ids.forEach(idn => {
        const sel = idn.id === curRef ? " selected" : "";
        opts.push(`<option value="${escapeHtml(idn.id)}"${sel}>${escapeHtml(idn.name)} · ${escapeHtml(this.authApi.badge(idn.kind))}</option>`);
      });
      if (hasRawToken) opts.push(`<option value="__raw__" selected>(custom token)</option>`);
      authControl = `<select class="set-input set-input-auth">${opts.join("")}</select>`;
    } else {
      authControl = `<input class="set-input" value="${cfg.auth ? "•".repeat(12) : ""}" placeholder="none" readonly />`;
    }

    box.innerHTML = `
      <div class="set-section">
        <h4>Identity</h4>
        <div class="set-row">
          <div class="set-row-text">
            <div class="set-row-title">Display name</div>
            <div class="set-row-sub">ウインドウのタイトルに表示</div>
          </div>
          <input class="set-input set-input-name" value="${escapeHtml(this.name || "")}" placeholder="Untitled" />
        </div>
      </div>

      <div class="set-section">
        <h4>Connection</h4>
        <div class="set-row" title="Connect ダイアログで入力した Discovery URL。 ${this.protoMode === "mcp" ? "MCP server (POST /mcp) を直接叩きます。" : "Atelier はこの URL の /.well-known/agent-card.json を取得して AgentCard を解釈します。 実際のチャット送信先は AgentCard 側の url フィールドです。"}">
          <div class="set-row-text">
            <div class="set-row-title">Discovery URL <span class="set-row-help" aria-hidden="true">?</span></div>
            <div class="set-row-sub">${this.protoMode === "mcp" ? "POST /mcp に直接送信します。" : "AgentCard を取得する起点 URL。 メッセージ送信先ではない。"}</div>
          </div>
          ${copyFieldHtml(configuredUrl)}
        </div>
        ${this.protoMode !== "mcp" ? `
        <div class="set-row" title="${cardTip}">
          <div class="set-row-text">
            <div class="set-row-title">Effective endpoint <span class="set-row-help" aria-hidden="true">?</span></div>
            <div class="set-row-sub">${effectiveUrl ? "AgentCard の url。 メッセージはここに POST されます。" : "AgentCard 未取得 — 接続中…"}</div>
          </div>
          ${copyFieldHtml(effectiveUrl, { cls: urlMismatch ? "is-warn" : "", placeholder: "(loading…)", title: cardTip })}
        </div>
        ${urlMismatch ? `<div class="set-warn">⚠ 参考: Discovery URL と Effective endpoint が異なります。 AgentCard の url フィールドに従い、 メッセージは Effective endpoint に送信されます (gateway/proxy 経由などで意図的に異なる場合もあります)。 意図しない場合はサーバ側で agent-card の url を見直してください。</div>` : ""}
        ` : ""}
        <div class="set-row" title="HTTP Authorization ヘッダに付ける bearer token。 connect ダイアログで指定したものが保存されています。">
          <div class="set-row-text">
            <div class="set-row-title">Authorization <span class="set-row-help" aria-hidden="true">?</span></div>
            <div class="set-row-sub">Auth (identity) を選択 / Bearer &lt;token&gt; ヘッダ</div>
          </div>
          ${authControl}
        </div>
        <div class="set-row" title="${tokenReadonly ? "現在送信中の Bearer token (identity 由来・表示専用)。 decode / copy できます。" : "identity を使わず Bearer token を直接貼り付けます。 入力すると identity 選択より優先され、 そのまま Authorization: Bearer に使われます (自動更新なし)。"}">
          <div class="set-row-text">
            <div class="set-row-title">Bearer token <span class="set-row-help" aria-hidden="true">?</span></div>
            <div class="set-row-sub">${tokenReadonly ? "現在送信中の token (identity 由来・表示専用)" : "Bearer token を直接貼り付け (identity より優先)"}</div>
          </div>
          <div class="set-rawtoken-col">
            <div class="set-rawtoken-field">
              <textarea class="set-input set-input-rawtoken" rows="2" spellcheck="false" autocomplete="off" placeholder="paste a Bearer token…"${tokenReadonly ? " readonly" : ""}>${escapeHtml(tokenVal)}</textarea>
              <button type="button" class="set-rawtoken-copy" hidden title="Copy token" aria-label="Copy token">copy</button>
            </div>
            <div class="set-rawtoken-actions">
              <button type="button" class="set-decode-btn" hidden>decode JWT ▾</button>
            </div>
          </div>
        </div>
        <div class="set-jwt-wrap" hidden>
          <button type="button" class="set-jwt-copy" title="Copy decoded JSON" aria-label="Copy decoded JSON">copy</button>
          <pre class="set-jwt-decoded"></pre>
        </div>
      </div>

      <div class="set-section">
        <h4>About</h4>
        <div class="set-row" title="このウインドウのセッション ID。 ページ reload で変わります。">
          <div class="set-row-text">
            <div class="set-row-title">Window ID</div>
            <div class="set-row-sub">セッション固有</div>
          </div>
          <input class="set-input" value="${this.id}" readonly />
        </div>
        <div class="set-row" title="このウインドウが使用するプロトコル adapter (a2a / mcp / slack 等)。">
          <div class="set-row-text">
            <div class="set-row-title">Protocol</div>
            <div class="set-row-sub">通信プロトコル</div>
          </div>
          <input class="set-input" value="${escapeHtml(this.protoMode || "")}" readonly />
        </div>
      </div>
    `;

    // URL 等の読み取り専用フィールドのコピーボタン (hover で出現、 chat の copy と同じ挙動)
    box.querySelectorAll(".set-copy-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const input = btn.parentElement?.querySelector(".set-input");
        const src = input ? input.value : "";
        if (!src) return;
        const done = () => {
          btn.classList.add("is-copied"); btn.textContent = "copied";
          setTimeout(() => { btn.classList.remove("is-copied"); btn.textContent = "copy"; }, 1200);
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(src).then(done).catch(() => { fallbackCopy(src); done(); });
        else { fallbackCopy(src); done(); }
      });
    });

    // Display name 編集を反映 (タイトル / 永続化)
    const nameInput = box.querySelector(".set-input-name");
    if (nameInput) {
      const commit = () => {
        const v = nameInput.value.trim();
        if (!v || v === this.name) return;
        this.name = v;
        this.adapter.config.name = v;
        this._nameLocked = true;   // 以後 agentCard.name で上書きしない
        this.el.querySelector(".aw-title").textContent = v + this.instanceSuffix;
        const wm = this.el.querySelector(".aw-watermark");
        if (wm) wm.textContent = v + this.instanceSuffix;
        this.onChange?.();
      };
      nameInput.addEventListener("change", commit);
      nameInput.addEventListener("blur",   commit);
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); }
      });
    }

    // Authorization (identity) 選択を反映: token を解決して adapter に適用 + 永続化。
    const authSel = box.querySelector(".set-input-auth");
    if (authSel && this.authApi) {
      authSel.addEventListener("change", async () => {
        const v = authSel.value;
        if (v === "__raw__") return;   // 既存 token を維持
        this.adapter.config.authRef = v || undefined;
        if (!v) {
          this.adapter.config.auth = undefined;
          this.adapter.config.authHeaders = undefined;
        } else {
          try {
            const resolved = await this.authApi.resolve(v);
            this.adapter.config.auth = resolved.auth;
            this.adapter.config.authHeaders = resolved.authHeaders;
          } catch (e) {
            console.warn("[settings] auth resolve failed:", e?.message || e);
          }
        }
        this.onChange?.();
        this._renderSettings();   // 表示を更新 (badge / custom token 表示の整理)
      });
    }

    // 手入力トークン: identity を使わず Bearer token を直接適用する (identity より優先)。
    const rawInput = box.querySelector(".set-input-rawtoken");
    if (rawInput) {
      const commitRaw = () => {
        if (rawInput.readOnly) return;   // identity 由来の表示専用は変更しない
        const tok = rawInput.value.trim();
        const hadRaw = !this.adapter.config.authRef && !!this.adapter.config.auth;
        if (tok) {
          this.adapter.config.authRef = undefined;      // raw token モード (自動更新なし)
          this.adapter.config.auth = tok;
          this.adapter.config.authHeaders = undefined;
        } else if (hadRaw) {
          this.adapter.config.auth = undefined;         // 空にしたら raw token 解除
        } else {
          return;                                       // 変化なし
        }
        this.onChange?.();
        this._renderSettings();
      };
      rawInput.addEventListener("change", commitRaw);
      rawInput.addEventListener("blur", commitRaw);
    }

    // JWT decode: textarea (無ければ現在の auth) が JWT 形式なら decode ボタンを出す。
    const decodeBtn = box.querySelector(".set-decode-btn");
    const copyTokenBtn = box.querySelector(".set-rawtoken-copy");
    const decodedWrap = box.querySelector(".set-jwt-wrap");
    const decodedPre = box.querySelector(".set-jwt-decoded");
    const copyBtn = box.querySelector(".set-jwt-copy");
    if (rawInput && decodeBtn && decodedWrap && decodedPre) {
      const tokenNow = () => (rawInput.value.trim() || this.adapter.config.auth || "");
      const looksJwt = (s) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s || "");
      const syncBtn = () => {
        const tk = tokenNow();
        decodeBtn.hidden = !looksJwt(tk);
        if (copyTokenBtn) copyTokenBtn.hidden = !tk;   // encode 文字列のコピー
        if (decodeBtn.hidden) decodedWrap.hidden = true;
      };
      rawInput.addEventListener("input", syncBtn);
      if (copyTokenBtn) {
        copyTokenBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const src = tokenNow();
          if (!src) return;
          const done = () => {
            copyTokenBtn.classList.add("is-copied"); copyTokenBtn.textContent = "copied";
            setTimeout(() => { copyTokenBtn.classList.remove("is-copied"); copyTokenBtn.textContent = "copy"; }, 1200);
          };
          if (navigator.clipboard?.writeText) navigator.clipboard.writeText(src).then(done).catch(() => { fallbackCopy(src); done(); });
          else { fallbackCopy(src); done(); }
        });
      }
      decodeBtn.addEventListener("click", () => {
        if (!decodedWrap.hidden) { decodedWrap.hidden = true; return; }   // toggle off
        const dec = decodeJwt(tokenNow());
        if (dec) decodedPre.innerHTML = formatJwt(dec);          // 色付き HTML
        else     decodedPre.textContent = "(JWT としてデコードできません)";
        decodedWrap.hidden = false;
      });
      if (copyBtn) {
        copyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const src = decodedPre.textContent || "";
          const done = () => {
            copyBtn.classList.add("is-copied");
            copyBtn.textContent = "copied";
            setTimeout(() => { copyBtn.classList.remove("is-copied"); copyBtn.textContent = "copy"; }, 1200);
          };
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(src).then(done).catch(() => { fallbackCopy(src); done(); });
          } else { fallbackCopy(src); done(); }
        });
      }
      syncBtn();
    }
  }

  // ───────────────────────────────────────────
  // MCP mode (tools tab + dynamic form)
  // ───────────────────────────────────────────
  // MCP は会話 protocol ではないので chat tab を隠し、 tools tab を主役にする。
  // tool-list は adapter "open" で渡される { tools } を使う。
  // tool をクリックすると inputSchema (or input_schema) から form を生成し、
  // call ボタンで adapter.callTool(name, args) を叩いて結果を pre 表示する。
  _setupMcpMode(node) {
    const chatTab  = node.querySelector('.aw-tab[data-tab="chat"]');
    const toolsTab = node.querySelector('.aw-tab[data-tab="tools"]');
    const cardTab  = node.querySelector('.aw-tab[data-tab="card"]');
    if (chatTab)  chatTab.hidden  = true;
    if (toolsTab) toolsTab.hidden = false;
    // chat の代わりに tools を初期 active に
    if (chatTab)  chatTab.classList.remove("is-active");
    if (toolsTab) toolsTab.classList.add("is-active");
    const chatPane  = node.querySelector('.pane-chat');
    const toolsPane = node.querySelector('.pane-tools');
    if (chatPane)  chatPane.classList.remove("is-active");
    if (toolsPane) toolsPane.classList.add("is-active");
    // agent card タブのラベルを "server info" に張り替え (MCP では agentCard 由来 ではないが view を流用)
    if (cardTab) {
      const lbl = cardTab.querySelector("span:last-child");
      if (lbl) lbl.textContent = "server";
    }

    // tools-list / tool-form の DOM ハンドラ。
    // _mcpApplyOpen で参照する this._mcpDom を **先に** 設定することが重要 —
    // 後段の state==="open" チェックで即時描画が走ったとき undefined だと何も描かれない。
    const list = toolsPane.querySelector(".tools-list");

    // アコーディオン: tool item ヘッダのクリックでその場展開し、
    // 引数フォーム + Send + 結果を項目の下に「びよーん」と出す。
    // 旧 .tool-form ダイアログ(index.html)は使わない。
    list.addEventListener("click", (ev) => {
      const head = ev.target.closest(".tool-item");
      if (!head) return;
      const acc = head.closest(".tool-acc");
      if (!acc) return;
      const tool = (this._mcpTools || []).find(t => t.name === acc.dataset.tool);
      if (!tool) return;
      const willOpen = !acc.classList.contains("is-open");
      // 単一展開: 他に開いている項目は閉じる
      list.querySelectorAll(".tool-acc.is-open").forEach((a) => {
        if (a !== acc) a.classList.remove("is-open");
      });
      if (willOpen && !acc.dataset.built) {
        this._buildMcpToolBody(acc, tool);
        acc.dataset.built = "1";
      }
      acc.classList.toggle("is-open", willOpen);
    });

    this._mcpDom = { list };

    // ── adapter "open" 購読 + 既に open 済みなら即時描画 ──
    // 既存の "open" イベントは _wireAdapter で chat 用ロジックも走るが、
    // MCP の場合は agent card レンダリングが意味をなさないので no-op になるだけで害はない。
    this.adapter.addEventListener("open", (e) => {
      this._mcpApplyOpen(e.detail?.tools, e.detail?.serverInfo, node);
    });

    // adapter.connect() は AgentWindow 作成前に awaited されるので、
    // この listener より先に "open" が emit されている可能性がある。
    // その場合は adapter.tools / adapter.serverInfo を直接読んで即時描画する。
    if (this.adapter.state === "open") {
      this._mcpApplyOpen(this.adapter.tools, this.adapter.serverInfo, node);
    }
  }

  _mcpApplyOpen(tools, serverInfo, node) {
    this._mcpTools = Array.isArray(tools) ? tools : [];
    this._renderMcpToolsList();
    const cnt = (node || this.el).querySelector('.aw-tab[data-tab="tools"] .tab-count');
    if (cnt) cnt.textContent = String(this._mcpTools.length);
    this._renderMcpServerInfo(serverInfo, this._mcpTools);
  }

  _renderMcpToolsList() {
    if (!this._mcpDom) return;
    const { list } = this._mcpDom;
    list.innerHTML = "";
    const tools = this._mcpTools || [];
    if (!tools.length) {
      list.innerHTML = '<div class="tools-empty">no tools</div>';
      return;
    }
    // ヘッダ: 件数 + read-only 数のサマリ
    const roCount = tools.filter(t => /READ-ONLY/i.test(t.description || "")).length;
    const head = document.createElement("div");
    head.className = "tools-head";
    head.innerHTML =
      `<span class="tools-head-count">${tools.length} tools</span>` +
      (roCount ? `<span class="tools-head-ro">${roCount} read-only</span>` : "");
    list.appendChild(head);

    for (const t of tools) {
      const cat  = toolCategory(t.name);
      const schema = t.inputSchema || t.input_schema || {};
      const argc = Object.keys(schema.properties || {}).length;
      const ro   = /READ-ONLY/i.test(t.description || "");
      const acc = document.createElement("div");
      acc.className = "tool-acc tool-cat-" + cat;
      acc.dataset.tool = t.name;
      acc.innerHTML = `
        <button type="button" class="tool-item">
          <span class="tool-ico" aria-hidden="true">${TOOL_GLYPH[cat]}</span>
          <span class="tool-item-main">
            <span class="tool-item-name">${escapeHtml(t.name)}</span>
            <span class="tool-item-desc">${escapeHtml(t.description || "")}</span>
          </span>
          <span class="tool-item-tags">
            ${argc ? `<span class="tool-tag">${argc} arg${argc === 1 ? "" : "s"}</span>`
                   : `<span class="tool-tag is-noargs">no args</span>`}
            ${ro ? `<span class="tool-tag is-ro">read-only</span>` : ""}
          </span>
          <span class="tool-go" aria-hidden="true">▾</span>
        </button>
        <div class="tool-acc-body"><div class="tool-acc-inner"></div></div>
      `;
      list.appendChild(acc);
    }
  }

  // アコーディオン項目の body を遅延生成: 説明 + 引数フォーム + Send + 結果。
  _buildMcpToolBody(acc, tool) {
    const inner = acc.querySelector(".tool-acc-inner");
    inner.innerHTML = "";

    if (tool.description) {
      const desc = document.createElement("p");
      desc.className = "tool-form-desc";
      desc.textContent = tool.description;
      inner.appendChild(desc);
    }

    const fields = document.createElement("form");
    fields.className = "tool-form-fields";
    fields.addEventListener("submit", (e) => e.preventDefault());

    const schema = tool.inputSchema || tool.input_schema || { properties: {}, required: [] };
    const props  = schema.properties || {};
    const required = new Set(schema.required || []);
    const keys = Object.keys(props);
    if (!keys.length) {
      const note = document.createElement("p");
      note.className = "tool-form-empty";
      note.textContent = "(no input fields — Send directly)";
      fields.appendChild(note);
    }
    for (const name of keys) {
      fields.appendChild(this._buildToolField(name, props[name] || {}, required.has(name)));
    }
    inner.appendChild(fields);

    const actions = document.createElement("div");
    actions.className = "tool-acc-actions";
    const run = document.createElement("button");
    run.type = "button";
    run.className = "tool-run";
    run.textContent = "Send";
    actions.appendChild(run);
    inner.appendChild(actions);

    const result = document.createElement("pre");
    result.className = "tool-result";
    result.hidden = true;
    inner.appendChild(result);

    run.addEventListener("click", () => this._runMcpToolIn(tool, fields, result));
    // Enter で送信 (textarea を除く)
    fields.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        this._runMcpToolIn(tool, fields, result);
      }
    });
  }

  _buildToolField(name, def, isRequired) {
    const row = document.createElement("label");
    row.className = "tool-field";
    const label = document.createElement("span");
    label.className = "tool-field-label";
    label.textContent = name + (isRequired ? " *" : "");
    const desc = document.createElement("span");
    desc.className = "tool-field-desc";
    desc.textContent = def.description || "";

    let input;
    const type = def.type;
    if (type === "integer" || type === "number") {
      input = document.createElement("input");
      input.type = "number";
      if (type === "integer") input.step = "1";
    } else if (type === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
    } else if (type === "object" || type === "array") {
      input = document.createElement("textarea");
      input.rows = 3;
      input.placeholder = type === "object" ? "{ }" : "[ ]";
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.className = "tool-field-input";
    input.dataset.name = name;
    input.dataset.type = type || "string";

    row.appendChild(label);
    if (def.description) row.appendChild(desc);
    row.appendChild(input);
    return row;
  }

  async _runMcpToolIn(tool, fields, result) {
    const args = {};
    const inputs = fields.querySelectorAll(".tool-field-input");
    for (const el of inputs) {
      const name = el.dataset.name;
      const type = el.dataset.type;
      if (type === "boolean") {
        args[name] = !!el.checked;
        continue;
      }
      const raw = el.value;
      if (raw === "" || raw == null) continue;       // 未入力は省略 (required は server 側で判定)
      if (type === "integer") {
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n)) args[name] = n;
      } else if (type === "number") {
        const n = Number(raw);
        if (!Number.isNaN(n)) args[name] = n;
      } else if (type === "object" || type === "array") {
        try { args[name] = JSON.parse(raw); }
        catch (e) {
          result.hidden = false;
          result.classList.add("is-error");
          result.textContent = `invalid JSON for "${name}": ${e.message}`;
          return;
        }
      } else {
        args[name] = raw;
      }
    }

    result.hidden = false;
    result.textContent = "calling…";
    result.classList.remove("is-error");
    try {
      const out = await this.adapter.callTool(tool.name, args);
      const body = out.parsed != null ? out.parsed : out.raw;
      if (typeof body === "string") {
        result.textContent = body;
      } else {
        // syntax-highlighted JSON (theme-aware via .k/.s/.n/.b spans)
        result.innerHTML = syntaxJson(body);
      }
      if (out.isError) result.classList.add("is-error");
    } catch (err) {
      result.classList.add("is-error");
      result.textContent = String(err.message || err);
    }
  }

  _renderMcpServerInfo(info, tools) {
    const cardScroll = this.el.querySelector(".card-scroll");
    if (!cardScroll) return;
    const lines = [];
    if (info?.name)    lines.push(`<dt>name</dt><dd>${escapeHtml(info.name)}</dd>`);
    if (info?.version) lines.push(`<dt>version</dt><dd>${escapeHtml(info.version)}</dd>`);
    lines.push(`<dt>tools</dt><dd>${(tools || []).length}</dd>`);
    cardScroll.innerHTML = `
      <div class="mcp-server-info">
        <h4>MCP server</h4>
        <dl>${lines.join("")}</dl>
      </div>
    `;
  }
}

// ─── helpers ─────────────────────────────────────────────
// document.execCommand("copy") は Promise を返さないので Clipboard API 失敗時の保険として
// 一時的な textarea を使った同期コピーを行う。
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

// 読み取り専用の値フィールド + hover で出るコピーボタン (URL 等)。
function copyFieldHtml(value, opts = {}) {
  const cls = opts.cls ? ` ${opts.cls}` : "";
  const ph = opts.placeholder ? ` placeholder="${escapeHtml(opts.placeholder)}"` : "";
  const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : "";
  return `<div class="set-copyfield">`
    + `<input class="set-input${cls}" value="${escapeHtml(value)}"${ph} readonly${title} />`
    + `<button type="button" class="set-copy-btn" title="Copy" aria-label="Copy">copy</button>`
    + `</div>`;
}

// JWT (header.payload.signature) を decode。失敗時は null。
export function decodeJwt(token) {
  const parts = String(token || "").trim().split(".");
  if (parts.length < 2) return null;
  const seg = (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    s += "=".repeat((4 - (s.length % 4)) % 4);
    try {
      // atob の binary string を UTF-8 として正しく decode (日本語 claim 等)
      const json = decodeURIComponent(
        atob(s).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
      );
      return JSON.parse(json);
    } catch { return null; }
  };
  const header = seg(parts[0]);
  const payload = seg(parts[1]);
  if (!payload) return null;
  return { header, payload };
}

// decode 結果を表示用テキストに整形。exp/iat/nbf を可読日時 + 相対表記に。
export function formatJwt(dec) {
  const now = Math.floor(Date.now() / 1000);
  const stamp = (v) => {
    if (typeof v !== "number") return v;
    let iso = "";
    try { iso = new Date(v * 1000).toISOString().replace(".000", ""); } catch {}
    const rel = v - now;
    const human = Math.abs(rel) >= 3600
      ? `${(rel / 3600).toFixed(1)}h` : `${Math.round(rel / 60)}m`;
    return `${v} (${iso} · ${rel >= 0 ? "in " + human : human.replace("-", "") + " ago"})`;
  };
  const p = { ...(dec.payload || {}) };
  ["exp", "iat", "nbf", "auth_time"].forEach(k => { if (k in p) p[k] = stamp(p[k]); });
  // syntaxJson で色付き HTML を返す (.k/.s/.n/.b + コメントは .c)
  const out = [];
  if (dec.header) out.push(`<span class="c">// header</span>`, syntaxJson(dec.header), "");
  out.push(`<span class="c">// payload</span>`, syntaxJson(p));
  return out.join("\n");
}

// marked / mrkdwnToHtml の出力を innerHTML に流す前に通す sanitizer。
// agent / Slack 由来の text に <img onerror=...> 等が混入したときの一次防御。
// DOMPurify が無い環境 (CDN ブロック等) では、 marked 出力を捨てて escape 済み textContent
// 相当の HTML にフォールバックして安全側に倒す。
function safeHtml(html) {
  if (typeof window !== "undefined" && window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
    return window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target", "rel"],
      // <a target=_blank> に rel=noopener noreferrer を強制
      FORBID_ATTR: ["style"],
    });
  }
  // fallback: 危険な要素を除いた最低限 — script/iframe/object/embed/style と onXxx 属性を弾く
  return String(html || "")
    .replace(/<\s*\/?\s*(script|iframe|object|embed|style|link|meta)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, ' $1="#"')
    .replace(/\s(href|src)\s*=\s*'\s*javascript:[^']*'/gi, " $1='#'");
}

// broker (Agent Network) 統合レポートの整形。
// broker の LLM は 【○○エージェント】の前に改行を入れたり入れなかったりムラがあるため
// (実機で確認)、 表示側で安定して整形する:
//   - 【○○エージェント】を必ず段落区切り (空行) + アクセント色 span に
//   - 冒頭の「インシデント:」「取引先:」ラベルを行立てして太字に
// 表 (| ... |) を含む応答 (incident/法務 等) や 【】が 1 個未満のものには適用しない
// (broker 専用の整形なので、 通常の agent 応答を壊さない)。
function formatBrokerReport(text) {
  const t = String(text || "");
  if (/^\s*\|.*\|/m.test(t)) return t;                 // 表形式は触らない
  if ((t.match(/【[^】]+】/g) || []).length < 2) return t;  // broker レポート以外は触らない

  let out = t;
  // 冒頭ヘッダのラベルを行立て (改行が無くても分割): 「…します。インシデント: X取引先: Y【…」
  out = out.replace(/(インシデント|取引先|担当バイヤー)\s*[:：]/g, "\n**$1:** ");
  // 各 【…】 を段落区切り + アクセント色 span に (前の改行有無に依存しない)
  out = out.replace(/\s*【([^】]+)】\s*/g, '\n\n<span class="agent-tag">【$1】</span> ');
  // 連続改行を 2 つに圧縮し、 先頭の余分な改行を除去
  out = out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return out;
}

function timeStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toTimeString().slice(0, 8);
}

// Slack mrkdwn → 安全な HTML サブセット変換
//   *bold*  _italic_  ~strike~  `code`  ```code block```
//   > quote  ・ <url> / <url|label>  ・ unordered/ordered list
function mrkdwnToHtml(text) {
  let s = escapeHtml(String(text || ""));
  // code block (先に処理して中身を保護)
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, body) => {
    blocks.push(body);
    return ` CB${blocks.length - 1} `;
  });
  // inline code
  const inlines = [];
  s = s.replace(/`([^`\n]+)`/g, (_, body) => {
    inlines.push(body);
    return ` IC${inlines.length - 1} `;
  });
  // Slack 風リンク: <url|label> / <url>
  s = s.replace(/&lt;(https?:\/\/[^|&\s]+)\|([^&\n]+?)&gt;/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // 素の URL
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  // bold / italic / strike (word 境界を考慮)
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g,   '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])~([^~\n]+)~/g,   '$1<del>$2</del>');
  // 行頭 quote
  s = s.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  // unordered list
  s = s.replace(/(^|\n)([-*•])\s+(.+)/g, '$1<li>$3</li>');
  s = s.replace(/(<li>.+<\/li>(?:\n<li>.+<\/li>)*)/g, '<ul>$1</ul>');
  // 改行 → <br> (block 要素の外のみ簡易に)
  s = s.replace(/\n/g, '<br>');
  s = s.replace(/<br>(<\/?(?:ul|li|blockquote|pre)[^>]*>)/g, '$1');
  // 復元
  s = s.replace(/ IC(\d+) /g, (_, i) => `<code>${inlines[+i]}</code>`);
  s = s.replace(/ CB(\d+) /g, (_, i) => `<pre><code>${blocks[+i]}</code></pre>`);
  return s;
}

// JSON syntax highlighter (keys / strings / numbers / booleans-null)
// 配列内の値も含めて色をつける。
function syntaxJson(obj) {
  const raw = escapeHtml(JSON.stringify(obj, null, 2));
  return raw.replace(
    /(&quot;(?:[^&\n]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, bool, num) => {
      if (str !== undefined) {
        const cls = colon ? "k" : "s";   // keyかvalueか
        return `<span class="${cls}">${str}</span>${colon || ""}`;
      }
      if (bool !== undefined) return `<span class="b">${bool}</span>`;
      if (num  !== undefined) return `<span class="n">${num}</span>`;
      return m;
    }
  );
}
