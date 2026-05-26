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
          <div class="modal-choices">${buttons}</div>
          ${extrasHtml}
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
