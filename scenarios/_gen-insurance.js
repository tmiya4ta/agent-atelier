// 保険業界デモ用シナリオ生成スクリプト (insurance-claims.json)
// すべて mock 接続 (emulate: a2a / mcp) で、接続先が無くてもデモが完結する。
//
// 題材: 自動車保険の保険金請求 (追突事故) を、複数部門を横断して処理する。
//   受付(FNOL) → 契約照会(Underwriting) → 損害査定(Claims) → 不正検知(SIU) → 支払(Disbursement)
//   契約データは MCP の「契約データストア」(Policy MDM) に置く。
//
// A 系 = Broker なし (人間が部門を持ち回るハブになる痛み)
// B 系 = Broker あり (1 文で部門横断を自律オーケストレーション)
//
// 実行: node scenarios/_gen-insurance.js  → scenarios/insurance-claims.json を書き出す

const fs = require("fs");
const path = require("path");

// mock:// URL ヘルパ (js/protocols/mock.js の mockUrl と同じ規則)
function slug(name) {
  return String(name || "").trim().toLowerCase()
    .replace(/\s+/g, "-").replace(/[^\w\-぀-ヿ一-龯]/g, "") || "agent";
}
const murl = (name, emu = "a2a") => `mock://${emu}/${slug(name)}`;

// 部門エージェント (mock a2a) と データストア (mock mcp)、Broker。
const AGENTS = [
  { name: "受付",        emulate: "a2a", role: "事故受付 (FNOL)。請求番号を採番し、初動の一次受付を行う。" },
  { name: "契約照会",    emulate: "a2a", role: "契約・引受 (Underwriting)。証券の有効性・補償範囲・免責金額を確認する。" },
  { name: "損害査定",    emulate: "a2a", role: "損害査定 (Claims Adjustment)。修理見積の妥当性と過失割合を評価する。" },
  { name: "不正検知",    emulate: "a2a", role: "不正調査 (SIU)。重複請求や不審指標をスクリーニングする。" },
  { name: "支払",        emulate: "a2a", role: "支払 (Disbursement)。支払可否と確定金額を判定し送金する。" },
  { name: "契約データストア", emulate: "mcp", role: "契約マスタ (Policy MDM)。証券・契約者・補償の参照を提供する MCP サーバ。",
    mockTools: [
      { name: "getPolicy", description: "証券番号から契約を取得する",
        inputSchema: { type: "object", properties: { policyId: { type: "string", description: "証券番号 (例 POL-2024-0042)" } }, required: ["policyId"] },
        mockResult: { policyId: "POL-2024-0042", holder: "田中 一郎", product: "自動車保険 (車両+対物+対人)",
          status: "有効", effective: "2024-04-01", expires: "2025-03-31",
          coverage: { vehicle: 3000000, property: "無制限", liability: "無制限" }, deductible: 50000 } },
      { name: "getClaimsHistory", description: "契約者の過去請求履歴を取得する",
        inputSchema: { type: "object", properties: { holderId: { type: "string", description: "契約者 ID または証券番号" } }, required: ["holderId"] },
        mockResult: { holder: "田中 一郎", pastClaims: [ { id: "CLM-2022-1180", type: "車両", amount: 120000, status: "支払済" } ], fraudFlags: 0 } }
    ] }
];

const BROKER = { name: "保険オーケストレーター", emulate: "a2a",
  role: "保険金請求コンシェルジュ。受付・契約照会・損害査定・不正検知・支払の各部門を横断して束ねる Broker。" };

// bookmark エントリ生成
function bm(a) {
  const url = murl(a.name, a.emulate);
  const e = { key: `mock::${url}`, protoId: "mock", url, name: a.name,
    auth: "", authRef: undefined, persona: "", channel: "", emulate: a.emulate };
  if (a.mockTools) e.mockTools = a.mockTools;
  return e;
}
function win(a, pos) {
  const url = murl(a.name, a.emulate);
  const config = { url, name: a.name, auth: "", persona: "", channel: "", emulate: a.emulate };
  if (a.mockTools) config.mockTools = a.mockTools;
  return { protoId: "mock", config, pos, activeTab: a.emulate === "mcp" ? "tools" : "chat", pinned: false };
}

// WS1: 個別部門 6 窓 (2 行 x 3 列)
const W = 470, H = 340, GX = 12, GY = 12, X0 = 14, Y0 = 14;
const grid6 = AGENTS.map((a, i) => {
  const col = i % 3, row = Math.floor(i / 3);
  return win(a, {
    left: `${X0 + col * (W + GX)}px`, top: `${Y0 + row * (H + GY)}px`,
    width: `${W}px`, height: `${H}px`, zIndex: String(210 + i)
  });
});
// WS2: Broker 1 窓 (中央大きめ)
const brokerWin = win(BROKER, { left: "120px", top: "40px", width: "820px", height: "560px", zIndex: "220" });

// ── 台本 (scripts) ──────────────────────────────────────
// `<` 送信 / `$>` mock 応答 (対称)。改行は \n、応答内改行は \\n (parseMocks が展開)。
const NL = "\\n";  // mock 応答内の改行 (JSON.stringify で "\\n" に出力される)

const scripts = [
  {
    id: "A0", name: "A0 — Broker なし: 請求の横断照会を 4 部門に持ち回る",
    body: [
      "# ─────────────────────────────────────────",
      "# A0. Broker なし — 保険金請求の状況を人間が部門横断で「照会」",
      "# 自動車事故 (追突) の請求。証券 POL-2024-0042 / 田中一郎。",
      "# Broker が無いので、契約→査定→不正→支払 を 1 つずつ開いて",
      "# 同じ証券番号を毎回打ち込み、4 つの答えを人間が突き合わせる。",
      "# ─────────────────────────────────────────",
      "",
      "clear",
      "sleep 1s",
      "",
      "# 1) 契約照会 — 証券の有効性と補償",
      "< 契約照会: 証券 POL-2024-0042 (田中一郎) は有効ですか? 対物・車両の補償範囲と免責金額を教えてください。",
      "> 契約照会 90s",
      `$> 契約照会: 📄 契約照会 (Underwriting)${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| 証券 | **POL-2024-0042** |${NL}| 契約者 | 田中 一郎 |${NL}| 状態 | **有効** (2024-04-01〜2025-03-31) |${NL}| 車両補償 | ¥3,000,000 |${NL}| 対物 | 無制限 |${NL}| 免責金額 | ¥50,000 |`,
      "sleep 2s",
      "",
      "# 2) 損害査定 — 見積の妥当性と過失割合",
      "< 損害査定: 追突事故の修理見積 ¥850,000 は妥当ですか? 過失割合の見立ても教えてください。",
      "> 損害査定 90s",
      `$> 損害査定: 🔧 損害査定 (Claims)${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| 見積 | ¥850,000 |${NL}| 妥当性 | 概ね妥当 (相場 ¥780,000〜¥900,000) |${NL}| 過失割合 | 当方 **0** : 相手 **10** (追突され) |${NL}| 査定額 | ¥820,000 (免責控除前) |`,
      "sleep 2s",
      "",
      "# 3) 不正検知 — 重複・不審指標",
      "< 不正検知: 田中一郎 / POL-2024-0042 のこの請求に不審な点や重複請求はありますか?",
      "> 不正検知 90s",
      `$> 不正検知: 🛡️ 不正調査 (SIU)${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| 重複請求 | なし |${NL}| 過去フラグ | 0 件 |${NL}| リスクスコア | **0.12** (低) |${NL}| 判定 | 通常処理で可 |`,
      "sleep 2s",
      "",
      "# 4) 支払 — 支払可否と金額 (終着)",
      "< 支払: 上記を踏まえ、この請求の支払可否と確定金額を教えてください。免責 ¥50,000 を控除してください。",
      "> 支払 90s",
      `$> 支払: 💴 支払 (Disbursement)${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| 査定額 | ¥820,000 |${NL}| 免責控除 | −¥50,000 |${NL}| **支払額** | **¥770,000** |${NL}| 可否 | **承認可** |`,
      "# まとめ: 1 件の請求を見るのに 4 部門を順に開き、同じ証券番号を何度も打ち込み、",
      "# 4 つの答えを人間が頭の中で突き合わせた。これを Broker は 1 文で肩代わりする (→ B0)。"
    ].join("\n"),
    createdAt: 0, updatedAt: 0
  },
  {
    id: "A1", name: "A1 — Broker なし: 担当外で弾かれ、次の部門へ持ち回る",
    body: [
      "# ─────────────────────────────────────────",
      "# A1. Broker なし — 各部門は自領域では賢いが、担当外はきっぱり断る。",
      "# 人間が受付→契約→査定→不正→支払 と文脈を手で運ぶ (たらい回し)。",
      "# ─────────────────────────────────────────",
      "",
      "clear",
      "sleep 1s",
      "",
      "# 1) 受付 — 事故受付・請求番号採番",
      "< 受付: 田中一郎さん (証券 POL-2024-0042) が追突事故。相手に追突され、車両後部破損。人身なし。新規の保険金請求として受け付けてください。",
      "> 受付 90s",
      `$> 受付: ✅ 請求を受け付けました。${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| 請求番号 | **CLM-20260609-0007** |${NL}| 証券 | POL-2024-0042 |${NL}| 事故区分 | 追突 (被害) |${NL}| status | OPEN |`,
      "sleep 2s",
      "# ↓『ついでに補償範囲も』→ 担当外で弾かれる",
      "< 受付: ついでにこの証券の補償範囲と免責も教えて。",
      "> 受付 60s",
      `$> 受付: その照会は受付の担当外です。${NL}補償・免責は「契約照会」、査定は「損害査定」、不正確認は「不正検知」、支払は「支払」へ。`,
      "sleep 2s",
      "",
      "# 2) 契約照会 — 人間が証券番号を持ち込む",
      "< 契約照会: POL-2024-0042 の補償範囲 (車両・対物) と免責金額を教えてください。",
      "> 契約照会 90s",
      `$> 契約照会: 📄 契約照会 (Underwriting)${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| 状態 | 有効 |${NL}| 車両補償 | ¥3,000,000 |${NL}| 対物 | 無制限 |${NL}| 免責 | ¥50,000 |`,
      "sleep 2s",
      "",
      "# 3) 損害査定 — 見積の妥当性",
      "< 損害査定: 修理見積 ¥850,000 の妥当性と過失割合を査定してください。",
      "> 損害査定 90s",
      `$> 損害査定: 🔧 損害査定 (Claims)${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| 妥当性 | 妥当 |${NL}| 過失 | 当方0 : 相手10 |${NL}| 査定額 | ¥820,000 |`,
      "sleep 2s",
      "",
      "# 4) 不正検知 — スクリーニング",
      "< 不正検知: CLM-20260609-0007 / 田中一郎 に不審指標や重複はありますか?",
      "> 不正検知 90s",
      `$> 不正検知: 🛡️ SIU${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| リスクスコア | 0.12 (低) |${NL}| 重複 | なし |${NL}| 判定 | 通常処理可 |`,
      "sleep 2s",
      "",
      "# 5) 支払 — 確定 (終着) → 受付に戻ってクローズ",
      "< 支払: 査定 ¥820,000、免責 ¥50,000 控除で支払額を確定してください。",
      "> 支払 90s",
      `$> 支払: 💴 支払 (Disbursement)${NL}${NL}| 項目 | 値 |${NL}|---|---|${NL}| 支払額 | **¥770,000** |${NL}| 可否 | 承認可 |`,
      "sleep 2s",
      "< 受付: CLM-20260609-0007 を支払承認済みでクローズしてください。",
      "> 受付 60s",
      `$> 受付: ✅ **CLM-20260609-0007** を **CLOSED (支払済)** に更新しました。`,
      "# まとめ: 各部門は自領域では即答したが、隣は全部「○○へ」と弾いた。",
      "# 人間が請求番号と証券番号を手で運び、5 部門をたらい回し。これを Broker が肩代わりする (→ B1)。"
    ].join("\n"),
    createdAt: 0, updatedAt: 0
  },
  {
    id: "B0", name: "B0 — Broker あり: 1 文で請求を横断照会",
    body: [
      "# ─────────────────────────────────────────",
      "# B0. Broker あり — A0 の 4 部門横断照会を 1 文で。",
      "# Broker が契約/査定/不正/支払 を呼び、1 つの回答に統合する。",
      "# ─────────────────────────────────────────",
      "",
      "clear",
      "sleep 1s",
      "",
      "< 保険オーケストレーター: 証券 POL-2024-0042 (田中一郎) の追突事故・修理見積 ¥850,000 について、補償範囲・査定の妥当性・不正リスク・最終支払見込みを横断的に教えてください。",
      "> 保険オーケストレーター 300s",
      `$> 保険オーケストレーター: 確認しました。要点は以下の通りです。${NL}${NL}**契約照会**${NL}- 証券 POL-2024-0042 は有効。車両 ¥3,000,000 / 対物 無制限 / 免責 ¥50,000。${NL}${NL}**損害査定**${NL}- 見積 ¥850,000 は相場内。過失 当方0:相手10。査定額 ¥820,000。${NL}${NL}**不正検知**${NL}- リスクスコア 0.12 (低)、重複・過去フラグなし。通常処理可。${NL}${NL}**支払見込み**${NL}- 査定 ¥820,000 − 免責 ¥50,000 = **¥770,000** を承認可。${NL}${NL}次の対応案: 請求の正式受付 / 支払承認 / 相手保険会社への求償。どれを進めますか?`,
      "# Broker が 4 部門を 1 度に横断照会し、1 つの回答に統合。",
      "# A0 で人間が 4 窓口を持ち回ったのと同じ情報が、1 文で揃う。"
    ].join("\n"),
    createdAt: 0, updatedAt: 0
  },
  {
    id: "B1", name: "B1 — Broker あり: 請求処理を自律オーケストレーション",
    body: [
      "# ─────────────────────────────────────────",
      "# B1. Broker あり — A1 で人間が持ち回った請求処理を Broker が自律実行。",
      "# 1 文投げるだけで: 受付採番 → 契約/査定/不正 を並列 → 支払確定 まで。",
      "# ─────────────────────────────────────────",
      "",
      "clear",
      "sleep 1s",
      "",
      "< 保険オーケストレーター: 田中一郎さん (証券 POL-2024-0042) が追突事故 (被害)。修理見積 ¥850,000、人身なし。新規の保険金請求として一連の処理を進めてください。",
      "> 保険オーケストレーター 300s",
      `$> 保険オーケストレーター: 請求を受け付け、各部門を稼働させました。${NL}請求番号: **CLM-20260609-0042**${NL}証券: POL-2024-0042 (田中一郎)${NL}${NL}【受付】事故区分 追突(被害) で起票。status OPEN。${NL}【契約照会】証券有効。車両 ¥3,000,000 / 対物 無制限 / 免責 ¥50,000。${NL}【損害査定】見積 ¥850,000 妥当。過失 当方0:相手10。査定額 ¥820,000。${NL}【不正検知】リスクスコア 0.12 (低)、重複なし。通常処理可。${NL}【支払】査定 ¥820,000 − 免責 ¥50,000 = **¥770,000** を承認。送金キュー登録済。${NL}${NL}相手 (加害) 側への求償も起票可能です。実行しますか?`,
      "# Broker が返す統合レポートに、請求番号・証券・査定・不正・支払 (¥770,000) が",
      "# 1 度の応答で揃う。これが Agent Network の価値 = 部門横断の自律オーケストレーション。"
    ].join("\n"),
    createdAt: 0, updatedAt: 0
  }
];

const out = {
  app: "atelier",
  exportedAt: "2026-06-09T00:00:00.000Z",
  _doc: "保険業界デモ — 自動車保険の保険金請求 (追突事故) を部門横断で処理。すべて mock 接続 (実エンドポイント不要)。受付/契約照会/損害査定/不正検知/支払 (a2a) + 契約データストア (mcp) + 保険オーケストレーター (broker, a2a)。A 系=Broker なし (人間が持ち回る)、B 系=Broker あり (1 文で横断)。WS1=個別部門 6 窓、WS2=Broker 1 窓。SCRS とは別物の汎用シナリオ。",
  state: {
    v: 1, zoom: 1, sidebarCollapsed: false, theme: "light",
    catalogs: [],
    scripts,
    selectedScriptId: "B1",
    bookmarks: [ ...AGENTS.map(bm), bm(BROKER) ],
    activeWsIdx: 0,
    workspaces: [
      { name: "保険 — 部門別 (A 系)", windows: grid6 },
      { name: "保険 — Broker (B 系)", windows: [brokerWin] }
    ]
  }
};

const dest = path.join(__dirname, "insurance-claims.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("wrote", dest, "bytes:", fs.statSync(dest).size);
