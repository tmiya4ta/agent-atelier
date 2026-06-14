// 暗号化設定同期 — TOTP 秘密由来の鍵でクライアント側暗号化し、 サーバ (/sync) には
// 暗号文だけ置く (ゼロ知識風)。 サーバは復号鍵を持たない。
//
//   accountId : sha256hex("acct|"+secret)  — ストアのキー (公開)
//   apiKey    : sha256hex("api|"+secret)   — 読み書き認可 (サーバは hash(apiKey) を照合)
//   encKey    : AES-GCM(sha256("enc|"+secret)) — 暗号鍵 (ブラウザのみ・送信しない)
//   blob      : "ivBase64.ctBase64"  (AES-GCM)

const te = new TextEncoder();
const td = new TextDecoder();

function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

async function sha256hex(str) {
  const h = await crypto.subtle.digest("SHA-256", te.encode(str));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function aesKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", te.encode("enc|" + secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function deriveSyncIds(secret) {
  return { accountId: await sha256hex("acct|" + secret), apiKey: await sha256hex("api|" + secret) };
}

export async function encryptBlob(secret, obj) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj)));
  return b64(iv) + "." + b64(ct);
}
export async function decryptBlob(secret, blob) {
  const [ivb, ctb] = String(blob || "").split(".");
  if (!ivb || !ctb) throw new Error("bad blob");
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivb) }, key, unb64(ctb));
  return JSON.parse(td.decode(pt));
}

// サーバへ保存。 成功で true。
export async function pushSettings(syncBase, secret, obj) {
  const { accountId, apiKey } = await deriveSyncIds(secret);
  const blob = await encryptBlob(secret, obj);
  const res = await fetch(`${syncBase}/sync`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, apiKey, blob })
  });
  return res.ok;
}

// サーバから取得 → 復号して返す。 未保存なら null。
export async function pullSettings(syncBase, secret) {
  const { accountId, apiKey } = await deriveSyncIds(secret);
  const res = await fetch(`${syncBase}/sync?account=${encodeURIComponent(accountId)}`, {
    headers: { "X-Sync-Key": apiKey }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sync pull HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.blob) return null;
  return await decryptBlob(secret, data.blob);
}
