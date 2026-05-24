// プロトコルレジストリ
// 新規プロトコルは ここに追加すれば自動的に UI へ反映される。

import { A2AAdapter }  from "./a2a.js";
import { MockAdapter } from "./mock.js";

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
    id: "mock",
    label: "Mock",
    sub: "offline demo",
    description: "Offline demo agents (no network)",
    AdapterClass: MockAdapter,
    status: "ready"
  },
  {
    id: "mcp",
    label: "MCP",
    sub: "model context",
    description: "Model Context Protocol — coming soon",
    AdapterClass: null,
    status: "planned"
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
