// 貼り付けた token / assertion の空白を落とす小さなユーティリティ。
// app.js と window.js の双方から使うので独立したモジュールにしてある
// (window.js から app.js を import すると循環参照になる)。

// JWT をターミナルやメールから拾うと途中で改行が入っていることが多く、 そのまま
// 保存すると Authorization ヘッダに改行が混じって送信自体が失敗する。
// ただし「空白を含むことが正当な API キー」を壊したくない。 内部の空白まで落とすのは
//   - 空白を除くと JWT の形 (base64url を . で 3 つ) になる、 または
//   - 改行が含まれている (= 折り返して貼られた)
// ときだけにする。 1 行でスペース区切りの値は意図的とみなし、 前後の trim だけ。
export function normalizeToken(v) {
  const trimmed = String(v ?? "").trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/\s+/g, "");
  const isJwt   = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(stripped);
  const wrapped = /[\r\n]/.test(trimmed);
  return (isJwt || wrapped) ? stripped : trimmed;
}
