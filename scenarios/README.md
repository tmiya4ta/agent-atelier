# scenarios — import 用 JSON 集

Atelier のサイドバー左下 **import** ボタンから読み込める snapshot。`From file` でローカルから、`From URL` でネットワーク経由 (CORS 越えは dev-server の `/proxy` を経由) で取り込める。

## ファイル

| file | 用途 |
|---|---|
| `scrs-step2.json` | step2 SCRS シナリオを 4 sync A2A agent (**法務 / 調達・在庫 / 物流 / 組織・人事**) で再現。CH2 T1/Sandbox/rootps の URL を埋め込み済み。スクリプト: メイン (INC-2026-0521 全フロー) / Slack 短文フォロー / smoke。 |
| `atelier-demo.json` | Mock A2A サーバ (5180-5183) を立てた状態で動かす旧デモ。Broker 経由 vs no-broker の比較や、エラーケース確認を含む 6 script。 |

## URL から import するときの URL 例

dev-server 同居:

- `http://127.0.0.1:8000/scenarios/scrs-step2.json`
- `/scenarios/scrs-step2.json` (相対 path、同一オリジンの簡略形)

CH2 atelier-static から:

- `https://atelier-static-znutqp.pnwfdv.jpn-e1.cloudhub.io/scenarios/scrs-step2.json`

GitHub raw (リポジトリ public 化済):

- `https://raw.githubusercontent.com/tmiya4ta/agent-atelier/main/scenarios/scrs-step2.json`

> 外部オリジンは Atelier dev-server / atelier-static の `/proxy?url=...` を自動で挟むので、CORS が無くても通る。

## エージェント名規約

`scrs-step2.json` のウインドウ display name は **日本語** で固定:

- 法務 → `atelier-legal-agent`
- 調達・在庫 → `atelier-procurement-agent` (代替部品検索 / 在庫確認 / 発注ドラフト / サプライヤー通知)
- 物流 → `atelier-logistics-agent` (出荷側: 元予約キャンセル / 代替仮確保)
- 組織・人事 → `atelier-org-agent` (バイヤー検索 / 承認依頼)

DSL (`> 法務: ...` `< 法務 240s` 等) も日本語名を使う。`_nameLocked` が import 時に立つので、AgentCard.name (`atelier-legal-agent` 等) では上書きされない。

## ローカル/CH2 切り替え

ローカル `mvn mule:run` で起動した場合、ウインドウの URL を `http://127.0.0.1:8081/` に書き換えれば良いが、4 アプリ同居で port 衝突するので 1 アプリずつ。普通は CH2 にデプロイ済みの方を使う方が楽。
