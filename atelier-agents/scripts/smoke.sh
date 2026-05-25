#!/usr/bin/env bash
# Smoke test for atelier-agents on CH2 T1/Sandbox/rootps.
# Usage:
#   bash scripts/smoke.sh                    # all 4 agents, agent-card + simple message/send
#   bash scripts/smoke.sh legal              # one agent only
#
# Reads from CH2 ingress (znutqp.pnwfdv.jpn-e1.cloudhub.io shard).
set -u
AGENTS=(legal procurement logistics org)
[ "${1:-}" != "" ] && AGENTS=("$1")

pass=0; fail=0
for name in "${AGENTS[@]}"; do
  base="https://atelier-${name}-agent-znutqp.pnwfdv.jpn-e1.cloudhub.io"
  echo "=== $name : $base ==="

  # 1. health
  if curl -sf -m 10 "$base/health" >/dev/null; then
    echo "  [PASS] /health"
    pass=$((pass+1))
  else
    echo "  [FAIL] /health"
    fail=$((fail+1)); continue
  fi

  # 2. agent-card.json
  card=$(curl -sf -m 10 "$base/.well-known/agent-card.json")
  if echo "$card" | grep -q "\"name\":\"atelier-${name}-agent\""; then
    echo "  [PASS] agent-card.name=atelier-${name}-agent"
    url=$(echo "$card" | grep -oE '"url":"[^"]+"' | head -1)
    echo "         card.$url"
    pass=$((pass+1))
  else
    echo "  [FAIL] agent-card not matching name"
    fail=$((fail+1)); continue
  fi

  # 3. message/send (simple ping; LLM 401 でも A2A レイヤは通るかを見る)
  case "$name" in
    legal)       msg="関西部品 (G-KANSAI-PARTS-001) の P-2024-KAN-001 で不良率15% (500個) HIGH severity / インシデント INC-2026-0521 を法務対応してほしい。" ;;
    procurement) msg="関西部品 G-KANSAI-PARTS-001 の P-2024-KAN-001 で不良率15% (500個 HIGH)。INC-2026-0521。代替部品で調達対応してほしい。" ;;
    logistics)   msg="INC-2026-0521 関西部品 P-2024-KAN-001 (500個 HIGH) の予約 RSV-2026-1134 をキャンセルし、代替 P-2024-ALT-005 を仮確保してほしい。" ;;
    org)         msg="INC-2026-0521 関西部品 (G-KANSAI-PARTS-001) の調達担当者を見つけて承認依頼を出してほしい。" ;;
  esac
  # Body は /tmp/$name-msg.json に書き出して --data-binary で送る (Git Bash の inline -d は日本語が文字化けする)
  tmp="/tmp/atelier-${name}-msg.json"
  cat > "$tmp" <<EOF
{"jsonrpc":"2.0","id":"smoke-1","method":"message/send","params":{"message":{"kind":"message","role":"user","parts":[{"kind":"text","text":"$msg"}],"messageId":"smoke-msg-1"},"configuration":{}}}
EOF
  resp=$(curl -sf -m 240 -H "Content-Type: application/json; charset=utf-8" -H "Accept: application/json" \
    -X POST "$base/" --data-binary "@$tmp")
  if echo "$resp" | grep -q '"kind":"task"'; then
    echo "  [PASS] message/send → task response"
    # extract first text part with grep -oE (no python needed; preserves UTF-8)
    txt=$(echo "$resp" | grep -oE '"text":"[^"]+"' | head -1 | sed 's/^"text":"//; s/"$//')
    echo "         reply: ${txt:0:300}"
    pass=$((pass+1))
  else
    echo "  [FAIL] message/send"
    echo "  $resp" | head -c 300; echo
    fail=$((fail+1))
  fi
done

echo "===================="
echo "TOTAL: $pass pass, $fail fail"
[ $fail -gt 0 ] && exit 1 || exit 0
