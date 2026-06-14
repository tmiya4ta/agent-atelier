// passphrase ベースのファイル暗号化 (AES-GCM + PBKDF2-SHA256)。
// Export(Secret 込み)で平文をブラウザ内で暗号化し、 Import で同じ passphrase で復号する。
// 鍵・平文はファイルにもサーバにも残さない。

const te = new TextEncoder();
const td = new TextDecoder();
const ITER = 210000;

function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

async function deriveKey(passphrase, salt, iter) {
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

// plaintext(文字列) → { kdf, iter, salt, iv, ct }(全 base64)
export async function encryptText(passphrase, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(passphrase, salt, ITER);
  const ct   = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(plaintext));
  return { kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

// box(encryptText の出力) → plaintext(文字列)。 passphrase 違い/改竄は throw。
export async function decryptText(passphrase, box) {
  const key = await deriveKey(passphrase, unb64(box.salt), box.iter || ITER);
  const pt  = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  return td.decode(pt);
}
