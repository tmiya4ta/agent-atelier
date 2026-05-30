# エージェント・ケーパビリティ拡張 設計メモ

**対象**: `atelier-agents` の 4 worker (legal / procurement / logistics / org)
**作成**: 2026-05-31
**ステータス**: 企画・設計のみ（実装は別途）

---

## TL;DR

現状、全 worker は **「品質インシデント対応」という 1 シナリオ (SCRS デモ) に必要な最小ツールだけ**を実装している。各ドメインの実務はもっと広い。本メモは「各エージェントが本来やること」を洗い出し、**既存 MCP backend で今すぐ足せるもの / backend 拡張が要るもの**に仕分けして、拡張の優先順位を示す。

---

## 現状のケーパビリティ（実装済み）

### worker が使っている MCP tool

| worker | scope×mode | 使用 MCP tool | backend |
|---|---|---|---|
| **legal** | legal (advise/execute) | `get_quality_agreement` / `generate_return_request` / `send_penalty_notice` / `resolve_supplier` | mcp-contract, mcp-mdm |
| **procurement** | procurement (advise/execute) | `get_alternative_parts` / `create_purchase_order_draft` | mcp-procurement |
| **logistics** | logistics (advise/execute) | `check_inventory` / `reserve_inventory` / `cancel_inventory_reservation` | mcp-inventory |
| **org** | org (advise/execute) | `find_best_buyer` / `send_approval_request` | mcp-hr |

### MCP backend が実装済みの tool（= 土台）

| MCP | 実装済み tool |
|---|---|
| **mcp-inventory** | check_inventory / reserve_inventory / cancel_inventory_reservation |
| **mcp-procurement** | get_alternative_parts / create_purchase_order_draft / **notify_supplier** ← agent 未配線 |
| **mcp-contract** | (dispatch 実装なし — 要確認) |
| **mcp-hr** | find_best_buyer / send_approval_request |
| **mcp-mdm** | find_suppliers_for_part / get_supplier_relations / list_incidents / list_part_alternatives / list_parts / list_regions / list_suppliers / resolve_part / resolve_supplier / update_ontology / update_supplier_risk_score |

**気づき**:
- MDM は 11 tool と充実。worker から使い切れていない（`list_*` 系・`resolve_part`・`update_supplier_risk_score` 等は宝の山）。
- procurement の `notify_supplier` は backend にあるが agent の few-shot/router に未配線 → **即追加可能**。
- backend が最小なので、多くの拡張は MCP 側にも tool 追加が要る（= 2 層の作業）。

---

## 拡張例（ドメイン別）

各項目に **[即可]** (既存 MCP tool で配線だけ) / **[要backend]** (MCP に tool 追加要) / **[要外部]** (新 backend/外部 API 要) のタグを付す。

### 🚚 logistics（物流）— 今は在庫照会・仮確保だけ

| 追加 intent/mode | 説明 | MCP tool | 区分 |
|---|---|---|---|
| 在庫一覧・横断照会 | 全倉庫の在庫サマリ、部品横断 | (mdm `list_parts` 流用 or 新) | [要backend] |
| 倉庫間移送 | K-1F→大阪 など拠点間転送 | `transfer_inventory` (新) | [要backend] |
| 輸送手配 | キャリア選定・配送ルート・追跡番号 | `arrange_shipment` (新) | [要backend] |
| リードタイム/コスト試算 | 配送日数・送料見積 | `estimate_delivery` (新) | [要backend] |
| 入荷予定 (ASN) 登録 | 入荷予定の登録・照会 | `register_asn` (新) | [要backend] |
| 返送物流 | 不良品回収 (リバース) — インシデント連動 | `arrange_return_pickup` (新) | [要backend] |
| 補充アラート | 発注点割れ検知 | `check_reorder_point` (新) | [要backend] |

→ logistics は最も拡張余地が大きい。**mode を advise/execute の 2 値から、ツール別 intent (incident 型) に作り替える**のが自然（incident-agent と同じ設計に寄せる）。

### 📦 procurement（調達）

| 追加 | 説明 | MCP tool | 区分 |
|---|---|---|---|
| サプライヤー通知 | 発注・是正の連絡 | `notify_supplier` | **[即可]** (backend 済) |
| 相見積 (RFQ) | 複数社へ見積依頼 | `request_quote` (新) | [要backend] |
| 発注確定/変更/取消 | ドラフト→確定のライフサイクル | `confirm_po` / `cancel_po` (新) | [要backend] |
| 入荷検収 | 検収登録・差異処理 | `receive_goods` (新) | [要backend] |
| サプライヤー評価 | 納期遵守率・品質スコア | mdm `get_supplier_relations` + 集計 | [要backend] |
| 単価・契約管理 | 年間契約・ボリューム判定 | `get_price_agreement` (新) | [要backend] |

### ⚖️ legal（法務）

| 追加 | 説明 | MCP tool | 区分 |
|---|---|---|---|
| 契約レビュー | リスク条項チェック・雛形比較 | `review_contract` (新) | [要backend] |
| 契約更新管理 | 期限アラート・自動更新確認 | `list_contract_renewals` (新) | [要backend] |
| コンプラ照合 | 輸出規制・制裁リスト・下請法 | `check_compliance` (新) | [要外部] |
| リスクスコア更新 | サプライヤーリスク引上げ | mdm `update_supplier_risk_score` | **[即可]** (backend 済) |
| 紛争・係争管理 | クレーム履歴・和解条件 | `log_dispute` (新) | [要backend] |

→ legal は mcp-contract の dispatch 実装が見当たらない（HTTP/別実装の可能性）。**まず legal が実際にどう get_quality_agreement を叩いているか確認**が要る。

### 👥 org（組織・人事）

| 追加 | 説明 | MCP tool | 区分 |
|---|---|---|---|
| 組織図照会 | 部門構成・レポートライン・代理承認者 | `get_org_chart` (新) | [要backend] |
| 多段承認ワークフロー | エスカレーション・代決 | `escalate_approval` (新) | [要backend] |
| スキル・要員検索 | 特定スキル保有者・稼働状況 | `find_by_skill` (新) | [要backend] |
| 権限・承認限度額 | 誰が何を承認できるか | `check_approval_authority` (新) | [要backend] |
| オンコール当番 | 緊急時の担当者割当 | `get_oncall` (新) | [要backend] |

---

## 設計上の論点

1. **scope×mode 型 vs intent 型**: 現 4 worker は「1 業務 × advise/execute」の scope×mode 型。ツールが増えると mode 2 値では足りない。incident-agent の **intent 列挙型に寄せる**のが拡張に強い（ツール = intent で 1:1）。
2. **2 層の作業**: 多くの拡張は worker (intent/few-shot/router) + MCP backend (tool 実装 + Salesforce/データソース) の両方が要る。**[即可] のものから着手**するのが費用対効果が高い:
   - procurement に `notify_supplier` 配線
   - legal に `update_supplier_risk_score` 配線（リスクスコア引上げ）
   - 各 worker に MDM の `list_*` 系を「照会」intent として配線
3. **out_of_scope 境界の再設計**: ケーパビリティが増えると「担当外」の線引きも変わる。few-shot の out_of_scope 例も追従が必要（[[a2a-agent-design]] のドメイン境界設計参照）。
4. **デモのスコープ**: SCRS デモは「インシデント対応」の筋。ケーパビリティを増やしすぎるとデモの主筋がぼやける。**「インシデント対応で自然に使う範囲」**（例: logistics の返送物流、procurement の発注確定、legal のリスクスコア）から優先的に。

---

## 推奨着手順（費用対効果順）

1. **[即可] 既存 backend tool の配線**（worker 変更のみ、最小コスト）
   - procurement ← `notify_supplier`
   - legal ← `update_supplier_risk_score`（リスクスコア引上げ）
   - 各 worker ← MDM `list_*`（照会系を「調べる」mode に追加）
2. **logistics を intent 型に作り替え + 返送物流/輸送手配を追加**（インシデント対応で自然に使う）
3. **procurement の発注ライフサイクル（確定/取消）**
4. それ以降はデモ要件次第で backend 拡張

## 関連
- 実装パターン: [[a2a-agent-design]]（intent 抽出 → 決定論ルータ、scope×mode vs intent 型、out_of_scope 設計）
- 現状の intent 一覧: 本リポジトリ各 `atelier-agents/<agent>/src/main/mule/<agent>-agent.xml` の extractor sys 定義
