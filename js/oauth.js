// OAuth2 Authorization Code Flow (with PKCE) — popup based
//
// 使い方:
//   const tokenData = await runAuthCodeFlow(cat);
//
// cat: { authUrl, tokenUrl, clientId, scopes }
// 戻り値: { access_token, expires_in, refresh_token?, ... }

const REDIRECT_PATH = "/oauth/callback.html";

// ポップアップ名は呼び出しごとにユニークにする。固定名 ("atelier-oauth") だと
// 再認証 (2 回目) で直前に閉じたばかりの同名 window が一瞬 reuse され、
// checkClosed が「閉じられた」と誤検知して "Authentication cancelled" になることがある。
let _popupSeq = 0;

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makePkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  );
  return { verifier, challenge };
}

export function redirectUri() {
  return `${location.origin}${REDIRECT_PATH}`;
}

export async function runAuthCodeFlow(cat, opts = {}) {
  const { verifier, challenge } = await makePkce();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  const params = new URLSearchParams({
    response_type:        "code",
    client_id:            cat.clientId,
    redirect_uri:         redirectUri(),
    state,
    code_challenge:        challenge,
    code_challenge_method: "S256"
  });
  // scope は ユーザー指定があれば送る。Anypointは指定なしも許容するケースが多い。
  if (cat.scopes) params.set("scope", cat.scopes);
  // prompt: IdP の SSO セッション (cookie) が別ウインドウにログインを引き継ぐのを防ぐ。
  //   "select_account" (既定) = 毎回アカウント選択 → 別 ID でログインできる
  //   "login" = 毎回 再認証を強制 / "none" or "" = 付けない (従来どおり SSO 再利用)
  //   identity の prompt フィールドで上書き可。未設定の既存 identity は select_account。
  const promptVal = ("prompt" in cat) ? cat.prompt : "select_account";
  if (promptVal && promptVal !== "none") params.set("prompt", promptVal);

  const authUrl = `${cat.authUrl}?${params.toString()}`;
  console.info("[oauth] authorize URL:", authUrl);
  console.info("[oauth] redirect_uri :", redirectUri());
  console.info("[oauth] scope        :", params.get("scope"));

  // opts.tab=true なら別タブ (features 無し)、 既定は中央ポップアップ。
  let features = "";
  if (!opts.tab) {
    const w = 520, h = 720;
    const left = Math.max(0, Math.floor((screen.width  - w) / 2));
    const top  = Math.max(0, Math.floor((screen.height - h) / 2));
    features = `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=yes,status=no`;
  }
  const popupName = opts.tab ? "_blank" : `atelier-oauth-${++_popupSeq}`;
  const popup = window.open(authUrl, popupName, features);

  if (!popup) throw new Error("Popup blocked. Allow popups for this site.");

  // callback からの受信: postMessage と localStorage の両対応。
  // 別タブ運用では IdP の COOP で window.opener が切られ postMessage が届かない
  // ことがあるため、 callback は localStorage にも結果を書く (同一オリジンの
  // storage イベントで元タブが拾う)。
  const STORE_KEY = "atelier:oauth-callback";
  // 前回フローの残骸を掃除する。1 回目が postMessage で完了すると callback が
  // localStorage に書いた結果が残り、 2 回目開始時の pre-check がそれ (古い state)
  // を拾って "state mismatch (CSRF guard)" で即 reject していた。開始時に消しておく。
  try { localStorage.removeItem(STORE_KEY); } catch {}

  const code = await new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => { if (done) return; done = true; cleanup(); fn(); };

    const handle = (d) => {
      if (!d || d.type !== "oauth-callback") return;
      // state 不一致 = このフロー宛ではない (別フロー / 古い残骸)。reject せず無視して
      // 待機を続ける。 これが本当の CSRF ガード: 一致しない callback は「採用しない」。
      if (d.state !== state) return;
      try { localStorage.removeItem(STORE_KEY); } catch {}  // 一致したものだけ消費・除去
      try { popup.close(); } catch {}
      if (d.error)  return finish(() => reject(new Error(`${d.error}: ${d.error_description || ""}`)));
      if (!d.code)  return finish(() => reject(new Error("No code in callback")));
      finish(() => resolve(d.code));
    };

    const onMsg = (e) => { if (e.origin === location.origin) handle(e.data); };
    const onStorage = (e) => {
      if (e.key !== STORE_KEY || !e.newValue) return;
      let d; try { d = JSON.parse(e.newValue); } catch { return; }
      handle(d);   // 除去は handle (一致時のみ) に任せる
    };

    // tab/popup が閉じられても、 直前に書かれた結果があれば拾う猶予を持たせる。
    const checkClosed = setInterval(() => {
      if (!popup.closed) return;
      try {
        const pre = localStorage.getItem(STORE_KEY);
        if (pre) handle(JSON.parse(pre));   // 一致すれば消費して finish、不一致は無視
      } catch {}
      // handle が resolve していれば finish は idempotent で no-op。
      finish(() => reject(new Error("Authentication cancelled")));
    }, 600);

    const cleanup = () => {
      clearInterval(checkClosed);
      window.removeEventListener("message", onMsg);
      window.removeEventListener("storage", onStorage);
    };
    window.addEventListener("message", onMsg);
    window.addEventListener("storage", onStorage);
    // 既に書き込み済みなら即拾う (一致時のみ消費、 古い残骸は handle が無視)
    try {
      const pre = localStorage.getItem(STORE_KEY);
      if (pre) handle(JSON.parse(pre));
    } catch {}
  });

  // Exchange code → token。client の種類で送り方を変える:
  //  - confidential client (client_secret あり, 例: Anypoint Connected App / Entra Web):
  //    client_secret_post を /proxy 経由で送る (CORS 回避)。
  //  - public client (client_secret なし, PKCE のみ, 例: Entra SPA アプリ):
  //    secret は送らず token endpoint へ直接 fetch する。Entra は SPA 登録の
  //    redirect URI に対してのみ CORS で token redemption を許可するため、
  //    /proxy (サーバ側 = Origin 無し) だと AADSTS9002327 で拒否される。直 fetch なら
  //    ブラウザが Origin を付けるので通る (PKCE で secret 不要)。
  const tokenParams = {
    grant_type:    "authorization_code",
    code,
    redirect_uri:  redirectUri(),
    client_id:     cat.clientId,
    code_verifier: verifier
  };
  if (cat.clientSecret) tokenParams.client_secret = cat.clientSecret;
  const body = new URLSearchParams(tokenParams);

  const isPublicClient = !cat.clientSecret;
  const fetchUrl = isPublicClient ? cat.tokenUrl : `/proxy?url=${encodeURIComponent(cat.tokenUrl)}`;
  const res = await fetch(fetchUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString()
  });
  // token endpoint は失敗時 非JSON (Unauthorized 等) を返すことがあるので安全に parse。
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!res.ok || data.error || !data.access_token) {
    const detail = data.error_description || data.error
      || (raw && !data.access_token ? raw.replace(/<[^>]+>/g, "").trim().slice(0, 140) : "");
    throw new Error(`token exchange HTTP ${res.status}${detail ? ` · ${detail}` : ""}`);
  }
  return data;
}
