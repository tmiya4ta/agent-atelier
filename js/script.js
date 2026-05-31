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
//   clear                                         全 window のチャットをクリア
//   clear <window>                                指定 window のチャットをクリア
//   $> <応答>                                     mock 応答。 直前の `> <window>` (無ければ直前の `< <window>:`)
//                                                 に紐づく。 mock モード ON 時のみ使用。 改行は \n で表現。
//                                                 mock OFF 時はコメント同様 no-op (ハイライトも dim)。
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
const CLEAR_RE    = /^clear(?:\s+(.+))?$/i;
// `$> <応答テキスト>` — mock モード時の擬似応答。 改行は \n で表現。
// window 名は書かず、 台本上の直前の `> <window>` (無ければ直前の `< <window>:`) に紐づく。
// 同じ window への複数の $> は送信順に消費される。
const MOCK_RE     = /^\$>\s?([\s\S]*)$/;

export function parseScript(text) {
  const ops = [];
  const lines = text.split(/\r?\n/);
  // `$>` mock 行が紐づく直近 window 名 (`> win` 優先、 無ければ `< win:`)。
  let lastWin = null;
  lines.forEach((raw, i) => {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#")) return;
    let m;
    // `$> ...` は mock 応答定義。 実行 op としては no-op (mock 辞書は parseMocks で別途構築)。
    // window 名を持たないので、 直前に出てきた window に紐づける。
    if ((m = ln.match(MOCK_RE)))  { ops.push({ kind: "mock", win: lastWin, line: i + 1 }); return; }
    if ((m = ln.match(OPERATOR_RE))) {
      const win = m[1].trim().replace(/^["']|["']$/g, "");
      lastWin = win;
      ops.push({ kind: "operator", win, hint: m[2].trim(), outVar: m[3], line: i + 1 });
      return;
    }
    if ((m = ln.match(SEND_RE)))  {
      const win = m[1].trim().replace(/^["']|["']$/g, "");
      lastWin = win;
      ops.push({ kind: "send", win, text: m[2].trim(), line: i + 1 });
      return;
    }
    if ((m = ln.match(WAIT_RE)))  {
      const win = m[1].trim().replace(/^["']|["']$/g, "");
      lastWin = win;
      ops.push({ kind: "wait", win, timeout: parseFloat(m[2] || "60"), outVar: m[3] || null, line: i + 1 });
      return;
    }
    if ((m = ln.match(SLEEP_RE))) { ops.push({ kind: "sleep", duration: parseFloat(m[1]), line: i + 1 }); return; }
    if ((m = ln.match(CLEAR_RE))) { ops.push({ kind: "clear", win: m[1] ? m[1].trim().replace(/^["']|["']$/g, "") : null, line: i + 1 }); return; }
    ops.push({ kind: "error", raw, line: i + 1 });
  });
  return ops;
}

// 台本から mock 辞書を組み立てる: { "<window名>": ["応答1", "応答2", ...] }。
// `$> text` は台本上の直前の window (`> win` 優先、 無ければ `< win:`) に紐づけ、
// その window への n 回目の send が n 番目の応答を取る。 \n リテラルは実改行に展開。
export function parseMocks(text) {
  const dict = {};
  let lastWin = null;
  String(text || "").split(/\r?\n/).forEach(raw => {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#")) return;
    let m;
    // window を持つ directive は lastWin を更新 (mock の紐づけ先になる)
    if ((m = ln.match(OPERATOR_RE)) || (m = ln.match(SEND_RE)) || (m = ln.match(WAIT_RE))) {
      lastWin = m[1].trim().replace(/^["']|["']$/g, "");
      return;
    }
    if ((m = ln.match(MOCK_RE))) {
      if (!lastWin) return;   // 紐づく window が未確定の $> は捨てる (先頭の孤立 $> など)
      const reply = m[1].replace(/\\n/g, "\n");
      (dict[lastWin] = dict[lastWin] || []).push(reply);
    }
  });
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
    const t0 = performance.now();
    for (const op of ops) {
      if (this.cancelled) break;
      try {
        await this._exec(op);
      } catch (e) {
        this.onLog({ level: "err", text: `line ${op.line}: ${e.message}` });
        if (this.cancelled) break;
      }
    }
    this.onLog({ level: "info", text: `done in ${Math.round(performance.now() - t0)}ms` });
  }

  async _exec(op) {
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
      win.sendProgrammatic(msg).catch(e => {
        this.onLog({ level: "err", text: `send failed: ${e.message}` });
      });
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
