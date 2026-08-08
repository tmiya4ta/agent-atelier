// プロトコルレジストリ
// 新規プロトコルは ここに追加すれば自動的に UI へ反映される。

import { A2AAdapter }   from "./a2a.js";
import { MCPAdapter }   from "./mcp.js";
import { MockAdapter }  from "./mock.js";
import { DbAdapter }    from "./db.js";
import { RestAdapter }  from "./rest.js";
import { SoapAdapter }  from "./soap.js";

// 表示順 = この配列の順 (connect ダイアログの grid は 4 列)。
export const PROTOCOLS = [
  {
    id: "rest",
    label: "REST",
    sub: "openapi · http",
    description: "REST client · OpenAPI/Swagger (JSON·YAML) からエンドポイント一覧 + raw リクエスト",
    AdapterClass: RestAdapter,
    status: "ready"
  },
  {
    id: "soap",
    label: "SOAP",
    sub: "wsdl · xml",
    description: "SOAP client · WSDL から operation 一覧 + Envelope 雛形を生成",
    AdapterClass: SoapAdapter,
    status: "ready"
  },
  {
    id: "a2a",
    label: "A2A",
    sub: "agent2agent",
    description: "Google Agent2Agent · JSON-RPC over HTTP",
    AdapterClass: A2AAdapter,
    status: "ready"
  },
  {
    id: "mcp",
    label: "MCP",
    sub: "model context",
    description: "Model Context Protocol · JSON-RPC 2.0 over HTTP",
    AdapterClass: MCPAdapter,
    status: "ready"
  },
  {
    id: "db",
    label: "DB",
    sub: "sql · jdbc/http",
    description: "Database client · clouderby (JDBC over HTTP) · SQL editor + result grid",
    AdapterClass: DbAdapter,
    status: "ready"
  },
  {
    id: "mock",
    label: "Mock",
    sub: "offline · scripted",
    description: "Pseudo agent · role conveyed by name alone · replays a script (Script Editor)",
    AdapterClass: MockAdapter,
    status: "ready"
  }
];

export function getProtocol(id) {
  return PROTOCOLS.find(p => p.id === id);
}
