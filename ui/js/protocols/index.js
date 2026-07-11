// プロトコルレジストリ
// 新規プロトコルは ここに追加すれば自動的に UI へ反映される。

import { A2AAdapter }   from "./a2a.js";
import { SlackAdapter } from "./slack.js";
import { MCPAdapter }   from "./mcp.js";
import { MockAdapter }  from "./mock.js";
import { DbAdapter }    from "./db.js";

// 表示順: 1 段目 A2A / MCP / Slack / Mock、2 段目 DB (grid は 4 列)。
export const PROTOCOLS = [
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
    id: "slack",
    label: "Slack",
    sub: "web api · mrkdwn",
    description: "Slack-compatible Web API (chat.postMessage)",
    AdapterClass: SlackAdapter,
    status: "ready"
  },
  {
    id: "mock",
    label: "Mock",
    sub: "offline · scripted",
    description: "Pseudo agent · role conveyed by name alone · replays a script (Script Editor)",
    AdapterClass: MockAdapter,
    status: "ready"
  },
  {
    id: "db",
    label: "DB",
    sub: "sql · jdbc/http",
    description: "Database client · clouderby (JDBC over HTTP) · SQL editor + result grid",
    AdapterClass: DbAdapter,
    status: "ready"
  }
];

export function getProtocol(id) {
  return PROTOCOLS.find(p => p.id === id);
}
