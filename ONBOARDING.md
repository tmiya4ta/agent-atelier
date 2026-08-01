# Atelier — Agent Workbench

A2A 中核のマルチプロトコルエージェントクライアント。 ブラウザ内に複数のフローティングウインドウを並べて、 REST / A2A / MCP / DB サーバへ同時接続するワークベンチ。

- **Repo**: https://github.com/tmiya4ta/agent-atelier
- **CH2 Deploy**: https://ai-workshop-23fgzd.pnwfdv.jpn-e1.cloudhub.io  (T1 / Sandbox / rootps · deployment 名 `ai-workshop`)
- **RTF Deploy**: `atelier-static-k0` (T1 / Sandbox / k0)。 relay 経由で https://atelier-relay-23fgzd.pnwfdv.jpn-e1.cloudhub.io/
- **Local dev**: `node server/dev-server.js --port 8000` → http://127.0.0.1:8000/ (Python 不要版。 後述「ローカル開発」参照)
- **言語**: 英語 default、 `ui/js/i18n.js` の `setLang("ja")` で日本語に切替可能 (現状 ja 部分翻訳)

> ⚠️ **セキュリティ前提**: このアプリは **dev / demo tool** です。 OAuth `client_credentials` flow で `client_secret` をブラウザに保持、 各種 token を `sessionStorage` に置く設計のため、 信頼できないユーザに公開してはいけません。 CH2 deploy も社内デモ用と割り切ってください (Atelier 配信側に認証が無い)。
> - localStorage に **secrets は保存しません** (sessionStorage 限定 — タブ閉で消える)
> - export / import の JSON snapshot にも secrets は含まれません
> - import 時は OAuth endpoint 書換や `__proto__` 等を検出して警告 dialog を出します
> - Markdown の HTML 化は DOMPurify で sanitize 済 (`<script>` / `onerror=` 等を弾く)
> - ⚠️ **A2A への MCP 受け渡しは例外**: A2A window に登録した MCP サーバの認証情報は、 ツールを実行する接続先エージェントへ送られる
> - `index.html` に CSP `<meta>` を埋め込んでおり、 marked / DOMPurify は SRI 付き CDN
> - dev-server.js の `/proxy` は **同一オリジン (dev-server 自身) からのみ受付**、 `/proxy?url=...` には allowlist + private IP (10.x / 169.254.x / 127.x / fc00::/7 等) 拒否を実装

## アーキテクチャ

```
agent-atelier/
├── ui/                     ← ブラウザアプリ一式 (dev-server / mule-app が web ルートとして配信)
│   ├── index.html          ← Atelier UI shell
│   ├── styles.css          ← Editorial minimal · Source Serif 4 + Geist + JetBrains Mono
│   ├── js/
│   │   ├── app.js          ← state / workspace / sidebar / dialog / script panel / connect 全部
│   │   ├── window.js       ← AgentWindow (drag, tabs, chat/debug/card/settings)
│   │   ├── i18n.js         ← STRINGS = { en, ja }, t(key), setLang
│   │   ├── modal.js        ← modalConfirm / modalAlert / modalPrompt
│   │   ├── persist.js      ← localStorage save/load
│   │   ├── oauth.js        ← PKCE Authorization Code flow (Anypoint)
│   │   ├── script.js       ← DSL runner (< send / > wait / sleep / clear)
│   │   └── protocols/
│   │       ├── base.js     ← ProtocolAdapter interface
│   │       ├── a2a.js      ← Google Agent2Agent (JSON-RPC / agent-card.json)
│   │       ├── mcp.js      ← Model Context Protocol (JSON-RPC / streamable HTTP)
│   │       ├── rest.js     ← REST (raw HTTP リクエスト)
│   │       ├── db.js       ← DB (clouderby · JDBC over HTTP)
│   │       ├── mock.js     ← オフラインのデモ用 persona
│   │       └── index.js    ← PROTOCOLS registry
│   ├── oauth/callback.html ← PKCE redirect target (postMessage to opener)
│   └── scenarios/          ← デモシナリオ (JSON) — /scenarios/ で同一オリジン配信
├── server/                 ← dev-server (Node/Python) + mock A2A + CDP test helpers
│   ├── dev-server.js       ← HTTP static + /proxy (CORS bypass), no-store, SSRF guard ★推奨
│   ├── dev-server.py       ← 同等の Python 版 (Python3 環境向け)
│   └── mock-agent.py       ← Mock A2A server (port 5180)
└── mule-app/               ← CH2 hosting for the same frontend
    ├── pom.xml             ← maven copies ../ui/{index.html,styles.css,js,oauth,scenarios} into static/
    ├── src/main/mule/
    │   ├── global-config.xml
    │   └── impl/
    │       ├── atelier-static.xml   ← / → classpath:static/, /__health
    │       ├── proxy.xml            ← /proxy?url=<encoded>, leg2 strips Authorization on 3xx
    │       └── jmx-endpoints.xml    ← /logs, /logs/tail, /logs/search
    └── README.md
```

## 主な機能

| 機能 | 説明 |
|---|---|
| **Multi-window** | フローティングウインドウ。 drag, resize, tile, workspace タブ |
| **Workspaces** | 複数の作業空間、 `⌘T` 追加、 `⌘⇧[`/`⌘⇧]` 切替 |
| **Connections** sidebar | live window list を proto+url で group、 子は `├─ aw-N`、 `+` で同じ agent の別 window |
| **Catalogs** sidebar | Anypoint Platform OAuth (CC + Authorization Code w/ PKCE)、 catalog の下に複数 Business Group を tree でぶら下げ |
| **Scenarios** sidebar | DSL script を複数管理、 auto loop モード |
| **Asset drawer** | Exchange `types=agent` ページング取得 + 各 asset の `instances[]` (Managed Instances) から URL 自動解決 |
| **Script Panel** (bottom IDE) | tab で複数 script 同時編集、 WINDOWS chip 補完、 COMMANDS chip、 syntax highlight、 typewriter |
| **Chat** | ChatGPT 風 typewriter (user/agent 両方 + blinking caret)、 markdown レンダリング |
| **Agent Card pane** | `├─ ▸ [ JSON ]` ツリーで raw JSON 折りたたみ表示 |

## DSL (script panel)

```
< SCRS Broker: hello             # 送信 (chevron 入 = agent への入力)
> SCRS Broker                    # 応答待ち (60s default)
> SCRS Broker 30s                # timeout 指定
> SCRS Broker 30s as reply       # 応答を ${reply} に保存
$> SCRS Broker: 在庫は十分です     # mock 応答 (mock モード時のみ)
sleep 1s                         # pause
clear                            # 全 window のチャットをクリア
clear SCRS Broker                # 指定 window のみクリア
# comment
```

`Enter` で `< name: text` の次に自動で `> name` が挿入される (連続会話用)。
記法の正典は `ui/js/script.js` の冒頭コメント。

## Catalog の Business Group ツリー

1. `[+]` ボタンで OAuth catalog 作成 (client_id / secret / optional BG)
2. Catalog item の下に BG が `├─ Marketing / ├─ Sales / └─ Engineering` の tree で並ぶ
3. Catalog item の `[+]` でいつでも BG 追加 (modalPrompt)
4. 各 BG をクリックすると drawer で Exchange asset 一覧 (organizationId フィルタ済)
5. Asset hover で **Quick Connect** ボタン (右上)、 詳細を見たい時は本体クリック
6. Asset detail に **managed instances pill** + 手動 URL 入力欄 (template `${...}` の場合のフォールバック)

## ローカル開発

### 開発サーバの起動

dev server は **Node 版 (`dev-server.js`) と Python 版 (`dev-server.py`) の 2 つ**があり、
どちらも「静的配信 + CORS bypass proxy (`/proxy?url=...`) + `Cache-Control: no-store`」で機能は等価。
**Node 版を推奨** (Python が無い環境でも動く。 当リポジトリの Windows 開発機は Node のみ)。

```sh
# 推奨: Node 版 (引数なしで port 8000 / host 127.0.0.1 が default)
node server/dev-server.js --port 8000
# → http://127.0.0.1:8000/
#   起動すると banner で static / proxy の URL を表示する。
#   --host 0.0.0.0          他端末からアクセスさせたいとき (社内デモのみ。 公開厳禁)
#   --proxy-allow host,...  proxy allowlist にホストを追加

# 代替: Python 版 (Python3 がある環境のみ)
python3 server/dev-server.py --port 8000
# → http://127.0.0.1:8000/

# 確認 (200 が返れば OK)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/

# Mock A2A サーバ (動作確認用、 Python のみ)
python3 server/mock-agent.py
# → http://127.0.0.1:5180/.well-known/agent-card.json
```

> ⚠️ ES module を多用しているので、 `file://` 直開きでは動かない (CORS / module 解決で失敗)。
> 必ず dev server 経由 (`http://127.0.0.1:8000/`) で開くこと。
> JS/CSS を編集したら `no-store` が効いているのでハードリロード不要だが、 念のため ⌘⇧R 推奨。

### Mule アプリのビルド

```sh
# CH2 hosting アプリのビルド (validation 用)。 Mule 4 にローカル起動 goal は無いので
# package が通ること = XML/DataWeave/コネクタ解決の検証。 実動作確認は CH2 デプロイ後。
cd mule-app
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 mvn clean package -DskipTests
```

> **ソースアタッチは pom.xml に `<attachMuleSources>true</attachMuleSources>` を埋め込み済み**
> (`mule-app` および `atelier-agents/*` 全アプリ)。 そのため CLI で `-DattachMuleSources` を
> 付けなくても、 ビルド成果物 jar に `META-INF/mule-src/<artifactId>/` として flow XML・pom が
> 同梱される。 Exchange から jar を取得した Studio / 他開発者がフローを開いて中身を確認できる。
> (明示的に無効化したい場合のみ `-DattachMuleSources=false`。)

## CH2 デプロイフロー

`mule-app/README.md` 詳細あり。 一行で:

```sh
# version を上げる (mule-app/pom.xml の先頭 <version>)
sed -i '0,|<version>1.3.X</version>|s||<version>1.3.Y</version>|' mule-app/pom.xml
mvn -f mule-app/pom.xml clean package -DskipTests
yc login tmiyashita
yc upload asset T1 atelier-static 1.3.Y mule-app/target/atelier-static-1.3.Y-mule-application.jar
```

**既存 deployment の版上げは Runtime Manager API を直接 PATCH する**。
`yc deploy app` はハングするため (新規作成のときだけ POST で作る)。

```sh
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.yc-session.json'))['access_token'])")
# org / env の id は yc から引く (このリポジトリは public なので値は書かない)
ORG=$(yc get org -o json | python3 -c "import json,sys;print([o['id'] for o in json.load(sys.stdin) if o['name']=='T1'][0])")
ENVID=$(yc get env T1 -o json | python3 -c "import json,sys;print([e['id'] for e in json.load(sys.stdin) if e['name']=='Sandbox'][0])")
B="https://anypoint.mulesoft.com/amc/application-manager/api/v2/organizations/$ORG/environments/$ENVID/deployments"
# deployment id は一覧から引く (name = ai-workshop / atelier-static-k0)
curl -s -H "Authorization: Bearer $TOKEN" "$B" | python3 -c "import json,sys;[print(i['name'],i['id']) for i in json.load(sys.stdin)['items']]"
curl -s -H "Authorization: Bearer $TOKEN" "$B/<deployment-id>" > d.json
python3 -c "import json;d=json.load(open('d.json'));r=d['application']['ref'];r['version']='1.3.Y';json.dump({'application':{'ref':r}},open('d.patch','w'))"
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @d.patch "$B/<deployment-id>"
```

反映確認は配信されている JS を直接見るのが確実:
`curl -s <url>/js/app.js | grep -c '<今回入れた文字列>'`

トラブル時は `yc logs A1 Sandbox <app>` でログ取得。

## ハマりどころ

| 症状 | 原因 / 対策 |
|---|---|
| ES module キャッシュで古い JS が残る | dev-server に `Cache-Control: no-store` 強制してある。 ハードリロードで OK |
| Anypoint Exchange asset の `a2a-card.json` の URL が `${ingressgw.url}/...` テンプレ | 各 asset の `/exchange/api/v2/assets/{groupId}/{assetId}` を fetch して `instances[]` から実 URL 解決 (実装済)、 それでもなければ detail drawer で手動 URL 入力 |
| Anypoint Exchange の S3 presigned URL に Authorization 付きで二重認証エラー | Python dev-server: `StripAuthOnRedirectHandler`、 Mule proxy: `followRedirects=false` で leg2 を Authorization なし |
| A2A タイムアウト | Mule proxy の `responseTimeout="120000"` 設定済 (2 分) |
| Catalog item / Bookmark / Script のレイアウト崩れ | sidebar 全 item の grid を `1fr auto auto auto` に統一、 host/badge は tooltip に逃がす |
| `yc deploy app` が返ってこない | 既知。 既存 deployment は Runtime Manager API を PATCH、 新規は POST で作る |
| Exchange の upload が 502 (`UNEXPECTED_PUBLICATION_ERROR`) | 一過性。 20 秒ほど置いて再実行すると通る |
| Private Space に空きが無く replica が `PENDING` | `Unschedulable: 0/N nodes are available`。 稼働中アプリを止めて枠を空けるしかない |
| `grep` が `ui/js/*.js` で空を返す | 長い Unicode 行のせいでバイナリ判定される。 `-a` を付ける |
| Chrome の `/__health` も 500 (過去 v1.0.2 まで) | `<ee:set-variable>` で Integer status code を正しく渡せない、 `statusCode="200"` ハードコード + 404 は body で表現 |

## 次やる候補 (TODO ヒント)

- Script DSL の `read <window> [var]` 等で前応答を変数に保存
- Atelier の i18n: 残りの ja 文字列を `STRINGS.ja` に揃える + `setLang` UI トグル
- Anypoint catalog の Connected App が複数 BG access ある時、 hierarchy 全表示 + select UI
- mule-app の proxy フローを independent CH2 app に分離 (atelier-static は純粋 static のみに)

## キーバインド早見表

| | |
|---|---|
| `⌘⇧[` `⌘⇧]` | workspace switch |
| `⌘1-9` | focus window N |
| `⌘⇧K` | script panel toggle |
| `⌘⏎` (editor フォーカス時) | script run |
| `⌘.` | script stop |
| `⌘W` (editor フォーカス時) | 現 script tab close |
| `Esc` | dialog dismiss |
| `Tab` (chat 入力欄) | AgentCard の例文を確定 (例が出ているときのみ) |

> `⌘N` / `⌘T` はブラウザの新規ウインドウ・新規タブに予約されており横取りできないため、
> 新規接続とワークスペース追加は UI のボタン (**+ new connection** / タブ右の `+`) から行う。
