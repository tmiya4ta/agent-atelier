# Atelier — Agent Workbench

A2A 中核のマルチプロトコルエージェントクライアント。 ブラウザ内に複数のフローティングウインドウを並べて、 A2A / Slack / (今後 MCP / OpenAI) サーバへ同時接続するワークベンチ。

- **Repo**: https://github.com/tmiya4ta/agent-atelier
- **CH2 Deploy**: https://atelier-static-znutqp.pnwfdv.jpn-e1.cloudhub.io  (T1 / Sandbox / rootps)
- **Local dev**: `python3 server/dev-server.py --port 8000` → http://127.0.0.1:8000/
- **言語**: 英語 default、 `js/i18n.js` の `setLang("ja")` で日本語に切替可能 (現状 ja 部分翻訳)

> ⚠️ **セキュリティ前提**: このアプリは **dev / demo tool** です。 OAuth `client_credentials` flow で `client_secret` をブラウザに保持、 各種 token を `sessionStorage` に置く設計のため、 信頼できないユーザに公開してはいけません。 CH2 deploy も社内デモ用と割り切ってください (Atelier 配信側に認証が無い)。
> - localStorage に **secrets は保存しません** (sessionStorage 限定 — タブ閉で消える)
> - export / import の JSON snapshot にも secrets は含まれません
> - import 時は OAuth endpoint 書換や `__proto__` 等を検出して警告 dialog を出します
> - Markdown / Slack mrkdwn の HTML 化は DOMPurify で sanitize 済 (`<script>` / `onerror=` 等を弾く)
> - `index.html` に CSP `<meta>` を埋め込んでおり、 marked / DOMPurify は SRI 付き CDN
> - dev-server.js の `/proxy` は **同一オリジン (dev-server 自身) からのみ受付**、 `/proxy?url=...` には allowlist + private IP (10.x / 169.254.x / 127.x / fc00::/7 等) 拒否を実装

## アーキテクチャ

```
agent-center/
├── index.html              ← Atelier UI shell
├── styles.css              ← Editorial minimal · Source Serif 4 + Geist + JetBrains Mono
├── js/
│   ├── app.js              ← state / workspace / sidebar / dialog / script panel / connect 全部
│   ├── window.js           ← AgentWindow (drag, tabs, chat/debug/card/settings)
│   ├── i18n.js             ← STRINGS = { en, ja }, t(key), setLang
│   ├── modal.js            ← modalConfirm / modalAlert / modalPrompt
│   ├── persist.js          ← localStorage save/load
│   ├── oauth.js            ← PKCE Authorization Code flow (Anypoint)
│   ├── script.js           ← DSL runner (> send / < wait / sleep / clear)
│   └── protocols/
│       ├── base.js         ← ProtocolAdapter interface
│       ├── a2a.js          ← Google Agent2Agent (JSON-RPC / agent-card.json)
│       ├── slack.js        ← Slack-compat (chat.postMessage / auth.test, mrkdwn)
│       ├── mock.js         ← (unused now, but kept for reference)
│       └── index.js        ← PROTOCOLS registry
├── oauth/callback.html     ← PKCE redirect target (postMessage to opener)
├── server/                 ← Python: dev-server + mock A2A + CDP test helpers
│   ├── dev-server.py       ← HTTP static + /proxy (CORS bypass), Cache-Control: no-store
│   └── mock-agent.py       ← Mock A2A server (port 5180)
└── mule-app/               ← CH2 hosting for the same frontend
    ├── pom.xml             ← maven copies ../{index.html,styles.css,js,oauth,assets} into static/
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
| **Scripts** sidebar | DSL script を複数管理、 auto loop モード |
| **Asset drawer** | Exchange `types=agent` ページング取得 + 各 asset の `instances[]` (Managed Instances) から URL 自動解決 |
| **Script Panel** (bottom IDE) | tab で複数 script 同時編集、 WINDOWS chip 補完、 COMMANDS chip、 syntax highlight、 typewriter |
| **Chat** | ChatGPT 風 typewriter (user/agent 両方 + blinking caret)、 markdown は Slack 接続時のみ |
| **Agent Card pane** | `├─ ▸ [ JSON ]` ツリーで raw JSON 折りたたみ表示 |

## DSL (script panel)

```
> SCRS Broker: hello             # 送信
< SCRS Broker                    # 応答待ち (60s default)
< SCRS Broker 30s                # timeout 指定
sleep 1s                         # pause
clear                            # 全 window のチャットをクリア
clear SCRS Broker                # 指定 window のみクリア
# comment
```

`Enter` で `> name: text` の次に自動で `< name` が挿入される (連続会話用)。

## Catalog の Business Group ツリー

1. `[+]` ボタンで OAuth catalog 作成 (client_id / secret / optional BG)
2. Catalog item の下に BG が `├─ Marketing / ├─ Sales / └─ Engineering` の tree で並ぶ
3. Catalog item の `[+]` でいつでも BG 追加 (modalPrompt)
4. 各 BG をクリックすると drawer で Exchange asset 一覧 (organizationId フィルタ済)
5. Asset hover で **Quick Connect** ボタン (右上)、 詳細を見たい時は本体クリック
6. Asset detail に **managed instances pill** + 手動 URL 入力欄 (template `${...}` の場合のフォールバック)

## ローカル開発

```sh
# Atelier dev server (CORS bypass proxy 付き、 no-cache 強制)
python3 server/dev-server.py --port 8000
# → http://127.0.0.1:8000/

# Mock A2A サーバ (動作確認用)
python3 server/mock-agent.py
# → http://127.0.0.1:5180/.well-known/agent-card.json

# CH2 hosting アプリのビルド (validation 用)。 Mule 4 にローカル起動 goal は無いので
# package が通ること = XML/DataWeave/コネクタ解決の検証。 実動作確認は CH2 デプロイ後。
cd mule-app
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 mvn clean package -DskipTests -DattachMuleSources
```

## CH2 デプロイフロー

`mule-app/README.md` 詳細あり。 一行で:

```sh
cd mule-app
# version を上げる (1.0.x → 1.0.x+1)
sed -i 's|<version>1.0.X</version>|<version>1.0.Y</version>|' pom.xml
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 mvn clean package -DskipTests -DattachMuleSources
yaac upload asset target/atelier-static-1.0.Y-mule-application.jar -g T1 -a atelier-static -v 1.0.Y
yaac deploy app T1 Sandbox atelier-static target=ch2:rootps v-cores=0.1 \
  -g T1 -a atelier-static -v 1.0.Y "+mule.env=ch2"
yaac describe app T1 Sandbox atelier-static  # STATUS=APPLIED, POD=RUNNING 待ち
```

トラブル時は `yaac logs app T1 Sandbox atelier-static -j -n 100` で JMX 経由ログ取得。

## ハマりどころ

| 症状 | 原因 / 対策 |
|---|---|
| ES module キャッシュで古い JS が残る | dev-server に `Cache-Control: no-store` 強制してある。 ハードリロードで OK |
| Anypoint Exchange asset の `a2a-card.json` の URL が `${ingressgw.url}/...` テンプレ | 各 asset の `/exchange/api/v2/assets/{groupId}/{assetId}` を fetch して `instances[]` から実 URL 解決 (実装済)、 それでもなければ detail drawer で手動 URL 入力 |
| Anypoint Exchange の S3 presigned URL に Authorization 付きで二重認証エラー | Python dev-server: `StripAuthOnRedirectHandler`、 Mule proxy: `followRedirects=false` で leg2 を Authorization なし |
| A2A タイムアウト | Mule proxy の `responseTimeout="120000"` 設定済 (2 分) |
| Catalog item / Bookmark / Script のレイアウト崩れ | sidebar 全 item の grid を `1fr auto auto auto` に統一、 host/badge は tooltip に逃がす |
| Chrome の `/__health` も 500 (過去 v1.0.2 まで) | `<ee:set-variable>` で Integer status code を正しく渡せない、 `statusCode="200"` ハードコード + 404 は body で表現 |

## 次やる候補 (TODO ヒント)

- Slack adapter で実 Slack の Events API or Socket Mode → 真の bot reply
- MCP / OpenAI adapter
- Script DSL の `read <window> [var]` 等で前応答を変数に保存
- Atelier の i18n: 残りの ja 文字列を `STRINGS.ja` に揃える + `setLang` UI トグル
- Anypoint catalog の Connected App が複数 BG access ある時、 hierarchy 全表示 + select UI
- mule-app の proxy フローを independent CH2 app に分離 (atelier-static は純粋 static のみに)

## キーバインド早見表

| | |
|---|---|
| `⌘N` | new connection |
| `⌘T` | new workspace |
| `⌘⇧[` `⌘⇧]` | workspace switch |
| `⌘1-9` | focus window N |
| `⌘⇧K` | script panel toggle |
| `⌘⏎` (editor フォーカス時) | script run |
| `⌘.` | script stop |
| `⌘W` (editor フォーカス時) | 現 script tab close |
| `Esc` | dialog dismiss |
