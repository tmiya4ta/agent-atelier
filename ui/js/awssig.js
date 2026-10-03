// AWS Signature Version 4 — ブラウザ (WebCrypto) だけで署名ヘッダを作る。
//
// Amazon Bedrock AgentCore Runtime の A2A エンドポイントは IAM (SigV4) 認証が必須で、
// Bearer では通らない (403 "Missing Authentication Token")。 Gateway を挟まずに
// Atelier から直接話すために、 送信直前に Authorization / X-Amz-Date などを付ける。
//
// 署名は宛先 URL (proxy を通す前の本来の URL) に対して行う。 /proxy はヘッダを
// 原則そのまま転送し、 Host は宛先に合わせて付け直すので、 署名と一致する。
//
//   const h = await signAws({ method: "POST", url, headers, body, aws });
//   aws = { accessKeyId, secretAccessKey, sessionToken?, region, service }
//
// Node (>= 20) でも globalThis.crypto.subtle があればそのまま動く (試験用)。

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data) {
  const bytes = typeof data === "string" ? enc.encode(data) : (data || new Uint8Array());
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

// RFC 3986 の unreserved 以外をすべて %XX にする (encodeURIComponent は !'()* を残す)。
function rfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// S3 以外のサービスは、 パスの各セグメントを「2 回」URI エンコードしたものが canonical URI。
// URL に載っているパスは 1 回エンコード済み (例 arn%3Aaws...) なので、 もう 1 回かける
// (→ arn%253Aaws...)。 ここを 1 回で済ませると AgentCore は signature mismatch を返す。
function canonicalPath(pathname) {
  if (!pathname) return "/";
  return pathname.split("/").map(rfc3986).join("/");
}

function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [k, v] of searchParams) pairs.push([rfc3986(k), rfc3986(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function amzDate(d) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");   // 20261003T040506Z
}

// url の host を見て region / service を推測する。 bedrock-agentcore.ap-northeast-1.amazonaws.com
// → { service: "bedrock-agentcore", region: "ap-northeast-1" }。 当たらなければ空。
export function guessAwsScope(url) {
  try {
    const m = new URL(url).hostname.match(/^([a-z0-9-]+)\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com$/);
    return m ? { service: m[1], region: m[2] } : {};
  } catch { return {}; }
}

// 署名済みのヘッダを返す (元の headers に足したもの)。 aws が無ければ headers をそのまま返す。
export async function signAws({ method = "GET", url, headers = {}, body = "", aws, now = new Date() }) {
  if (!aws || !aws.accessKeyId || !aws.secretAccessKey) return headers;
  const u = new URL(url);
  const scope0 = guessAwsScope(url);
  const region  = aws.region  || scope0.region;
  const service = aws.service || scope0.service;
  if (!region || !service) throw new Error("AWS SigV4: region / service が決まらない (URL から推測できない)");

  const xAmzDate  = amzDate(now);
  const dateStamp = xAmzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body || "");

  const signed = {
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": xAmzDate
  };
  if (aws.sessionToken) signed["x-amz-security-token"] = aws.sessionToken;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map(n => `${n}:${String(signed[n]).trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(u.pathname),
    canonicalQuery(u.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", xAmzDate, credentialScope, await sha256Hex(canonicalRequest)
  ].join("\n");

  let k = await hmac("AWS4" + aws.secretAccessKey, dateStamp);
  k = await hmac(k, region);
  k = await hmac(k, service);
  k = await hmac(k, "aws4_request");
  const signature = hex(await hmac(k, stringToSign));

  const out = { ...headers };
  // Host はブラウザが付けられない (proxy が宛先に合わせて付ける)。 残りを載せる。
  out["X-Amz-Date"] = xAmzDate;
  out["X-Amz-Content-Sha256"] = payloadHash;
  if (aws.sessionToken) out["X-Amz-Security-Token"] = aws.sessionToken;
  out["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${aws.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
