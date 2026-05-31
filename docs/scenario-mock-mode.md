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

## データ形式 (台本インライン `$>`)

mock 応答は **台本 (`body`) の中にインライン**で書く。直前の送信/待機に紐づく `$>` 行として並べるので、台本とモックが 1 つのテキストで完結し、エディタからそのまま編集できる:

```
< インシデント: 九州製作所の P-2024-KYU-001 で品質トラブル。登録して。
> インシデント 90s
$> ✅ インシデントを登録しました。\n\n| 項目 | 値 |\n|---|---|\n| incidentId | INC-... |

< 法務: 九州製作所の不良 15% について返品請求できますか?
> 法務 60s
$> ⚖️ 法務エージェント (相談)\n\n| 項目 | 値 |\n|---|---|\n| 取引先 | G-KYUSHU-MFG-001 |
```

### 構文・解決規則
- `$> <応答>`: 直前の `> <window>` (無ければ直前の `< <window>:`) に紐づく mock 応答。**window 名は書かない**。
- 改行は `\n` リテラルで表現 (`$>` は 1 行)。`parseMocks` が実改行に展開する。
- 同じ window に複数回送る台本 (例: A1 の incident は 起票 → ついで法務で弾かれ → 最後にクローズ) は、**送信順に `$>` を並べる**。n 回目の send が n 番目の `$>` を取る (順番消費型 `_mockResolve`)。
- 応答が尽きた場合のフォールバック: `"⚠️ (mock) 応答が尽きました: <入力先頭40字>"` (デモ中に気づける)。
- **mock OFF 時は `$>` 行はコメント同様 no-op** (実行されず、ハイライトも dim)。`# コメント` と同じ扱いになるので、同じ台本を実通信モードでもそのまま流せる。
- (旧仕様の JSON `mocks` キーは廃止。`runScript` は `parseMocks(text)` だけを見る。)

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
   - ON → `parseMocks(text)` で台本の `$>` を `{ "<window>": ["応答1", ...] }` に畳み、対象 window に `win.adapter.mockInstall(dict[winName])` を呼び、state を "open" に。
   - 実行後 (finally) → `win.adapter.mockRestore()` で元の send/state に戻す。
3. **`$>` が無いスクリプトで mock ON** → ログに警告 + 実行は通常どおり (実通信)。
4. **ハイライト**: mock トグルで `updateScriptHighlight()` を呼び、`$>` 行を ON=mock 色 / OFF=コメント dim に切り替える。

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
- 実装の中心: `js/script.js` (`$>` parser + `parseMocks`), `js/protocols/base.js` (mockInstall/Restore + 順番消費型 `_mockResolve`), `js/window.js` (sendProgrammatic/waitForReply は変更不要), `js/app.js` (runScript 配線 + `$>` ハイライト), `scenarios/scrs-a.json` (`$>` インライン)
- 既存 `js/protocols/mock.js` は汎用ペルソナ用で別物 (今回は使わない or 参考)
