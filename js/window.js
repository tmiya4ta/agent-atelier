// AgentWindow — フローティングウインドウ
// 1接続=1ウインドウ。Chat / Agent Card / Debug / Settings の4タブ。

let zCounter = 10;
let idCounter = 0;

export class AgentWindow {
  constructor({ adapter, layer, onClose, onFocus, onChange, instanceSuffix, restore }) {
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

    this.debugFrames = [];
    this.debugPaused = false;
    this.startedAt = Date.now();
    this.lastLatency = null;
    this.lastSendAt = null;

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

    // Close
    node.querySelector(".aw-btn-clear")?.addEventListener("click", () => this.clearChat());
    node.querySelector(".aw-btn-close").addEventListener("click", () => this.close());
    node.querySelector('.aw-traffic-dot[data-act="close"]').addEventListener("click", () => this.close());

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
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._sendFromCompose();
      }
    });
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
    });
    sendBtn.addEventListener("click", () => this._sendFromCompose());

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

    this.layer.appendChild(node);
    this.focus();

    // 既に open 済み adapter を渡された場合は、 open event 相当の初期描画を即時実行
    if (this.adapter.state === "open" && this.adapter.agentCard) {
      this._setStatus("live");
      this._renderCard(this.adapter.agentCard);
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
        this._updateLatency();
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

  _updateLatency() {
    const el = this.el.querySelector(".aw-latency");
    if (this.lastLatency != null) el.textContent = `${this.lastLatency} ms`;
    else el.textContent = "— ms";
  }

  // ───────────────────────────────────────────
  // Drag
  // ───────────────────────────────────────────
  _beginDrag(e) {
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

  // ───────────────────────────────────────────
  // Chat
  // ───────────────────────────────────────────
  _sendFromCompose() {
    const ta = this.el.querySelector(".compose-input");
    const text = ta.value.trim();
    if (!text || this.adapter.state !== "open") return;
    ta.value = "";
    ta.style.height = "auto";
    this.sendProgrammatic(text);
  }

  // Script から呼び出される。chat-stream を空にする
  clearChat() {
    const stream = this.el.querySelector(".chat-stream");
    if (stream) stream.innerHTML = "";
  }

  // Script から呼び出される。返り値は adapter.send の Promise
  sendProgrammatic(text) {
    if (!text || this.adapter.state !== "open") return Promise.reject(new Error("not connected"));
    this._addUserMessage(text);
    this._showTyping(true);
    this.lastSendAt = Date.now();
    return this.adapter.send(text, { stream: true }).catch(err => {
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
    this._scrollChat();
  }

  _addSystemMessage(text) {
    const stream = this.el.querySelector(".chat-stream");
    stream.appendChild(this._renderMsg("system", "system", text));
    this._scrollChat();
  }

  _handleAgentMessage(text, final) {
    this._showTyping(false);
    const stream = this.el.querySelector(".chat-stream");
    let last = stream.lastElementChild;
    let body;
    if (last?.classList.contains("msg-agent") && last?.dataset.streaming === "1") {
      body = last.querySelector(".msg-body");
    } else {
      const node = this._renderMsg("agent", this.adapter.agentCard?.name || this.name, "");
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
    const current = body.textContent || "";
    const finalize = () => {
      if (final) body.parentElement.dataset.streaming = "0";
      // Slack: typewriter 完了後に mrkdwn を HTML 化
      if (final && this.protoId === "slack") {
        body.innerHTML = mrkdwnToHtml(fullText);
      }
      // a2a: Markdown (GFM) を HTML 化
      else if (final && this.protoId === "a2a" && window.marked) {
        try {
          window.marked.setOptions({ gfm: true, breaks: true });
          body.innerHTML = window.marked.parse(fullText);
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
    body.parentElement.dataset.typing = "1";
    let i = current.length;
    const total = fullText.length;
    const stepSize = total > 400 ? 3 : total > 120 ? 2 : 1;
    const interval = 30;
    const tick = () => {
      if (i >= total) {
        body.parentElement.dataset.typing = "0";
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

  // user 側の typewriter (agent と同じ感覚で少し速め)
  _typewriteUser(body, fullText) {
    if (this._userTypeTimer) {
      clearTimeout(this._userTypeTimer);
      this._userTypeTimer = null;
    }
    body.parentElement.dataset.typing = "1";
    let i = 0;
    const total = fullText.length;
    const stepSize = total > 400 ? 3 : total > 120 ? 2 : 1;
    const interval = 26;
    const tick = () => {
      if (i >= total) {
        body.parentElement.dataset.typing = "0";
        if (this.protoId === "slack") body.innerHTML = mrkdwnToHtml(fullText);
        this._userTypeTimer = null;
        this._scrollChat();
        return;
      }
      const next = Math.min(i + stepSize, total);
      body.textContent = fullText.slice(0, next);
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
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = text;
    wrap.appendChild(body);
    return wrap;
  }

  _showTyping(on) {
    const stream = this.el.querySelector(".chat-stream");
    let t = stream.querySelector(".msg-typing");
    if (on && !t) {
      const node = document.createElement("div");
      node.className = "msg msg-agent msg-typing";
      // ドット吹き出しのみ (名前は応答時に msg-head として表示される)
      node.innerHTML = `<div class="msg-body"><span></span><span></span><span></span></div>`;
      stream.appendChild(node);
      this._scrollChat();
    } else if (!on && t) {
      t.remove();
    }
  }

  _scrollChat() {
    const s = this.el.querySelector(".chat-scroll");
    s.scrollTop = s.scrollHeight;
  }

  // ───────────────────────────────────────────
  // Card
  // ───────────────────────────────────────────
  _renderCard(card) {
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

    box.innerHTML = `
      <div class="card-hero">
        <div class="card-avatar">${escapeHtml(initial)}</div>
        <div>
          <h3 class="card-name">${escapeHtml(card.name || "Unnamed Agent")}</h3>
          <p class="card-desc">${escapeHtml(card.description || "")}</p>
          <div class="card-url">${escapeHtml(card.url || this.adapter.config.url || "")}</div>
        </div>
      </div>

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
        <div class="set-row">
          <div class="set-row-text">
            <div class="set-row-title">Endpoint</div>
            <div class="set-row-sub">エージェントのHTTPベースURL</div>
          </div>
          <input class="set-input" value="${escapeHtml(this.adapter.config.url || "")}" readonly />
        </div>
        <div class="set-row">
          <div class="set-row-text">
            <div class="set-row-title">Authorization</div>
            <div class="set-row-sub">Bearer token (任意)</div>
          </div>
          <input class="set-input" value="${this.adapter.config.auth ? "•".repeat(12) : ""}" placeholder="none" readonly />
        </div>
      </div>

      <div class="set-section">
        <h4>About</h4>
        <div class="set-row">
          <div class="set-row-text">
            <div class="set-row-title">Window ID</div>
            <div class="set-row-sub">セッション固有</div>
          </div>
          <input class="set-input" value="${this.id}" readonly />
        </div>
        <div class="set-row">
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
}

// ─── helpers ─────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
  s = s.replace(/&lt;(https?:\/\/[^|&\s]+)\|([^&\n]+?)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  // 素の URL
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
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
