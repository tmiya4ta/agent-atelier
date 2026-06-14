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

// Derby SQL の補完候補キーワード (大文字で挿入)。
const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "BETWEEN", "EXISTS",
  "ORDER BY", "GROUP BY", "HAVING", "DISTINCT", "AS", "ON", "UNION", "UNION ALL",
  "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "CROSS JOIN",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "MERGE INTO",
  "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "CREATE VIEW", "CREATE INDEX",
  "OFFSET", "FETCH FIRST", "FETCH NEXT", "ROWS ONLY",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "CAST", "COALESCE",
  "CASE", "WHEN", "THEN", "ELSE", "END", "ASC", "DESC", "WITH",
  "CURRENT_DATE", "CURRENT_TIMESTAMP", "CURRENT_TIME", "LOWER", "UPPER", "TRIM", "SUBSTR",
  "PRIMARY KEY", "FOREIGN KEY", "REFERENCES", "DEFAULT", "UNIQUE"
];
const TABLE_CTX = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE"]);   // 直前語がこれなら table 優先

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
    this._colCache = {};         // tableNameUpper → [colName] (SQL 補完用)
    this._preview = null;        // テーブルプレビューのページング {table,page,pageSize,total,lastCount}
    this._ac = { open: false, items: [], idx: 0, token: "", tokenStart: 0 };  // SQL 補完状態

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

    // editor + run + SQL autocomplete
    this._sql = node.querySelector(".dbw-sql");
    this._acBox = document.createElement("div");
    this._acBox.className = "dbw-ac";
    this._acBox.hidden = true;
    node.querySelector(".dbw-editor").appendChild(this._acBox);
    node.querySelector(".dbw-run").addEventListener("click", () => this._run());
    this._sql.addEventListener("keydown", (e) => this._onSqlKeydown(e));
    this._sql.addEventListener("input",   () => this._acUpdate());
    this._sql.addEventListener("blur",    () => setTimeout(() => this._acClose(), 150));
    this._sql.addEventListener("scroll",  () => { if (this._ac.open) this._acClose(); });
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
        <button class="dbw-table-row" title="click: preview rows · ▸: columns">
          <span class="dbw-caret" role="button" title="toggle columns">▸</span>
          <span class="dbw-tbl-glyph">${t.type === "VIEW" ? "◇" : "▦"}</span>
          <span class="dbw-tbl-name">${escapeHtml(t.name)}</span>
        </button>
        <div class="dbw-cols"></div>`;
      const btn = row.querySelector(".dbw-table-row");
      btn.addEventListener("click", (e) => {
        // ▸ (caret) は列の開閉、それ以外のクリックは行プレビュー
        if (e.target.closest(".dbw-caret")) { e.stopPropagation(); this._toggleTable(i, row); return; }
        this._previewTable(t.name);
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
      this._colCache[t.name.toUpperCase()] = (t.columns || []).map(c => c.name);   // 補完用に cache
      box.innerHTML = t.columns.map(c => `
        <div class="dbw-col" title="${escapeHtml(c.type || "")}${c.nullable === 0 ? " · NOT NULL" : ""}">
          <span class="dbw-col-name">${escapeHtml(c.name)}${c.autoInc ? '<span class="dbw-pk">↑</span>' : ""}</span>
          <span class="dbw-col-type">${escapeHtml(c.type || "")}</span>
        </div>`).join("");
    } catch (e) {
      box.innerHTML = `<div class="dbw-col dbw-col-error">${escapeHtml(e.message || "failed")}</div>`;
    }
  }

  // テーブルをクリック → ページング付きプレビュー (20 件/ページ, OFFSET/FETCH)
  async _previewTable(table) {
    this._preview = { table, page: 0, pageSize: 20, total: null, lastCount: 0 };
    this._sql.value = `SELECT * FROM ${table}`;
    this._acClose();
    // 総件数 (任意・失敗してもプレビューは出す)
    this.adapter.query(`SELECT COUNT(*) AS N FROM ${table}`).then(r => {
      if (this._preview && this._preview.table === table && r.kind === "rows") {
        this._preview.total = Number(r.rows?.[0]?.[0] ?? NaN);
        if (Number.isFinite(this._preview.total)) this._renderPager();
      }
    }).catch(() => {});
    await this._runPreview();
  }

  async _runPreview() {
    if (!this._preview || this._busy) return;
    const { table, page, pageSize } = this._preview;
    this._busy = true;
    this._setStatus(`loading ${table} · page ${page + 1}…`);
    const t0 = Date.now();
    try {
      const sql = `SELECT * FROM ${table} OFFSET ${page * pageSize} ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
      const r = await this.adapter.query(sql, pageSize);
      const ms = Date.now() - t0;
      if (r.kind === "rows") {
        this._preview.lastCount = r.rows.length;
        this._renderGrid(r.columns, r.rows, page * pageSize);
        this._renderPager();
        this._setStatus(`${table} · page ${page + 1} · ${r.rows.length} row${r.rows.length === 1 ? "" : "s"} · ${ms} ms`);
      } else {
        this._renderMessage(`${r.updateCount} rows affected`);
      }
    } catch (e) {
      this._renderError(e.message || String(e));
      this._setStatus(`error · ${Date.now() - t0} ms`, true);
    } finally {
      this._busy = false;
      this.onChange?.();
    }
  }

  // 結果グリッドの下にページングバーを出す (preview 中のみ)。
  _renderPager() {
    const host = this.el.querySelector(".dbw-result");
    if (!host) return;
    host.querySelector(".dbw-pager")?.remove();
    if (!this._preview) return;
    const { page, pageSize, total, lastCount } = this._preview;
    const from = lastCount ? page * pageSize + 1 : 0;
    const to   = page * pageSize + (lastCount || 0);
    const hasNext = total != null && Number.isFinite(total) ? to < total : lastCount === pageSize;
    const hasPrev = page > 0;
    const bar = document.createElement("div");
    bar.className = "dbw-pager";
    bar.innerHTML =
      `<button class="dbw-pg-btn dbw-pg-prev" ${hasPrev ? "" : "disabled"}>‹ prev</button>` +
      `<span class="dbw-pg-info">${from}–${to}${(total != null && Number.isFinite(total)) ? ` of ${total}` : ""}</span>` +
      `<button class="dbw-pg-btn dbw-pg-next" ${hasNext ? "" : "disabled"}>next ›</button>`;
    bar.querySelector(".dbw-pg-prev").onclick = () => { if (this._preview && this._preview.page > 0) { this._preview.page--; this._runPreview(); } };
    bar.querySelector(".dbw-pg-next").onclick = () => { if (this._preview) { this._preview.page++; this._runPreview(); } };
    host.appendChild(bar);
  }

  // ───────────────────────────────────────────
  // Run query
  // ───────────────────────────────────────────
  async _run() {
    if (this._busy) return;
    const sql = (this._sql.value || "").trim();
    if (!sql) { this._sql.focus(); return; }
    this._preview = null;   // 任意 SQL の実行はページング対象外 (pager は出さない)
    this._acClose();
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

  _renderGrid(columns, rows, rowOffset = 0) {
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
      `<tr><td class="dbw-rownum">${rowOffset + i + 1}</td>${row.map(cell).join("")}</tr>`
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
  // SQL autocomplete (keywords + table names + column names)
  // ───────────────────────────────────────────
  _onSqlKeydown(e) {
    if (this._ac.open && this._ac.items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); this._ac.idx = (this._ac.idx + 1) % this._ac.items.length; this._acRender(); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); this._ac.idx = (this._ac.idx - 1 + this._ac.items.length) % this._ac.items.length; this._acRender(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); this._acAccept(this._ac.items[this._ac.idx]); return; }
      if (e.key === "Escape") { e.preventDefault(); this._acClose(); return; }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this._run(); return; }
    if (e.key === " " && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this._acUpdate(true); return; }  // 明示的に補完を開く
  }

  _allCachedColumns() {
    const set = new Set();
    for (const cols of Object.values(this._colCache)) for (const c of cols) set.add(c);
    return [...set];
  }

  _acUpdate(force = false) {
    const ta = this._sql;
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) { this._acClose(); return; }
    const before = ta.value.slice(0, pos);
    const m = before.match(/[A-Za-z_][\w]*$/);
    const token = m ? m[0] : "";
    if (!token && !force) { this._acClose(); return; }
    const tokenStart = pos - token.length;
    const pre = before.slice(0, tokenStart);
    const dot = pre.match(/([A-Za-z_][\w]*)\.\s*$/);                 // t.<col>
    const prevWord = (pre.match(/([A-Za-z_]+)\s+$/)?.[1] || "").toUpperCase();
    const tables = (this._schema || []).map(t => t.name);
    let cands;
    if (dot) {
      cands = (this._colCache[dot[1].toUpperCase()] || []).map(c => ({ label: c, kind: "col" }));
    } else if (TABLE_CTX.has(prevWord)) {
      cands = tables.map(t => ({ label: t, kind: "table" }));
    } else {
      cands = [
        ...tables.map(t => ({ label: t, kind: "table" })),
        ...SQL_KEYWORDS.map(k => ({ label: k, kind: "kw" })),
        ...this._allCachedColumns().map(c => ({ label: c, kind: "col" })),
      ];
    }
    const tl = token.toLowerCase();
    const seen = new Set();
    const items = cands.filter(c => {
      const ll = c.label.toLowerCase();
      if (tl && !ll.startsWith(tl)) return false;
      if (ll === tl) return false;
      const key = c.kind + ll;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 12);
    if (!items.length) { this._acClose(); return; }
    this._ac = { open: true, items, idx: 0, token, tokenStart };
    this._acRender();
    this._prefetchCols(ta.value);
  }

  _acRender() {
    const box = this._acBox;
    const { items, idx } = this._ac;
    const glyph = { table: "▦", col: "·", kw: "K" };
    box.innerHTML = items.map((it, i) =>
      `<div class="dbw-ac-item${i === idx ? " is-active" : ""}" data-i="${i}">` +
      `<span class="dbw-ac-kind dbw-ac-${it.kind}">${glyph[it.kind] || ""}</span>` +
      `<span class="dbw-ac-label">${escapeHtml(it.label)}</span></div>`
    ).join("");
    box.querySelectorAll(".dbw-ac-item").forEach(el => {
      el.addEventListener("mousedown", (e) => { e.preventDefault(); this._acAccept(items[+el.dataset.i]); });
    });
    const { x, y, lh } = this._caretCoords();
    box.style.left = Math.round(x) + "px";
    box.style.top  = Math.round(y + lh + 2) + "px";
    box.hidden = false;
  }

  _acAccept(item) {
    if (!item) { this._acClose(); return; }
    const ta = this._sql;
    const pos = ta.selectionStart;
    const start = this._ac.tokenStart;
    const ins = item.label + (item.kind === "kw" ? " " : "");
    ta.value = ta.value.slice(0, start) + ins + ta.value.slice(pos);
    const caret = start + ins.length;
    ta.setSelectionRange(caret, caret);
    this._acClose();
    ta.focus();
  }

  _acClose() {
    this._ac.open = false;
    if (this._acBox) this._acBox.hidden = true;
  }

  // textarea のキャレット座標 (.dbw-editor 基準) を mirror div で測る。
  _caretCoords() {
    const ta = this._sql;
    const host = ta.parentElement;   // .dbw-editor (position: relative)
    const cs = getComputedStyle(ta);
    const div = document.createElement("div");
    ["fontFamily","fontSize","fontWeight","fontStyle","letterSpacing","lineHeight","textTransform","wordSpacing",
     "paddingTop","paddingRight","paddingBottom","paddingLeft","borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth","boxSizing","tabSize"]
      .forEach(p => { try { div.style[p] = cs[p]; } catch {} });
    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.wordWrap = "break-word";
    div.style.overflow = "hidden";
    div.style.width = ta.offsetWidth + "px";
    div.style.top = ta.offsetTop + "px";
    div.style.left = ta.offsetLeft + "px";
    div.textContent = ta.value.slice(0, ta.selectionStart);
    const span = document.createElement("span");
    span.textContent = "​";
    div.appendChild(span);
    host.appendChild(div);
    const x = ta.offsetLeft + span.offsetLeft - ta.scrollLeft;
    const y = ta.offsetTop + span.offsetTop - ta.scrollTop;
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    host.removeChild(div);
    return { x, y, lh };
  }

  // SQL 中で参照されているテーブルの列を背景取得して補完 cache に入れる。
  _prefetchCols(sql) {
    const re = /\b(?:from|join|into|update)\s+([A-Za-z_][\w]*)/gi;
    const known = new Set((this._schema || []).map(t => t.name.toUpperCase()));
    let m;
    while ((m = re.exec(sql))) {
      const up = m[1].toUpperCase();
      if (known.has(up) && !this._colCache[up]) {
        this._colCache[up] = [];   // 二重 fetch 防止のプレースホルダ
        this.adapter.columns(m[1])
          .then(cols => { this._colCache[up] = (cols || []).map(c => c.name); })
          .catch(() => { delete this._colCache[up]; });
      }
    }
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
