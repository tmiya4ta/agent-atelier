# incident-agent 改善記録 — intent 抽出アーキテクチャへの移行

**対象**: `atelier-agents/incident-agent`
**期間**: 2026-05-30
**最終バージョン**: `1.9.6` (StepA / BetterTogetherDemo / shard `d7gr5m` にデプロイ済み)
**ステータス**: ✅ 動作確認済み・プロトタイプ完了

---

## TL;DR

LLM に「自然文を読んで、どのツールを・どんな条件で呼ぶか」を **prompt 内の場合分けで判断させる**設計をやめ、
**「LLM は 自然文 → 構造化 JSON (intent + entities) への変換だけに専念。 分岐・必須項目の検証・出力整形は Mule (DataWeave) で決定論的に行う」** 二段構成に作り替えた。

弱い LLM (gpt-5-mini) に条件分岐を語らせると誤判定が頻発する (例: 「一覧を見たい」のに新規登録用の severity を聞き返す) のが動機。
intent 抽出に特化させ、判定ロジックをコード側 (Mule の `choice` + DataWeave) に移したことで、同種のバグが**構造的に起きにくく**なり、prompt も大幅に短くなった。

---

## なぜ変えたか — 旧設計の問題

旧 `incident-agent` は OpenAI 互換の **tool-use ループ** (`agentLoopFlow` / `agentInferenceFlow` / `agentExecuteToolsFlow`) で動いていた。
system prompt (約 85 行 / STEP 0〜2) に以下を全部書き込み、LLM に判断させていた:

- STEP 0: メタ質問はゲート無しで回答
- STEP 1: 「NEED_INFO ゲート」— ツール実行依頼には supplierGoldenId + partNumber + severity の 3 点が揃うまで問い返す
- STEP 2: 出力テンプレ (ADVISORY / EXECUTE / NEED_INFO) + Markdown 整形ルール + 幻覚防止の禁止例 4 つ

### 観測されたバグ

1. **一覧照会なのに severity を聞かれる**
   ユーザ「九州製作所のインシデントの一覧をしりたい」→ agent「severity (HIGH/MEDIUM/...) を指定してください」。
   原因: NEED_INFO ゲートが *新規登録 (register)* 専用のはずの 3 項目を、*照会・一覧* にも要求していた。
   さらに **そもそも一覧取得ツールが無かった** (`lookup_incident` は 1 件のみ、`list_incidents` 未実装)。

2. **「〜をしりたい / 教えて」を capability (能力質問) と誤分類**
   ユーザ「九州製作所のインシデントの一覧をしりたい」→ agent「できます: 既存インシデントの照会、新規登録、ステータス更新…」(能力一覧を返してしまう)。
   原因: 弱い LLM が「知りたい」を「(この agent は) 何ができるか問う質問」と取り違えた。
   抽象的な intent 定義文だけでは弱モデルに境界が伝わらない。

根本原因は共通で、**「prompt 内の自然文による場合分け」を弱い LLM の判断に委ねていた**こと。

---

## 新アーキテクチャ

```
[broker からの DataPart {tool,args}] ──→ directToolFlow ──┐
                                                          ├─→ callMcpExecuteFlow ─→ MCP (/mcp/execute)
[人間の自然文] ─→ intentExtractFlow ─→ intentRouterFlow ──┘
                  (LLM: 抽出のみ)        (Mule: 決定論)
```

### 1. `intentExtractFlow` — LLM は抽出だけ

LLM へのリクエストは「次の JSON スキーマだけを出力。説明・前置き・コードフェンス禁止」。**条件分岐は一切書かない。**

```json
{
  "intent": "list_incidents | lookup_incident | register_incident | update_status | capability | out_of_scope | unknown",
  "entities": {
    "supplierGoldenId": null, "supplierName": null, "partNumber": null,
    "incidentId": null, "severity": null, "status": null, "quantity": null, "since": null
  },
  "rawMessage": "ユーザ発話の原文そのまま",
  "language": "ja"
}
```

- entities は **読み取れた値だけ**入れ、読み取れないものは `null` (推測・正規化・捏造は禁止)。
- **few-shot 例** を実際の会話ターン (user/assistant ペア) として 6 件同梱し、intent 境界を固定 (後述「ハマり所」参照)。

### 2. `intentRouterFlow` — Mule の choice で決定論的に捌く

抽出済み `vars.intent.intent` で分岐。LLM は使わない。

| intent | 必須 slot | 振る舞い |
|---|---|---|
| `list_incidents` | なし | entities の非 null だけ MCP に渡して即実行 (**ゲート無し**)。結果を Markdown テーブルに整形。 |
| `lookup_incident` | `incidentId` | 無ければ NEED_INFO。あれば 1 件取得して整形。 |
| `register_incident` | `supplierGoldenId`, `partNumber`, `severity` | **欠けた slot を DataWeave で算出**し、不足分だけ NEED_INFO。揃えば MCP で登録。 |
| `update_status` | `incidentId`, `status` | 同上。 |
| `capability` | — | 静的テキスト (能力説明)。 |
| `out_of_scope` | — | 担当外案内 (他 agent / broker へ)。 |
| `unknown` / その他 | — | フォールバック (例示付きの聞き返し)。 |

「どの intent に何が必須か」が **prompt の自然文ではなく DataWeave のコード (表)** になったため、
「一覧で severity を聞く」類のバグは構造的に発生しなくなった。

### 利点

- **prompt から条件分岐が消えた** → 弱い LLM が苦手な「抽象ルールからの判断」をさせない。
- broker 経路 (`directToolFlow`) と人間経路が同じ `callMcpExecuteFlow` に合流 → ディスパッチが一本化。
- デバッグは「抽出された intent JSON のログを見るだけ」。挙動が追いやすい。

---

## 追加したツール

`list_incidents` (一覧取得, READ-ONLY) を追加。backend は MDM MCP の `list_incidents` (`mcpKind="mdm"` でルーティング)。
全パラメータ任意 (`supplierGoldenId` / `partNumber` / `status` / `severity` / `since` / `limit`)。何も指定しなければ最新一覧。

既存ツール: `lookup_incident` (1 件), `register_incident` (登録), `update_incident_status` (状態更新) は incident-mcp 側。

---

## ハマり所と対処 (横展開する人向け・重要)

これらは **legal/procurement/logistics/org へ同パターンを移植する際にも同じく踏む**ので必読。

| # | 症状 | 原因 | 対処 |
|---|---|---|---|
| 1 | LLM が HTTP 400 `error parsing the body` | OpenAI 互換 proxy (`openai-proxy.demos.mulesoft.com`) が **`response_format: {"type":"json_object"}` を受け付けない** | `response_format` を送らず、プロンプトで「JSON だけ出力」と指示。出力をコードフェンス除去してから parse する保険を入れる。 |
| 2 | LLM 応答が `messages: null` → `expected an array` エラー | **同一 `<ee:variables>` ブロック内で `vars.extractMessages` を参照すると、まだ未確定で null** になる | `extractMessages` と `extractBody` を **別々の `<ee:transform>`** に分ける。 |
| 3 | `Unable to resolve reference of: list_incidents` | `<ee:set-variable variableName="toolName">list_incidents</ee:set-variable>` の **裸の文字列が MEL 式として評価**される | `#['list_incidents']` のように式 + 文字列リテラルにする。 |
| 4 | logger で `Cannot coerce Object to String` | HTTP response payload は**既に Object に自動デシリアライズ済み**のことがある (Binary/String 前提のコードが落ちる) | `if (payload is Binary) … else if (payload is String) … else payload` で型分岐。 |
| 5 | 「一覧をしりたい/教えて」を `capability` と誤分類 | 弱い LLM は intent 定義の説明文だけでは境界を学べない | **few-shot 例**を会話ターンとして同梱 + 判定ルール明文化 (「具体データを含む / 特定インシデントを求める発話は capability では絶対にない」「『〜を知りたい/教えて』はデータ照会」)。 |

### 補足
- gpt-5-mini は **reasoning モデル**。`max_completion_tokens` が小さいと reasoning トークンで枯渇し `content` が空になりうる (今回は 2048 で足りたが、出力が長い agent では注意)。
- 多ターン文脈 (「さっきの goldenId 使って」) は本プロトタイプでは未対応 (`saveMemoryFlow` は `vars.messages` 前提で、新パイプラインでは空配列を保存)。横展開時に必要なら、抽出器に直近ターンを渡すか、ルータで前ターン entities をマージする設計を足す。

---

## 検証結果 (v1.9.6, 2026-05-30)

| 入力 | 分類 intent | 結果 |
|---|---|---|
| 「九州製作所のインシデントの一覧をしりたい」 | `list_incidents` | ✅ 一覧テーブル (severity を聞かない) |
| 「九州製作所のインシデントを教えて」 | `list_incidents` | ✅ 一覧テーブル |
| 「INC-2026-0579 はどんな状態?」 | `lookup_incident` | ✅ 1 件詳細 |
| 「G-KYUSHU-MFG-001 の P-2024-KYU-001 を登録して」(severity 欠落) | `register_incident` | ✅ **severity だけ** NEED_INFO |
| 「… severity HIGH で登録して」(全揃い) | `register_incident` | ✅ MCP 登録 → incidentId 採番 |
| 「君は何ができるの?」 | `capability` | ✅ 能力説明 |
| 「横浜倉庫の在庫を仮確保して」 | `out_of_scope` | ✅ 担当外案内 |

---

## 関連ファイル

- 実装: `atelier-agents/incident-agent/src/main/mule/incident-agent.xml`
  - `intentExtractFlow` (LLM 抽出) / `intentRouterFlow` (決定論ルータ) が本改善の中核。
  - 旧 `agentLoopFlow` / `agentInferenceFlow` / `agentExecuteToolsFlow` と巨大 `sysPrompt` は **未参照のまま残置** (ロールバック容易のため。横展開後に削除可)。
- デプロイ: `pom-stepa.xml` (Salesforce BG / StepA / BetterTogetherDemo)。
  2-step (`mvn deploy -DskipMuleDeploy=true` で Exchange publish → `mvn deploy -DmuleDeploy` で CH2 デプロイ)。

## 次のステップ (未着手)

1. legal / procurement / logistics / org へ同じ intent 抽出パターンを横展開 (各 agent のドメイン intent で `intentExtractFlow` / `intentRouterFlow` を作る)。
2. 多ターン文脈の復活 (上記「補足」参照)。
3. 旧 tool-use ループ関連の dead code 削除。
