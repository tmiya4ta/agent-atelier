// clouderby (JDBC over HTTP) ブラウザクライアント
// ─────────────────────────────────────────────────────────
// プロトコル仕様: https://github.com/tmiya4ta/mule-clouderby
//   POST   /sessions            {user,password,database}     → {session-id, server-version}
//   POST   /queries             {sql, fetch-size}            → {columns,rows,done,cursor-id} | {update-count,last-insert-id}
//   GET    /metadata/tables                                  → {tables:[{name,type,schema}]}
//   GET    /metadata/columns?tablePattern=T                  → {columns:[{column-name,type-name,...}]}
//   DELETE /sessions                                         → {closed:true}
//   GET    /health                                           → {status:"UP"}
// セッションは X-Clouderby-Session-Id ヘッダで引き回す。
//
// clouderby サーバは CORS ヘッダを返さないので、ブラウザからは既定で同一オリジンの
// /proxy?url=... 経由でアクセスする (a2a/mcp と同じ規約)。node テスト時は proxify に
// 恒等関数を渡せば素のエンドポイントを直接叩ける。

const DEFAULT_PROXIFY = (url) => `/proxy?url=${encodeURIComponent(url)}`;

export class ClouderbyClient {
  constructor({ baseUrl, user, password, database, proxify, fetchImpl } = {}) {
    this.baseUrl  = String(baseUrl || "").replace(/\/+$/, "");
    this.user     = user;
    this.password = password;
    this.database = database || "default";
    this.proxify  = proxify  || DEFAULT_PROXIFY;
    this.fetch    = fetchImpl || ((...a) => fetch(...a));
    this.sessionId     = null;
    this.serverVersion = null;
  }

  _url(path) { return this.proxify(this.baseUrl + path); }

  async _req(method, path, { body, sessionId } = {}) {
    const headers = { "Accept": "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // sessionId を明示 null で渡すと「ヘッダを付けない」(health / open 用)
    const sid = (sessionId !== undefined) ? sessionId : this.sessionId;
    if (sid) headers["X-Clouderby-Session-Id"] = sid;

    const res  = await this.fetch(this._url(path), {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { error: text }; }
    if (!res.ok) {
      const e = new Error((data && data.error) || `HTTP ${res.status}`);
      e.status = res.status; e.body = data;
      throw e;
    }
    return data;
  }

  async health() {
    return this._req("GET", "/health", { sessionId: null });
  }

  // セッション確立 (= 認証)。誤った user/password は 401 で throw。
  async open() {
    const d = await this._req("POST", "/sessions", {
      sessionId: null,
      body: { user: this.user, password: this.password, database: this.database }
    });
    this.sessionId     = d["session-id"];
    this.serverVersion = d["server-version"] || null;
    if (!this.sessionId) throw new Error("session-id not returned by server");
    return d;
  }

  async _ensure() { if (!this.sessionId) await this.open(); }

  // SQL を実行。SELECT 系は {kind:"rows",...}、DML/DDL は {kind:"update",...}。
  async query(sql, fetchSize = 200) {
    await this._ensure();
    const d = await this._req("POST", "/queries", { body: { sql, "fetch-size": fetchSize } });
    if (d.columns) {
      return {
        kind: "rows",
        columns:  d.columns.map(c => ({ name: c.name, type: c.type, nullable: c.nullable, autoInc: c["auto-increment"] })),
        rows:     d.rows || [],
        done:     d.done !== false,
        cursorId: d["cursor-id"] || null
      };
    }
    return {
      kind: "update",
      updateCount:  d["update-count"] ?? 0,
      lastInsertId: d["last-insert-id"] ?? null
    };
  }

  // スキーマツリー用: テーブル一覧。
  async tables() {
    await this._ensure();
    const d = await this._req("GET", "/metadata/tables");
    return (d.tables || []).map(t => ({ name: t.name, type: t.type || "TABLE", schema: t.schema || null }));
  }

  // 指定テーブルの列メタ。
  async columns(table) {
    await this._ensure();
    const d = await this._req("GET", "/metadata/columns?tablePattern=" + encodeURIComponent(table));
    return (d.columns || []).map(c => ({
      name:     c["column-name"],
      type:     c["type-name"],
      size:     c["column-size"],
      nullable: c.nullable,
      ordinal:  c["ordinal-position"],
      autoInc:  c["is-auto-increment"]
    }));
  }

  async close() {
    if (!this.sessionId) return;
    try { await this._req("DELETE", "/sessions"); } catch { /* best-effort */ }
    this.sessionId = null;
  }
}
