// Atelier-style confirm/alert modal
// Usage:
//   await modalConfirm({ title, message, danger?, confirmLabel?, cancelLabel? }) → true/false
//   await modalAlert  ({ title, message, confirmLabel? })                       → true

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

let _stackKeyHandler = null;

function buildModal({ kind, title, message, confirmLabel, cancelLabel, danger }) {
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-head">
        <span class="modal-eyebrow">${kind === "alert" ? "notice" : (danger ? "confirm · destructive" : "confirm")}</span>
        <h3 class="modal-title">${escapeHtml(title)}</h3>
      </header>
      ${message ? `<div class="modal-body"><p class="modal-msg">${escapeHtml(message)}</p></div>` : ""}
      <footer class="modal-foot">
        <div class="modal-foot-actions">
          ${kind === "alert" ? "" : `<button type="button" class="ghost-btn modal-cancel">${escapeHtml(cancelLabel)}</button>`}
          <button type="button" class="primary-btn modal-confirm${danger ? " is-danger" : ""}">
            <span>${escapeHtml(confirmLabel)}</span>
            <span class="arrow">→</span>
          </button>
        </div>
      </footer>
    </div>
  `;
  return wrap;
}

function _show({ kind, title, message, confirmLabel, cancelLabel, danger }) {
  return new Promise((resolve) => {
    const wrap = buildModal({
      kind,
      title:        title        || (kind === "alert" ? "Notice" : "Confirm"),
      message:      message      || "",
      confirmLabel: confirmLabel || (kind === "alert" ? "OK"     : "Confirm"),
      cancelLabel:  cancelLabel  || "Cancel",
      danger:       !!danger
    });
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));

    const close = (result) => {
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 220);
      if (_stackKeyHandler === onKey) {
        document.removeEventListener("keydown", onKey, true);
        _stackKeyHandler = null;
      }
      resolve(result);
    };

    wrap.querySelector(".modal-confirm").addEventListener("click", () => close(true));
    const cancel = wrap.querySelector(".modal-cancel");
    if (cancel) cancel.addEventListener("click", () => close(false));
    // backdrop click は無効 (誤操作防止)

    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(true); }
    };
    document.addEventListener("keydown", onKey, true);
    _stackKeyHandler = onKey;

    setTimeout(() => wrap.querySelector(".modal-confirm").focus(), 50);
  });
}

export function modalConfirm(opts) {
  return _show({ kind: "confirm", ...opts });
}
export function modalAlert(opts) {
  return _show({ kind: "alert", ...opts });
}

// modalChoice — 複数選択モーダル
//   await modalChoice({ title, message?, choices: [{ id, label, description?, danger? }],
//                       extras?: [{ id, label, description?, defaultChecked? }] })
//     → 戻り値:
//        - extras 指定なし: 選択した choice.id (Cancel/Esc は null) ← 後方互換
//        - extras 指定あり: { id, extras: { <extraId>: boolean, ... } } (Cancel/Esc は null)
export function modalChoice({ title, message, choices = [], extras, cancelLabel } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    const buttons = choices.map((c, i) => `
      <button type="button" class="primary-btn modal-choice${c.danger ? " is-danger" : ""}" data-choice-id="${escapeHtml(c.id)}" data-choice-idx="${i}">
        <span class="modal-choice-main">
          <span class="modal-choice-label">${escapeHtml(c.label)}</span>
          ${c.description ? `<span class="modal-choice-desc">${escapeHtml(c.description)}</span>` : ""}
        </span>
        <span class="arrow">→</span>
      </button>
    `).join("");
    const extrasHtml = Array.isArray(extras) && extras.length ? `
      <div class="modal-extras">
        ${extras.map(x => `
          <label class="modal-extra" data-extra-id="${escapeHtml(x.id)}">
            <input type="checkbox" ${x.defaultChecked ? "checked" : ""} />
            <span class="modal-extra-main">
              <span class="modal-extra-label">${escapeHtml(x.label)}</span>
              ${x.description ? `<span class="modal-extra-desc">${escapeHtml(x.description)}</span>` : ""}
            </span>
          </label>
        `).join("")}
      </div>
    ` : "";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <span class="modal-eyebrow">choose</span>
          <h3 class="modal-title">${escapeHtml(title || "Choose an option")}</h3>
        </header>
        ${message ? `<div class="modal-body"><p class="modal-msg">${escapeHtml(message)}</p></div>` : ""}
        <footer class="modal-foot modal-foot-stack">
          ${extrasHtml}
          <div class="modal-choices">${buttons}</div>
          <div class="modal-foot-actions">
            <button type="button" class="ghost-btn modal-cancel">${escapeHtml(cancelLabel || "Cancel")}</button>
          </div>
        </footer>
      </div>
    `;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));

    const readExtras = () => {
      const out = {};
      wrap.querySelectorAll(".modal-extra").forEach(lab => {
        const id = lab.dataset.extraId;
        const cb = lab.querySelector("input[type=checkbox]");
        if (id && cb) out[id] = !!cb.checked;
      });
      return out;
    };
    const wantExtras = Array.isArray(extras) && extras.length > 0;

    const close = (result) => {
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 220);
      if (_stackKeyHandler === onKey) {
        document.removeEventListener("keydown", onKey, true);
        _stackKeyHandler = null;
      }
      resolve(result);
    };
    wrap.querySelectorAll(".modal-choice").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.choiceId;
        close(wantExtras ? { id, extras: readExtras() } : id);
      });
    });
    wrap.querySelector(".modal-cancel").addEventListener("click", () => close(null));
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    document.addEventListener("keydown", onKey, true);
    _stackKeyHandler = onKey;

    setTimeout(() => wrap.querySelector(".modal-choice")?.focus(), 50);
  });
}

// modalPrompt — 1 行入力モーダル
//   await modalPrompt({ title, label?, placeholder?, defaultValue?, confirmLabel? })
//     → 入力文字列 (Cancel/Esc は null)
export function modalPrompt({ title, label, placeholder, defaultValue, confirmLabel, cancelLabel } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <span class="modal-eyebrow">input</span>
          <h3 class="modal-title">${escapeHtml(title || "Enter value")}</h3>
        </header>
        <div class="modal-body">
          ${label ? `<label class="modal-label">${escapeHtml(label)}</label>` : ""}
          <input class="modal-input" type="text" autocomplete="off"
                 placeholder="${escapeHtml(placeholder || "")}"
                 value="${escapeHtml(defaultValue || "")}" />
        </div>
        <footer class="modal-foot">
          <div class="modal-foot-actions">
            <button type="button" class="ghost-btn modal-cancel">${escapeHtml(cancelLabel || "Cancel")}</button>
            <button type="button" class="primary-btn modal-confirm">
              <span>${escapeHtml(confirmLabel || "OK")}</span>
              <span class="arrow">→</span>
            </button>
          </div>
        </footer>
      </div>
    `;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));

    const input = wrap.querySelector(".modal-input");
    const close = (result) => {
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 220);
      if (_stackKeyHandler === onKey) {
        document.removeEventListener("keydown", onKey, true);
        _stackKeyHandler = null;
      }
      resolve(result);
    };
    wrap.querySelector(".modal-confirm").addEventListener("click", () => close(input.value.trim() || null));
    wrap.querySelector(".modal-cancel").addEventListener("click", () => close(null));
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === "Enter" && document.activeElement === input) {
        e.preventDefault(); e.stopPropagation();
        close(input.value.trim() || null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    _stackKeyHandler = onKey;

    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

// modalExport — Export ダイアログ。 ファイル名 + 「Secret を含める」チェック +
// チェック時にスライド表示される passphrase 欄。
//   返り値: { name, includeSecrets, passphrase } または null (cancel)。
export function modalExport({ title, defaultValue } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop modal-top";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <span class="modal-eyebrow">input</span>
          <h3 class="modal-title">${escapeHtml(title || "Name this export")}</h3>
        </header>
        <div class="modal-body">
          <label class="modal-label">file name (.json appended automatically)</label>
          <input class="modal-input" id="expName" type="text" autocomplete="off" value="${escapeHtml(defaultValue || "")}" />
          <label class="modal-check">
            <input type="checkbox" id="expSecrets" />
            <span class="modal-check-main">
              <span class="modal-check-label">Include secrets (client_secret / tokens)</span>
              <span class="modal-check-desc">Full backup. The file will be encrypted with a passphrase.</span>
            </span>
          </label>
          <div class="modal-passwrap" id="expPassWrap">
            <label class="modal-label">passphrase (encrypts the file)</label>
            <input class="modal-input" id="expPass" type="password" autocomplete="new-password" placeholder="encryption passphrase" />
            <span class="modal-hint">This passphrase encrypts the file. Required to import it. If lost, the file cannot be decrypted.</span>
          </div>
        </div>
        <footer class="modal-foot">
          <div class="modal-foot-actions">
            <button type="button" class="ghost-btn modal-cancel">Cancel</button>
            <button type="button" class="primary-btn modal-confirm"><span>Export</span><span class="arrow">→</span></button>
          </div>
        </footer>
      </div>
    `;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));
    const q = (s) => wrap.querySelector(s);
    const nameEl = q("#expName"), cb = q("#expSecrets"), passWrap = q("#expPassWrap"), passEl = q("#expPass");
    cb.addEventListener("change", () => {
      passWrap.classList.toggle("is-open", cb.checked);
      if (cb.checked) setTimeout(() => passEl.focus(), 180);
    });
    const close = (result) => {
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 220);
      if (_stackKeyHandler === onKey) { document.removeEventListener("keydown", onKey, true); _stackKeyHandler = null; }
      resolve(result);
    };
    const submit = () => {
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      if (cb.checked && !passEl.value) { passEl.focus(); return; }
      close({ name, includeSecrets: cb.checked, passphrase: passEl.value });
    };
    q(".modal-confirm").addEventListener("click", submit);
    q(".modal-cancel").addEventListener("click", () => close(null));
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    document.addEventListener("keydown", onKey, true);
    _stackKeyHandler = onKey;
    setTimeout(() => { nameEl.focus(); nameEl.select(); }, 50);
  });
}

// modalImportScope — Import の scope 選択。 暗号化ファイル時は同じダイアログに
// passphrase 欄を同居させ、 ダイアログを 1 枚に減らす。
//   返り値: { scope: "all"|"scripts", passphrase } または null (cancel)。
export function modalImportScope({ encrypted } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop modal-top";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <span class="modal-eyebrow">choose</span>
          <h3 class="modal-title">What to import?</h3>
        </header>
        <div class="modal-body">
          <label class="modal-check">
            <input type="checkbox" id="impScripts" />
            <span class="modal-check-main">
              <span class="modal-check-label">Scenarios only</span>
              <span class="modal-check-desc">Merge scenarios only — keep current connections, no reload.</span>
            </span>
          </label>
          ${encrypted ? `
          <div class="modal-passwrap is-open">
            <label class="modal-label">passphrase (encrypted file)</label>
            <input class="modal-input" id="impPass" type="password" autocomplete="off" placeholder="decryption passphrase" />
            <span class="modal-hint">This file is encrypted. Enter the passphrase used when it was exported.</span>
          </div>` : ``}
        </div>
        <footer class="modal-foot">
          <div class="modal-foot-actions">
            <button type="button" class="ghost-btn modal-cancel">Cancel</button>
            <button type="button" class="primary-btn modal-confirm"><span>Import</span><span class="arrow">→</span></button>
          </div>
        </footer>
      </div>
    `;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));
    const q = (s) => wrap.querySelector(s);
    const passEl = q("#impPass");
    const close = (result) => {
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 220);
      if (_stackKeyHandler === onKey) { document.removeEventListener("keydown", onKey, true); _stackKeyHandler = null; }
      resolve(result);
    };
    const submit = () => {
      const scope = q("#impScripts").checked ? "scripts" : "all";
      const passphrase = encrypted ? (passEl.value || "") : "";
      if (encrypted && !passphrase) { passEl.focus(); return; }
      close({ scope, passphrase });
    };
    q(".modal-confirm").addEventListener("click", submit);
    q(".modal-cancel").addEventListener("click", () => close(null));
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    document.addEventListener("keydown", onKey, true);
    _stackKeyHandler = onKey;
    setTimeout(() => { (encrypted ? passEl : q("#impScripts"))?.focus(); }, 50);
  });
}

// modalBusinessGroup — business group を「1 枚で」選ばせる/入力させるモーダル。
//   await modalBusinessGroup({ title, loadGroups, signIn })
//     loadGroups: async () => [{id,name}]   (throw すると失敗扱い)
//     signIn:     async () => void          (任意。 loadGroups が code:"REAUTH_REQUIRED" を
//                                            投げたら「Sign in」ボタンを出し、 押下でこれを実行→再ロード)
//   挙動: ロード表示 → 成功なら select + 手入力併設 / 0件 or 失敗はテキスト /
//         認証必要なら Sign in ボタン (ユーザー操作で OAuth ポップアップを通す)。
//   返り値: { input, bgId, bgName } または null (cancel)。
export function modalBusinessGroup({ title, loadGroups, signIn, loadEnvs } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <span class="modal-eyebrow">business group</span>
          <h3 class="modal-title">${escapeHtml(title || "Add business group")}</h3>
        </header>
        <div class="modal-body">
          <p class="modal-msg modal-bg-status">Loading business groups…</p>
          <button type="button" class="primary-btn modal-bg-signin" hidden><span class="cat-bg-signin-dot"></span> Sign in to load business groups <span class="arrow">→</span></button>
          <select class="modal-input modal-bg-select" aria-label="business group" hidden></select>
          <label class="modal-label modal-bg-or" hidden>or enter name / ID manually</label>
          <input class="modal-input modal-bg-text" type="text" autocomplete="off"
                 placeholder="e.g. btd  or  0fc4eaf1-5697-4cef-9c1b-3b96e3a52ee2" hidden />
          <label class="modal-check modal-bg-scan">
            <input type="checkbox" class="modal-bg-scan-cb" />
            <span>Scan Runtime Manager apps (also list deployed apps)</span>
          </label>
          <div class="modal-bg-envwrap" hidden>
            <label class="modal-label">environments</label>
            <div class="modal-bg-envlist cat-env-list"></div>
            <p class="modal-bg-envstatus modal-hint"></p>
          </div>
        </div>
        <footer class="modal-foot">
          <div class="modal-foot-actions">
            <button type="button" class="ghost-btn modal-cancel">Cancel</button>
            <button type="button" class="primary-btn modal-confirm"><span>Add</span><span class="arrow">→</span></button>
          </div>
        </footer>
      </div>
    `;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));

    const status   = wrap.querySelector(".modal-bg-status");
    const signinEl = wrap.querySelector(".modal-bg-signin");
    const sel      = wrap.querySelector(".modal-bg-select");
    const orLbl    = wrap.querySelector(".modal-bg-or");
    const text     = wrap.querySelector(".modal-bg-text");
    const scanCb   = wrap.querySelector(".modal-bg-scan-cb");
    const envWrap  = wrap.querySelector(".modal-bg-envwrap");
    const envList  = wrap.querySelector(".modal-bg-envlist");
    const envStat  = wrap.querySelector(".modal-bg-envstatus");

    // 現在選択中の BG の UUID (dropdown 選択時のみ。手入力は未解決なので null)
    const currentBgId = () => (!sel.hidden && sel.value) ? sel.value : null;

    let _envSeq = 0;
    async function refreshEnvs() {
      if (!scanCb || !scanCb.checked) { if (envWrap) envWrap.hidden = true; return; }
      envWrap.hidden = false;
      const bgId = currentBgId();
      if (!bgId) { envList.innerHTML = ""; envStat.textContent = "pick a business group from the list above to choose environments"; return; }
      if (typeof loadEnvs !== "function") { envList.innerHTML = ""; envStat.textContent = ""; return; }
      const seq = ++_envSeq;
      envStat.textContent = "loading environments…"; envList.innerHTML = "";
      try {
        const envs = await loadEnvs(bgId);
        if (seq !== _envSeq) return;   // 古い結果は破棄
        if (!envs?.length) { envStat.textContent = "no environments found"; return; }
        envStat.textContent = "select environments to scan";
        envList.innerHTML = "";
        envs.forEach(e => {
          const row = document.createElement("label");
          row.className = "cat-env-opt";
          row.innerHTML =
            `<input type="checkbox" value="${escapeHtml(e.id)}" data-name="${escapeHtml(e.name)}" />` +
            `<span>${escapeHtml(e.name)}${e.isProduction ? " · prod" : ""}</span>`;
          envList.appendChild(row);
        });
      } catch (e) {
        if (seq !== _envSeq) return;
        envStat.textContent = `couldn't load environments (${e?.message || e})`;
      }
    }
    scanCb?.addEventListener("change", refreshEnvs);
    sel?.addEventListener("change", () => { if (scanCb?.checked) refreshEnvs(); });

    const close = (result) => {
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 220);
      if (_stackKeyHandler === onKey) {
        document.removeEventListener("keydown", onKey, true);
        _stackKeyHandler = null;
      }
      resolve(result);
    };
    const confirm = () => {
      const scanRtm = scanCb?.checked || false;
      const envs = scanRtm
        ? [...envList.querySelectorAll('input[type="checkbox"]:checked')].map(b => ({ id: b.value, name: b.dataset.name || b.value }))
        : [];
      if (!sel.hidden && sel.value) {
        const opt = sel.selectedOptions[0];
        const nm = (opt?.dataset.name || opt?.textContent || sel.value).trim();
        close({ input: nm || sel.value, bgId: sel.value, bgName: opt?.dataset.name || null, scanRtm, envs });
        return;
      }
      const v = text.value.trim();
      if (v) { close({ input: v, bgId: null, bgName: null, scanRtm, envs }); return; }
      text.hidden = false; text.focus();
    };
    wrap.querySelector(".modal-confirm").addEventListener("click", confirm);
    wrap.querySelector(".modal-cancel").addEventListener("click", () => close(null));
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === "Enter" && document.activeElement === text) {
        e.preventDefault(); e.stopPropagation(); confirm();
      }
    };
    document.addEventListener("keydown", onKey, true);
    _stackKeyHandler = onKey;

    const showSignIn = () => {
      status.hidden = true;
      sel.hidden = true; orLbl.hidden = true; text.hidden = true;
      signinEl.hidden = false; signinEl.disabled = false;
      signinEl.querySelector(".arrow")?.removeAttribute("hidden");
    };
    const fallbackToText = (msg, isErr) => {
      signinEl.hidden = true;
      status.hidden = false;
      status.classList.toggle("is-error", !!isErr);
      status.textContent = msg;
      text.hidden = false; text.focus();
    };

    async function runLoad() {
      status.hidden = false; status.classList.remove("is-error");
      status.textContent = "Loading business groups…";
      signinEl.hidden = true; sel.hidden = true; orLbl.hidden = true; text.hidden = true;
      try {
        const groups = (typeof loadGroups === "function") ? await loadGroups() : [];
        if (!wrap.isConnected) return;
        if (Array.isArray(groups) && groups.length) {
          sel.innerHTML = "";
          const head = document.createElement("option");
          head.value = ""; head.textContent = "— select business group —";
          sel.appendChild(head);
          groups.forEach(g => {
            const o = document.createElement("option");
            o.value = g.id; o.dataset.name = g.name || "";
            o.textContent = (g.name || g.id) + (g.disabled ? "  (added)" : "");
            if (g.disabled) o.disabled = true;
            sel.appendChild(o);
          });
          status.hidden = true;
          sel.hidden = false; orLbl.hidden = false; text.hidden = false;
          sel.focus();
        } else {
          fallbackToText("No selectable business groups found — enter name / ID.", false);
        }
      } catch (e) {
        if (!wrap.isConnected) return;
        if (e?.code === "REAUTH_REQUIRED" && typeof signIn === "function") {
          status.hidden = false; status.classList.remove("is-error");
          status.textContent = e.message || "Sign in to load your business groups.";
          showSignIn();
        } else {
          fallbackToText(`Couldn't load business groups (${e?.message || e}). Enter name / ID manually.`, true);
        }
      }
    }

    signinEl.addEventListener("click", async () => {
      signinEl.disabled = true;
      signinEl.innerHTML = `<span class="cat-bg-signin-dot"></span> signing in…`;
      try {
        await signIn();                 // ユーザー操作起点なので OAuth ポップアップが通る
        await runLoad();
      } catch (e) {
        signinEl.disabled = false;
        signinEl.innerHTML = `Retry sign-in <span class="arrow">→</span>`;
      }
    });

    runLoad();
  });
}
