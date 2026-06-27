/**
 * SsrfGuard — /proxy?url=... の宛先 SSRF ガード。
 *
 * 使い方:
 *   import dw::SsrfGuard
 *   SsrfGuard::check(attributes.queryParams.url default "")
 *   SsrfGuard::check(url, extraSuffixes)   // 追加許可 suffix を渡す版
 *     -> { deny: Boolean, reason: String, host: String }
 *
 * 方針 (公開 CloudHub 2 上で open proxy にしないため strict allowlist):
 *   - scheme は http / https のみ許可
 *   - host が ALLOW_SUFFIX (+ 呼び出し側が渡す extra) のいずれかに一致
 *     (完全一致 or ".suffix" で終端) した場合のみ許可
 *   - それ以外 (任意 public host を含む) はすべて拒否 → 第三者攻撃の踏み台化を防ぐ
 *   - localhost / 内部名 / private・reserved IP リテラル / 非 http(s) は明示的に拒否
 *     (allowlist host が userinfo 詐称等で内部 IP を指すケースも host 解析後に弾く)
 *
 * 外部 A2A/MCP エージェントを足すときは ALLOW_SUFFIX を編集するか、
 * 設定プロパティ proxy.allowHosts (カンマ区切り) を flow から extra で渡す。
 *
 * 限界: DNS rebinding は本モジュールでは防げない (Mule HTTP connector が host 名で
 * 再解決するため)。 公開運用では API Manager の client-id enforcement + rate limiting を併用すること。
 */
%dw 2.0
import some from dw::core::Arrays

// 既定の許可 host suffix。 子ドメインも含む (例: "exchange2.anypoint.mulesoft.com" は "mulesoft.com" で許可)。
var ALLOW_SUFFIX = [
  "mulesoft.com",
  "cloudhub.io",
  "amazonaws.com",          // Exchange の S3 presigned URL
  "salesforce.com",
  "force.com",
  "githubusercontent.com",  // raw scenarios
  "github.com",
  "login.microsoftonline.com",  // Microsoft Entra ID OAuth2 token/authorize endpoint
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net"
]

// "10" 等の各オクテットを Number 化 (非数なら -1)
fun octet(s: String): Number = (s default "") match {
  case x if (x matches /^\d{1,3}$/) -> x as Number
  else -> -1
}

fun isPrivateV4(host: String): Boolean = do {
    var m = (host scan /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)[0]
    ---
    if (m == null) false
    else do {
        var a = octet(m[1])
        var b = octet(m[2])
        ---
        a == 0 or a == 10 or a == 127 or a >= 224          // current-net / private / loopback / multicast+reserved
        or (a == 169 and b == 254)                         // link-local + cloud metadata 169.254.169.254
        or (a == 172 and b >= 16 and b <= 31)              // 172.16/12
        or (a == 192 and b == 168)                         // 192.168/16
        or (a == 100 and b >= 64 and b <= 127)             // CGNAT 100.64/10
    }
}

fun isPrivateV6(host: String): Boolean = do {
    var h = lower(host)
    ---
    h == "::1" or h == "::"
    or (h startsWith "fe80")                                // link-local
    or (h startsWith "fc") or (h startsWith "fd")           // ULA fc00::/7
    or (h startsWith "ff")                                  // multicast
}

// URL から host (小文字・port/userinfo/IPv6ブラケット除去後) を取り出す
fun hostOf(rawIn: Any): String = do {
    var raw         = trim((rawIn default "") as String)
    var afterScheme = raw replace /(?i)^[a-z][a-z0-9+.\-]*:\/\// with ""
    var authority   = (afterScheme scan /^([^\/?#]*)/)[0][1] default ""
    var hostPort    = (authority splitBy "@")[-1] default ""
    ---
    lower(
      if (hostPort startsWith "[")
        ((hostPort scan /^\[([^\]]*)\]/)[0][1]) default hostPort
      else
        ((hostPort splitBy ":")[0]) default hostPort
    )
}

fun check(rawIn: Any, extra: Array = []): Object = do {
    var lc     = lower(trim((rawIn default "") as String))
    var scheme = (lc scan /^([a-z][a-z0-9+.\-]*):\/\//)[0][1] default ""
    var host   = hostOf(rawIn)
    var allow  = ALLOW_SUFFIX ++ ((extra default []) map lower(trim($ as String)) filter ($ != ""))

    var isHttp      = scheme == "http" or scheme == "https"
    var isLocalName = host == "" or host == "localhost" or (host endsWith ".localhost") or (host endsWith ".internal") or (host endsWith ".local")
    var isPrivate   = isPrivateV4(host) or isPrivateV6(host)
    var allowed     = allow some ((s) -> (host == s) or (host endsWith ("." ++ s)))
    ---
    {
      host: host,
      deny: (not isHttp) or isLocalName or isPrivate or (not allowed),
      reason:
        if (not isHttp)       "scheme not allowed (http/https only)"
        else if (isLocalName) "localhost/internal host not allowed"
        else if (isPrivate)   "private/reserved IP not allowed"
        else if (not allowed) ("host not in allowlist: " ++ host)
        else "ok"
    }
}

// ── Java URI safe ──────────────────────────────────────────
// Mule の http:request は URL を java.net.URI でパースし、query に { } | space ^ ` 等を
// 生で含むと "Illegal character in query" で落ちる (502)。forward 前にこれらを %-encode する
// (該当文字のみ置換・既存の %xx は不変)。Exchange の downloadURL が 3xx で返す Location が
// これらを生で含むケース (fat-oas 等) で必要。
fun uriSafe(u: Any): String = do {
    var s = trim((u default "") as String)
    ---
    s replace / /  with "%20"
      replace /"/  with "%22"
      replace /</  with "%3C"
      replace />/  with "%3E"
      replace /\{/ with "%7B"
      replace /\}/ with "%7D"
      replace /\|/ with "%7C"
      replace /\\/ with "%5C"
      replace /\^/ with "%5E"
      replace /`/  with "%60"
      replace /\[/ with "%5B"
      replace /\]/ with "%5D"
}
