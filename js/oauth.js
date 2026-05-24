// OAuth2 Authorization Code Flow (with PKCE) — popup based
//
// 使い方:
//   const tokenData = await runAuthCodeFlow(cat);
//
// cat: { authUrl, tokenUrl, clientId, scopes }
// 戻り値: { access_token, expires_in, refresh_token?, ... }

const REDIRECT_PATH = "/oauth/callback.html";

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

export async function runAuthCodeFlow(cat) {
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

  const authUrl = `${cat.authUrl}?${params.toString()}`;
  console.info("[oauth] authorize URL:", authUrl);
  console.info("[oauth] redirect_uri :", redirectUri());
  console.info("[oauth] scope        :", params.get("scope"));

  // Popup
  const w = 520, h = 720;
  const left = Math.max(0, Math.floor((screen.width  - w) / 2));
  const top  = Math.max(0, Math.floor((screen.height - h) / 2));
  const popup = window.open(authUrl, "atelier-oauth",
    `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=yes,status=no`);

  if (!popup) throw new Error("Popup blocked. Allow popups for this site.");

  // Wait for postMessage from callback or popup close
  const code = await new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => { if (done) return; done = true; fn(); cleanup(); };

    const onMsg = (e) => {
      if (e.origin !== location.origin) return;
      const d = e.data;
      if (!d || d.type !== "oauth-callback") return;
      try { popup.close(); } catch {}
      if (d.error)               return finish(() => reject(new Error(`${d.error}: ${d.error_description || ""}`)));
      if (!d.code)               return finish(() => reject(new Error("No code in callback")));
      if (d.state !== state)     return finish(() => reject(new Error("state mismatch (CSRF guard)")));
      finish(() => resolve(d.code));
    };

    const checkClosed = setInterval(() => {
      if (popup.closed) finish(() => reject(new Error("Authentication cancelled")));
    }, 500);

    const cleanup = () => {
      clearInterval(checkClosed);
      window.removeEventListener("message", onMsg);
    };
    window.addEventListener("message", onMsg);
  });

  // Exchange code → token (via /proxy for CORS)
  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri:  redirectUri(),
    client_id:     cat.clientId,
    code_verifier: verifier
  });
  // Connected App が Web app タイプの場合のみ secret を渡す (SPA タイプは PKCE のみ)
  if (cat.clientSecret) body.set("client_secret", cat.clientSecret);

  const res = await fetch(`/proxy?url=${encodeURIComponent(cat.tokenUrl)}`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString()
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
  }
  return data;
}
