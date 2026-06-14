// DbAdapter — DB コネクション (clouderby ドライバ) のアダプタ
// ─────────────────────────────────────────────────────────
// chat 型の A2A/MCP とは違い、DB は query→rows のリクエスト/レスポンス型。
// ProtocolAdapter を継承して connect()/disconnect() のライフサイクルだけ共有し、
// 実体は DbWindow が adapter.query()/tables()/columns() を直接呼ぶ。
//
// 認証は inline の user/password (clouderby は property ベース)。secret は
// config.password として持ち、persist 側で sessionStorage に分離される。

import { ProtocolAdapter } from "./base.js";
import { ClouderbyClient } from "./db/clouderby.js";

export class DbAdapter extends ProtocolAdapter {
  static get id()    { return "db"; }
  static get label() { return "DB"; }

  constructor(config) {
    super(config);
    this.driver = config.dbDriver || "clouderby";
    this.client = new ClouderbyClient({
      baseUrl:  config.url,
      user:     config.user,
      password: config.password,
      database: config.database
    });
  }

  async connect() {
    this._setState("connecting");
    try {
      await this.client.open();
      this.agentCard = {
        name:    this.config.name || this.config.url,
        kind:    "db",
        driver:  this.driver,
        version: this.client.serverVersion,
        database: this.config.database
      };
      this._setState("open");
      this._emit("open", { card: this.agentCard });
      return this.agentCard;
    } catch (e) {
      this._setState("error");
      this._emit("error", e);
      throw e;
    }
  }

  async disconnect() {
    try { await this.client.close(); } catch { /* ignore */ }
    this._setState("closed");
    this._emit("close");
  }

  // DbWindow から呼ぶ DB 操作
  query(sql, fetchSize)   { return this.client.query(sql, fetchSize); }
  tables()                { return this.client.tables(); }
  columns(table)          { return this.client.columns(table); }
}
