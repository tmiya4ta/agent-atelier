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

export class A2AAdapter extends ProtocolAdapter {
  static get id()    { return "a2a"; }
  static get label() { return "A2A"; }

  constructor(config) {
    super(config);
    this.endpoint = normalizeUrl(config.url);
    this.rpcUrl   = null;
    this.turn = 0;
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
      this.rpcUrl    = cached.card.url || trimSlash(this.endpoint);
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
      return;
    }

    await this._fetchCard({ emitOpen: true });
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
    this.rpcUrl    = card.url || trimSlash(this.endpoint);
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

  async send(text, opts = {}) {
    if (this.state !== "open") throw new Error("not connected");
    await this._ensureFreshAuth();   // 期限切れトークンをここで更新
    this.turn += 1;
    const reqId = `req-${this.turn}`;

    const useStream = !!(opts.stream && this.agentCard?.capabilities?.streaming);
    const method = useStream ? "message/stream" : "message/send";

    const message = {
      kind: "message",                        // A2A 0.3+ で discriminator として必須
      role: "user",
      parts: [{ kind: "text", text }],
      messageId: uuid()
    };
    // 既存セッションがあるときだけ contextId を付ける。
    // 初回 (this.contextId === null) は server に採番させる。
    if (this.contextId) message.contextId = this.contextId;
    // 追加入力待ち (input-required) の task が残っていれば、 同じ task を継続する。
    // これが無いと毎ターン新規 task になり、 直前の問いかけの文脈が引き継がれない。
    if (this.taskId) message.taskId = this.taskId;

    const body = {
      jsonrpc: "2.0",
      id: reqId,
      method,
      params: { message, configuration: {} }
    };

    const headers = {
      "Content-Type": "application/json",
      // message/stream のときは SSE を受ける。 そうでなければ JSON。
      Accept: useStream ? "text/event-stream" : "application/json"
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
      const res = await fetch(proxify(this.rpcUrl), { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // ── streaming (SSE) 経路 ───────────────────────────────
      // server が text/event-stream を返したら 1 イベントずつ読み、
      // status-update / artifact-update を逐次 message として emit する。
      const ctype = res.headers.get("content-type") || "";
      if (useStream && ctype.includes("text/event-stream")) {
        await this._consumeSse(res, method, ac, headersToObj(res.headers));
        return;
      }

      const data = await res.json();

      this._emit("rpc", {
        dir: "in", method: `200 OK · ${method}`,
        headers: headersToObj(res.headers), payload: data, raw: JSON.stringify(data, null, 2)
      });

      if (data.error) throw new Error(`RPC error: ${data.error.message || data.error.code}`);

      // server が採番した contextId を保持 (A2A 0.3 で task.contextId / message.contextId の
      // どちらにも乗ってくる可能性があるので両方見る)
      const result = data.result || {};
      const ctx = result.contextId
        || result.task?.contextId
        || result.message?.contextId
        || result.status?.contextId;
      if (ctx && !this.contextId) this.contextId = ctx;
      // input-required の task なら taskId を継続保持する
      this._trackTask(result);

      // A2A 0.3 互換: 応答が様々な形を取りうるため、テキストパートを掘り出す
      const messages = collectMessages(result);
      // LLM-like "thinking" delay: simulate think time before surfacing the reply
      // (scriptRunner の `< Agent` wait もこの emit を待つので、順序が保たれる)
      // 停止ボタンで中断できるよう、 signal abort で reject する race にする。
      const delayMs = 1500 + Math.random() * 2000;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        ac.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      for (const m of messages) {
        const txt = collectText(m);
        if (txt) this._emit("message", { role: m.role || "agent", text: txt, final: true });
      }
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
      if (p.kind === "data" && p.data != null) {
        // データパートを文字列化 (JSON 出力エージェント対策)
        try { return "```json\n" + JSON.stringify(p.data, null, 2) + "\n```"; }
        catch { return ""; }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
