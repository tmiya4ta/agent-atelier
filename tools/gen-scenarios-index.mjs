#!/usr/bin/env node
// scenarios/*.json をスキャンして scenarios/index.json を生成する。
//
// Atelier UI の Import → Repository はこの index.json を GitHub raw から読む
// (ui/js/app.js の SCENARIO_REPO_RAW)。 スナップショットを追加/削除したら
// このスクリプトを走らせれば一覧が追従する。 CI (.github/workflows/scenarios-index.yml)
// が push のたびに実行するので、 手で走らせるのは動作確認のときだけでよい。
//
//   node tools/gen-scenarios-index.mjs           # 生成して書き込む
//   node tools/gen-scenarios-index.mjs --check    # 差分があれば exit 1 (書き込まない)
//
// 各スナップショットは任意で meta を持てる。 無ければファイル名と中身の
// 件数から自動生成する。
//
//   { "meta": { "name": "…", "description": "…", "order": 10 }, "state": { … } }

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR       = join(ROOT, "scenarios");
const INDEX     = join(DIR, "index.json");
const INDEX_REL = "scenarios/index.json";

const check = process.argv.includes("--check");

// ファイル名 → 表示名。 "AI-Workshop-Step1" → "AI Workshop Step1"
function titleFromFile(file) {
  return file.replace(/\.json$/i, "").replace(/[-_]+/g, " ").trim();
}

// 中身から「何が入っているか」を一言で説明する。 name/description が
// meta に無いときのフォールバック。
function describe(counts) {
  const parts = [];
  if (counts.workspaces) parts.push(`${counts.workspaces} workspace${counts.workspaces === 1 ? "" : "s"}`);
  if (counts.bookmarks)  parts.push(`${counts.bookmarks} connection${counts.bookmarks === 1 ? "" : "s"}`);
  if (counts.scripts)    parts.push(`${counts.scripts} scenario${counts.scripts === 1 ? "" : "s"}`);
  if (counts.identities) parts.push(`${counts.identities} identit${counts.identities === 1 ? "y" : "ies"}`);
  return parts.length ? parts.join(", ") : "empty snapshot";
}

function count(v) { return Array.isArray(v) ? v.length : 0; }

const files = readdirSync(DIR)
  .filter(f => f.endsWith(".json") && f !== "index.json")
  .sort();

const items = [];
const problems = [];

for (const file of files) {
  let snap;
  try {
    snap = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  } catch (e) {
    problems.push(`${file}: invalid JSON — ${e.message}`);
    continue;
  }
  const st   = snap?.state ?? snap ?? {};
  const meta = snap?.meta ?? {};
  const counts = {
    workspaces: count(st.workspaces),
    bookmarks:  count(st.bookmarks),
    scripts:    count(st.scripts),
    identities: count(st.identities)
  };
  items.push({
    id:          file.replace(/\.json$/i, ""),
    // 先頭 / は必須。 GitHub raw では base に連結され、 同一オリジンへ
    // フォールバックしたときは verbatim で使われるため、 相対パスだと
    // 現在のパス基準で解決されて壊れる。
    url:         `/scenarios/${file}`,
    name:        meta.name || titleFromFile(file),
    description: meta.description || describe(counts),
    // UI が import scope を決めるのに使う。 scenarios が 0 の
    // スナップショットは "Scenarios only" では取り込めない。
    counts,
    ...(snap?.exportedAt ? { exportedAt: snap.exportedAt } : {}),
    ...(Number.isFinite(meta.order) ? { order: meta.order } : {})
  });
}

if (problems.length) {
  console.error("scenarios/ に読めないファイルがあります:\n  " + problems.join("\n  "));
  process.exit(1);
}

// order があれば優先、 無いものは末尾でファイル名順。 毎回同じ並びになるよう
// 決定的にソートする (index.json が実行のたびに churn しないように)。
items.sort((a, b) => {
  const ao = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
  const bo = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
  return ao - bo || a.id.localeCompare(b.id);
});

// generatedAt のようなタイムスタンプは入れない。 中身が変わっていないのに
// 毎回 diff が出て、 CI が無意味な commit を積むため。
const next = JSON.stringify({ v: 1, items }, null, 2) + "\n";

let current = null;
try { current = readFileSync(INDEX, "utf8"); } catch {}

if (current === next) {
  console.log(`${INDEX_REL} は最新です (${items.length} items)`);
  process.exit(0);
}

if (check) {
  console.error(`${INDEX_REL} が古いです。 node tools/gen-scenarios-index.mjs を実行してください。`);
  process.exit(1);
}

writeFileSync(INDEX, next);
console.log(`${INDEX_REL} を書き出しました (${items.length} items)`);
