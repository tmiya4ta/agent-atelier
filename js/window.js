// AgentWindow — フローティングウインドウ
// 1接続=1ウインドウ。Chat / Agent Card / Debug / Settings の4タブ。

let zCounter = 10;
let idCounter = 0;

export class AgentWindow {
  constructor({ adapter, layer, onClose, onFocus, onChange, instanceSuffix, restore, lockName }) {
    this.id = `aw-${++idCounter}`;
    this.adapter = adapter;
    this.layer    = layer;
    this.onClose  = onClose;
    this.onFocus  = onFocus;
    this.onChange = onChange;
    this.instanceSuffix = instanceSuffix || "";   // 重複ウインドウ用 " #2" など
    this.restore  = restore || null;

    this.protoId = adapter.constructor.id;
    this.protoLabel = adapter.constructor.label;
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
    badge.dataset.proto = this.protoId;

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
    if (this.protoId === "mcp") this._setupMcpMode(node);

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
    this.sendProgrammatic(text);
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

  // Script から呼び出される。返り値は adapter.send の Promise
  sendProgrammatic(text) {
    if (!text || this.adapter.state !== "open") return Promise.reject(new Error("not connected"));
    this._addUserMessage(text);
    this._showTyping(true);
    this.lastSendAt = Date.now();
    return this.adapter.send(text, { stream: true }).catch(err => {
      // 停止ボタンによる中断は _stopInflight 側で表示済みなので、 ここでは何も出さない
      if (err?.name === "AbortError") { this._showTyping(false); throw err; }
      this._showTyping(false);
      this._addSystemMessage(`send failed: ${err.message}`);
      throw err;
    });
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

  _addUserMessage(text) {
    const stream = this.el.querySelector(".chat-stream");
    const node = this._renderMsg("user", "you", "");
    stream.appendChild(node);
    const body = node.querySelector(".msg-body");
    this._typewriteUser(body, text);
    this._scrollChat(true);
  }

  _addSystemMessage(text) {
    const stream = this.el.querySelector(".chat-stream");
    stream.appendChild(this._renderMsg("system", "system", text));
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
      if (final && this.protoId === "slack") {
        body.innerHTML = safeHtml(mrkdwnToHtml(fullText));
        body.dataset.md = "1";
      }
      // a2a: Markdown (GFM) を HTML 化
      // breaks:false にして "\n" 1 つは段落内改行扱い (= 詰める)、空行のみ段落分け。
      // pre-wrap と <br> の二重改行を避けるため md 完了で data-md=1 を立てて
      // white-space: normal に切替 (CSS 側で扱う)。
      else if (final && this.protoId === "a2a" && window.marked) {
        try {
          window.marked.setOptions({ gfm: true, breaks: false });
          body.innerHTML = safeHtml(window.marked.parse(fullText));
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
  _typewriteUser(body, fullText) {
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
      if (this.protoId === "slack") {
        body.innerHTML = safeHtml(mrkdwnToHtml(normalized));
        body.dataset.md = "1";
      } else if (this.protoId === "a2a" && window.marked) {
        try {
          window.marked.setOptions({ gfm: true, breaks: false });
          body.innerHTML = safeHtml(window.marked.parse(normalized));
          body.dataset.md = "1";
        } catch (e) {
          console.warn("[window] marked.parse (user) failed:", e);
        }
      }
      this._scrollChat();
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

  // 停止ボタン押下: 進行中の adapter 送信を中断し、 typing 表示を消す。
  _stopInflight() {
    if (typeof this.adapter.abort === "function") this.adapter.abort();
    this._showTyping(false);
    this._setBusy(false);
    this._addSystemMessage("⏹ 停止しました");
  }

  _showTyping(on) {
    if (on) this._setBusy(true); else this._setBusy(false);
    const stream = this.el.querySelector(".chat-stream");
    let t = stream.querySelector(".msg-typing");
    if (on && !t) {
      const author = this.name || this.adapter.agentCard?.name || "agent";
      const node = document.createElement("div");
      node.className = "msg msg-agent msg-typing";
      // 通常のメッセージと同じ構造: 名前は枠の外 (msg-head)、 ドットだけ枠内
      node.innerHTML = `
        <div class="msg-head">
          <span class="msg-author">${escapeHtml(author)}</span>
        </div>
        <div class="msg-body">
          <span class="msg-typing-dots"><span></span><span></span><span></span></span>
        </div>
      `;
      stream.appendChild(node);
      this._scrollChat();
    } else if (!on && t) {
      t.remove();
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

      <button class="card-raw-toggle" type="button" aria-expanded="false">
        <span class="crt-branch">├─</span>
        <span class="crt-caret">▸</span>
        <span class="crt-bracket-l">[</span>
        <span class="crt-label">JSON</span>
        <span class="crt-bracket-r">]</span>
        <span class="crt-meta">${JSON.stringify(card).length} bytes</span>
      </button>
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
      const dirLbl = f.dir === "out" ? "→ out" : f.dir === "in" ? "← in" : "× err";
      const meta = f.payload?.id ? `id=${f.payload.id}` : "";
      entry.innerHTML = `
        <span class="dbg-time">${timeStr(f.ts)}</span>
        <span class="dbg-dir ${dirCls}">${dirLbl}</span>
        <span class="dbg-summary">${escapeHtml(f.method)}</span>
        <span class="dbg-meta">${meta}</span>
        <pre class="dbg-body">${f.payload ? syntaxJson(f.payload) : escapeHtml(f.raw || "")}</pre>
      `;
      entry.addEventListener("click", () => entry.classList.toggle("is-open"));
      box.appendChild(entry);
    }
    box.scrollTop = box.scrollHeight;
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
    const cardTip = this.protoId === "mcp"
      ? "MCP では agent card は提供されないため、 接続先はそのまま Discovery URL です。"
      : "AgentCard の url フィールド。 メッセージはこの URL に POST されます (Discovery URL ではなく)。 Discovery URL と異なる場合があるので注意してください。";

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
        <div class="set-row" title="Connect ダイアログで入力した Discovery URL。 ${this.protoId === "mcp" ? "MCP server (POST /mcp) を直接叩きます。" : "Atelier はこの URL の /.well-known/agent-card.json を取得して AgentCard を解釈します。 実際のチャット送信先は AgentCard 側の url フィールドです。"}">
          <div class="set-row-text">
            <div class="set-row-title">Discovery URL <span class="set-row-help" aria-hidden="true">?</span></div>
            <div class="set-row-sub">${this.protoId === "mcp" ? "POST /mcp に直接送信します。" : "AgentCard を取得する起点 URL。 メッセージ送信先ではない。"}</div>
          </div>
          <input class="set-input" value="${escapeHtml(configuredUrl)}" readonly />
        </div>
        ${this.protoId !== "mcp" ? `
        <div class="set-row" title="${cardTip}">
          <div class="set-row-text">
            <div class="set-row-title">Effective endpoint <span class="set-row-help" aria-hidden="true">?</span></div>
            <div class="set-row-sub">${effectiveUrl ? "AgentCard の url。 メッセージはここに POST されます。" : "AgentCard 未取得 — 接続中…"}</div>
          </div>
          <input class="set-input ${urlMismatch ? "is-warn" : ""}" value="${escapeHtml(effectiveUrl)}" placeholder="(loading…)" readonly title="${cardTip}" />
        </div>
        ${urlMismatch ? `<div class="set-warn">⚠ 参考: Discovery URL と Effective endpoint が異なります。 AgentCard の url フィールドに従い、 メッセージは Effective endpoint に送信されます (gateway/proxy 経由などで意図的に異なる場合もあります)。 意図しない場合はサーバ側で agent-card の url を見直してください。</div>` : ""}
        ` : ""}
        <div class="set-row" title="HTTP Authorization ヘッダに付ける bearer token。 connect ダイアログで指定したものが保存されています。">
          <div class="set-row-text">
            <div class="set-row-title">Authorization <span class="set-row-help" aria-hidden="true">?</span></div>
            <div class="set-row-sub">Authorization: Bearer &lt;token&gt; ヘッダ (任意)</div>
          </div>
          <input class="set-input" value="${this.adapter.config.auth ? "•".repeat(12) : ""}" placeholder="none" readonly />
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
          <input class="set-input" value="${escapeHtml(this.protoId || "")}" readonly />
        </div>
      </div>
    `;

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
    const list   = toolsPane.querySelector(".tools-list");
    const form   = toolsPane.querySelector(".tool-form");
    const fields = form.querySelector(".tool-form-fields");
    const result = form.querySelector(".tool-result");
    const back   = form.querySelector(".tool-back");
    const cancel = form.querySelector(".tool-cancel");
    const run    = form.querySelector(".tool-run");

    list.addEventListener("click", (ev) => {
      const item = ev.target.closest(".tool-item");
      if (!item) return;
      const name = item.dataset.tool;
      const tool = (this._mcpTools || []).find(t => t.name === name);
      if (!tool) return;
      this._openMcpToolForm(tool);
    });

    back.addEventListener("click",   () => this._closeMcpToolForm());
    cancel.addEventListener("click", () => this._closeMcpToolForm());
    run.addEventListener("click",    () => this._runMcpTool());

    // form 内 Enter で submit (textarea を除き)
    fields.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        this._runMcpTool();
      }
    });

    this._mcpDom = { list, form, fields, result };

    // tools タブを再クリックしたら form を閉じて一覧に戻す。
    if (toolsTab) {
      toolsTab.addEventListener("click", () => this._closeMcpToolForm());
    }

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
    for (const t of tools) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-item";
      btn.dataset.tool = t.name;
      btn.innerHTML = `
        <span class="tool-item-name">${escapeHtml(t.name)}</span>
        <span class="tool-item-desc">${escapeHtml(t.description || "")}</span>
      `;
      list.appendChild(btn);
    }
  }

  _openMcpToolForm(tool) {
    if (!this._mcpDom) return;
    const { list, form, fields, result } = this._mcpDom;
    list.hidden = true;
    form.hidden = false;
    result.hidden = true;
    result.textContent = "";
    form.querySelector(".tool-form-title").textContent = tool.name;
    form.querySelector(".tool-form-desc").textContent  = tool.description || "";
    fields.innerHTML = "";
    this._mcpCurrentTool = tool;

    const schema = tool.inputSchema || tool.input_schema || { properties: {}, required: [] };
    const props  = schema.properties || {};
    const required = new Set(schema.required || []);
    const keys = Object.keys(props);
    if (!keys.length) {
      const note = document.createElement("p");
      note.className = "tool-form-empty";
      note.textContent = "(no input fields — call directly)";
      fields.appendChild(note);
    }
    for (const name of keys) {
      const def = props[name] || {};
      const row = document.createElement("label");
      row.className = "tool-field";
      const label = document.createElement("span");
      label.className = "tool-field-label";
      label.textContent = name + (required.has(name) ? " *" : "");
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
      fields.appendChild(row);
    }
  }

  _closeMcpToolForm() {
    if (!this._mcpDom) return;
    const { list, form } = this._mcpDom;
    list.hidden = false;
    form.hidden = true;
    this._mcpCurrentTool = null;
  }

  async _runMcpTool() {
    if (!this._mcpDom || !this._mcpCurrentTool) return;
    const { fields, result } = this._mcpDom;
    const tool = this._mcpCurrentTool;
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
