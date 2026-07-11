# scenarios — import 用 JSON 集

Atelier のサイドバー左下 **import** ボタンから読み込める snapshot。`From file` でローカルから、`From URL` でネットワーク経由 (CORS 越えは dev-server の `/proxy` を経由) で取り込める。

## ファイル

| file | 用途 |
|---|---|
| `scrs-a.json` | SCRS シナリオ A (正常系)。インシデント起票 → 法務 / 調達・在庫 / 物流 / 組織・人事 に 1 タスクずつ順次依頼する happy path。Multi Agents workspace (5 ウインドウ)。CH2 T1/Sandbox/rootps の URL を埋め込み済み。 |

## URL から import するときの URL 例

dev-server 同居:

- `http://127.0.0.1:8000/scenarios/scrs-a.json`
- `/scenarios/scrs-a.json` (相対 path、同一オリジンの簡略形)

CH2 atelier-static から:

- `https://atelier-static-znutqp.pnwfdv.jpn-e1.cloudhub.io/scenarios/scrs-a.json`

GitHub raw (リポジトリ public 化済):

- `https://raw.githubusercontent.com/tmiya4ta/agent-atelier/main/scenarios/scrs-a.json`

> 外部オリジンは Atelier dev-server / atelier-static の `/proxy?url=...` を自動で挟むので、CORS が無くても通る。

## エージェント名規約

ウインドウ display name は **日本語** で固定:

- 法務 → `atelier-legal-agent`
- 調達・在庫 → `atelier-procurement-agent` (代替部品検索 / 在庫確認 / 発注ドラフト / サプライヤー通知)
- 物流 → `atelier-logistics-agent` (出荷側: 元予約キャンセル / 代替仮確保)
- 組織・人事 → `atelier-org-agent` (バイヤー検索 / 承認依頼)
- インシデント → `atelier-incident-agent` (インシデント新規登録 / 状態更新 / 検索)

DSL (`> 法務: ...` `< 法務 240s` 等) も日本語名を使う。`_nameLocked` が import 時に立つので、AgentCard.name (`atelier-legal-agent` 等) では上書きされない。

## ローカル/CH2 切り替え

ローカル `mvn mule:run` で起動した場合、ウインドウの URL を `http://127.0.0.1:8081/` に書き換えれば良いが、複数アプリ同居で port 衝突するので 1 アプリずつ。普通は CH2 にデプロイ済みの方を使う方が楽。
