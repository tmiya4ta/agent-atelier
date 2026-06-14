// TOTP (RFC 6238) — 認証アプリ (Google Authenticator 等) 互換のワンタイムコード。
// 完全クライアント完結: Web Crypto の HMAC-SHA1 で計算。 バックエンド不要・オフライン可。
//
//   const secret = genSecret();              // base32 の共有秘密 (登録時に1度だけ)
//   otpauthUri(secret, "you@example", "Atelier")  // → QR にする otpauth:// URI
//   await verifyTotp(secret, "123456")       // 入力コードの検証 (±1 step 許容)

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// ランダムな base32 秘密 (既定 20 byte = 160bit → base32 32文字)。
export function genSecret(bytes = 20) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bits = "", out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

// base32 (RFC 4648, padding/空白/大小文字を許容) → Uint8Array
export function base32decode(s) {
  const clean = String(s || "").toUpperCase().replace(/[=\s-]/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}

// 8 byte big-endian counter
function counterBytes(counter) {
  const b = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) { b[i] = n & 0xff; n = Math.floor(n / 256); }
  return b;
}

// HOTP(RFC 4226): HMAC-SHA1 → dynamic truncation → digits 桁
export async function hotp(secret, counter, digits = 6) {
  const keyBytes = base32decode(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes(counter)));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

// TOTP: 現在時刻 (step=30s) を counter にして HOTP
export async function totp(secret, { step = 30, digits = 6, t = Date.now() } = {}) {
  return hotp(secret, Math.floor(t / 1000 / step), digits);
}

// 入力コードの検証。 時計ずれ吸収のため ±window step を許容 (既定 ±1 = ±30s)。
export async function verifyTotp(secret, code, { step = 30, digits = 6, window = 1, t = Date.now() } = {}) {
  const norm = String(code || "").replace(/\s/g, "");
  if (!/^\d{6,8}$/.test(norm)) return false;
  const c0 = Math.floor(t / 1000 / step);
  for (let w = -window; w <= window; w++) {
    if (await hotp(secret, c0 + w, digits) === norm) return true;
  }
  return false;
}

// 認証アプリ登録用 otpauth:// URI (QR にエンコードする)
export function otpauthUri(secret, label = "user", issuer = "Atelier") {
  const lbl = encodeURIComponent(`${issuer}:${label}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${lbl}?${q.toString()}`;
}
