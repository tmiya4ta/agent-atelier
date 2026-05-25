# atelier-agents — Atelier 用 同期 A2A エージェント群

step2 の 4 AI Agent (legal / procurement / logistics / org) を **同期 A2A サーバ**として再パッケージしたもの。Slack を介さず、[Atelier](../agent-atelier/) の chat 入力をそのまま受けて LLM tool-use ループを回し、統合サマリを Atelier に同期で返す。

step2 → ここでの主な置換:

| step2 | atelier-agents |
|---|---|
| 入口 = `POST /slack/events` (APIKit) | 入口 = `<a2a:task-listener>` (mule4-a2a-connector 1.1.1) |
| `vars.evText` (Slack envelope の `event.text`) | `vars.userText` (`payload.message.parts[0].text`) |
| `<async>` で別スレッドにキック → 即 `{ok:true}` を ack | 同期実行。LLM ループの結果を A2A Task response でその場で返す |
| 出口 = `chat.postMessage` (slack.com) | 出口 = `vars.taskJson` (kind=task, status=completed, parts[0].text=finalText) |
| sysPrompt / tools / agentLoopFlow / agentExecuteToolsFlow / callMcpExecuteFlow | **そのまま流用** |
| MCP 接続先 (`mdm-mcp-df8af0...`) | **そのまま流用** (step2 と同じ CH2 ホストを叩く) |
| LLM (`openai-proxy.demos.mulesoft.com`) | **そのまま流用** |

## ディレクトリ

```
atelier-agents/
├── README.md
├── legal-agent/        port 8081  ← contract-mcp + mdm-mcp
├── procurement-agent/  port 8082  ← procurement-mcp + inventory-mcp + mdm-mcp
├── logistics-agent/    port 8083  ← inventory-mcp + mdm-mcp
└── org-agent/          port 8084  ← hr-mcp + mdm-mcp
```

各アプリは独立した Mule application:

```
<agent>/
├── pom.xml                           Mule 4.9.8 / Java 17 / mule4-a2a-connector 1.1.1
├── mule-artifact.json
└── src/main/
    ├── mule/<agent>.xml
    └── resources/config.properties   ← LLM / MCP / port 設定
```

## ローカル起動

それぞれ別ターミナルで:

```bash
cd atelier-agents/legal-agent
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
mvn mule:run -Dllm.token=$LLM_TOKEN
```

```bash
cd atelier-agents/procurement-agent
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
mvn mule:run -Dllm.token=$LLM_TOKEN
```

```bash
cd atelier-agents/logistics-agent
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
mvn mule:run -Dllm.token=$LLM_TOKEN
```

```bash
cd atelier-agents/org-agent
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
mvn mule:run -Dllm.token=$LLM_TOKEN
```

`$LLM_TOKEN` は base64(clientId:clientSecret)。step2 の Anypoint deploy 用の `llm.token` プロパティと同じ値を使う。

起動確認:

```bash
curl -s http://127.0.0.1:8081/health
curl -s http://127.0.0.1:8081/.well-known/agent-card.json | jq .name   # "atelier-legal-agent"
```

JVM が 4 つ並ぶので RAM 8GB 以上推奨。重ければ 1 つずつ立てて scenario を分割実行する。

## Atelier から接続

1. Atelier dev server を立てる:
   ```bash
   cd ../agent-atelier
   python3 server/dev-server.py --port 8000
   ```
   → http://127.0.0.1:8000/
2. 上部 rail の **+ new connection** (⌘N) で 4 回、proto=A2A、URL に以下を入れる:
   - `http://127.0.0.1:8081`  (display name: `legal`)
   - `http://127.0.0.1:8082`  (display name: `procurement`)
   - `http://127.0.0.1:8083`  (display name: `logistics`)
   - `http://127.0.0.1:8084`  (display name: `org`)

   AgentCard が取得できれば各 window が `is-live` (status dot 緑) になる。

3. ⌘⇧K で Script Panel を開いて以下の DSL を貼り、`▶ run` (⌘⏎):

```
> legal: 関西部品 (G-KANSAI-PARTS-001) の P-2024-KAN-001 で不良率15% (500個) が出た。HIGH severity でインシデント INC-2026-0521 として法務対応してほしい。
< legal 240s
sleep 1s
> procurement: 関西部品 G-KANSAI-PARTS-001 の P-2024-KAN-001 で不良率15% (500個 HIGH)。INC-2026-0521。代替部品で調達対応してほしい。
< procurement 240s
sleep 1s
> logistics: INC-2026-0521 関西部品 P-2024-KAN-001 (500個 HIGH) の予約 RSV-2026-1134 をキャンセルし、代替 P-2024-ALT-005 を仮確保してほしい。
< logistics 240s
sleep 1s
> org: INC-2026-0521 関西部品 (G-KANSAI-PARTS-001) の調達担当者を見つけて承認依頼を出してほしい。
< org 240s
```

各 agent ウインドウの **chat** タブにユーザ発話と統合サマリ (`⚖️ legal-agent: ...`, `✅ procurement-agent: ...`, `📦 logistics-agent: ...`, `👥 org-agent: ...`) が並び、**debug** タブで JSON-RPC `message/send` の往復が見える。step2 で Slack に流れていた応答が、そのまま Atelier の画面に出る。

## scenario 再現と step2 との対応

step2 では Slack の `incident-channel` に上記 4 メッセージを投げると、4 agent がそれぞれ独立に応答を `chat.postMessage` していた (順序は async なので不定)。  
atelier-agents では Atelier の Script DSL で **send → wait** を直列化しているので、各 agent の応答が出揃ってから次に進む。並列にしたければ DSL を `<` の wait なしで連続 `>` するだけで OK。

scenario の seed データ (`G-KANSAI-PARTS-001`, `P-2024-KAN-001`, `RSV-2026-1134` 等) は `mule-infa-agent-demo/CLAUDE.md` の「デモ用シードデータの ID 規約」と一致。Salesforce / MCP 側のシードは step2 と同じものを使う。

## トラブルシュート

| 症状 | 確認 |
|---|---|
| AgentCard fetch が 404 | a2a connector が listener を hijack できていない。`mvn mule:run` のログで `A2A` 関連の WARN が出ていないか |
| Atelier で `fetch failed` | dev-server.py が立っていない or `/proxy` 経路が壊れている。直接 `curl http://127.0.0.1:8081/.well-known/agent-card.json` を試す |
| 60s で timeout | LLM の tool-use ループが長い。Atelier DSL を `< name 240s` に上げる (a2a.js の default は 60s) |
| `MCP_CALL_FAILED` | step2 の MCP CH2.0 アプリが落ちている。`curl https://mdm-mcp-df8af0.xdfpbh.jpn-e1.cloudhub.io/health` で確認 |
| `invalid_grant` 系 LLM 401 | `-Dllm.token=` 未指定 or 値が間違い。step2 と同じ token (base64 encoded) を渡す |
| port already in use | 既に同 port で別 Mule が動いている。`config.properties` の `http.listener.port` を一時的に変える |

## ハンドオフ用メモ

- step2 から差分は **入口/出口だけ** を入れ替えた最小変更。sysPrompt / tools / loop は完全コピー。
- `agent.public.url` は AgentCard の `url` フィールドに埋まる値で、Atelier はこれを次の JSON-RPC POST 先に使う。ローカルなら `http://127.0.0.1:<port>/`、CH2 にデプロイするなら `https://<app>-<shard>.cloudhub.io/`。
- 1 アプリ / 4 path にしなかったのは、step2/step3 の慣習 (1 agent = 1 mule app) を踏襲し、各 agent をその場で `mvn mule:run` で個別に再起動できるようにするため。
