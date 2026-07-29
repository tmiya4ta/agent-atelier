// A2AAdapter — Agent2Agent プロトコル
//
// AgentCard URL の決定ルール:
//   - "*/.well-known/agent-card.json" を含む  → そのまま使用 (新仕様)
//   - "*/.well-known/agent.json"      を含む  → そのまま使用 (旧仕様)
//   - それ以外                                → "<base>/.well-known/agent-card.json" を試し、
//                                                404なら "<base>/.well-known/agent.json" にフォールバック
//
// CORS:
//   外部ドメインへのfetchはブラウザがブロックするので、
//   同一オリジンの "/proxy?url=..." 経由でリクエストする。
//   ローカル(同一オリジン)のURLは直接fetch。

import { ProtocolAdapter, headersToObj } from "./base.js";
import { MCPAdapter }      from "./mcp.js";

export class A2AAdapter extends ProtocolAdapter {
  static get id()    { return "a2a"; }
  static get label() { return "A2A"; }

  constructor(config) {
    super(config);
    this.endpoint = normalizeUrl(config.url);
    this.rpcUrl   = null;
    this.turn = 0;
    // A2A window にも Agent window と同じ MCP 複数登録ができる。
    // 送信時に tools/list をまとめて data part で相手エージェントへ渡し、
    // エージェントが input-required + tool-call データで呼び返したら
    // ここで実際に tools/call を実行して結果を次ターンとして送り返す
    // (詳細は send()/_sendTurn() を参照)。
    this._seed   = Array.isArray(config.mcpServers) ? config.mcpServers.slice() : [];
    this.servers = [];   // [{ id, name, url, auth, authHeaders, mcp, tools, state, error }]
    this._srvSeq = 0;
    // contextId — A2A 0.3 の会話 ID。 サーバ側で会話履歴 (memory) を保つ識別子。
    // 初回は null にしておき、 サーバから返ってきた contextId をそのまま使う。
    // (MAF broker のように「先に read、 無ければ 500」と実装された server を救うため。
    //  client 側で生成すると broker の ObjectStore に存在しないキーを送ることになり、
    //  Object with key [...] does not exist in store ... というエラーで死ぬ。)
    this.contextId = null;
    // taskId — A2A の task 継続 ID。 server が status.state="input-required"/"auth-required"
    // (= 追加入力待ち) の task を返したら保持し、 次ターンの message.taskId に付けて
    // 同じ task を継続する。 これが無いと毎ターン新規 task 扱いになり、 broker が直前の
    // 問いかけ ("一覧を取得しますか?") を忘れて文脈が切れる (「はい」が通じない)。
    this.taskId = null;
    // メッセージのワイヤー形式。 null = 未判定 (まず legacy を試す)。
    //   "legacy" — A2A 0.3 系の素朴な JSON-RPC (kind 判別子, method="message/send")。
    //   "proto"  — A2A 1.0 の正規スキーマ (protobuf 由来, method="SendMessage", kind 無し)。
    // AgentCard の supportedInterfaces でトランスポートを宣言しないサーバもあるため、
    // 事前判定はできない。 send() が -32601 (Method not found) を見て自動フォールバックし、
    // 一度判定したらセッション中はそのまま使い続ける。
    this._msgStyle = null;
  }

  // 履歴クリアからのフック (window.js から呼ぶ)。 contextId を null に戻すと
  // 次のターンは初対面扱いとなり、 サーバが新しい contextId を採番してくれる。
  resetContext() {
    this.contextId = null;
    this.taskId = null;
    this.turn = 0;
  }

  // task の状態を見て taskId を継続 / 破棄する。
  //  input-required / auth-required (追加入力待ち) → その taskId を次ターンへ継続。
  //  completed / failed / canceled / rejected (終端)   → taskId を破棄し次は新規 task。
  //  submitted / working (中間)                         → 何もしない (まだ確定しない)。
  _trackTask(result) {
    if (!result || typeof result !== "object") return;
    const state = result.status?.state || result.state;
    const tid = (result.kind === "task" ? result.id : undefined)
      || result.taskId
      || result.status?.message?.taskId
      || result.task?.id;
    if ((state === "input-required" || state === "auth-required") && tid) {
      this.taskId = tid;
    } else if (state && state !== "submitted" && state !== "working") {
      this.taskId = null;
    }
  }

  async connect() {
    this._setState("connecting");

    // ── キャッシュヒット時は即 open し、 裏で revalidate (stale-while-revalidate) ──
    const cached = readCardCache(this.endpoint);
    if (cached) {
      this.agentCard = cached.card;
      this.rpcUrl    = cached.card.url || ensureTrailingSlash(this.endpoint);
      this._emit("rpc", {
        dir: "in",
        method: `cache HIT · agent card · ${shortPath(cached.cardUrl)}`,
        payload: cached.card,
        raw: JSON.stringify(cached.card, null, 2)
      });
      this._setState("open");
      this.startedAt = Date.now();
      this._emit("open", { card: cached.card });
      // 裏で再検証 (失敗しても open は維持; card が更新されたら state.agentCard を差し替え)
      this._revalidateCard().catch(() => {});
      await this._connectSeedServers();
      return;
    }

    await this._fetchCard({ emitOpen: true });
    await this._connectSeedServers();
  }

  async _connectSeedServers() {
    for (const s of this._seed) {
      try { await this.addServer(s); } catch { /* keep going */ }
    }
  }

  async disconnect() {
    for (const s of this.servers) { try { await s.mcp?.disconnect(); } catch {} }
    this.servers = [];
    await super.disconnect();
  }

  abort() {
    for (const s of this.servers) { try { s.mcp?.abort(); } catch {} }
    super.abort();
  }

  // ─── MCP サーバの動的追加/削除 (Settings から呼ぶ。Agent window と同じ形) ───
  async addServer({ url, auth, authHeaders, name } = {}) {
    if (!url) throw new Error("url required");
    const id  = `s${++this._srvSeq}`;
    const rec = { id, name: name || hostLabel(url), url, auth: auth || undefined,
                  authHeaders: authHeaders || undefined,
                  mcp: null, tools: [], state: "connecting", error: null };
    this.servers.push(rec);
    this._emit("servers-changed", { servers: this.serverSummaries() });

    try {
      const mcp = new MCPAdapter({ url, auth: rec.auth, authHeaders: rec.authHeaders });
      mcp.addEventListener("rpc", (e) => {
        const d = e.detail || {};
        this._emit("rpc", { ...d, method: `[${rec.name}] ${d.method || ""}` });
      });
      rec.mcp = mcp;
      await mcp.connect();
      rec.tools = Array.isArray(mcp.tools) ? mcp.tools : [];
      rec.state = "open";
    } catch (e) {
      rec.state = "error";
      rec.error = e?.message || String(e);
    }
    this._emit("servers-changed", { servers: this.serverSummaries() });
    return rec.state;
  }

  async removeServer(id) {
    const i = this.servers.findIndex(s => s.id === id);
    if (i < 0) return;
    const [rec] = this.servers.splice(i, 1);
    try { await rec.mcp?.disconnect(); } catch {}
    this._emit("servers-changed", { servers: this.serverSummaries() });
  }

  serverSummaries() {
    return this.servers.map(s => ({
      id: s.id, name: s.name, url: s.url, state: s.state, error: s.error,
      toolCount: s.tools.length, hasAuth: !!(s.auth || s.authHeaders)
    }));
  }

  serverConfigs() {
    return this.servers.map(s => ({ name: s.name, url: s.url, auth: s.auth, authHeaders: s.authHeaders }));
  }

  // 全 MCP の tools を prefix 付き (mcp__<srvId>__<tool>) で集約。相手エージェントに
  // そのまま JSON Schema として渡せる形 (name/description/input_schema)。
  _allTools() {
    const out = [];
    for (const s of this.servers) {
      if (s.state !== "open") continue;
      for (const t of s.tools) {
        out.push({
          name:         `mcp__${s.id}__${t.name}`,
          description:  `[${s.name}] ${t.description || ""}`,
          input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} },
          _srv: s.id, _base: t.name
        });
      }
    }
    return out;
  }

  async _fetchCard({ emitOpen = false } = {}) {
    const candidates = candidateCardUrls(this.endpoint);
    let card = null, cardUrl = null, lastErr = null, cardResHeaders = null;
    for (const cu of candidates) {
      const reqHeaders = { Accept: "application/json" };
      if (this.config.auth) reqHeaders["Authorization"] = `Bearer ${this.config.auth}`;
      if (this.config.authHeaders) Object.assign(reqHeaders, this.config.authHeaders);
      this._emit("rpc", { dir: "out", method: `GET ${cu}`, headers: reqHeaders, raw: `GET ${cu}\nAccept: application/json` });
      try {
        const res = await fetch(proxify(cu), { headers: reqHeaders });
        if (res.status === 404) {
          this._emit("rpc", { dir: "err", method: "404 not found", raw: cu });
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        card = await res.json();
        cardUrl = cu;
        cardResHeaders = headersToObj(res.headers);
        break;
      } catch (e) {
        lastErr = e;
        this._emit("rpc", { dir: "err", method: `fetch failed: ${cu}`, raw: String(e) });
      }
    }

    if (!card) {
      if (emitOpen) {
        this._setState("error");
        const err = lastErr || new Error(`AgentCard not found at ${candidates.join(", ")}`);
        this._emit("error", err);
        throw err;
      }
      // revalidate 失敗 → open のままで握り潰す
      return;
    }

    this.agentCard = card;
    this.rpcUrl    = card.url || ensureTrailingSlash(this.endpoint);
    writeCardCache(this.endpoint, card, cardUrl);

    this._emit("rpc", {
      dir: "in", method: `200 OK · agent card · ${shortPath(cardUrl)}`,
      headers: cardResHeaders, payload: card, raw: JSON.stringify(card, null, 2)
    });

    if (emitOpen) {
      this._setState("open");
      this.startedAt = Date.now();
      this._emit("open", { card });
    }
  }

  async _revalidateCard() {
    return this._fetchCard({ emitOpen: false });
  }

  // legacy (A2A 0.3 系, kind 判別子) / proto (A2A 1.0 正規スキーマ) いずれかの
  // message/send リクエスト body を組み立てる。
  // extraData: 追加で乗せる data part の配列 (例: 登録済み MCP tools 一覧、tool 実行結果)。
  _buildMessageBody(reqId, text, legacyMethod, style, extraData = []) {
    const dataParts = extraData.map(d => style === "proto" ? { data: d } : { kind: "data", data: d });
    if (style === "proto") {
      const parts = [];
      if (text) parts.push({ text });
      parts.push(...dataParts);
      const message = { messageId: uuid(), role: "ROLE_USER", parts };
      if (this.contextId) message.contextId = this.contextId;
      if (this.taskId) message.taskId = this.taskId;
      return { jsonrpc: "2.0", id: reqId, method: "SendMessage", params: { message, configuration: {} } };
    }
    const parts = [];
    if (text) parts.push({ kind: "text", text });
    parts.push(...dataParts);
    const message = {
      kind: "message",                        // A2A 0.3+ で discriminator として必須
      role: "user",
      parts,
      messageId: uuid()
    };
    if (this.contextId) message.contextId = this.contextId;
    if (this.taskId) message.taskId = this.taskId;
    return { jsonrpc: "2.0", id: reqId, method: legacyMethod, params: { message, configuration: {} } };
  }

  async send(text, opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    await this._ensureFreshAuth();   // 期限切れトークンをここで更新

    const useStream = !!(opts.stream && this.agentCard?.capabilities?.streaming);
    // 登録済み MCP サーバの URL 一覧 (+ 参考として現在分かっているツール一覧) を渡す。
    // 実際の tools/list・tools/call は相手エージェントが直接 MCP サーバに対して行う
    // (Atelier は仲介しない — Atelier はあくまで MCP サーバを紹介するだけ)。
    const mcpServers = this.servers.filter(s => s.state === "open").map(s => ({ url: s.url, name: s.name }));
    const tools = this._allTools();
    const initialData = [];
    if (mcpServers.length) initialData.push({ mcpServers });
    if (tools.length) initialData.push({ tools });

    const first = await this._postTurn(text, initialData, useStream);
    if (!first) return; // streaming 経路は _postTurn 内で emit 済み

    const { result, ac } = first;
    this._trackTask(result);
    const messages = collectMessages(result);
    const delayMs = 400 + Math.random() * 600;
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      ac.signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });
    for (const m of messages) {
      const txt = collectText(m);
      if (txt) this._emit("message", { role: m.role || "agent", text: txt, final: true });
    }
  }

  // 1 リクエスト分の送受信 (legacy↔proto 自動フォールバック込み)。 streaming の場合は
  // _consumeSse に委譲して null を返す (呼び出し側はそこで打ち切る)。
  async _postTurn(text, extraData, useStream) {
    this.turn += 1;
    const reqId = `req-${this.turn}`;
    const legacyMethod = useStream ? "message/stream" : "message/send";

    // style 判定: 既に分かっていればそれを使う。 未判定ならまず legacy で試し、
    // -32601 (Method not found) が返ってきたら proto で自動的に再送する (下記)。
    let style  = this._msgStyle || "legacy";
    let method = style === "proto" ? "SendMessage" : legacyMethod;
    let body   = this._buildMessageBody(reqId, text, legacyMethod, style, extraData);

    const headers = {
      "Content-Type": "application/json",
      // message/stream (legacy) のときだけ SSE を受ける。 proto の streaming (SendStreamingMessage)
      // は未実装なので、 proto style では常に JSON を要求する。
      Accept: (useStream && style === "legacy") ? "text/event-stream" : "application/json",
      // spec: "Clients MUST send the A2A-Version header with each request" (Major.Minor)。
      // AgentCard の protocolVersion から算出 (例 "0.3.0" → "0.3")。 card 自体が
      // protocolVersion を省略している server もあるので、 その場合は現行 GA の "1.0" を既定にする
      // (未送信だと server 側は "0.3" 扱いにする実装もあり、 厳格な gateway policy では拒否されうる)。
      "A2A-Version": a2aVersionHeader(this.agentCard)
    };
    if (this.config.auth) headers["Authorization"] = `Bearer ${this.config.auth}`;
    if (this.config.authHeaders) Object.assign(headers, this.config.authHeaders);

    this._emit("rpc", {
      dir: "out", method, headers, payload: body, raw: JSON.stringify(body, null, 2)
    });

    // 停止ボタン用: この送信を中断できるよう AbortController を立てる
    const ac = new AbortController();
    this._inflight = ac;

    try {
      let res = await fetch(proxify(this.rpcUrl), { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
      // AgentCard の url を末尾スラッシュ無しで publish しているのに、 実際の
      // listener は "<path>/" にしか無い server がある (Flex Gateway 経由の
      // Mule アプリで実際に遭遇: スラッシュ無しは 404、 付ければ 200)。
      // カードの url は信用して先に試し、 404 のときだけ 1 回だけ付けて再送する。
      // 成功したら rpcUrl 自体を差し替え、 以降のターンは最初から正しい URL を使う。
      if (res.status === 404 && !this.rpcUrl.endsWith("/")) {
        const slashed = this.rpcUrl + "/";
        this._emit("rpc", { dir: "err", method: `404 · ${method}`, raw: `${this.rpcUrl}\nretrying with trailing slash: ${slashed}` });
        const res2 = await fetch(proxify(slashed), { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
        if (res2.ok) { this.rpcUrl = slashed; res = res2; }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // ── streaming (SSE) 経路 ───────────────────────────────
      // server が text/event-stream を返したら 1 イベントずつ読み、
      // status-update / artifact-update を逐次 message として emit する。
      const ctype = res.headers.get("content-type") || "";
      if (useStream && style === "legacy" && ctype.includes("text/event-stream")) {
        await this._consumeSse(res, method, ac, headersToObj(res.headers));
        return;
      }

      let data = await res.json();

      this._emit("rpc", {
        dir: "in", method: `200 OK · ${method}`,
        headers: headersToObj(res.headers), payload: data, raw: JSON.stringify(data, null, 2)
      });

      // legacy で "Method not found" (-32601) なら、 このサーバは message/send ではなく
      // A2A 1.0 の正規スキーマ (proto3-JSON, method="SendMessage") を話す (例: v2 gateway)。
      // 1 回だけ proto 形式で自動的に再送し、 以後このセッションでは proto を使い続ける。
      if (data.error?.code === -32601 && style === "legacy" && !this._msgStyle) {
        this._msgStyle = "proto";
        style  = "proto";
        method = "SendMessage";
        headers.Accept = "application/json";
        body = this._buildMessageBody(reqId, text, legacyMethod, style, extraData);
        this._emit("rpc", {
          dir: "out", method: `${method} (auto-retry: proto schema)`, headers, payload: body, raw: JSON.stringify(body, null, 2)
        });
        res = await fetch(proxify(this.rpcUrl), { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        this._emit("rpc", {
          dir: "in", method: `200 OK · ${method}`,
          headers: headersToObj(res.headers), payload: data, raw: JSON.stringify(data, null, 2)
        });
      }

      if (data.error) throw new Error(`RPC error: ${data.error.message || data.error.code}`);

      // 通った形式を記録する。 これまでは proto へフォールバックしたときしか
      // 覚えておらず、 legacy がそのまま成功した場合は null のままだった。
      // 判定済みなら次ターン以降そのまま使えるし、 capabilities の transport 表示も
      // 「未判定」ではなく実際の形式を出せる。
      this._msgStyle = style;

      // proto 応答は legacy と同じ内部形状 (kind/status.state 文字列/role 文字列) に正規化してから
      // 以降の処理 (collectMessages/collectText/_trackTask) に渡す。 これで下流は無改修で共用できる。
      const result = style === "proto" ? protoResultToLegacy(data.result) : (data.result || {});

      // server が採番した contextId を保持 (A2A 0.3 で task.contextId / message.contextId の
      // どちらにも乗ってくる可能性があるので両方見る)
      const ctx = result.contextId
        || result.task?.contextId
        || result.message?.contextId
        || result.status?.contextId;
      if (ctx && !this.contextId) this.contextId = ctx;
      // input-required の task なら taskId を継続保持する (ツール呼び出しループの継続にも使う)
      this._trackTask(result);

      return { result, ac };
    } catch (e) {
      if (e?.name === "AbortError") {
        this._emit("rpc", { dir: "err", method: `aborted · ${method}`, raw: "stopped by user" });
        this._emit("aborted", { method });
        const err = new Error("aborted by user");
        err.name = "AbortError";
        throw err;
      }
      this._emit("rpc", { dir: "err", method: `error: ${method}`, raw: String(e) });
      this._emit("error", e);
      throw e;
    } finally {
      if (this._inflight === ac) this._inflight = null;
    }
  }

  // ─── SSE (text/event-stream) を 1 イベントずつ消費する ───────────
  // A2A streaming は `event: <kind>` + `data: <json>` の SSE フレームを返す:
  //   event: task          → 初期 Task (submitted)
  //   event: status-update → 進捗。 status.state = working|completed|failed、 final フラグ付き
  //   event: artifact-update → 部分成果物
  // 中間 (final=false) の status は進捗として system 行で逐次表示し、
  // 最終 (final=true / completed) のテキストだけを通常の agent message として出す。
  async _consumeSse(res, method, ac, resHeaders) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let lastText = "";          // 最後に出した進捗テキスト (最終 fallback 用)
    let finalEmitted = false;
    let firstFrame = true;      // SSE 応答ヘッダは最初のフレームにだけ載せる

    const handleEvent = (evName, dataStr) => {
      let data;
      try { data = JSON.parse(dataStr); } catch { return; }

      // debug タブにも生フレームを流す (応答ヘッダは最初のフレームにだけ付ける)
      this._emit("rpc", {
        dir: "in", method: `SSE · ${evName}`,
        headers: firstFrame ? resHeaders : undefined,
        payload: data, raw: JSON.stringify(data, null, 2)
      });
      firstFrame = false;

      const result = data.result || data;

      // contextId を拾って保持 (次ターンの会話継続用)
      const ctx = result.contextId || result.task?.contextId
        || result.status?.contextId || result.message?.contextId;
      if (ctx && !this.contextId) this.contextId = ctx;
      // input-required の task なら taskId を継続保持する (最終フレームの状態が効く)
      this._trackTask(result);

      if (data.error) { this._emit("error", new Error(`RPC error: ${data.error.message || data.error.code}`)); return; }

      // status-update: status.message.parts[].text を取り出す
      if (result.kind === "status-update" || result.status) {
        const st    = result.status || {};
        const state = st.state || "";
        const txt   = collectText(st.message) || "";
        const isFinal = result.final === true || state === "completed" || state === "failed";
        if (txt) {
          if (isFinal) {
            this._emit("message", { role: "agent", text: txt, final: true });
            finalEmitted = true;
          } else {
            // 中間進捗 → system 行で逐次表示 (差分 typewriter を避ける)
            this._emit("status", { state, text: txt });
            lastText = txt;
          }
        }
        return;
      }

      // artifact-update / task / その他: テキストが取れれば最終扱いで出す
      const msgs = collectMessages(result);
      for (const m of msgs) {
        const txt = collectText(m);
        if (txt) { this._emit("message", { role: m.role || "agent", text: txt, final: true }); finalEmitted = true; }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE フレームは空行 (\n\n) 区切り
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let evName = "message", dataStr = "";
          for (const raw of frame.split("\n")) {
            const line = raw.replace(/\r$/, "");
            if (line.startsWith("event:")) evName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += (dataStr ? "\n" : "") + line.slice(5).trim();
          }
          if (dataStr) handleEvent(evName, dataStr);
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        this._emit("rpc", { dir: "err", method: `aborted · ${method}`, raw: "stopped by user" });
        this._emit("aborted", { method });
        const err = new Error("aborted by user"); err.name = "AbortError"; throw err;
      }
      throw e;
    }

    // completed/final が来ないまま閉じたら、 最後の進捗を最終メッセージにする
    if (!finalEmitted && lastText) {
      this._emit("message", { role: "agent", text: lastText, final: true });
    }
  }
}

// ─── agent-card cache (stale-while-revalidate) ────────
// localStorage に保存。 entry あれば即 connect → 裏で revalidate。
//   key:   atelier:a2aCard:<normalized endpoint>
//   value: { card, cardUrl, savedAt }
const CARD_CACHE_PREFIX = "atelier:a2aCard:";
const CARD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7d 経ったら捨てる

function readCardCache(endpoint) {
  try {
    const raw = localStorage.getItem(CARD_CACHE_PREFIX + endpoint);
    if (!raw) return null;
    const ent = JSON.parse(raw);
    if (!ent?.card || !ent?.savedAt) return null;
    if (Date.now() - ent.savedAt > CARD_CACHE_TTL_MS) {
      localStorage.removeItem(CARD_CACHE_PREFIX + endpoint);
      return null;
    }
    return ent;
  } catch { return null; }
}
function writeCardCache(endpoint, card, cardUrl) {
  try {
    localStorage.setItem(
      CARD_CACHE_PREFIX + endpoint,
      JSON.stringify({ card, cardUrl, savedAt: Date.now() })
    );
  } catch { /* quota / private mode は無視 */ }
}

// ─── helpers ────────────────────────────────────────
function normalizeUrl(u) {
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) return "https://" + u;
  return u;
}
function trimSlash(u) { return u.replace(/\/+$/, ""); }
// AgentCard に url フィールドが無いサーバ (spec 上は必須だが省略する実装がある) 向けの
// フォールバック先。 単純に trimSlash すると、 末尾スラッシュ有りでしかルーティングしない
// gateway (Flex Gateway のベースパス等) で 404 になる。 見てきた実例 (card.url を持つ agent)
// は軒並み末尾スラッシュ付きだったので、 フォールバックでも末尾スラッシュを 1 個保証する。
function ensureTrailingSlash(u) { return trimSlash(u) + "/"; }
// AgentCard.protocolVersion ("0.3.0" 等) → ヘッダー値 "Major.Minor" ("0.3")。
// card 未取得 / protocolVersion 省略時は現行 GA の "1.0" を既定にする。
function a2aVersionHeader(card) {
  const v = card?.protocolVersion;
  if (typeof v === "string" && /^\d+\.\d+/.test(v)) {
    const m = v.match(/^(\d+)\.(\d+)/);
    return `${m[1]}.${m[2]}`;
  }
  return "1.0";
}

function candidateCardUrls(endpoint) {
  if (/\/\.well-known\/agent-card\.json\b/.test(endpoint)) return [endpoint];
  if (/\/\.well-known\/agent\.json\b/.test(endpoint))      return [endpoint];
  const base = trimSlash(endpoint);
  return [
    `${base}/.well-known/agent-card.json`,   // 新仕様 (preferred)
    `${base}/.well-known/agent.json`         // 旧仕様
  ];
}

function shortPath(u) {
  try { return new URL(u).pathname; } catch { return u; }
}

function hostLabel(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).host; }
  catch { return url; }
}

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // fallback: pseudo UUID v4
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
    (c ^ (Math.random() * 16) >> (c / 4)).toString(16)
  );
}

// CORS バイパス: 外部オリジン宛は /proxy?url=... に書き換える
function proxify(targetUrl) {
  try {
    const t = new URL(targetUrl);
    if (t.origin === location.origin) return targetUrl;
  } catch { /* fall through */ }
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// ─── A2A 1.0 正規スキーマ (protobuf 由来, lf.a2a.v1) → legacy 内部形状への変換 ───
// SendMessageResponse は oneof { Task task; Message message; } なので proto3 の JSON
// マッピングでは data.result が { task: {...} } か { message: {...} } になる
// (a2a.proto: SendMessageResponse / Task / Message / Part / Role / TaskState を参照)。
// legacy 側 (collectMessages/collectText/_trackTask) が理解する形へ正規化することで、
// 下流のロジックを一切変更せずに両スキーマを共用する。
function protoRoleToLegacy(role) {
  return role === "ROLE_USER" ? "user" : "agent";   // ROLE_AGENT / ROLE_UNSPECIFIED / 不明 → agent
}
const PROTO_TASK_STATE_MAP = {
  TASK_STATE_SUBMITTED:      "submitted",
  TASK_STATE_WORKING:        "working",
  TASK_STATE_COMPLETED:      "completed",
  TASK_STATE_FAILED:         "failed",
  TASK_STATE_CANCELED:       "canceled",
  TASK_STATE_INPUT_REQUIRED: "input-required",
  TASK_STATE_REJECTED:       "rejected",
  TASK_STATE_AUTH_REQUIRED:  "auth-required"
};
function protoTaskStateToLegacy(state) { return PROTO_TASK_STATE_MAP[state] || ""; }

// Part は oneof (text|raw|url|data) のフラット表現。 kind 判別子は無いので
// 中身から legacy 形式 ({kind:"text",text} / {kind:"data",data}) を組み立てる。
// url/raw (ファイル的な part) は legacy 側に file 用の描画が無いため、
// 中身が見えるよう data kind としてダンプする (せめて情報は失わない)。
function protoPartToLegacy(p) {
  if (!p) return { kind: "text", text: "" };
  if (typeof p.text === "string") return { kind: "text", text: p.text };
  if (p.data !== undefined) return { kind: "data", data: p.data };
  if (p.url) return { kind: "data", data: { url: p.url, filename: p.filename, mediaType: p.mediaType } };
  if (p.raw) return { kind: "data", data: { filename: p.filename, mediaType: p.mediaType, note: "binary (raw) content omitted" } };
  return { kind: "text", text: "" };
}
function protoMessageToLegacy(m) {
  if (!m) return null;
  return {
    role: protoRoleToLegacy(m.role),
    parts: (m.parts || []).map(protoPartToLegacy),
    messageId: m.messageId,
    contextId: m.contextId,
    taskId: m.taskId
  };
}
function protoTaskToLegacy(t) {
  if (!t) return null;
  return {
    id: t.id,
    contextId: t.contextId,
    status: {
      state: protoTaskStateToLegacy(t.status?.state),
      message: protoMessageToLegacy(t.status?.message)
    },
    artifacts: (t.artifacts || []).map(a => ({ role: "agent", parts: (a.parts || []).map(protoPartToLegacy) })),
    history: (t.history || []).map(protoMessageToLegacy)
  };
}
function protoResultToLegacy(protoResult) {
  if (!protoResult) return protoResult;
  if (protoResult.task)    return { kind: "task", ...protoTaskToLegacy(protoResult.task) };
  if (protoResult.message) return protoMessageToLegacy(protoResult.message);
  return protoResult;
}

// A2A 0.3+ で result の形が増えたため、複数候補を見て messages を集める
function collectMessages(result) {
  if (!result) return [];
  // Direct messages array (legacy)
  if (Array.isArray(result.messages)) return result.messages;
  if (result.message)                  return [result.message];
  // result 自体が Message のケース ({ kind:"message", role, parts, ... })。
  // message/send が task ではなく Message を直接返すサーバ (io.a2a 等) 対応。
  if (result.kind === "message" || Array.isArray(result.parts)) return [result];
  // Task形式: { kind:"task", status:{ message, state }, artifacts, history }
  // 最新の応答は status.message に入るので最優先
  if (result.kind === "task") {
    const out = [];
    if (result.status?.message) out.push(result.status.message);
    if (Array.isArray(result.artifacts)) {
      for (const a of result.artifacts) {
        if (a?.parts?.length) out.push({ role: "agent", parts: a.parts });
      }
    }
    if (out.length) return out;
  }
  // Artifact 形式
  if (result.artifact?.parts) return [{ role: "agent", parts: result.artifact.parts }];
  if (Array.isArray(result.artifacts)) {
    return result.artifacts.map(a => ({ role: "agent", parts: a.parts || [] }));
  }
  // text-only fallback
  if (typeof result.text === "string") return [{ role: "agent", parts: [{ kind: "text", text: result.text }] }];
  return [];
}

function collectText(msg) {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  const parts = msg.parts || [];
  return parts
    .map(p => {
      if (p.kind === "text" && typeof p.text === "string") return p.text;
      // data part (raw JSON) は表示しない
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
