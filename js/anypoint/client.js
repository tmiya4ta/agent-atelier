// AnypointClient — Anypoint control-plane API クライアント (leaf モジュール)
//
// app.js の private な state / ensureIdentityToken には触らない。
// token 取得とプロキシ経路は **注入** する設計:
//
//   const client = new AnypointClient({
//     getToken: () => ensureIdentityToken(idn, { rethrow: true }),  // async () => token
//     base:     controlPlaneBase(idn),                              // "https://anypoint.mulesoft.com"
//   });
//   const me   = await client.me();
//   const bgs  = await client.businessGroups();            // [{ id, name }]
//   const envs = await client.environments(orgId);         // [{ id, name, type, isProduction }]
//   const deps = await client.deployments(orgId, envId);   // RTF + CloudHub 2.0 を統合した一覧
//
// 全リクエストは /proxy?url=... 経由 (CORS 回避 + SsrfGuard allowlist)。
//
// 対象ランタイム: Runtime Fabric + CloudHub 2.0 のみ。
//   両者とも Application Manager API v2 (`amc/application-manager/api/v2`) の同一エンドポイントで
//   一覧/詳細が取れる (target.provider / target.targetId で判別)。CloudHub 1.0 / hybrid は対象外。

const AMC = "amc/application-manager/api/v2";

export class AnypointClient {
  constructor({ getToken, base } = {}) {
    if (typeof getToken !== "function") {
      throw new Error("AnypointClient: getToken (async () => token) is required");
    }
    this._getToken = getToken;
    this.base = String(base || "https://anypoint.mulesoft.com").replace(/\/+$/, "");
  }

  // ── low-level ────────────────────────────────────────────
  // path は base 相対 ("accounts/api/me") でも絶対 URL でも可。
  _url(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.base}/${String(path).replace(/^\/+/, "")}`;
  }

  async _req(method, path, { body, headers } = {}) {
    const token = await this._getToken();
    if (!token) throw new Error("AnypointClient: no access token");
    const target = this._url(path);
    const h = { Authorization: `Bearer ${token}`, Accept: "application/json", ...(headers || {}) };
    let payload;
    if (body !== undefined) {
      h["Content-Type"] = h["Content-Type"] || "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res  = await fetch(`/proxy?url=${encodeURIComponent(target)}`, { method, headers: h, body: payload });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error || data.detail))
        || (typeof data === "string" ? data.replace(/<[^>]+>/g, "").trim().slice(0, 200) : "")
        || `HTTP ${res.status}`;
      const err = new Error(`Anypoint ${method} ${path} → ${res.status}: ${msg}`);
      err.status = res.status; err.body = data;
      throw err;
    }
    return data;
  }
  _get(path, opts)         { return this._req("GET",    path, opts); }
  _post(path, body, opts)  { return this._req("POST",   path, { ...opts, body }); }
  _patch(path, body, opts) { return this._req("PATCH",  path, { ...opts, body }); }
  _delete(path, opts)      { return this._req("DELETE", path, opts); }

  // ── Access Management (コンテキスト軸: org / env) ─────────
  me() { return this._get("accounts/api/me"); }

  // password grant では me.user.organization、client_credentials では me.client.org_id しか無い。
  static _rootOrgId(me) {
    return me?.user?.organization?.id || me?.organization?.id
        || me?.user?.organizationId   || me?.client?.org_id || null;
  }

  async rootOrgId() {
    const id = AnypointClient._rootOrgId(await this.me());
    if (!id) throw new Error("no organization id in /me");
    return id;
  }

  // business group (org 階層) を平らにして返す。hierarchy が取れなければ root のみ。
  async businessGroups() {
    const me = await this.me();
    const rootId = AnypointClient._rootOrgId(me);
    if (!rootId) throw new Error("no organization id in /me");
    const rootName = me?.user?.organization?.name || me?.organization?.name || "";
    let nodes;
    try {
      const h = await this._get(`accounts/api/organizations/${rootId}/hierarchy`);
      nodes = flattenOrgTree(h);
    } catch {
      nodes = [{ id: rootId, name: rootName }];
    }
    return nodes.map(n => ({ id: n.id, name: n.name || (n.id === rootId ? rootName : n.id) }));
  }

  async environments(orgId) {
    const j = await this._get(`accounts/api/organizations/${orgId}/environments`);
    const data = j?.data || j?.environments || [];
    return data.map(e => ({ id: e.id, name: e.name, type: e.type, isProduction: !!e.isProduction }));
  }

  // ── Runtime Manager (RTF + CloudHub 2.0 を統合) ──────────
  async deployments(orgId, envId) {
    const j = await this._get(`${AMC}/organizations/${orgId}/environments/${envId}/deployments`);
    const items = j?.items || j?.data || [];
    return items.map(d => normalizeDeployment(d, envId));
  }

  async deployment(orgId, envId, deploymentId) {
    const d = await this._get(`${AMC}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}`);
    return normalizeDeployment(d, envId, /* detail */ true);
  }

  // spec = デプロイのバージョン履歴 (どの artifact/設定で展開されたか)。
  specs(orgId, envId, deploymentId) {
    return this._get(`${AMC}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}/specs`);
  }

  // runtime target 一覧 = RTF fabric + CloudHub 2.0 shared/private space を統合した配信先一覧。
  // deployment.target.targetId は provider="MC" で CH2/RTF を区別しないため、ここで
  // targetId → { name, type } を解決する (type: runtime-fabric / private-space / shared-space)。
  async runtimeTargets(orgId) {
    const j = await this._get(`runtimefabric/api/organizations/${orgId}/targets`);
    const arr = Array.isArray(j) ? j : (j?.items || j?.data || []);
    return arr.map(t => ({ id: t.id, name: t.name, type: t.type, status: t.status }));
  }

  // アプリログ (RTF + CH2 共通)。`/specs/{specId}/logs` は **直近 ~10 件固定** で返る
  // (limit/tail パラメータは無効)。tail はこれを poll して docId で dedup・追記する。
  // specId 省略時は最新 spec (createdAt 最大) を解決して使う。
  async logs(orgId, envId, deploymentId, specId) {
    let sid = specId;
    if (!sid) {
      const specs = await this.specs(orgId, envId, deploymentId);
      const arr = Array.isArray(specs) ? specs : (specs?.items || specs?.data || []);
      arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      sid = arr[0]?.version;
      if (!sid) return [];
    }
    const j = await this._get(`${AMC}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}/specs/${sid}/logs`);
    const arr = Array.isArray(j) ? j : (j?.items || j?.data || []);
    return arr.map(e => ({
      docId: e.docId, ts: e.timestamp, level: e.logLevel || "",
      msg: e.message || "", replicaId: e.replicaId || "", logger: e.context?.logger || "",
    }));
  }

  // ── Lineage (デプロイ → asset / spec / API Manager) ──────
  // Exchange ポータルの asset URL。
  exchangeUrl(groupId, assetId, version) {
    const v = version ? `${encodeURIComponent(version)}/` : "";
    return `${this.base}/exchange/${groupId}/${assetId}/${v}`;
  }

  // 公開済み asset のメタ + 依存から spec 系を抽出 (jar 展開せず Exchange から)。
  async assetInfo(groupId, assetId, version) {
    const a = await this._get(`exchange/api/v2/assets/${groupId}/${assetId}/${version}`);
    const SPEC = /rest-api|oas|raml|evented-api|api-spec|wsdl|http-api|soap-api|async-api/i;
    return {
      name: a.name || assetId, type: a.type || "", description: a.description || "",
      dependencyCount: (a.dependencies || []).length,
      specs: (a.dependencies || []).filter(d => SPEC.test(d.type || ""))
        .map(d => ({ groupId: d.groupId, assetId: d.assetId, version: d.version, type: d.type })),
    };
  }

  // API Manager の API instance 一覧 (各 spec asset 参照 + deployment binding)。
  async apiInstances(orgId, envId) {
    const j = await this._get(`apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis?limit=100`);
    const out = [];
    for (const a of (j?.assets || [])) {
      for (const inst of (a.apis || [])) {
        out.push({
          id: inst.id,
          specGroupId: a.groupId, specAssetId: a.assetId,
          specName: a.exchangeAssetName || a.assetId, specVersion: inst.assetVersion || "",
          technology: inst.technology || "", status: inst.status || inst.deployment?.expectedStatus || "",
          label: inst.instanceLabel || "", contracts: inst.activeContractsCount ?? null,
          applicationId: inst.deployment?.applicationId || "", targetId: inst.deployment?.targetId || "",
          autodiscoveryName: inst.autodiscoveryInstanceName || "",
          endpointUri: inst.endpointUri || "",   // mule4/llm 等は直接 backend URL を持つ
        });
      }
    }
    return out;
  }

  // API instance の backend (upstream) URL を解決。flexGateway は routing の upstream が
  // ID 参照なので /apis/{id}/upstreams で URL を引く。endpointUri があればそちらが直接の backend。
  async apiUpstreams(orgId, envId, apiId) {
    const j = await this._get(`apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis/${apiId}/upstreams`);
    const arr = Array.isArray(j) ? j : (j?.upstreams || j?.data || []);
    return arr.map(u => u.uri || u.url).filter(Boolean);
  }

  // ── Lineage explorer 用 (一覧は痩せ・detail がリッチ) ────
  // API instance の detail。endpoint.uri=backend(実装URL)、proxyUri のパス=base path、
  // deployment.targetId=配備先 Flex Gateway。
  async apiInstance(orgId, envId, apiId) {
    const j = await this._get(`apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis/${apiId}`);
    const ep = j.endpoint || {};
    let basePath = "/";
    try { const p = new URL(ep.proxyUri).pathname; basePath = (p && p !== "/") ? p : "/"; } catch {}
    return {
      id: j.id, label: j.instanceLabel || "", technology: j.technology || "", status: j.status || "",
      specGroupId: j.groupId, specAssetId: j.assetId, specVersion: j.assetVersion,
      backend: ep.uri || "", basePath,
      gatewayId: j.deployment?.targetId || "", deployStatus: j.deployment?.expectedStatus || "",
      _raw: j,
    };
  }

  // Flex Gateway の detail。consumer URL の前半 (ingress.publicUrl) を持つ。
  async gateway(orgId, envId, gatewayId) {
    const j = await this._get(`gatewaymanager/api/v1/organizations/${orgId}/environments/${envId}/gateways/${gatewayId}`);
    return {
      id: j.id, name: j.name || "", status: j.status || "",
      publicUrl: (j.configuration?.ingress?.publicUrl || "").replace(/\/$/, ""),
      port: j.portConfiguration?.ingress?.port ?? null,
      targetId: j.targetId || "", targetName: j.targetName || "",
    };
  }

  // env の Flex Gateway 一覧 (Gateways 入口)。
  async gateways(orgId, envId) {
    const j = await this._get(`gatewaymanager/api/v1/organizations/${orgId}/environments/${envId}/gateways`);
    return (j?.content || j?.data || []).map(g => ({ id: g.id, name: g.name, targetId: g.targetId, status: g.status }));
  }

  // org の API spec asset 一覧 (Specs 入口)。rest-api/oas/raml/evented-api 型のみ。
  async specAssets(orgId) {
    const j = await this._get(`exchange/api/v2/assets?organizationId=${orgId}&limit=250`);
    const arr = Array.isArray(j) ? j : (j?.assets || j?.data || []);
    const SPEC = /rest-api|oas|raml|evented-api|http-api|soap-api|async-api/i;
    return arr.filter(a => SPEC.test(a.type || ""))
      .map(a => ({ groupId: a.groupId, assetId: a.assetId, version: a.version, name: a.name || a.assetId, type: a.type }));
  }

  // ── API spec (OAS) 取得 → endpoint 抽出 (REST tester の「ボタンで投げる」用) ──
  // rest-api asset の files から OAS を落としてパースし [{method, path, summary, bodyExample}] を返す。
  // OAS 本体は presigned S3 (amazonaws.com·allowlist 済) に置かれるので externalLink を /proxy 経由で取得。
  // YAML/RAML はブラウザに parser が無いため endpoints は空 (note で理由を返す)。
  async fetchOas(groupId, assetId, version) {
    const a = await this._get(`exchange/api/v2/assets/${groupId}/${assetId}/${version}`);
    const files = a.files || [];
    // JSON OAS を最優先 (fat-oas = $ref 解決済みで扱いやすい)。次に任意 oas、最後に raml/rest-api。
    const pick = files.find(f => /oas/i.test(f.classifier || "") && /json/i.test(f.packaging || ""))
              || files.find(f => /oas/i.test(f.classifier || ""))
              || files.find(f => /(raml|rest-api)/i.test(f.classifier || ""));
    // downloadURL = ファイル本体の取得 endpoint。externalLink は portal の閲覧 URL なので後回し。
    const link = pick && (pick.downloadURL || pick.externalLink || pick.url);
    if (!link) return { endpoints: [], note: `no spec file (classifiers: ${files.map(f => f.classifier).join(",") || "none"})` };
    let host = ""; try { host = new URL(link).host; } catch {}
    // Exchange の downloadURL は Java URI が query で弾く文字を生で含むことがあり
    // (Mule の http:request が "Illegal character in query" で 502)。proxy は
    // queryParams.url を 1 回 decode するので、Java の query 許可集合
    // (unreserved + sub-delims + : @ / ? # と %xx) 以外を全部 %-encode しておけば
    // decode 後も %xx で残り通る。既存の %xx は保持。
    const safe = String(link).replace(/%[0-9A-Fa-f]{2}|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?#]/g,
      m => (m.length === 3 && m[0] === "%") ? m : encodeURIComponent(m));
    // presigned S3 (X-Amz-*/Signature 付き) に Authorization を足すと S3 が
    // "Only one auth mechanism allowed" で弾く。presigned なら Bearer を付けない。
    const presigned = /[?&](x-amz-|signature=|awsaccesskeyid=)/i.test(link);
    const token = presigned ? null : await this._getToken().catch(() => null);
    let res, text;
    try {
      res  = await fetch(`/proxy?url=${encodeURIComponent(safe)}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
      text = await res.text();
    } catch (e) { return { endpoints: [], note: `spec fetch failed @${host}: ${e?.message || e}` }; }
    if (!res.ok) {
      const b = String(text).replace(/<[^>]+>/g, " ").trim();
      // proxy の "Illegal character in query at index N: <url>" から該当文字を抽出して **先頭に** 出す
      // (どの文字が弾かれてるか確定させ、proxy の encode 対象に足すため。URL は長く切れるので char を前に)。
      let head = "";
      const m = b.match(/index (\d+):\s*([\s\S]+)/);   // url は空白も含めて全部捕捉
      if (m) {
        const idx = Number(m[1]); const ch = (m[2] || "")[idx];
        if (ch != null) head = `◆ FAILING CHAR @${idx} = "${ch}" (U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}) — `;
      }
      return { endpoints: [], note: `${head}[${pick.classifier}] HTTP ${res.status}: ${b.slice(0, 120)}` };
    }
    let doc; try { doc = JSON.parse(text); }
    catch { return { endpoints: [], note: `non-JSON spec @${host} (${pick.classifier}/${pick.packaging}) — JSON OAS のみ対応` }; }
    return { endpoints: extractOasEndpoints(doc), title: doc?.info?.title || assetId };
  }

  // ── 書き込み操作 ─────────────────────────────────────────
  // !! confirm + prod ガードは UI 側の責務。ここは API 機構だけ。
  // !! CH2/RTF の Application Manager v2 には専用 "restart" verb が無い。
  //    restart = 既存設定のまま PATCH して rolling で再展開する、が正攻法。
  //    stop/start = application.desiredState、scale = target.replicas を PATCH。
  //    いずれも「最新 raw を GET → 必要箇所だけ差し替えて全体 PATCH」。部分 PATCH は
  //    環境差で欠落フィールドが消える事故が起きやすいので避ける。
  //    ※ 本番投入前に必ず非 prod env で live スモークすること (本体未検証)。
  _depPath(orgId, envId, deploymentId) {
    return `${AMC}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}`;
  }

  // 取得済みの正規化前 raw を渡せば再 GET を省ける。
  async _rawDeployment(orgId, envId, deploymentId) {
    return this._get(this._depPath(orgId, envId, deploymentId));
  }

  async restart(orgId, envId, deploymentId, raw) {
    const cur = raw || await this._rawDeployment(orgId, envId, deploymentId);
    const body = { ...cur };
    body.target = { ...(cur.target || {}) };
    body.target.deploymentSettings = { ...(cur.target?.deploymentSettings || {}), updateStrategy: "rolling" };
    return this._patch(this._depPath(orgId, envId, deploymentId), body);
  }

  async setDesiredState(orgId, envId, deploymentId, desiredState, raw) { // "STARTED" | "STOPPED"
    const cur = raw || await this._rawDeployment(orgId, envId, deploymentId);
    const body = { ...cur, application: { ...(cur.application || {}), desiredState } };
    return this._patch(this._depPath(orgId, envId, deploymentId), body);
  }

  start(orgId, envId, deploymentId, raw) { return this.setDesiredState(orgId, envId, deploymentId, "STARTED", raw); }
  stop (orgId, envId, deploymentId, raw) { return this.setDesiredState(orgId, envId, deploymentId, "STOPPED", raw); }

  async scale(orgId, envId, deploymentId, replicas, raw) {
    const cur = raw || await this._rawDeployment(orgId, envId, deploymentId);
    const body = { ...cur, target: { ...(cur.target || {}), replicas } };
    return this._patch(this._depPath(orgId, envId, deploymentId), body);
  }

  // デプロイ削除 (アプリ停止 + 取り下げ)。元に戻せないので UI 側で強 confirm 必須。
  async remove(orgId, envId, deploymentId) {
    return this._delete(this._depPath(orgId, envId, deploymentId));
  }

  // replicas / vCores / cpu / memory をまとめて 1 回の PATCH で適用 (指定分だけ差し替え)。
  // 個別に PATCH すると 2 回目が古い raw を踏むので、control deck の Apply はこれを使う。
  async applyChanges(orgId, envId, deploymentId, { replicas, vCores, cpu, memory } = {}, raw) {
    const cur = raw || await this._rawDeployment(orgId, envId, deploymentId);
    const body = { ...cur, target: { ...(cur.target || {}) } };
    if (replicas != null) body.target.replicas = replicas;
    if (vCores != null) body.application = { ...(cur.application || {}), vCores };
    if (cpu || memory) {
      const ds = cur.target?.deploymentSettings || {};
      const res = { ...(ds.resources || {}) };
      if (cpu) res.cpu = cpu;
      if (memory) res.memory = memory;
      body.target.deploymentSettings = { ...ds, resources: res };
    }
    return this._patch(this._depPath(orgId, envId, deploymentId), body);
  }

  // CH2: replica サイズ = vCores (0.1/0.2/0.5/1/2/4)。
  async setVCores(orgId, envId, deploymentId, vCores, raw) {
    const cur = raw || await this._rawDeployment(orgId, envId, deploymentId);
    const body = { ...cur, application: { ...(cur.application || {}), vCores } };
    return this._patch(this._depPath(orgId, envId, deploymentId), body);
  }

  // RTF: cpu/memory = { reserved, limit } (例 {reserved:"500m",limit:"2000m"})。指定分だけ差し替え。
  async setCpuMem(orgId, envId, deploymentId, { cpu, memory } = {}, raw) {
    const cur = raw || await this._rawDeployment(orgId, envId, deploymentId);
    const ds = cur.target?.deploymentSettings || {};
    const res = { ...(ds.resources || {}) };
    if (cpu) res.cpu = cpu;
    if (memory) res.memory = memory;
    const body = { ...cur, target: { ...(cur.target || {}), deploymentSettings: { ...ds, resources: res } } };
    return this._patch(this._depPath(orgId, envId, deploymentId), body);
  }
}

// ── helpers ────────────────────────────────────────────────

// OAS (Swagger 2 / OpenAPI 3) doc → [{ method, path, summary, bodyExample }]。
// path は basePath / servers[0] の path 部分を前置する (spec の意図する完全パス)。
export function extractOasEndpoints(doc) {
  if (!doc || typeof doc !== "object") return [];
  const base = oasBasePath(doc);
  const out = [];
  const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
  for (const [p, item] of Object.entries(doc.paths || {})) {
    if (!item || typeof item !== "object") continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== "object") continue;
      out.push({ method: m.toUpperCase(), path: (base + p) || p,
        summary: op.summary || op.operationId || "", bodyExample: oasBodyExample(op) });
    }
  }
  return out;
}
function oasBasePath(doc) {
  if (doc.basePath) return String(doc.basePath).replace(/\/+$/, "");   // Swagger 2
  const u = doc.servers && doc.servers[0] && doc.servers[0].url;       // OpenAPI 3
  if (u) { try { return new URL(u, "http://_").pathname.replace(/\/+$/, ""); } catch { return /^\//.test(u) ? u.replace(/\/+$/, "") : ""; } }
  return "";
}
function oasBodyExample(op) {
  try {
    const j = op.requestBody?.content?.["application/json"];        // OpenAPI 3
    if (j?.example) return JSON.stringify(j.example, null, 2);
    if (j?.schema?.example) return JSON.stringify(j.schema.example, null, 2);
    const bp = (op.parameters || []).find(p => p && p.in === "body");  // Swagger 2
    if (bp?.schema?.example) return JSON.stringify(bp.schema.example, null, 2);
  } catch {}
  return "";
}

// org 階層ツリーを [{ id, name }] に平坦化 (subOrganizations / children のどれでも辿る)。
export function flattenOrgTree(node, acc = []) {
  if (!node) return acc;
  acc.push({ id: node.id, name: node.name });
  (node.subOrganizations || node.subOrganization || node.children || []).forEach(s => flattenOrgTree(s, acc));
  return acc;
}

// API のバージョン差・list/detail 差を吸収し、Fleet 表が必要とする平らな形へ。
// 元データは _raw に保持 (detail 表示・PATCH 再利用のため)。
//
// 重要 (実データ T1/Sandbox で確認):
//  - 生 API は camelCase (yaac の kebab は Clojure 変換)。
//  - 一覧 (list) item は痩せていて version / replicas / vCores / desiredState /
//    deploymentSettings を含まない。代わりに top-level currentRuntimeVersion を持つ。
//    → これらは detail (単一 GET) でのみ埋まる。表は list 由来、drawer は detail 由来。
//  - target.provider は CH2/RTF 双方で "MC"。判別は targetId → runtimeTargets() の type。
export function normalizeDeployment(d, envId, detail = false) {
  const app = d.application || {};
  const tgt = d.target || {};
  const ds  = tgt.deploymentSettings || {};
  const ref = app.ref || {};
  const res = ds.resources || {};
  const fmtRes = (r) => r ? `${r.reserved ?? ""}${r.reserved != null && r.limit != null ? "/" : ""}${r.limit ?? ""}` : null;
  return {
    id:           d.id,
    name:         d.name,
    appStatus:    app.status || "",              // RUNNING / NOT_RUNNING / STARTED ... (app 稼働状態)
    deployStatus: d.status || "",                // APPLIED / FAILED / APPLYING ... (デプロイ状態)
    desired:      app.desiredState || "",        // STARTED / STOPPED (detail のみ)
    provider:     tgt.provider || "",            // CH2/RTF 双方 "MC" — 判別不可。targetId で解決する
    targetId:     tgt.targetId || "",
    runtime:      d.currentRuntimeVersion || ds.runtimeVersion || "",  // 一覧は currentRuntimeVersion
    replicas:     tgt.replicas ?? (Array.isArray(d.replicas) ? d.replicas.length : null),  // 一覧は null
    vCores:       app.vCores ?? null,            // CH2 のみ (detail)
    cpu:          fmtRes(res.cpu),               // RTF は cpu/mem (detail)
    mem:          fmtRes(res.memory),
    version:      ref.version || "",             // detail のみ
    artifact:     ref.artifactId || "",
    clustered:    !!ds.clustered,
    updatedAt:    d.lastModifiedDate || d.creationDate || null,
    envId,
    replicaList: detail && Array.isArray(d.replicas)
      ? d.replicas.map(r => ({ id: r.id, state: r.state, version: r.currentDeploymentVersion, reason: r.reason }))
      : undefined,
    _raw: d
  };
}

// runtime target の type → 短ラベル (Fleet 表の Target 列バッジ)。
export function targetKind(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("fabric")) return "RTF";        // runtime-fabric
  if (t.includes("space"))  return "CH2";        // shared-space / private-space
  return "";
}
