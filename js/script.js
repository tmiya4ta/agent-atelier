// Atelier · script DSL runner
//
// Syntax (each line is one directive):
//   < <window>: <message>       send message to window  (chevron 入: agent への入力)
//   > <window>                  wait for next agent reply (chevron 出: agent からの返信)
//   > <window> 30s              wait with timeout
//   sleep 2s                    pause execution
//   clear                       全 window のチャットをクリア
//   clear <window>              指定 window のチャットをクリア
//   # ...                       comment (ignored)
//
//  <window> はウインドウ名 (大文字小文字区別なし、部分一致OK) または ID (例 aw-1)

const SEND_RE  = /^<\s*(.+?)\s*:\s*(.+)$/;
const WAIT_RE  = /^>\s*(.+?)(?:\s+(\d+(?:\.\d+)?)\s*s?)?$/;
const SLEEP_RE = /^sleep\s+(\d+(?:\.\d+)?)\s*s?$/i;
const CLEAR_RE = /^clear(?:\s+(.+))?$/i;

export function parseScript(text) {
  const ops = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#")) return;
    let m;
    if ((m = ln.match(SEND_RE)))  { ops.push({ kind: "send",  win: m[1].trim().replace(/^["']|["']$/g, ""), text: m[2].trim(), line: i + 1 }); return; }
    if ((m = ln.match(WAIT_RE)))  { ops.push({ kind: "wait",  win: m[1].trim().replace(/^["']|["']$/g, ""), timeout: parseFloat(m[2] || "60"), line: i + 1 }); return; }
    if ((m = ln.match(SLEEP_RE))) { ops.push({ kind: "sleep", duration: parseFloat(m[1]), line: i + 1 }); return; }
    if ((m = ln.match(CLEAR_RE))) { ops.push({ kind: "clear", win: m[1] ? m[1].trim().replace(/^["']|["']$/g, "") : null, line: i + 1 }); return; }
    ops.push({ kind: "error", raw, line: i + 1 });
  });
  return ops;
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
      this.onLog({ level: "send", text: `→ ${win.name}: ${op.text}` });
      win.sendProgrammatic(op.text).catch(e => {
        this.onLog({ level: "err", text: `send failed: ${e.message}` });
      });
      return;
    }
    if (op.kind === "wait") {
      this.onLog({ level: "dim", text: `… waiting ${win.name} (${op.timeout}s)` });
      try {
        const reply = await Promise.race([
          win.waitForReply({ timeout: op.timeout * 1000 }),
          this._cancelPromise()
        ]);
        const snip = (reply.text || "").replace(/\s+/g, " ").slice(0, 140);
        this.onLog({ level: "recv", text: `← ${win.name}: ${snip}` });
      } catch (e) {
        this.onLog({ level: "err", text: `${win.name}: ${e.message}` });
      }
    }
  }
}
