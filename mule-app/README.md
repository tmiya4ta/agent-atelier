# atelier-static

Atelier (Agent Workbench) の静的アセット (`index.html` / `styles.css` / `js/` / `oauth/`)
を CloudHub 2 でホストするための Mule 4 アプリ。

親フォルダ `..` にある Atelier のソースを **build 時にそのまま JAR に同梱**するので、
Atelier 側を編集 → `mvn package` し直し → 再デプロイ、 で反映される。

## 構成

```
mule-app/
├─ pom.xml                                ← maven-resources-plugin で ../{index.html,styles.css,js,oauth} を staging
├─ mule-artifact.json
├─ src/main/mule/
│  ├─ global-config.xml                  ← http-listener-config, jmx-config, mule.env
│  └─ impl/
│     ├─ atelier-static.xml              ← `/*` 受け取り → classpath:static/{path} を返す
│     └─ jmx-endpoints.xml               ← /logs /logs/tail /logs/search
└─ src/main/resources/
   ├─ log4j2.xml                          ← atelier-static.log
   ├─ config/config-local.yaml           ← http.port: "8081"
   └─ config/config-ch2.yaml             ← http.port: "8081"
```

## エンドポイント

| Path           | 内容 |
|----------------|------|
| `/`            | `static/index.html` を返す |
| `/styles.css`  | `static/styles.css` を返す |
| `/js/app.js` 等 | `static/js/app.js` を返す |
| `/oauth/callback.html` | OAuth リダイレクト先 |
| `/__health`    | `{ app, env, version, time }` JSON ヘルスチェック |
| `/logs`        | JMX module — 直近 N 件のログ取得 |
| `/logs/tail`   | JMX module — file tail |
| `/logs/search` | JMX module — pattern grep |

Content-Type は拡張子から判定 (html/css/js/json/svg/png/jpg/webp/ico/woff2/...)。
失敗時 404。 `Cache-Control: no-store` (dev 兼任のため恒久キャッシュなし)。

## ビルド

```sh
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
  mvn clean package -DskipTests
```

→ `target/atelier-static-1.0.0-mule-application.jar`

**ソースアタッチは pom.xml に組み込み済み** (`<attachMuleSources>true</attachMuleSources>`)。
CLI で `-DattachMuleSources` を付けなくても、 jar に flow XML・pom 等が
`META-INF/mule-src/atelier-static/` として同梱される
(Exchange から取得した Studio / 他開発者がフローを開ける)。
無効化したい場合のみ `-DattachMuleSources=false`。

確認:
```sh
# 静的アセットが static/ に入っているか
unzip -l target/atelier-static-1.0.0-mule-application.jar | grep -E '(index.html|static/js)'
# Mule ソースが同梱されているか
unzip -l target/atelier-static-1.0.0-mule-application.jar | grep 'META-INF/mule-src'
```
親フォルダの `index.html` / `js/*.js` が JAR 内 `static/...` に、
flow XML が `META-INF/mule-src/...` に入っていることを確認。

## CloudHub 2 デプロイ

`/home/myst/.claude/rules/mule-deploy.md` のチェックリスト準拠:

```sh
# 1. upload to Exchange
yaac upload asset target/atelier-static-1.0.0-mule-application.jar \
  -g <org> -a atelier-static -v 1.0.0

# 2. deploy (CH2)
yaac deploy app <org> <env> atelier-static \
  target=ch2:<ps> v-cores=0.1 \
  -g <org> -a atelier-static -v 1.0.0 \
  "+mule.env=ch2"

# 3. APPLIED まで待つ
yaac describe app <org> <env> atelier-static
# STATUS=APPLIED, POD=RUNNING で OK

# 4. ログ確認 (JMX module 経由)
yaac logs app <org> <env> atelier-static -j -n 50
```

## Atelier 側を更新した時

```sh
# 親フォルダで JS/CSS/HTML を編集 → mule-app/ で再 build → 再 deploy
cd mule-app
mvn clean package -DskipTests
yaac upload asset target/atelier-static-1.0.0-mule-application.jar -g <org> -a atelier-static -v 1.0.0
yaac deploy app <org> <env> atelier-static target=ch2:<ps> v-cores=0.1 \
  -g <org> -a atelier-static -v 1.0.0 "+mule.env=ch2"
```

(あるいは `1.0.1` → `1.0.2` のようにリビジョンを上げて update)

## /proxy エンドポイント (CORS バイパス)

`impl/proxy.xml` に `/proxy?url=<encoded>` フローを実装済み。 Atelier client が CORS 制約の
ある先 (Anypoint Exchange / 外部 A2A・MCP など) を叩くための転送口で、 Python dev-server と
同じ I/F。

### SSRF ガード (公開 CloudHub 上で必須)

`/proxy` は**無認証で誰でも叩ける公開エンドポイント**になるため、 open proxy 化を防ぐ
SSRF ガード (`src/main/resources/dw/SsrfGuard.dwl`) を組み込んである:

- **strict allowlist**: host が許可 suffix に一致した時だけ転送。 既定は
  `*.mulesoft.com` / `*.cloudhub.io` / `*.amazonaws.com` (Exchange の S3) /
  `*.salesforce.com` / `*.force.com` / `github(usercontent).com` / fonts / jsdelivr。
- **private/reserved IP 拒否**: `10/8` `127/8` `169.254/16` (cloud metadata) `172.16/12`
  `192.168/16` `100.64/10` CGNAT、 IPv6 `::1`/ULA/link-local、 `localhost`/`.internal`/`.local`。
- **scheme は http/https のみ**。 `file:` `gopher:` 等は拒否。
- **userinfo 詐称** (`http://anypoint.mulesoft.com@169.254.169.254/`) は host 解析後に弾く。
- **3xx redirect 先にも同じガードを適用** (allowlist host が内部へ飛ばす経路を遮断)。
- 違反時は upstream に飛ばさず `403 { error, reason, host }` を返す。

外部 A2A/MCP エージェントを足すときは:

- `config/config-*.yaml` の **`proxy.allowHosts`** にカンマ区切りで host suffix を追加
  (例 `proxy.allowHosts: "agents.example.com,my-a2a.io"`)、 または
- `SsrfGuard.dwl` の `ALLOW_SUFFIX` を編集。

### まだ残るリスク / 推奨

- ガードは **DNS rebinding を防げない** (Mule HTTP connector が host 名で再解決するため)。
- ガードは allowlist であり**認証・レート制限ではない**。 公開運用では `/proxy` に
  **API Manager の client-id enforcement + rate limiting** ポリシーを併用すること。
- 可能なら `/proxy` を静的配信アプリと分離し、 認証必須の別 listener に置く。
- 同梱されるアセット: 親 (`../`) の `index.html`, `styles.css`, `js/**`, `oauth/**`, `assets/**`
- `server/*.py` (mock-agent / dev-server) は同梱されない (CH2 では Python 動かないので)
