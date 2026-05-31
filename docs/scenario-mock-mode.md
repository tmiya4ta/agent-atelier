# シナリオ・モックモード 設計メモ

**対象**: Atelier UI のスクリプト実行 (script DSL / ScriptRunner)
**作成**: 2026-05-31
**目的**: オフライン / 実エージェント不要でシナリオを流せるようにする。CloudHub のエージェントが落ちていても、ネットが無くても、スクリプトを実行すると SCRS らしい応答が返る (展示会・リハーサル・LLM 不安定時の保険)。

---

## 要件

- **用途**: オフラインデモ。実エージェント (StepA/StepB) に一切繋がず、ローカルだけで完結。
- **応答の持ち方**: シナリオ JSON に埋め込む (台本とモック応答が同じファイルで一致、自己完結)。
- **見た目**: 本番と同じであること (typewriter・チャット表示・debug タブの RPC フレーム)。デモ映え最優先 → **adapter 層**で差し込む。
- **トグル**: スクリプトパネルから mock ON/OFF を切り替え。OFF で実通信に戻る。

---

## アーキテクチャ判断

### なぜ adapter 層か
- ScriptRunner は `win.sendProgrammatic()` / `win.waitForReply()` を呼ぶだけ。これらは `this.adapter.send()` と adapter の `message` イベントに依存している。
- **adapter の `send` をモックに乗っ取れば**、window・ScriptRunner・UI は一切変えずに、typewriter も debug タブも本番同様に動く。

### なぜ adapter インスタンスを作り替えないか
- window は constructor で `this.adapter` を受け取り、open/message/rpc/error/close を bind 済み (window.js:239-290)。
- adapter を別インスタンスに差し替えるとイベント再 bind が必要で複雑・壊れやすい。
- → **同一 adapter インスタンスの `send` メソッドだけを上書き** (`mockInstall` / `mockRestore`)。state も擬似的に "open" にする。元の send は退避して OFF で復帰。

---

## データ形式 (シナリオ JSON 埋め込み)

各 script に `mocks` を追加 (省略時は mock 不可)。**window 名 × 入力パターン → 応答** の辞書:

```jsonc
{
  "id": "A1",
  "name": "...",
  "body": "...",
  "mocks": {
    "インシデント": [
      { "match": "登録",   "reply": "✅ インシデントを登録しました。\n\n| 項目 | 値 |..." },
      { "match": "ついで", "reply": "その依頼は incident-agent の担当外です。..." }
    ],
    "法務": [
      { "match": "返品", "reply": "⚖️ 法務エージェント (相談)\n\n| 項目 | 値 |..." }
    ],
    "Broker (Agent Network)": [
      { "match": "*", "reply": "重大な品質問題を検知しました。\nインシデント: INC-MOCK-0001\n【調達】...\n【物流】...\n【法務】..." }
    ]
  }
}
```

### マッチ規則
- window 名は **完全一致** (台本の `< 法務:` の `法務` と同じ)。
- `match`: 入力テキストに**含まれる部分文字列**。複数候補は**配列の順 + マッチした中で最初**を採用。
- `"*"` は無条件マッチ (ブローカーのように 1 応答で済むもの)。
- 同じ window に複数回送る台本 (例: A1 の incident は起票→ついで法務の 2 回) は、各送信テキストに対して match で出し分ける。
- マッチ無し時のフォールバック: `"⚠️ (mock) 応答が定義されていません: <入力先頭40字>"` を返す (デモ中に気づける)。

---

## モック adapter の挙動 (本番 a2a.js に寄せる)

`send(text)` 呼び出し時:
1. `rpc` (dir:out, method:"message/send") を emit → debug タブに出る
2. 人工 delay (300〜800ms ランダム。LLM っぽさ。長すぎるとデモがだれる)
3. mocks から応答テキストを解決
4. `message` (role:agent, text, final:true) を emit → typewriter で表示
5. `rpc` (dir:in, method:"200 OK") を emit

`connect()` 相当: mock ON 時に state="open" + 擬似 agentCard を即時セット (ネット fetch 無し)。

---

## トグルと配線

1. **UI**: スクリプトパネルのツールバーに `mock` チェックボックス/トグルを追加。状態は `state.scriptMock` (persist しなくてよい。セッション内のみ)。
2. **runScript**: 開始時に `state.scriptMock` を見て、
   - ON → 対象スクリプトの各 window に `win.adapter.mockInstall(scriptMocks[winName])` を呼び、state を "open" に。
   - 実行後 (finally) → `win.adapter.mockRestore()` で元の send/state に戻す。
3. **mocks が無いスクリプトで mock ON** → ログに警告 + 実行は通常どおり (フォールバック応答が出るだけ)。

---

## 実装ステップ

1. `ProtocolAdapter` (base.js) に `mockInstall(mockEntries)` / `mockRestore()` を追加 (共通実装)。
   - install: 元の `send`/`state`/`agentCard` を退避 → `send` をモック関数に、`state="open"`、擬似 card セット、`open` イベント emit。
   - restore: 退避した値を戻す。
2. `scrs-a.json` の各 script に `mocks` を追加。**応答は実機で実際に返ったテキストを貼る** (前セッションのE2Eログから流用するとリアル)。
3. スクリプトパネルに mock トグル (index.html + app.js)。
4. `runScript` に install/restore の配線。
5. 検証: ネット遮断 (or 存在しない window URL) で A1〜A3 / B1〜B3 を流し、本番同様の表示になることを確認。

---

## 留意点
- mock 中は実際の contextId / 会話履歴は動かない (純粋な台本再生)。多ターン参照 (「さっきの INC」) はモック応答側に固定文言で埋める。
- mocks の応答は**実機の最新フォーマットとずれる**ことがある (agent 改修時)。デモ前に 1 度実機で流して mock を更新する運用を推奨 (将来 "capture モード" で自動化も可)。
- mock ON のまま実通信したい誤操作を防ぐため、トグル状態をパネルに明示 (例: 実行ボタン横に "MOCK" バッジ)。

## 関連
- 実装の中心: `js/protocols/base.js` (mockInstall/Restore), `js/window.js` (sendProgrammatic/waitForReply は変更不要), `js/app.js` (runScript 配線), `scenarios/scrs-a.json` (mocks データ)
- 既存 `js/protocols/mock.js` は汎用ペルソナ用で別物 (今回は使わない or 参考)
