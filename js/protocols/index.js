// プロトコルレジストリ
// 新規プロトコルは ここに追加すれば自動的に UI へ反映される。

import { A2AAdapter }   from "./a2a.js";
import { SlackAdapter } from "./slack.js";
import { MCPAdapter }   from "./mcp.js";

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
    id: "slack",
    label: "Slack",
    sub: "web api · mrkdwn",
    description: "Slack 互換 Web API (chat.postMessage)",
    AdapterClass: SlackAdapter,
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
    id: "openai",
    label: "OpenAI",
    sub: "assistants",
    description: "OpenAI Assistants API — coming soon",
    AdapterClass: null,
    status: "planned"
  }
];

export function getProtocol(id) {
  return PROTOCOLS.find(p => p.id === id);
}
