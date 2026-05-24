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
