# Atelier — アーキテクチャ詳細

本書は Atelier の内部設計、データフロー、拡張方法を解説します。利用者向けの概要は
[`../README.md`](../README.md)、運用・デプロイは [`../ONBOARDING.md`](../ONBOARDING.md) を参照してください。

---

## 1. 設計思想

- **ビルドレス**: フレームワーク・npm・バンドラなし。ブラウザネイティブの ES Modules と 1 枚の
  `index.html` だけで動く。`<script type="module" src="js/app.js">` がエントリポイント。
- **adapter で抽象化**: プロトコル差分（A2A / MCP / Slack）はすべて `ProtocolAdapter` のサブクラスに閉じ込め、
  UI 層（`AgentWindow`）は共通イベント（`open` / `message` / `rpc` / `error` / `close`）だけを見る。
- **イベント駆動**: adapter は `EventTarget` を継承し、`CustomEvent` を dispatch する。UI はそれを購読して描画。
  プロトコルの中身を知らずにチャット・デバッグ・カードを描ける。
- **状態は 1 つのグローバル `state`**: `app.js` の `state` オブジェクトが全 UI 状態の単一の真実。
  永続化は `persist.js` が `localStorage`（非機密）と `sessionStorage`（機密）に分離して行う。

```
┌─────────────────────────────────────────────────────────┐
│ index.html  (UI シェル, CSP, テンプレート <template>)      │
└─────────────────────────────────────────────────────────┘
            │ import
┌───────────▼─────────────────────────────────────────────┐
│ app.js — グローバル state / sidebar / dialog / script /   │
│          connect() / workspace / 永続化呼び出し           │
└───┬─────────────────────────────┬───────────────────────┘
    │ new AgentWindow(adapter)     │ new XxxAdapter(config)
┌───▼──────────────┐        ┌──────▼───────────────────────┐
│ window.js        │ events │ protocols/<id>.js             │
│ AgentWindow      │◀───────│ extends ProtocolAdapter       │
│ (DOM/tab/chat/   │ rpc/   │ (base.js)                     │
│  debug/card/set) │ message│   connect() / send() / ...    │
└──────────────────┘        └──────┬───────────────────────┘
                                    │ fetch (CORS bypass)
                            ┌───────▼───────────────────────┐
                            │ dev-server /proxy?url=...      │
                            │ → 実エージェント (A2A/MCP/Slack)│
                            └────────────────────────────────┘
```

---

## 2. モジュール構成

| ファイル | 役割 |
|---|---|
| `js/app.js` | 中核。グローバル `state`、ワークスペース、3 つの sidebar（Connections / Catalogs / Scripts）、接続ダイアログ、Script Panel、`connect()`、Anypoint Exchange 連携、キーバインド |
| `js/window.js` | `AgentWindow` クラス。フローティングウィンドウの DOM 構築・drag/resize・タブ切替・チャット typewriter・デバッグペイン・Agent Card 描画・MCP tools フォーム |
| `js/script.js` | 会話 DSL のパーサ（`parseScript` / `parseMocks`）と `ScriptRunner`（async 実行エンジン） |
| `js/persist.js` | `localStorage`（state）/ `sessionStorage`（secrets）の保存・読込、import/export |
| `js/oauth.js` | Anypoint Platform の PKCE Authorization Code flow |
| `js/i18n.js` | `STRINGS = { en, ja }`、`t(key)`、`setLang()` |
| `js/modal.js` | Promise ベースの `modalConfirm` / `modalAlert` / `modalPrompt` |
| `js/protocols/base.js` | `ProtocolAdapter` 基底クラス + `headersToObj` ヘルパ |
| `js/protocols/{a2a,mcp,slack,mock}.js` | 各プロトコル実装 |
| `js/protocols/index.js` | `PROTOCOLS` レジストリと `getProtocol(id)` |

---

## 3. プロトコル adapter 層

### 3.1 ProtocolAdapter（基底クラス）

`js/protocols/base.js`。全 adapter の共通インターフェース。`EventTarget` を継承。

```js
class ProtocolAdapter extends EventTarget {
  constructor(config)            // config = { url, name, auth, authHeaders, persona, channel, ... }
  async connect()                // 接続確立 → "open" を emit
  async disconnect()             // "close" を emit
  async send(text, opts={})      // メッセージ送信 → "message"(+"rpc") を emit
  abort()                        // 進行中の fetch を AbortController で中断
  static get id()                // "a2a" 等のプロトコル識別子
  static get label()             // UI 表示名
  // 状態: this.state = idle | connecting | open | error | closed
  //       this.agentCard, this.config
}
```

### 3.2 イベント契約

adapter は以下の `CustomEvent` を dispatch し、`AgentWindow` が購読する:

| イベント | detail | 意味 |
|---|---|---|
| `open` | `{ card }` または `{ serverInfo, tools }` | 接続確立。AgentCard / MCP server info 確定 |
| `message` | `{ role, text, final }` | エージェント応答（`final=false` は SSE 中間チャンク） |
| `status` | `{ state, text }` | SSE の status-update など中間進捗 |
| `rpc` | `{ dir, method, headers?, payload?, raw }` | 生 RPC フレーム（Debug タブ用） |
| `error` | `Error` | エラー |
| `close` | — | 切断 |

`rpc` の `dir` は `"out"`（送信）/ `"in"`（受信）/ `"err"`（エラー）。Debug タブはこれを時系列で並べ、
展開時に `payload` と `headers` をサブタブで切り替えて表示する（`headersToObj()` が `Headers` を平坦化）。

### 3.3 各 adapter の要点

- **a2a.js** — `/.well-known/agent-card.json`（新仕様）→ `agent.json`（旧仕様）を順に discovery。
  `message/send`（JSON）と `message/stream`（SSE）に対応。AgentCard を localStorage に
  stale-while-revalidate でキャッシュ。`contextId` をサーバ採番に任せて会話継続。
- **mcp.js** — Streamable HTTP。`initialize` → `notifications/initialized` → `tools/list`。
  `Mcp-Session-Id` ヘッダを以降のリクエストに付与。レスポンスは JSON / SSE 両対応。
  会話 protocol ではないため、UI は chat ではなく **tools タブ + 動的フォーム**（`callTool`）を使う。
- **slack.js** — `auth.test` で接続確認 → 仮想 AgentCard を合成。`chat.postMessage` で送信、
  同期 reply（mock サーバ想定）があれば agent message として emit。
- **mock.js** — オフラインデモ用。`PERSONAS` 定義からローカルで AgentCard・応答を合成（実通信なし）。

### 3.4 新規プロトコルの追加手順

1. `js/protocols/<id>.js` に `ProtocolAdapter` を継承したクラスを実装（`connect` / `send` / イベント emit）。
2. `js/protocols/index.js` の `PROTOCOLS` 配列に 1 エントリ追加（`id` / `label` / `AdapterClass` / `status`）。
3. これだけで接続ダイアログ・sidebar に自動反映される（UI 側は登録を意識しない）。

---

## 4. UI 層: AgentWindow

`js/window.js`。1 接続 = 1 インスタンス。`index.html` の `<template id="tplWindow">` を clone して DOM 構築。

- **4 タブ**: Chat / Agent Card / Debug / Settings（MCP モードでは Chat を隠し **Tools** タブを露出）。
- **ウィンドウ操作**: drag（ヘッダ）、8 方向 resize、最大化（ダブルクリック / ボタン）、ピン留め（位置・サイズ固定）。
- **Chat**: ChatGPT 風 typewriter。user/agent 双方を 1〜数文字ずつ append。A2A/Slack は完了後に
  Markdown / mrkdwn を `marked` + DOMPurify で HTML 化。応答時間（レイテンシ）を吹き出しに刻む。
- **Debug**: `rpc` フレームを append-only 描画。各行クリックで展開 → payload / headers サブタブ。
  矢印は受信 `→ in` / 送信 `← out`。`pause` / `clear` ツールバー付き。
- **送信ボタン**: 通常は送信、応答待ち中は停止ボタン（`adapter.abort()`）に変化。
- **入力履歴**: ターミナル風に ↑/↓ で過去入力を呼び戻し（最大 10 件）。

---

## 5. 状態管理と永続化

### 5.1 グローバル state（app.js）

主要フィールド:

| フィールド | 内容 |
|---|---|
| `state.workspaces` | ワークスペース配列。各々 `{ id, layer, windows[], events }` |
| `state.activeWs` | アクティブなワークスペース ID |
| `state.bookmarks` | 登録済み接続（proto+url+name+authRef…）。sidebar の Connections の元 |
| `state.catalogs` | Anypoint OAuth カタログ（client_id 等。secret は sessionStorage） |
| `state.identities` | 認証 identity（bearer / OAuth）。`authRef` でウィンドウから参照 |
| `state.scripts` / `state.openScriptIds` | 会話 DSL 台本群と Script Panel で開いているタブ |
| `state._script` | 実行中のスクリプトランナー状態（実行中のみ非 null） |

### 5.2 永続化レイヤ（persist.js）

- `localStorage["atelier:state:v1"]` — **非機密**の state スナップショット（ワークスペース・bookmark・台本・レイアウト）。
- `sessionStorage["atelier:secrets:v1"]` — **機密**（bearer token / client_secret）。タブを閉じると消える。
  scope（proto+url や catalog id）でキー化し、state とは別管理。
- **export / import**: JSON スナップショットは secrets を含まない。import 時は OAuth endpoint 書換や
  `__proto__` 汚染などを検出して警告ダイアログを出す。

> **設計理由**: localStorage は XSS 一発で全読みされるため、secrets を置かない。公開ホスティングに
> 上げる場合も secrets はメモリ / sessionStorage 限定に留める。

---

## 6. CORS バイパス（dev サーバ / Mule proxy）

ブラウザから外部エージェントへの直接 fetch は CORS でブロックされるため、同一オリジンの
`/proxy?url=<encoded>` を経由する。`server/dev-server.js`（Node）と `server/dev-server.py`（Python）が
ローカル用、本番（CH2 ホスティング）は `mule-app` の `proxy.xml` が同等機能を提供する。

proxy の主な責務:

- **CORS ヘッダ付与** — ただし dev サーバ自身の origin にのみ echo（クロスタブ SSRF 遮断）。
- **SSRF ガード** — `http/https` 以外を拒否、private/loopback/link-local/メタデータ IP（10.x / 127.x /
  169.254.x / fc00::/7 等）を拒否。allowlist（`*.cloudhub.io` / `*.mulesoft.com` / `*.salesforce.com` 等）。
- **Authorization strip on 3xx** — Exchange → S3 presigned URL のような 303 リダイレクトで、
  2 leg 目の Authorization を落とす（二重認証エラー回避）。
- **`Cache-Control: no-store`** — ES Module の古いキャッシュ残留を防ぐ。
- **ストリーミング透過** — SSE をそのまま pipe（per-response タイムアウトなし）。

---

## 7. 会話 DSL と ScriptRunner

`js/script.js`。複数エージェントを跨いだ会話シナリオを台本として記述・再生する。

### 7.1 ディレクティブ

| 構文 | 意味 |
|---|---|
| `< <window>: <message>` | メッセージ送信（`${var}` を実行直前に展開） |
| `> <window>` / `> <window> 30s` | 応答待ち（既定 60s / timeout 指定） |
| `> <window> 30s as <var>` | 応答待ち + 受信本文を `${var}` に保存 |
| `^ <operator>: <hint> -> <var>` | operator-agent に hint + 直近 captured vars を渡し、応答を `${var}` に保存 |
| `sleep 2s` | 一時停止 |
| `clear` / `clear <window>` | 全 / 指定ウィンドウのチャットをクリア |
| `$> <window>: <応答>` | mock 応答定義（mock モード時のみ。実通信しない） |
| `# ...` | コメント |

`<window>` はウィンドウ名（大小無視・部分一致可）または ID（`aw-1`）。

### 7.2 実行モデル

- `ScriptRunner.run(ops)` が ops を逐次 await 実行。`stop()` で `cancelPromise` を reject して中断。
- **Run 時の自動オープン**: 台本が参照するウィンドウが未オープンでも、一致する bookmark があれば
  `connect()` で開いてから実行する（`ensureScriptWindowsOpen`）。bookmark も無い名前はスキップ（ログ通知）。
- **auto-loop**: 台本を繰り返し実行（iteration 間に小休止）。
- **mock モード**: `$>` 定義を `{ window: [応答…] }` に畳み、対象ウィンドウの adapter の `send` を
  ローカル応答に乗っ取る（`mockInstall`）。typewriter・Debug タブは本番同様に動く。詳細は
  [`scenario-mock-mode.md`](scenario-mock-mode.md)。

---

## 8. Anypoint Exchange 連携（Catalogs）

- **OAuth**: Client Credentials または Authorization Code + PKCE（`oauth.js`）で Anypoint Platform に認証。
  catalog の下に複数 Business Group をツリー表示。
- **Asset drawer**: Exchange の `types=agent` asset をページング取得。各 asset の
  `/exchange/api/v2/assets/{groupId}/{assetId}` を fetch し、`instances[]`（Managed Instances）から
  実 URL を解決。`a2a-card.json` の URL が `${ingressgw.url}/...` テンプレートのままなら手動 URL 入力に逃がす。
- **Quick Connect**: asset hover で即接続。詳細を見たい時は本体クリックで detail drawer。

---

## 9. CloudHub 2.0 ホスティング（mule-app）

フロントエンドそのものを CH2 で配信するための Mule アプリ。

- `pom.xml` の maven-resources-plugin が親フォルダの `index.html` / `styles.css` / `js` / `oauth` /
  `assets` / `scenarios` を `src/main/resources/static/` にコピーして jar に同梱。
- `atelier-static.xml` が `/` → `classpath:static/` を配信、`proxy.xml` が `/proxy`、
  `jmx-endpoints.xml` が `/logs` 系を提供。
- `<attachMuleSources>true</attachMuleSources>` を埋め込み済みのため、`mvn clean package` だけで
  flow ソースが jar に同梱される（Studio / 他開発者が Exchange 取得 jar のフローを開ける）。

デプロイ手順は [`../mule-app/README.md`](../mule-app/README.md) と [`../ONBOARDING.md`](../ONBOARDING.md) 参照。

---

## 10. 関連ドキュメント

| ドキュメント | 内容 |
|---|---|
| [`../README.md`](../README.md) | 概要・クイックスタート・機能一覧 |
| [`../ONBOARDING.md`](../ONBOARDING.md) | ローカル開発・CH2 デプロイ・ハマりどころ・キーバインド |
| [`scenario-mock-mode.md`](scenario-mock-mode.md) | mock モードの仕組み |
| [`agent-capability-expansion.md`](agent-capability-expansion.md) | エージェント能力拡張の検討メモ |
| [`incident-agent-intent-redesign.md`](incident-agent-intent-redesign.md) | incident-agent の intent 抽出設計 |
| [`../mule-app/README.md`](../mule-app/README.md) | フロントエンドの CH2 配信アプリ |
