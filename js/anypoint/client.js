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
}

// ── helpers ────────────────────────────────────────────────

// org 階層ツリーを [{ id, name }] に平坦化 (subOrganizations / children のどれでも辿る)。
export function flattenOrgTree(node, acc = []) {
  if (!node) return acc;
  acc.push({ id: node.id, name: node.name });
  (node.subOrganizations || node.subOrganization || node.children || []).forEach(s => flattenOrgTree(s, acc));
  return acc;
}

// API のバージョン差・provider 差を吸収し、Fleet 表が必要とする平らな形へ。
// 元データは _raw に保持 (detail 表示・PATCH 再利用のため)。
export function normalizeDeployment(d, envId, detail = false) {
  const app = d.application || {};
  const tgt = d.target || {};
  const ds  = tgt.deploymentSettings || {};
  const ref = app.ref || {};
  return {
    id:        d.id,
    name:      d.name,
    status:    app.status || d.status || "",     // RUNNING / STARTED / FAILED / APPLYING / ...
    desired:   app.desiredState || "",           // STARTED / STOPPED
    provider:  tgt.provider || "",               // CloudHub 2.0 / Runtime Fabric の判別軸 (raw のまま)
    targetId:  tgt.targetId || "",
    runtime:   ds.runtimeVersion || "",
    replicas:  tgt.replicas ?? (Array.isArray(d.replicas) ? d.replicas.length : null),
    vCores:    app.vCores ?? null,
    version:   ref.version || "",
    artifact:  ref.artifactId || "",
    clustered: !!ds.clustered,
    updatedAt: d.lastModifiedDate || d.lastModified || d.creationDate || null,
    envId,
    replicaList: detail && Array.isArray(d.replicas)
      ? d.replicas.map(r => ({ id: r.id, state: r.state, version: r.currentDeploymentVersion, reason: r.reason }))
      : undefined,
    _raw: d
  };
}
