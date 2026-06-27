// Anypoint Lineage Explorer — 横フィルムストリップのグラフナビゲータ
//
// データは小さなグラフ (deployment / spec / instance / gateway がエッジで繋がり、
// backend→deployment でループする)。各ノードを「facts + relations(次に繋がるノード)」
// に統一し、クリックのたび右に列を積む。全体は一切再描画しない。
//
//   const exp = createExplorer({ stage, client, getContext, getDeployments });
//   exp.open({ type:"deployment", id, title, data: row });   // deployment 起点で開く
//
// getContext : () => ({ orgId, envId, targetName(id) })
// getDeployments : () => Fleet の行配列 (backend→deployment 解決 + Deployments 入口)

const $ = (s, p = document) => p.querySelector(s);

function el(spec, props = {}, ...kids) {
  const m = String(spec).match(/^([a-z0-9]+)?(.*)$/i);
  const node = document.createElement(m[1] || "div");
  for (const tok of (m[2].match(/[.#][^.#]+/g) || [])) {
    if (tok[0] === "#") node.id = tok.slice(1); else node.classList.add(tok.slice(1));
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) node.append(k.nodeType ? k : document.createTextNode(k));
  return node;
}

// ノード種別 → グリフ / 色クラス
const TYPE = {
  deployment: { g: "▣", c: "dep",  n: "deploy" },
  spec:       { g: "◆", c: "spec", n: "spec" },
  instance:   { g: "⬡", c: "inst", n: "API instance" },
  gateway:    { g: "⬢", c: "gw",   n: "gateway" },
};
function hostApp(url) {
  try { return new URL(url).host.split(".")[0].replace(/-[a-z0-9]+$/i, ""); } catch { return ""; }
}

let _styled = false;
function injectStyles() {
  if (_styled) return; _styled = true;
  const css = `
.ap-exp { position:absolute; inset:0; z-index:4; display:none; flex-direction:column; background:var(--paper); }
.ap-exp.is-open { display:flex; }
.ap-exp-head { display:flex; align-items:center; gap:10px; padding:9px 14px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
.ap-exp-tabs { display:flex; gap:4px; }
.ap-exp-tab { padding:4px 10px; font:600 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); background:var(--paper); border:1px solid var(--line); border-radius:99px; cursor:pointer; }
.ap-exp-tab.is-on { background:var(--ink-navy); color:var(--you-ink); border-color:var(--ink-navy); }
.ap-exp-crumb { display:flex; align-items:center; gap:4px; font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); flex:1; min-width:0; overflow:hidden; }
.ap-exp-crumb b { color:var(--ink); font-weight:600; }
.ap-exp-crumb .c { cursor:pointer; white-space:nowrap; }
.ap-exp-crumb .c:hover { color:var(--accent-ink); }
.ap-exp-x { cursor:pointer; border:none; background:none; color:var(--ink-3); font-size:calc(18px*var(--fs,1)); line-height:1; }
.ap-exp-strip { flex:1; display:flex; overflow-x:auto; overflow-y:hidden; align-items:stretch; }
.ap-col { flex:0 0 290px; border-right:1px solid var(--line); overflow-y:auto; display:flex; flex-direction:column; background:var(--paper); }
.ap-col.is-entry { background:var(--panel-soft); }
.ap-col-h { padding:11px 14px 9px; border-bottom:1px solid var(--line-3); position:sticky; top:0; background:inherit; }
.ap-col-t { font:700 calc(14px*var(--fs,1)) var(--f-display); color:var(--ink); display:flex; align-items:center; gap:7px; }
.ap-col-s { margin-top:3px; font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); }
.ap-g { font-size:calc(13px*var(--fs,1)); }
.ap-g.dep{color:var(--ink-2);} .ap-g.spec{color:var(--accent-ink);} .ap-g.inst{color:var(--ok);} .ap-g.gw{color:var(--caution);}
.ap-facts { padding:8px 14px; display:grid; grid-template-columns:auto 1fr; gap:4px 10px; font:500 calc(12px*var(--fs,1)) var(--f-ui); }
.ap-facts dt { color:var(--ink-3); font-size:calc(11px*var(--fs,1)); }
.ap-facts dd { margin:0; color:var(--ink); text-align:right; font-family:var(--f-mono); font-size:calc(11px*var(--fs,1)); word-break:break-all; }
.ap-facts dd a { color:var(--accent-ink); text-decoration:none; }
.ap-consumer { margin:6px 14px 10px; padding:8px 10px; background:var(--accent-soft); border:1px solid var(--accent); border-radius:var(--radius); }
.ap-consumer .lbl { font:700 calc(9px*var(--fs,1)) var(--f-ui); letter-spacing:.06em; color:var(--accent-ink); text-transform:uppercase; }
.ap-consumer .url { margin-top:3px; font:600 calc(12px*var(--fs,1)) var(--f-mono); color:var(--ink); word-break:break-all; }
.ap-consumer .acts { margin-top:5px; display:flex; gap:6px; }
.ap-consumer button, .ap-consumer a { font:600 calc(10px*var(--fs,1)) var(--f-ui); padding:2px 8px; border-radius:var(--radius); border:1px solid var(--accent); background:var(--panel); color:var(--accent-ink); cursor:pointer; text-decoration:none; }
.ap-rel { padding:6px 0 4px; border-top:1px solid var(--line-3); }
.ap-rel-l { padding:0 14px; font:700 calc(9px*var(--fs,1)) var(--f-ui); letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3); }
.ap-rel-note { padding:2px 14px; font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); }
.ap-item { display:flex; align-items:center; gap:8px; padding:6px 14px; cursor:pointer; font:500 calc(12px*var(--fs,1)) var(--f-ui); color:var(--ink-2); }
.ap-item:hover { background:var(--accent-soft); }
.ap-item.is-active { background:var(--accent-soft); }
.ap-item-b { min-width:0; flex:1; }
.ap-item-t { color:var(--ink); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ap-item-s { font:500 calc(10px*var(--fs,1)) var(--f-ui); color:var(--ink-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ap-item .chev { color:var(--ink-4); font-size:calc(12px*var(--fs,1)); }
.ap-exp-filter { width:100%; padding:5px 9px; margin:8px 14px; box-sizing:border-box; width:calc(100% - 28px); font:500 calc(12px*var(--fs,1)) var(--f-ui); color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); }
.ap-note2 { padding:10px 14px; font:500 calc(11px*var(--fs,1)) var(--f-ui); color:var(--ink-3); }
.ap-note2.is-err { color:var(--warn); }
.ap-exp-acts { padding:8px 14px; display:flex; gap:6px; flex-wrap:wrap; border-top:1px solid var(--line-3); }
.ap-exp-act { padding:5px 12px; font:700 calc(11px*var(--fs,1)) var(--f-ui); color:var(--accent-ink); background:var(--accent-soft); border:1px solid var(--accent); border-radius:var(--radius); cursor:pointer; }
.ap-exp-act:hover { background:var(--accent); color:var(--you-ink); }
`;
  document.head.appendChild(el("style#anypoint-explorer-styles", {}, css));
  $("#anypoint-explorer-styles").textContent = css;
}

// ════════════════════════════════════════════════════════════
export function createExplorer({ stage, getContext, getDeployments, openTester }) {
  injectStyles();
  const cache = new Map();
  const cached = (k, fn) => cache.has(k) ? cache.get(k) : (cache.set(k, fn()), cache.get(k));
  const ctx = () => getContext();

  const tabsEl = el("div.ap-exp-tabs");
  const crumbEl = el("div.ap-exp-crumb");
  const strip = el("div.ap-exp-strip");
  const root = el("div.ap-exp", {},
    el("div.ap-exp-head", {},
      tabsEl, crumbEl,
      el("button.ap-exp-x", { text: "×", on: { click: close } })),
    strip);
  stage.append(root);

  let entry = "deployments";   // 入口タブ
  let walk = [];               // 入口の後の歩き (node 配列)

  // ── entry tabs ─────────────────────────────────────────────
  for (const [k, label] of [["deployments", "Deployments"], ["specs", "Specs"], ["gateways", "Gateways"]]) {
    tabsEl.append(el("button.ap-exp-tab", { dataset_k: k, text: label,
      on: { click: () => { entry = k; walk = []; render(); } } }));
  }
  function syncTabs() {
    [...tabsEl.children].forEach(b => b.classList.toggle("is-on", b.textContent.toLowerCase() === entry));
  }

  // ── node descriptors ──────────────────────────────────────
  const specNode = (s) => ({ type: "spec", id: `${s.groupId}|${s.assetId}|${s.version}`, title: `${s.assetId}:${s.version}`, sub: "spec" });
  const instNode = (i) => ({ type: "instance", id: i.id, title: `#${i.id}`, sub: `${i.specName || i.specAssetId || ""} · ${i.technology || ""}` });
  const gwNode   = (g) => ({ type: "gateway", id: g.id, title: g.name, sub: "gateway", data: g });
  const depNode  = (d) => ({ type: "deployment", id: d.id, title: d.name, sub: "deploy", data: d });

  // ── resolve(node) → { facts, relations, consumer? } ───────
  async function resolve(node) {
    const { orgId, envId, targetName, client } = ctx();
    if (node.type === "deployment") {
      const row = node.data;
      const ref = row._raw?.application?.ref;
      const facts = [
        ["status", row.appStatus || row.deployStatus || row.status || "—"],
        ["runtime", row.runtime || "—"],
        ["target", targetName ? targetName(row.targetId) : (row.targetId || "—")],
      ];
      const relations = [];
      if (ref?.artifactId) {
        facts.push(["asset", `${ref.artifactId}:${ref.version}`, client.exchangeUrl(ref.groupId, ref.artifactId, ref.version)]);
        const info = await cached(`asset:${ref.groupId}/${ref.artifactId}/${ref.version}`, () => client.assetInfo(ref.groupId, ref.artifactId, ref.version));
        const specTypes = (info.specs || []).map(s => s.type).filter(Boolean);
        if (specTypes.length) facts.push(["spec type", [...new Set(specTypes)].join(", ")]);
        relations.push({ label: "spec (impl)", items: (info.specs || []).map(specNode), note: (info.specs || []).length ? "" : "no API spec in pom dependencies" });
      }
      // この deployment を即テスト (型は console 側で判定して開く)。
      const actions = openTester ? [{ label: "▶ Test", run: () => openTester({ deployment: row }) }] : [];
      return { facts, relations, actions };
    }
    if (node.type === "spec") {
      const [g, a, v] = node.id.split("|");
      const facts = [["type", "rest-api"], ["version", v], ["Exchange", "open ↗", client.exchangeUrl(g, a, v)]];
      const apis = await cached(`apis:${envId}`, () => client.apiInstances(orgId, envId));
      const users = apis.filter(x => x.specAssetId === a);
      return { facts, relations: [{ label: "API instances using this", items: users.map(instNode), note: users.length ? "" : "no instance uses this spec" }] };
    }
    if (node.type === "instance") {
      const det = await cached(`inst:${node.id}`, () => client.apiInstance(orgId, envId, node.id));
      const facts = [["label", det.label || "—"], ["technology", det.technology || "—"], ["base path", det.basePath]];
      const relations = [];
      relations.push({ label: "spec", items: [specNode({ groupId: det.specGroupId, assetId: det.specAssetId, version: det.specVersion })] });
      let consumer = null;
      if (det.gatewayId) {
        const gw = await cached(`gw:${det.gatewayId}`, () => client.gateway(orgId, envId, det.gatewayId));
        facts.push(["FGW", `${gw.name} (${det.deployStatus || "?"})`]);
        if (gw.publicUrl) consumer = gw.publicUrl + (det.basePath === "/" ? "/" : det.basePath);
        relations.push({ label: "gateway", items: [gwNode(gw)] });
      } else {
        facts.push(["FGW", "not deployed"]);
      }
      if (det.backend) {
        const app = hostApp(det.backend);
        const dep = getDeployments().find(d => d.name === app);
        relations.push({ label: "backend (impl)", items: dep ? [depNode(dep)] : [], note: dep ? "" : `external backend: ${app || det.backend}` });
      }
      return { facts, relations, consumer };
    }
    if (node.type === "gateway") {
      const gw = node.data || await cached(`gw:${node.id}`, () => client.gateway(orgId, envId, node.id));
      const facts = [["name", gw.name], ["public URL", gw.publicUrl || "—", null, true], ["port", gw.port ?? "—"], ["runtime", gw.targetName || gw.targetId || "—"]];
      const apis = await cached(`apis:${envId}`, () => client.apiInstances(orgId, envId));
      const here = apis.filter(x => x.targetId === gw.id);
      return { facts, relations: [{ label: "deployed API instances", items: here.map(instNode), note: here.length ? "" : "no deployed instance" }] };
    }
    return { facts: [], relations: [] };
  }

  // ── 列 (node カード) を描画 → DOM 要素 ─────────────────────
  function nodeColumn(node, walkIndex) {
    const t = TYPE[node.type] || {};
    const col = el("div.ap-col", {},
      el("div.ap-col-h", {},
        el("div.ap-col-t", {}, el("span", { class: `ap-g ${t.c}`, text: t.g }), node.title),
        el("div.ap-col-s", { text: node.sub || t.n })));
    const body = el("div.ap-note2", { text: "resolving…" });
    col.append(body);
    resolve(node).then(({ facts, relations, consumer, actions }) => {
      body.remove();
      // facts
      if (facts?.length) {
        const dl = el("dl.ap-facts");
        for (const [k, v, href, copy] of facts) {
          dl.append(el("dt", { text: k }));
          const dd = el("dd");
          if (href) dd.append(el("a", { href, target: "_blank", rel: "noopener noreferrer", text: v }));
          else dd.append(v);
          if (copy) dd.append(" ", el("a", { href: "#", title: "copy",
            on: { click: (e) => { e.preventDefault(); navigator.clipboard?.writeText(v); } }, text: "⧉" }));
          dl.append(dd);
        }
        col.append(dl);
      }
      // consumer URL (ご褒美)
      if (consumer) {
        col.append(el("div.ap-consumer", {},
          el("div.lbl", { text: "▶ Consumer URL" }),
          el("div.url", { text: consumer }),
          el("div.acts", {},
            el("button", { text: "copy", on: { click: () => navigator.clipboard?.writeText(consumer) } }),
            el("a", { href: consumer, target: "_blank", rel: "noopener noreferrer", text: "open ↗" }),
            openTester ? el("button", { text: "Test ▶",
              on: { click: () => openTester({ type: "rest", baseUrl: consumer, title: node.title, sub: "consumer URL" }) } }) : null)));
      }
      // actions (deployment 等を即テスト)
      if (actions?.length) {
        const bar = el("div.ap-exp-acts");
        for (const a of actions) bar.append(el("button.ap-exp-act", { text: a.label, on: { click: a.run } }));
        col.append(bar);
      }
      // relations
      for (const rel of (relations || [])) {
        const box = el("div.ap-rel", {}, el("div.ap-rel-l", { text: rel.label }));
        if (rel.note) box.append(el("div.ap-rel-note", { text: rel.note }));
        for (const it of (rel.items || [])) {
          const t2 = TYPE[it.type] || {};
          box.append(el("div.ap-item", { on: { click: () => pushWalk(walkIndex, it) } },
            el("span", { class: `ap-g ${t2.c}`, text: t2.g }),
            el("div.ap-item-b", {}, el("div.ap-item-t", { text: it.title }), el("div.ap-item-s", { text: it.sub || "" })),
            el("span.chev", { text: "▸" })));
        }
        col.append(box);
      }
    }).catch(e => { body.textContent = "error: " + (e?.message || e); body.classList.add("is-err"); });
    return col;
  }

  // ── entry 列 (入口リスト) ─────────────────────────────────
  function entryColumn() {
    const col = el("div.ap-col.is-entry", {},
      el("div.ap-col-h", {}, el("div.ap-col-t", { text: entry[0].toUpperCase() + entry.slice(1) })));
    const filter = el("input.ap-exp-filter", { type: "search", placeholder: "filter…" });
    const list = el("div");
    col.append(filter, list);
    const fill = (items, toNode, label) => {
      const draw = (q) => {
        list.innerHTML = "";
        items.filter(it => !q || label(it).toLowerCase().includes(q)).forEach(it => {
          const n = toNode(it); const t = TYPE[n.type];
          list.append(el("div.ap-item", { on: { click: () => { walk = [n]; render(); } } },
            el("span", { class: `ap-g ${t.c}`, text: t.g }),
            el("div.ap-item-b", {}, el("div.ap-item-t", { text: n.title }), el("div.ap-item-s", { text: n.sub })),
            el("span.chev", { text: "▸" })));
        });
      };
      draw("");
      filter.addEventListener("input", () => draw(filter.value.trim().toLowerCase()));
    };
    const { orgId, envId, client } = ctx();
    if (entry === "deployments") fill(getDeployments(), depNode, d => d.name);
    else if (entry === "specs") client.specAssets(orgId).then(s => fill(s, specNode, x => x.assetId)).catch(() => list.append(el("div.ap-note2.is-err", { text: "failed to load specs" })));
    else if (entry === "gateways") client.gateways(orgId, envId).then(g => fill(g, gwNode, x => x.name)).catch(() => list.append(el("div.ap-note2.is-err", { text: "failed to load gateways" })));
    return col;
  }

  // ── 歩きに 1 ノード追加 (fromIndex 以降を切って push) ───────
  function pushWalk(fromIndex, node) {
    walk = walk.slice(0, fromIndex + 1);
    walk.push(node);
    render();
    requestAnimationFrame(() => { strip.scrollLeft = strip.scrollWidth; });
  }

  // ── 全列を組み直す (DOM 再構築だが画面遷移ではない・スクロール末尾へ) ──
  function render() {
    syncTabs();
    strip.innerHTML = "";
    strip.append(entryColumn());
    walk.forEach((n, i) => strip.append(nodeColumn(n, i)));
    // breadcrumb
    crumbEl.innerHTML = "";
    crumbEl.append(el("span.c", { text: entry, on: { click: () => { walk = []; render(); } } }));
    walk.forEach((n, i) => {
      crumbEl.append(el("span", { text: " › " }));
      crumbEl.append(el("span.c", { on: { click: () => { walk = walk.slice(0, i + 1); render(); } } },
        el("b", { text: n.title })));
    });
  }

  function open(node) {
    if (node) { entry = node.type === "deployment" ? "deployments" : node.type === "spec" ? "specs" : "gateways"; walk = [node]; }
    root.classList.add("is-open");
    render();
    requestAnimationFrame(() => { strip.scrollLeft = strip.scrollWidth; });
  }
  function close() { root.classList.remove("is-open"); }
  function clearCache() { cache.clear(); }

  return { open, close, clearCache, el: root };
}
