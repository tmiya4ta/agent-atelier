// Atelier · script DSL runner
//
// Syntax (each line is one directive):
//   < <window>: <message>                         send message to window (chevron 入: agent への入力)
//                                                 message 内の ${var} は実行直前に vars から展開
//   > <window>                                    wait for next agent reply (chevron 出: agent からの返信)
//   > <window> 30s                                wait with timeout
//   > <window> 30s as <var>                       wait + 受信本文を vars.<var> に保存
//   ^ <operator>: <hint> -> <var>                 operator-agent に hint + 直近の captured vars を送り、
//                                                 reply を vars.<var> に保存 (デモ自動化の繋ぎ役)
//   sleep 2s                                      pause execution
//   delay 2s                                      mock 応答の「考える時間」ベースを指定 (mock モード時)。
//                                                 以降の send に適用 (上に書けば全体に効く)。 0s で即答。
//   clear                                         全 window のチャットをクリア
//   clear <window>                                指定 window のチャットをクリア
//   $> <window>: <応答>                          mock 応答 (`<` と対称)。 その window への n 回目の send が
//                                                 n 番目の応答を取る。 mock モード ON 時のみ使用。 改行は \n。
//                                                 mock OFF 時は非表示 (実行されない)。
//                                                 ★同じ window 宛の $> を連続して並べると、 1 回の応答の中で
//                                                 「ステップを 1 つずつ順番に表示」する (1 ステップ = 1 行で書ける)。
//                                                 間に < / > / sleep などが入ると次の応答 (次の send 用) に分かれる。
//                                                 例:
//                                                   $> Broker: まず受付します
//                                                   $> Broker: 次に査定します
//                                                   $> Broker: 完了しました   ← この 3 行で 1 応答 (3 ステップ順次表示)
//   # ...                                         comment (ignored)
//
//  <window> はウインドウ名 (大文字小文字区別なし、部分一致OK) または ID (例 aw-1)

// ─── line patterns ─────────────────────────────
const SEND_RE     = /^<\s*(.+?)\s*:\s*(.+)$/;
// `> Agent` / `> Agent 30s` / `> Agent 30s as varname`
const WAIT_RE     = /^>\s*(.+?)(?:\s+(\d+(?:\.\d+)?)\s*s?)?(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?$/;
// `^ Operator: hint here -> varname` (操作: → でも -> でも可)
const OPERATOR_RE = /^\^\s*(.+?)\s*:\s*(.+?)\s*(?:->|→)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*$/;
const SLEEP_RE    = /^sleep\s+(\d+(?:\.\d+)?)\s*s?$/i;
// `delay 2s` — mock 応答の思考ベース時間 (秒) を指定。 mock モード時のみ意味を持つ。
const DELAY_RE    = /^delay\s+(\d+(?:\.\d+)?)\s*s?$/i;
const CLEAR_RE    = /^clear(?:\s+(.+))?$/i;
// `$> <window>: <応答テキスト>` — mock モード時の擬似応答 (`<` と対称)。 改行は \n で表現。
// window 名を明示し、 その window への n 回目の send が n 番目の $> を取る (送信順に消費)。
const MOCK_RE     = /^\$>\s*(.+?)\s*:\s*([\s\S]*)$/;

export function parseScript(text) {
  const ops = [];
  const lines = text.split(/\r?\n/);
  const clean = w => w.trim().replace(/^["']|["']$/g, "");
  lines.forEach((raw, i) => {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#")) return;
    let m;
    // `$> win: ...` は mock 応答定義。 実行 op としては no-op (mock 辞書は parseMocks で別途構築)。
    if ((m = ln.match(MOCK_RE)))  { ops.push({ kind: "mock", win: clean(m[1]), line: i + 1 }); return; }
    if ((m = ln.match(OPERATOR_RE))) {
      ops.push({ kind: "operator", win: clean(m[1]), hint: m[2].trim(), outVar: m[3], line: i + 1 });
      return;
    }
    if ((m = ln.match(SEND_RE)))  {
      ops.push({ kind: "send", win: clean(m[1]), text: m[2].trim(), line: i + 1 });
      return;
    }
    if ((m = ln.match(WAIT_RE)))  {
      ops.push({ kind: "wait", win: clean(m[1]), timeout: parseFloat(m[2] || "60"), outVar: m[3] || null, line: i + 1 });
      return;
    }
    if ((m = ln.match(SLEEP_RE))) { ops.push({ kind: "sleep", duration: parseFloat(m[1]), line: i + 1 }); return; }
    if ((m = ln.match(DELAY_RE))) { ops.push({ kind: "delay", duration: parseFloat(m[1]), line: i + 1 }); return; }
    if ((m = ln.match(CLEAR_RE))) { ops.push({ kind: "clear", win: m[1] ? clean(m[1]) : null, line: i + 1 }); return; }
    ops.push({ kind: "error", raw, line: i + 1 });
  });
  return ops;
}

// 台本から mock 辞書を組み立てる: { "<window名>": ["応答1", "応答2", ...] }。
// `$> win: text` の win から直接引き、 その window への n 回目の send が n 番目の応答を取る。
// \n リテラルは実改行に展開。
//
// ★連続グルーピング: 同じ window 宛の `$>` を「途中に他の行を挟まず」連続して並べると、
//   それらを 1 つの応答 (要素) にまとめ、各ステップを "[[STEP]]" で連結する。
//   adapter (base.js) 側が [[STEP]] を分割して 1 つずつ順番に表示する。
//   - コメント / 空行は区切りにしない (グループ継続)
//   - 別 window の `$>`、 または `<` `>` `sleep` `clear` などの非 $> 行が来たらグループを閉じる
//   これで「1 ステップ = 1 行」で書け、 続けて並べるだけで順次表示になる。
export function parseMocks(text) {
  const dict = {};
  // window ごとに「いま積み上げ中のステップ配列」を保持。null = グループ未開始。
  let curWin = null;     // 直前に $> を積んだ window
  let curSteps = null;   // その積み上げ中ステップ (string[])

  const flush = () => {
    if (curWin != null && curSteps && curSteps.length) {
      (dict[curWin] = dict[curWin] || []).push(curSteps.join("[[STEP]]"));
    }
    curWin = null; curSteps = null;
  };

  String(text || "").split(/\r?\n/).forEach(raw => {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#")) return;   // 空行/コメントはグループを切らない
    const m = ln.match(MOCK_RE);
    if (m) {
      const win = m[1].trim().replace(/^["']|["']$/g, "");
      const step = m[2].replace(/\\n/g, "\n");
      if (curWin !== null && curWin !== win) flush();   // 別 window に切替 → 確定
      curWin = win;
      (curSteps = curSteps || []).push(step);
    } else {
      // $> 以外の実行行 (< / > / sleep / clear 等) が来たらグループを閉じる
      flush();
    }
  });
  flush();
  return dict;
}

// ${var} 展開。 vars に無い key はそのまま残す (デモ中に視認できるように)。
function expandVars(text, vars) {
  return String(text || "").replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => {
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] ?? "") : m;
  });
}

/** ScriptRunner — async iterable of log events */
export class ScriptRunner {
  constructor({ findWindow, getAllWindows, onLog }) {
    this.findWindow    = findWindow;
    this.getAllWindows = getAllWindows || (() => []);
    this.onLog = onLog || (() => {});
    this.cancelled = false;
    this._cancelReject = null;
  }

  stop() {
    this.cancelled = true;
    if (this._cancelReject) this._cancelReject(new Error("stopped by user"));
  }

  // Promise.race 用: 即座に reject されるキャンセル Promise
  _cancelPromise() {
    return new Promise((_, reject) => { this._cancelReject = reject; });
  }

  async run(ops) {
    this.cancelled = false;
    this.vars = {};        // ${var} 展開 + capture (`as var`) で使う script-scoped 変数テーブル
    this._pending = [];    // 投げっぱなしにした send (直後に明示 `>` がある時 / operator) の Promise。 run 末尾の drainSends で待つ
    const t0 = performance.now();
    for (let i = 0; i < ops.length; i++) {
      if (this.cancelled) break;
      const op = ops[i];
      try {
        await this._exec(op, ops[i + 1] || null);
      } catch (e) {
        this.onLog({ level: "err", text: `line ${op.line}: ${e.message}` });
        if (this.cancelled) break;
      }
    }
    // wait (`>`) を伴わない投げっぱなしの send がまだ走っているなら、ここで完了を待つ。
    // mock モードでは run 後に adapter.send が本物へ戻る (mockRestore) ため、待たずに
    // 抜けると send が「戻った後の本物 send」を呼んでしまい、mock 応答が出ない。
    await this.drainSends();
    this.onLog({ level: "info", text: `done in ${Math.round(performance.now() - t0)}ms` });
  }

  // fire-and-forget で投げた send (`<` / `^`) の完了をまとめて待つ。
  // 個々の reject は send 側でログ済みなので、ここでは握り潰して全件待ち切る。
  async drainSends() {
    const pending = this._pending || [];
    this._pending = [];
    // 停止された場合は待たない (mock の思考ディレイで最大数十秒固まるのを避ける)。
    if (!pending.length || this.cancelled) return;
    await Promise.allSettled(pending);
  }

  async _exec(op, nextOp = null) {
    if (op.kind === "error") {
      this.onLog({ level: "err", text: `unknown directive: ${op.raw}` });
      return;
    }
    if (op.kind === "sleep") {
      this.onLog({ level: "dim", text: `· sleep ${op.duration}s` });
      await Promise.race([
        new Promise(r => setTimeout(r, op.duration * 1000)),
        this._cancelPromise()
      ]);
      return;
    }
    if (op.kind === "delay") {
      // mock 応答の「考える時間」ベースを ms で全 mock window に伝播 (以降の send に効く)。
      // mock 中でなければ no-op だが、 値は保持しておく (後で mock が乗れば効く)。
      this._mockDelayMs = Math.max(0, op.duration * 1000);
      for (const w of this.getAllWindows()) {
        if (w.adapter && w.adapter._mockActive) w.adapter._mockDelayMs = this._mockDelayMs;
      }
      this.onLog({ level: "dim", text: `· mock delay = ${op.duration}s` });
      return;
    }
    if (op.kind === "clear") {
      if (op.win) {
        const w = this.findWindow(op.win);
        if (!w) { this.onLog({ level: "err", text: `no window matching "${op.win}"` }); return; }
        w.clearChat();
        this.onLog({ level: "dim", text: `· cleared ${w.name}` });
      } else {
        const all = this.getAllWindows();
        all.forEach(w => w.clearChat());
        this.onLog({ level: "dim", text: `· cleared ${all.length} window(s)` });
      }
      return;
    }
    const win = this.findWindow(op.win);
    if (!win) {
      this.onLog({ level: "err", text: `no window matching "${op.win}"` });
      return;
    }
    if (op.kind === "send") {
      const msg = expandVars(op.text, this.vars);
      this.onLog({ level: "send", text: `→ ${win.name}: ${msg}` });
      const sendP = win.sendProgrammatic(msg).catch(e => {
        this.onLog({ level: "err", text: `send failed: ${e.message}` });
      });
      // 直後に同じ window 宛の明示 `>` (wait) があれば、 待ちはそちらに任せて投げっぱなし。
      // それ以外は「送信 → 返信到着まで待つ」逐次実行 (上から 1 つずつ・ 返信の連発を防ぐ)。
      const nextIsWaitSameWin = nextOp && nextOp.kind === "wait"
        && this.findWindow(nextOp.win) === win;
      if (nextIsWaitSameWin) {
        // wait op が後で drain するので、 取りこぼし防止に _pending へ積むだけ。
        this._pending.push(sendP);
        return;
      }
      // 逐次: この send の返信 (typewriter 完了) まで待ってから次行へ。
      // 既定 timeout は wait と同じ 60s。 停止時は即抜ける。
      try {
        await Promise.race([
          win.waitForReply({ timeout: 60000 }),
          this._cancelPromise()
        ]);
      } catch (e) {
        // 返信が来なくても (timeout 等) スクリプトは止めず次行へ進む。
        if (!this.cancelled) this.onLog({ level: "dim", text: `· ${win.name}: ${e.message}` });
      }
      return;
    }
    if (op.kind === "wait") {
      this.onLog({ level: "dim", text: `… waiting ${win.name} (${op.timeout}s)${op.outVar ? ` → \${${op.outVar}}` : ""}` });
      try {
        const reply = await Promise.race([
          win.waitForReply({ timeout: op.timeout * 1000 }),
          this._cancelPromise()
        ]);
        const txt  = reply.text || "";
        const snip = txt.replace(/\s+/g, " ").slice(0, 140);
        this.onLog({ level: "recv", text: `← ${win.name}: ${snip}` });
        if (op.outVar) {
          this.vars[op.outVar] = txt;
          this.onLog({ level: "dim", text: `· captured \${${op.outVar}} (${txt.length} chars)` });
        }
      } catch (e) {
        this.onLog({ level: "err", text: `${win.name}: ${e.message}` });
      }
      return;
    }
    if (op.kind === "operator") {
      // operator-agent (atelier-operator-agent) の window を 1 つ確保し、 hint + captured vars を投げる
      // → reply を vars.<outVar> に保存。 次の `< Agent: ${outVar}` で展開される。
      if (!op.outVar) { this.onLog({ level: "err", text: `operator directive needs '-> varname'` }); return; }
      const hintExpanded = expandVars(op.hint, this.vars);
      const capturedLines = Object.keys(this.vars).map(k => `captured.${k}: ${this.vars[k]}`).join("\n");
      const userBlock = [
        `hint: ${hintExpanded}`,
        capturedLines
      ].filter(Boolean).join("\n");
      this.onLog({ level: "send", text: `^ ${win.name} ← hint: ${hintExpanded.slice(0, 120)}` });
      win.sendProgrammatic(userBlock).catch(e => {
        this.onLog({ level: "err", text: `operator send failed: ${e.message}` });
      });
      try {
        const reply = await Promise.race([
          win.waitForReply({ timeout: 120000 }),
          this._cancelPromise()
        ]);
        const txt = (reply.text || "").trim();
        this.vars[op.outVar] = txt;
        const snip = txt.replace(/\s+/g, " ").slice(0, 140);
        this.onLog({ level: "recv", text: `← ${win.name} → \${${op.outVar}}: ${snip}` });
        if (txt.startsWith("INSUFFICIENT_CONTEXT")) {
          this.onLog({ level: "err", text: `operator returned INSUFFICIENT_CONTEXT — subsequent \${${op.outVar}} expansion may fail` });
        }
      } catch (e) {
        this.onLog({ level: "err", text: `${win.name}: ${e.message}` });
      }
      return;
    }
  }
}
