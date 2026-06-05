// MockAdapter — オフラインのデモ用エージェント
// 実際の接続はせず、AgentCardとレスポンスをローカルに合成する

import { ProtocolAdapter } from "./base.js";

const PERSONAS = {
  "atelier-research": {
    name: "Atelier Research",
    description:
      "学術論文の検索・要約・引用整形を行うリサーチエージェント。Tavily / Semantic Scholar / arXiv を背後で利用します。",
    url: "https://atelier.example/agents/research",
    version: "0.4.1",
    provider: { organization: "Atelier Labs", url: "https://atelier.example" },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text", "file"],
    defaultOutputModes: ["text", "markdown"],
    skills: [
      { id: "search-papers", name: "Search papers", description: "キーワードから関連論文を検索し要約", tags: ["research", "search"] },
      { id: "summarize-pdf", name: "Summarize PDF",  description: "PDFを節単位で要約", tags: ["summary"] },
      { id: "cite-bibtex",   name: "Cite as BibTeX", description: "引用情報をBibTeX形式で出力", tags: ["citation"] }
    ],
    initial: "やあ、Atelier Research です。論文の検索・要約・引用整形を担当します。何を調べましょう？",
    style: ["なるほど、それは興味深いトピックですね。", "現時点で参照可能な論文は 3 本あります。", "要約をお作りしますか？"]
  },

  "obsidian-orchestrator": {
    name: "Obsidian Orchestrator",
    description: "他のエージェントへタスクを分配する司令塔エージェント。A2A越しに sub-agent を呼び出します。",
    url: "https://obsidian.example/agents/orchestrator",
    version: "1.2.0",
    provider: { organization: "Obsidian Systems" },
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      { id: "delegate", name: "Delegate to sub-agent", description: "適切なエージェントへタスクをルーティング", tags: ["orchestration"] },
      { id: "parallel", name: "Parallel fan-out",      description: "複数エージェントへ並列問い合わせ", tags: ["parallel"] }
    ],
    initial: "Obsidian Orchestrator がオンライン。タスクを受け取り、下位エージェントに分配します。",
    style: ["タスクを分解しました。", "research / writer / qa の3エージェントに並列で渡します。", "結果をマージしています…"]
  },

  "silica-vision": {
    name: "Silica Vision",
    description: "画像理解・OCR・図表要約に特化したマルチモーダルエージェント。",
    url: "https://silica.example/agents/vision",
    version: "0.9.3",
    provider: { organization: "Silica" },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["image", "text"],
    defaultOutputModes: ["text"],
    skills: [
      { id: "ocr", name: "OCR", description: "画像から日本語/英語のテキストを抽出", tags: ["vision", "ocr"] },
      { id: "figure-explain", name: "Figure explain", description: "図表の構造と内容を説明", tags: ["vision"] }
    ],
    initial: "Silica Vision です。画像を投げていただければ、内容を読み解きます。",
    style: ["画像を解析中です…", "図表の主要な傾向は次のとおりです。", "信頼度: 0.87"]
  }
};

export class MockAdapter extends ProtocolAdapter {
  static get id()    { return "mock"; }
  static get label() { return "Mock"; }

  constructor(config) {
    super(config);
    this.persona = config.persona || "atelier-research";
    this.turn = 0;
  }

  async connect() {
    this._setState("connecting");
    await sleep(280 + Math.random() * 240);

    const p = PERSONAS[this.persona] || PERSONAS["atelier-research"];
    this.agentCard = { ...p };
    this.startedAt = Date.now();

    // emit a fake "fetch agent card" rpc frame for debug visibility
    this._emit("rpc", {
      dir: "out",
      method: "GET /.well-known/agent.json",
      headers: { "Accept": "application/json" },
      payload: null,
      raw: `GET ${p.url}/.well-known/agent.json HTTP/1.1\nAccept: application/json`
    });
    this._emit("rpc", {
      dir: "in",
      method: "200 OK · agent card",
      headers: { "Content-Type": "application/json", "Server": "atelier-mock" },
      payload: this.agentCard,
      raw: JSON.stringify(this.agentCard, null, 2)
    });

    this._setState("open");
    this._emit("open", { card: this.agentCard });

    // greeting
    setTimeout(() => {
      this._emit("message", { role: "agent", text: p.initial, final: true });
    }, 350);
  }

  async send(text, _opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    this.turn += 1;

    const reqId = `req-${this.turn}`;

    // outgoing rpc frame
    const rpcOut = {
      jsonrpc: "2.0",
      id: reqId,
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text }],
          messageId: `msg-${this.turn}-u`
        }
      }
    };
    this._emit("rpc", { dir: "out", method: "message/send",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      payload: rpcOut, raw: JSON.stringify(rpcOut, null, 2) });

    // simulate streaming response
    await sleep(180 + Math.random() * 320);

    const p = PERSONAS[this.persona];
    const reply = makeReply(p, text, this.turn);

    if (p.capabilities.streaming) {
      // emit a partial first
      const halves = chunk(reply, 2);
      let acc = "";
      for (let i = 0; i < halves.length; i++) {
        acc += halves[i];
        this._emit("message", { role: "agent", text: acc, final: i === halves.length - 1 });
        if (i < halves.length - 1) await sleep(120 + Math.random() * 180);
      }
    } else {
      this._emit("message", { role: "agent", text: reply, final: true });
    }

    const rpcIn = {
      jsonrpc: "2.0",
      id: reqId,
      result: {
        status: { state: "completed" },
        messages: [{
          role: "agent",
          parts: [{ kind: "text", text: reply }],
          messageId: `msg-${this.turn}-a`
        }]
      }
    };
    this._emit("rpc", { dir: "in", method: "200 OK · message/send",
      headers: { "Content-Type": "application/json", "Server": "atelier-mock" },
      payload: rpcIn, raw: JSON.stringify(rpcIn, null, 2) });
  }

  async disconnect() {
    this._setState("closed");
    this._emit("close");
  }
}

// ─── helpers ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeReply(persona, userText, turn) {
  // simple thematic reply combining style sentences
  const lines = persona.style;
  const intro = lines[turn % lines.length];
  const mention = userText.length > 0
    ? `ご質問「${userText.slice(0, 40)}${userText.length > 40 ? "…" : ""}」について確認しました。`
    : "リクエストを受け付けました。";
  const close = persona.skills[turn % persona.skills.length];
  return `${intro}\n\n${mention}\n\n該当する skill: \`${close.id}\` — ${close.description}`;
}

function chunk(str, n) {
  // split into roughly n equal parts on word boundaries
  const out = [];
  const step = Math.ceil(str.length / n);
  for (let i = 0; i < str.length; i += step) out.push(str.slice(i, i + step));
  return out;
}
