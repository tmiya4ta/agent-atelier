// DbWindow — DB コネクション専用のフローティングウインドウ
// ─────────────────────────────────────────────────────────
// AgentWindow (chat) とは別物。chrome (head / traffic / drag / resize /
// maximize / pin / focus / close) は同じ .aw-* クラスを流用しつつ、本体は
// SQL エディタ + 結果グリッド + スキーマツリーの DB ワークスペース。
// app.js の window 管理 (tile/serialize/focus/close) が依存する I/F:
//   props : el, id, protoId, adapter, instanceSuffix, layer, pinned, name
//   method: focus(), close(), switchTab()(no-op), togglePin(), toggleMaximize()

let zCounter = 4000;        // chat の zCounter とは別系列 (十分大きく)
let idCounter = 0;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export class DbWindow {
  constructor({ adapter, layer, onClose, onFocus, onChange, instanceSuffix, restore }) {
    this.id = `dbw-${++idCounter}`;
    this.adapter  = adapter;
    this.layer    = layer;
    this.onClose  = onClose;
    this.onFocus  = onFocus;
    this.onChange = onChange;
    this.instanceSuffix = instanceSuffix || "";
    this.restore  = restore || null;

    this.protoId   = adapter.constructor.id;          // "db"
    this.protoLabel = adapter.constructor.label;       // "DB"
    this.name = adapter.config.name || adapter.config.url || "Database";

    this.pinned = !!(this.restore && this.restore.pinned);
    this._schema = [];           // [{name,type,columns?:[],open:bool}]
    this._busy = false;

    this._buildDom();
    this._wireAdapter();

    // 既に open 済み (通常の connect フロー) なら即スキーマ読込
    if (this.adapter.state === "open") this._loadSchema();
  }

  // ───────────────────────────────────────────
  // DOM
  // ───────────────────────────────────────────
  _buildDom() {
    const tpl = document.getElementById("tplDbWindow");
    const node = tpl.content.firstElementChild.cloneNode(true);
    this.el = node;
    node.id = this.id;

    // 位置 / サイズ
    if (this.restore?.pos?.left) {
      const p = this.restore.pos;
      node.style.left = p.left; node.style.top = p.top;
      node.style.width = p.width || "720px"; node.style.height = p.height || "560px";
      const z = parseInt(p.zIndex, 10);
      if (!isNaN(z)) { zCounter = Math.max(zCounter, z); node.style.zIndex = z; }
      else node.style.zIndex = ++zCounter;
    } else {
      const idx = this.layer.children.length;
      node.style.left = (40 + idx * 26) + "px";
      node.style.top  = (32 + idx * 22) + "px";
      node.style.width = "720px"; node.style.height = "560px";
      node.style.zIndex = ++zCounter;
    }

    // head
    node.querySelector(".aw-title").textContent = this.name + this.instanceSuffix;
    const badge = node.querySelector(".aw-proto-badge");
    badge.textContent = this.protoLabel;
    badge.dataset.proto = "db";
    const sub = node.querySelector(".dbw-sub");
    if (sub) sub.textContent = this.adapter.config.database ? `db: ${this.adapter.config.database}` : "";

    // head buttons
    node.querySelector(".aw-btn-close").addEventListener("click", () => this.close());
    node.querySelector('.aw-traffic-dot[data-act="close"]').addEventListener("click", () => this.close());
    node.querySelector(".aw-btn-max")?.addEventListener("click", () => this.toggleMaximize());
    node.querySelector(".aw-btn-pin")?.addEventListener("click", () => this.togglePin());
    node.querySelector(".aw-head").addEventListener("dblclick", (e) => {
      if (e.target.closest("button") || e.target.closest(".aw-traffic-dot")) return;
      this.toggleMaximize();
    });

    // drag / focus
    node.querySelector(".aw-head").addEventListener("mousedown", (e) => this._beginDrag(e));
    node.addEventListener("mousedown", () => this.focus());

    // schema refresh
    node.querySelector(".dbw-refresh")?.addEventListener("click", () => this._loadSchema());

    // editor + run
    this._sql = node.querySelector(".dbw-sql");
    node.querySelector(".dbw-run").addEventListener("click", () => this._run());
    this._sql.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this._run(); }
    });
    if (this.restore?.sql) this._sql.value = this.restore.sql;

    // resize handles
    const grip = document.createElement("div");
    grip.className = "aw-resize-grip"; grip.title = "Drag to resize";
    grip.addEventListener("mousedown", (e) => this._beginResize(e, "se"));
    node.appendChild(grip);
    ["n","s","e","w","ne","nw","sw"].forEach(dir => {
      const h = document.createElement("div");
      h.className = "aw-resize-edge aw-resize-" + dir;
      h.addEventListener("mousedown", (ev) => this._beginResize(ev, dir));
      node.appendChild(h);
    });

    this.layer.appendChild(node);
    this.focus();
    this._applyPinnedState();

    this._setStatus(this.adapter.state === "open"
      ? `connected · ${this.adapter.config.url}`
      : `connecting to ${this.adapter.config.url}…`);
  }

  _wireAdapter() {
    this.adapter.addEventListener("open", () => {
      this._setStatus(`connected · ${this.adapter.client?.serverVersion ? "clouderby " + this.adapter.client.serverVersion : this.adapter.config.url}`);
      this._loadSchema();
    });
    this.adapter.addEventListener("error", (e) => {
      this._setStatus(`error · ${e.detail?.message || e.detail || "connection error"}`, true);
    });
    this.adapter.addEventListener("close", () => this._setStatus("disconnected", true));
  }

  // ───────────────────────────────────────────
  // Schema tree
  // ───────────────────────────────────────────
  async _loadSchema() {
    const tree = this.el.querySelector(".dbw-schema-tree");
    tree.innerHTML = `<div class="dbw-tree-loading">loading…</div>`;
    try {
      const tables = await this.adapter.tables();
      this._schema = tables.map(t => ({ ...t, columns: null, open: false }));
      this._renderSchema();
    } catch (e) {
      tree.innerHTML = `<div class="dbw-tree-error">${escapeHtml(e.message || "failed to load schema")}</div>`;
    }
  }

  _renderSchema() {
    const tree = this.el.querySelector(".dbw-schema-tree");
    tree.innerHTML = "";
    const countEl = this.el.querySelector(".dbw-schema-count");
    if (countEl) countEl.textContent = String(this._schema.length);
    this._schema.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "dbw-table" + (t.open ? " is-open" : "");
      row.innerHTML = `
        <button class="dbw-table-row" title="${escapeHtml(t.type || "TABLE")}">
          <span class="dbw-caret">▸</span>
          <span class="dbw-tbl-glyph">${t.type === "VIEW" ? "◇" : "▦"}</span>
          <span class="dbw-tbl-name">${escapeHtml(t.name)}</span>
          <span class="dbw-tbl-peek" title="SELECT * FROM ${escapeHtml(t.name)}">▷</span>
        </button>
        <div class="dbw-cols"></div>`;
      const btn = row.querySelector(".dbw-table-row");
      btn.addEventListener("click", (e) => {
        if (e.target.closest(".dbw-tbl-peek")) { e.stopPropagation(); this._peek(t.name); return; }
        this._toggleTable(i, row);
      });
      tree.appendChild(row);
    });
  }

  async _toggleTable(i, row) {
    const t = this._schema[i];
    t.open = !t.open;
    row.classList.toggle("is-open", t.open);
    const box = row.querySelector(".dbw-cols");
    if (!t.open) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="dbw-col dbw-col-loading">loading…</div>`;
    try {
      if (!t.columns) t.columns = await this.adapter.columns(t.name);
      box.innerHTML = t.columns.map(c => `
        <div class="dbw-col" title="${escapeHtml(c.type || "")}${c.nullable === 0 ? " · NOT NULL" : ""}">
          <span class="dbw-col-name">${escapeHtml(c.name)}${c.autoInc ? '<span class="dbw-pk">↑</span>' : ""}</span>
          <span class="dbw-col-type">${escapeHtml(c.type || "")}</span>
        </div>`).join("");
    } catch (e) {
      box.innerHTML = `<div class="dbw-col dbw-col-error">${escapeHtml(e.message || "failed")}</div>`;
    }
  }

  _peek(table) {
    const sql = `SELECT * FROM ${table}`;
    this._sql.value = sql;
    this._run();
  }

  // ───────────────────────────────────────────
  // Run query
  // ───────────────────────────────────────────
  async _run() {
    if (this._busy) return;
    const sql = (this._sql.value || "").trim();
    if (!sql) { this._sql.focus(); return; }
    this._busy = true;
    const runBtn = this.el.querySelector(".dbw-run");
    runBtn.disabled = true; runBtn.classList.add("is-busy");
    this._setStatus("running…");
    const t0 = Date.now();
    try {
      const r = await this.adapter.query(sql, 500);
      const ms = Date.now() - t0;
      if (r.kind === "rows") {
        this._renderGrid(r.columns, r.rows);
        const more = r.done ? "" : " (more rows available — refine with WHERE / FETCH FIRST n ROWS ONLY)";
        this._setStatus(`${r.rows.length} row${r.rows.length === 1 ? "" : "s"} · ${ms} ms${more}`);
      } else {
        this._renderMessage(`${r.updateCount} row${r.updateCount === 1 ? "" : "s"} affected`
          + (r.lastInsertId != null ? ` · last insert id ${r.lastInsertId}` : ""));
        this._setStatus(`done · ${ms} ms`);
        // DML/DDL の後はスキーマが変わっている可能性 → 静かに refresh
        this._loadSchema();
      }
    } catch (e) {
      this._renderError(e.message || String(e));
      this._setStatus(`error · ${Date.now() - t0} ms`, true);
    } finally {
      this._busy = false;
      runBtn.disabled = false; runBtn.classList.remove("is-busy");
      this.onChange?.();
    }
  }

  _renderGrid(columns, rows) {
    const host = this.el.querySelector(".dbw-result");
    if (!rows.length) { host.innerHTML = `<div class="dbw-empty">∅ no rows</div>`; return; }
    const cell = (v) => {
      if (v === null || v === undefined) return `<td class="dbw-null">NULL</td>`;
      const s = String(v);
      const num = typeof v === "number";
      const shown = s.length > 300 ? s.slice(0, 300) + "…" : s;
      return `<td class="${num ? "dbw-num" : ""}" title="${escapeHtml(s)}">${escapeHtml(shown)}</td>`;
    };
    const head = columns.map(c =>
      `<th title="${escapeHtml(c.type || "")}"><span class="dbw-th-name">${escapeHtml(c.name)}</span><span class="dbw-th-type">${escapeHtml(c.type || "")}</span></th>`
    ).join("");
    const body = rows.map((row, i) =>
      `<tr><td class="dbw-rownum">${i + 1}</td>${row.map(cell).join("")}</tr>`
    ).join("");
    host.innerHTML = `<div class="dbw-grid-scroll"><table class="dbw-grid"><thead><tr><th class="dbw-rownum">#</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  _renderMessage(msg) {
    this.el.querySelector(".dbw-result").innerHTML = `<div class="dbw-msg">✓ ${escapeHtml(msg)}</div>`;
  }
  _renderError(msg) {
    this.el.querySelector(".dbw-result").innerHTML = `<div class="dbw-sqlerror"><span class="dbw-err-tag">SQL error</span><pre>${escapeHtml(msg)}</pre></div>`;
  }
  _setStatus(text, isError = false) {
    const el = this.el.querySelector(".dbw-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", isError);
  }

  // ───────────────────────────────────────────
  // Window ops (AgentWindow と同じ挙動)
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

  switchTab() { /* DB window はタブ無し: no-op (app.js 互換) */ }

  togglePin() { this.pinned = !this.pinned; this._applyPinnedState(); this.onChange?.(); }
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

  _beginDrag(e) {
    if (this.pinned) return;
    if (e.target.closest("button") || e.target.closest(".aw-traffic-dot")) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = this.el.getBoundingClientRect();
    const layerRect = this.layer.getBoundingClientRect();
    const offsetX = startX - rect.left, offsetY = startY - rect.top;
    const onMove = (ev) => {
      this.el.style.left = Math.max(0, ev.clientX - layerRect.left - offsetX) + "px";
      this.el.style.top  = Math.max(0, ev.clientY - layerRect.top  - offsetY) + "px";
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.onChange?.();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  _beginResize(e, dir = "se") {
    if (this.pinned) return;
    if (this.el.classList.contains("is-maximized")) return;
    e.preventDefault(); e.stopPropagation();
    this.focus();
    const startX = e.clientX, startY = e.clientY;
    const startW = this.el.offsetWidth, startH = this.el.offsetHeight;
    const startL = this.el.offsetLeft, startT = this.el.offsetTop;
    const minW = parseInt(getComputedStyle(this.el).minWidth, 10) || 480;
    const minH = parseInt(getComputedStyle(this.el).minHeight, 10) || 340;
    const cursorMap = { n:"ns-resize", s:"ns-resize", e:"ew-resize", w:"ew-resize", ne:"nesw-resize", sw:"nesw-resize", nw:"nwse-resize", se:"nwse-resize" };
    document.body.style.userSelect = "none";
    document.body.style.cursor = cursorMap[dir] || "nwse-resize";
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let w = startW, h = startH, l = startL, t = startT;
      if (dir.includes("e")) w = Math.max(minW, startW + dx);
      if (dir.includes("s")) h = Math.max(minH, startH + dy);
      if (dir.includes("w")) { w = Math.max(minW, startW - dx); l = startL + (startW - w); }
      if (dir.includes("n")) { h = Math.max(minH, startH - dy); t = startT + (startH - h); }
      this.el.style.width = w + "px"; this.el.style.height = h + "px";
      this.el.style.left = l + "px"; this.el.style.top = t + "px";
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = ""; document.body.style.cursor = "";
      this.onChange?.();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  toggleMaximize() {
    if (this._maxAnimTimer) { clearTimeout(this._maxAnimTimer); this._maxAnimTimer = null; }
    const willMax = !this.el.classList.contains("is-maximized");
    if (willMax) {
      this._preMaxPos = { left: this.el.style.left, top: this.el.style.top, width: this.el.style.width, height: this.el.style.height, zIndex: this.el.style.zIndex };
      this.el.classList.add("is-animating");
      requestAnimationFrame(() => this.el.classList.add("is-maximized"));
    } else {
      this.el.classList.add("is-animating");
      this.el.classList.remove("is-maximized");
      if (this._preMaxPos) { Object.assign(this.el.style, this._preMaxPos); this._preMaxPos = null; }
    }
    const cleanup = () => { this.el.classList.remove("is-animating"); this.el.removeEventListener("transitionend", cleanup); this._maxAnimTimer = null; };
    this.el.addEventListener("transitionend", cleanup);
    this._maxAnimTimer = setTimeout(cleanup, 400);
    this.focus();
    this.onChange?.();
  }

  // persist 用に現在の SQL を返す (snapshotWindow から参照)
  currentSql() { return this._sql?.value || ""; }
}
