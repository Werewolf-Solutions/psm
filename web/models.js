/* Models (#/models): every model this machine can run — Claude and Codex
 * through their CLIs, Ollama, and GGUF files through llama.cpp — with price,
 * context, capabilities, what each is good and poor at, and how it scored on
 * the model-bench library. Select models to compare them side by side, narrow
 * the comparison by category and benchmark at the same time, and start runs.
 *
 * Everything a model wrote (run outputs) is rendered as text, never markup.
 * The server enforces who may start a run; this page only asks. */
(() => {
  const ENGINE_NAME = { claude: "Claude", codex: "Codex", ollama: "Ollama", gguf: "GGUF · llama.cpp" };
  const CATEGORY_NAME = { reasoning: "Reasoning", coding: "Coding", instructions: "Instructions", extraction: "Extraction", knowledge: "Knowledge", sanity: "Sanity" };
  const CAPS = [
    { id: "thinking", label: "Thinking" },
    { id: "vision", label: "Vision" },
    { id: "tools", label: "Tools" },
    { id: "local", label: "Runs locally" },
    { id: "free", label: "No per-token price" },
    { id: "measured", label: "Has results" },
    { id: "new", label: "New benchmarks" },
  ];
  const SORTS = [
    { id: "score", label: "Best score" },
    { id: "cheap", label: "Cheapest" },
    { id: "fast", label: "Fastest" },
    { id: "context", label: "Largest context" },
    { id: "name", label: "Name" },
  ];
  const VIEWS = ["models", "compare", "benchmarks", "runs"];
  const MAX_COMPARE = 8;
  const STORE_KEY = "psm.models.v1";

  /* ---------- tiny DOM helper: builds nodes, sets text, never parses markup ---------- */
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "style") node.setAttribute("style", value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  const button = (label, onclick, cls = "btn btn-small", attrs = {}) => h("button", { type: "button", class: cls, onclick, ...attrs }, label);

  /* ---------- formatting ---------- */
  const pct = (v) => v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
  const money = (v) => {
    if (v === null || v === undefined) return "—";
    if (v === 0) return "$0";
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  };
  const perMTok = (v) => v === null || v === undefined ? "?" : v === 0 ? "0" : v < 1 ? `$${v.toFixed(2)}` : `$${v % 1 ? v.toFixed(2) : v}`;
  const tokens = (v) => !v ? "—" : v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(v);
  const bytes = (v) => !v ? null : v >= 1e9 ? `${(v / 1e9).toFixed(1)} GB` : `${Math.round(v / 1e6)} MB`;
  const ms = (v) => v === null || v === undefined ? "—" : v >= 60_000 ? `${(v / 60_000).toFixed(1)} min` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  const ago = (t) => {
    if (!t) return "—";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  const scoreClass = (v) => v === null || v === undefined ? "na" : v >= 0.85 ? "hi" : v >= 0.6 ? "mid" : "lo";

  /* ---------- state ---------- */
  let ctx = null; // { api, root, summary, toast, setRoute }
  let data = null;
  let loadingOverview = null;
  let runs = { runs: [], active: [] };
  let pollTimer = null;
  let view = "models";
  let detailKey = null;
  let runDetail = null;
  const ui = loadUi();

  function loadUi() {
    const defaults = { q: "", engines: [], caps: [], sort: "score", layout: "cards", selected: [], cats: [], benchCats: [], suites: [], onlyDiff: false, runsModel: "", showUnavailable: false };
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      return { ...defaults, ...saved, q: "" };
    } catch {
      return defaults;
    }
  }
  function saveUi() {
    try {
      const { q, ...keep } = ui;
      localStorage.setItem(STORE_KEY, JSON.stringify(keep));
    } catch { /* private window: preferences just don't persist */ }
  }

  async function call(path, init = {}) {
    const response = await ctx.api(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  const modelByKey = (key) => data?.models.find((m) => m.key === key) || null;
  const suiteById = (id) => data?.suites.find((s) => s.id === id) || null;

  function capsOf(model) {
    const c = model.profile?.capabilities || {};
    const local = model.engine === "ollama" || model.engine === "gguf" || c.local;
    return {
      thinking: !!c.thinking || model.efforts.length > 0,
      vision: !!c.vision,
      tools: !!c.tools,
      local,
      free: local || model.profile?.pricing?.inputPerMTok === 0,
      measured: !!model.scores?.runs,
      new: model.newSuites.length > 0,
    };
  }

  function priceOf(model) {
    const p = model.profile?.pricing;
    if (!p) return model.engine === "ollama" || model.engine === "gguf" ? { text: "Free · local", sort: 0 } : { text: "Price not set", sort: Infinity };
    if (p.inputPerMTok === 0 && p.outputPerMTok === 0) return { text: "Free · local", sort: 0 };
    if (p.inputPerMTok === null || p.outputPerMTok === null) return { text: "Price not set", sort: Infinity };
    return { text: `${perMTok(p.inputPerMTok)} in · ${perMTok(p.outputPerMTok)} out /MTok`, sort: p.inputPerMTok + p.outputPerMTok * 3 };
  }

  /* ---------- loading ---------- */
  async function refresh(force = false) {
    if (loadingOverview && !force) return loadingOverview;
    ctx.summary.textContent = data ? "Refreshing…" : "Asking every engine which models it has…";
    loadingOverview = call(`/api/models${force ? "?refresh=1" : ""}`)
      .then((body) => {
        data = body;
        // forget selections of models that are gone
        ui.selected = ui.selected.filter((key) => data.models.some((m) => m.key === key));
        render();
        schedulePoll();
      })
      .catch((error) => {
        ctx.summary.textContent = error.message;
      })
      .finally(() => { loadingOverview = null; });
    return loadingOverview;
  }

  async function loadRuns() {
    try {
      const query = ui.runsModel ? `?model=${encodeURIComponent(ui.runsModel)}&limit=100` : "?limit=100";
      const before = new Set(runs.active.map((r) => r.id));
      runs = await call(`/api/models/runs${query}`);
      const finished = [...before].some((id) => !runs.active.some((r) => r.id === id));
      if (finished) await refresh();
      else if (view === "runs") render();
      else updateActive();
    } catch (error) {
      if (view === "runs") ctx.toast?.(error.message);
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!ctx) return;
    const busy = (data?.active?.length || 0) + (runs.active?.length || 0) > 0;
    if (!busy && view !== "runs") return;
    pollTimer = setTimeout(async () => {
      await loadRuns();
      schedulePoll();
    }, busy ? 2500 : 15000);
  }

  /* ---------- route ---------- */
  function routeParams() {
    const params = new URLSearchParams();
    if (view === "compare") {
      if (ui.selected.length) params.set("m", ui.selected.join(","));
      if (ui.cats.length) params.set("c", ui.cats.join(","));
      if (ui.suites.length) params.set("s", ui.suites.join(","));
    }
    const query = params.toString();
    return `#/models${view === "models" ? "" : `/${view}`}${query ? `?${query}` : ""}`;
  }
  function syncRoute() {
    const target = routeParams();
    if (location.hash !== target) history.replaceState(null, "", target);
  }
  function setView(next) {
    view = VIEWS.includes(next) ? next : "models";
    if (view === "runs") void loadRuns();
    render();
    schedulePoll();
  }

  /* ---------- render: frame ---------- */
  function render() {
    if (!ctx) return;
    syncRoute();
    const root = ctx.root;
    root.replaceChildren();
    if (!data) {
      root.append(h("div", { class: "mdl-empty" }, h("p", { class: "hint", text: "Loading models…" })));
      return;
    }
    const measured = data.models.filter((m) => m.scores?.runs).length;
    ctx.summary.textContent = `${data.models.filter((m) => m.available).length} models on ${data.engines.filter((e) => e.status !== "missing").length} engines · ${data.suites.length} benchmarks · ${measured} measured`;
    root.append(...[
      renderStatus(),
      renderRequests(),
      renderActive(),
      h("nav", { class: "mdl-tabs", role: "tablist", "aria-label": "Models views" },
        VIEWS.map((id) => h("button", {
          type: "button", role: "tab", class: `mdl-tab${view === id ? " on" : ""}`, "aria-selected": view === id ? "true" : "false",
          onclick: () => setView(id),
        }, { models: "Models", compare: `Compare${ui.selected.length ? ` (${ui.selected.length})` : ""}`, benchmarks: "Benchmarks", runs: `Runs${runs.active.length || data.active.length ? " ●" : ""}` }[id]))),
      view === "models" ? renderModels() : view === "compare" ? renderCompare() : view === "benchmarks" ? renderBenchmarks() : renderRuns(),
      renderTray(),
    ].filter(Boolean)); // append() would print a null as the text "null"
    if (detailKey) { const panel = renderDetail(); if (panel) root.append(panel); }
    if (runDetail) root.append(renderRunDetail());
  }

  function renderStatus() {
    const wrap = h("section", { class: "mdl-status", "aria-label": "Engines and usage" });
    if (!data.bench.found) {
      wrap.append(h("div", { class: "mdl-callout warn" },
        h("strong", { text: "model-bench is not set up. " }),
        `Benchmarks, results and local models need the model-bench repo at ${data.bench.dir}. `,
        data.bench.error ? h("span", { class: "hint", text: data.bench.error }) : null));
    }
    if (data.bench.libraryErrors?.length) {
      wrap.append(h("div", { class: "mdl-callout warn" }, h("strong", { text: "Broken benchmark files: " }), data.bench.libraryErrors.join(" · ")));
    }
    const engines = h("div", { class: "mdl-engines" });
    for (const engine of data.engines) {
      engines.append(h("span", { class: `mdl-engine st-${engine.status}`, title: engine.message || engine.status },
        h("span", { class: "dot" }), ENGINE_NAME[engine.engine] || engine.engine, " ",
        h("span", { class: "hint", text: engine.status === "ready" ? "ready" : engine.status === "stopped" ? "starts per run" : engine.status })));
    }
    wrap.append(engines);
    for (const provider of data.usage || []) {
      if (provider.status !== "available" || !provider.windows?.length) continue;
      wrap.append(h("div", { class: "mdl-usage", title: provider.message || "" },
        h("span", { class: "mdl-usage-name" }, provider.name, provider.plan ? h("span", { class: "hint", text: ` · ${provider.plan}` }) : null),
        provider.windows.slice(0, 3).map((w) => h("span", { class: `mdl-window sev-${w.severity}`, title: w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : "" },
          h("span", { class: "mdl-window-label", text: w.label }),
          h("span", { class: "mdl-bar" }, h("span", { style: `width:${Math.min(100, Math.max(0, w.usedPercent))}%` })),
          h("span", { class: "mdl-window-pct", text: `${Math.round(w.usedPercent)}%` })))));
    }
    return wrap;
  }

  function renderRequests() {
    if (!data.requests?.length) return null;
    return h("section", { class: "mdl-callout info", "aria-label": "Run requests from models" },
      h("strong", { text: `${data.requests.length} run request${data.requests.length > 1 ? "s" : ""} from models` }),
      h("p", { class: "hint", text: "A model asked over MCP to be benchmarked. Nothing runs until you approve; approving spends its usage window or GPU time." }),
      data.requests.map((request) => {
        const model = modelByKey(request.model);
        return h("div", { class: "mdl-request" },
          h("span", { class: "mono", text: model?.label || request.model }),
          h("span", { text: ` → ${request.suites.map((id) => suiteById(id)?.title || id).join(", ")}` }),
          h("span", { class: "hint", text: ` · “${request.reason}” · ${ago(request.requestedAt)}` }),
          h("span", { class: "mdl-request-actions" },
            button("Approve & run", () => decide(request.id, "approve"), "btn btn-small btn-primary"),
            button("Dismiss", () => decide(request.id, "dismiss"))));
      }));
  }

  async function decide(id, decision) {
    try {
      const body = await call(`/api/models/requests/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ decision }) });
      ctx.toast?.(decision === "approve" ? `Started ${body.runs.length} run(s)` : "Request dismissed");
      await refresh();
      await loadRuns();
    } catch (error) {
      ctx.toast?.(error.message);
    }
  }

  /** Progress only: a poll never rebuilds the page, so typing and scroll are left alone. */
  function updateActive() {
    if (!ctx || !data) return;
    const current = ctx.root.querySelector(".mdl-active, .mdl-active-slot");
    const next = renderActive() || h("div", { class: "mdl-active-slot", hidden: true });
    if (current) current.replaceWith(next);
  }

  function renderActive() {
    const active = runs.active.length ? runs.active : data.active || [];
    if (!active.length) return h("div", { class: "mdl-active-slot", hidden: true });
    return h("section", { class: "mdl-active", "aria-label": "Runs in progress", "aria-live": "polite" },
      active.map((run) => {
        const suite = suiteById(run.suite.id);
        const done = run.summary?.total || 0;
        const total = suite?.taskCount || done || 1;
        return h("div", { class: "mdl-active-row" },
          h("span", { class: `mdl-run-st st-${run.status}`, text: run.status }),
          h("span", { text: `${run.model.label} · ${run.suite.title}` }),
          h("span", { class: "mdl-bar wide" }, h("span", { style: `width:${Math.round((done / total) * 100)}%` })),
          h("span", { class: "hint", text: `${done}/${total}${run.summary ? ` · ${pct(run.summary.score)}` : ""}` }),
          button("Cancel", () => cancel(run.id)));
      }),
      active.length > 1 ? h("div", { class: "mdl-card-actions" }, button(`Cancel all ${active.length}`, () => cancelAll(active.map((run) => run.id)))) : null);
  }

  async function cancelAll(ids) {
    // queued first, so the queue does not start the next one while the running one stops
    const order = [...ids].sort((a, b) => Number(runs.active.find((r) => r.id === a)?.status === "running") - Number(runs.active.find((r) => r.id === b)?.status === "running"));
    for (const id of order) {
      try { await call(`/api/models/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }); } catch { /* already finished */ }
    }
    await loadRuns();
  }

  async function cancel(id) {
    try {
      await call(`/api/models/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
      await loadRuns();
    } catch (error) {
      ctx.toast?.(error.message);
    }
  }

  /* ---------- Models view ---------- */
  function filteredModels() {
    const q = ui.q.trim().toLowerCase();
    let list = data.models.filter((m) => ui.showUnavailable || m.available || m.scores?.runs);
    if (ui.engines.length) list = list.filter((m) => ui.engines.includes(m.engine));
    if (ui.caps.length) list = list.filter((m) => { const caps = capsOf(m); return ui.caps.every((c) => caps[c]); });
    if (q) {
      list = list.filter((m) => [m.label, m.id, m.description, m.profile?.vendor, m.profile?.family, ...(m.aliases || []), ...(m.profile?.bestAt || [])]
        .filter(Boolean).join(" ").toLowerCase().includes(q));
    }
    const by = {
      score: (a, b) => (b.scores?.overall ?? -1) - (a.scores?.overall ?? -1) || a.label.localeCompare(b.label),
      cheap: (a, b) => priceOf(a).sort - priceOf(b).sort || a.label.localeCompare(b.label),
      fast: (a, b) => (a.scores?.avgLatencyMs ?? Infinity) - (b.scores?.avgLatencyMs ?? Infinity),
      context: (a, b) => (b.profile?.contextTokens ?? 0) - (a.profile?.contextTokens ?? 0),
      name: (a, b) => a.label.localeCompare(b.label),
    }[ui.sort] || (() => 0);
    return [...list].sort(by);
  }

  function chip(label, on, onclick, count) {
    return h("button", { type: "button", class: `chip${on ? " on" : ""}`, "aria-pressed": on ? "true" : "false", onclick }, label, count !== undefined ? h("span", { class: "cnt", text: ` ${count}` }) : null);
  }
  function toggle(list, value) {
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1); else list.push(value);
  }

  function renderModels() {
    const list = filteredModels();
    const search = h("input", {
      type: "search", class: "mdl-search", placeholder: "Search models, vendors, strengths…", value: ui.q, "aria-label": "Search models",
      oninput: (event) => { ui.q = event.target.value; renderModelsBody(); },
    });
    const counts = Object.fromEntries(Object.keys(ENGINE_NAME).map((e) => [e, data.models.filter((m) => m.engine === e && (m.available || ui.showUnavailable)).length]));
    const toolbar = h("div", { class: "mdl-toolbar" },
      search,
      h("div", { class: "mdl-chips", role: "group", "aria-label": "Engine" },
        Object.keys(ENGINE_NAME).filter((e) => counts[e]).map((e) => chip(ENGINE_NAME[e], ui.engines.includes(e), () => { toggle(ui.engines, e); saveUi(); render(); }, counts[e]))),
      h("div", { class: "mdl-chips", role: "group", "aria-label": "Capabilities" },
        CAPS.map((c) => chip(c.label, ui.caps.includes(c.id), () => { toggle(ui.caps, c.id); saveUi(); render(); }))),
      h("div", { class: "mdl-toolbar-end" },
        h("label", { class: "mdl-inline" }, "Sort ",
          h("select", { onchange: (e) => { ui.sort = e.target.value; saveUi(); render(); } },
            SORTS.map((s) => h("option", { value: s.id, selected: ui.sort === s.id }, s.label)))),
        h("div", { class: "mdl-seg", role: "group", "aria-label": "Layout" },
          ["cards", "table"].map((l) => h("button", { type: "button", class: ui.layout === l ? "on" : "", "aria-pressed": ui.layout === l ? "true" : "false", onclick: () => { ui.layout = l; saveUi(); render(); } }, l === "cards" ? "Cards" : "Table"))),
        h("label", { class: "mdl-inline hint" }, h("input", { type: "checkbox", checked: ui.showUnavailable, onchange: (e) => { ui.showUnavailable = e.target.checked; saveUi(); render(); } }), " retired"),
        (ui.engines.length || ui.caps.length || ui.q) ? button("Clear filters", () => { ui.engines = []; ui.caps = []; ui.q = ""; saveUi(); render(); }) : null));
    const body = h("div", { class: "mdl-body", id: "mdl-models-body" });
    function renderModelsBody() {
      const items = filteredModels();
      body.replaceChildren(items.length
        ? (ui.layout === "table" ? renderTable(items) : h("div", { class: "mdl-grid" }, items.map(renderCard)))
        : h("p", { class: "mdl-empty hint", text: "No model matches these filters." }));
    }
    body.replaceChildren(list.length
      ? (ui.layout === "table" ? renderTable(list) : h("div", { class: "mdl-grid" }, list.map(renderCard)))
      : h("p", { class: "mdl-empty hint", text: "No model matches these filters." }));
    return h("div", {}, toolbar, body);
  }

  function selectBox(model) {
    const on = ui.selected.includes(model.key);
    return h("label", { class: "mdl-select", title: on ? "Remove from comparison" : "Add to comparison" },
      h("input", {
        type: "checkbox", checked: on, "aria-label": `Compare ${model.label}`,
        onchange: () => {
          if (!on && ui.selected.length >= MAX_COMPARE) { ctx.toast?.(`Compare up to ${MAX_COMPARE} models at once`); render(); return; }
          toggle(ui.selected, model.key); saveUi(); render();
        },
      }), " Compare");
  }

  function capTags(model) {
    const caps = capsOf(model);
    const c = model.profile?.capabilities || {};
    return h("div", { class: "mdl-tags" },
      caps.thinking ? h("span", { class: "mdl-tag", text: c.effort || model.efforts.length > 2 ? "thinking · effort" : "thinking" }) : null,
      caps.vision ? h("span", { class: "mdl-tag", text: "vision" }) : null,
      caps.tools ? h("span", { class: "mdl-tag", text: "tools" }) : null,
      caps.local ? h("span", { class: "mdl-tag local", text: "local" }) : null,
      c.openWeights ? h("span", { class: "mdl-tag", text: "open weights" }) : null,
      model.profile?.contextTokens ? h("span", { class: "mdl-tag", text: `${tokens(model.profile.contextTokens)} context` }) : null,
      model.params ? h("span", { class: "mdl-tag", text: model.params }) : null,
      model.quantization ? h("span", { class: "mdl-tag", text: model.quantization }) : null,
      bytes(model.sizeBytes || model.profile?.resources?.diskBytes) ? h("span", { class: "mdl-tag", text: bytes(model.sizeBytes || model.profile?.resources?.diskBytes) }) : null);
  }

  function scoreBlock(model) {
    const s = model.scores;
    if (!s?.runs) {
      return h("div", { class: "mdl-score none" }, h("span", { class: "hint", text: model.applicable.length ? "Not benchmarked yet" : "No benchmark applies" }));
    }
    const cats = Object.entries(s.categories || {});
    return h("div", { class: "mdl-score" },
      h("div", { class: `mdl-overall ${scoreClass(s.overall)}`, title: "Mean of current benchmark scores" }, h("strong", { text: pct(s.overall) }), h("span", { class: "hint", text: "overall" })),
      h("div", { class: "mdl-cats" }, cats.map(([cat, v]) => h("div", { class: "mdl-cat", title: `${CATEGORY_NAME[cat] || cat}: ${pct(v)}` },
        h("span", { class: "mdl-cat-name", text: CATEGORY_NAME[cat] || cat }),
        h("span", { class: "mdl-bar" }, h("span", { class: scoreClass(v), style: `width:${Math.round(v * 100)}%` })),
        h("span", { class: "mdl-cat-v", text: pct(v) })))),
      h("div", { class: "mdl-perf hint" },
        s.avgLatencyMs !== null ? `${ms(s.avgLatencyMs)}/task` : null,
        s.tokPerS ? ` · ${s.tokPerS} tok/s` : null,
        s.avgCostPerTask !== null ? ` · ${money(s.avgCostPerTask)}/task` : null));
  }

  function strengths(model, limit = 3) {
    const best = [...(model.profile?.bestAt || [])];
    const weak = [...(model.profile?.weakAt || [])];
    const strong = (model.insight?.strong || []).map((s) => `${CATEGORY_NAME[s.category]} ${pct(s.score)}${s.of > 1 ? ` (#${s.rank} of ${s.of})` : ""}`);
    const poor = (model.insight?.weak || []).map((s) => `${CATEGORY_NAME[s.category]} ${pct(s.score)}${s.of > 1 ? ` (#${s.rank} of ${s.of})` : ""}`);
    if (!best.length && !weak.length && !strong.length && !poor.length) return null;
    return h("div", { class: "mdl-sw" },
      (best.length || strong.length) ? h("div", { class: "mdl-sw-col good" }, h("span", { class: "mdl-sw-h", text: "Best at" }),
        h("ul", {}, strong.map((t) => h("li", { class: "measured", title: "Measured by benchmarks" }, "▲ ", t)), best.slice(0, limit).map((t) => h("li", { text: t })))) : null,
      (weak.length || poor.length) ? h("div", { class: "mdl-sw-col bad" }, h("span", { class: "mdl-sw-h", text: "Not good at" }),
        h("ul", {}, poor.map((t) => h("li", { class: "measured", title: "Measured by benchmarks" }, "▼ ", t)), weak.slice(0, limit).map((t) => h("li", { text: t })))) : null);
  }

  function renderCard(model) {
    const price = priceOf(model);
    return h("article", { class: `mdl-card${ui.selected.includes(model.key) ? " selected" : ""}${model.available ? "" : " retired"}` },
      h("header", { class: "mdl-card-head" },
        h("div", { class: "mdl-card-title" },
          h("span", { class: `mdl-engine-badge e-${model.engine}`, text: ENGINE_NAME[model.engine] }),
          h("h3", {}, h("button", { type: "button", class: "mdl-link", onclick: () => openDetail(model.key), text: model.label })),
          h("span", { class: "mdl-id mono", text: model.id + (model.aliases.length ? `  (${model.aliases.join(", ")})` : "") })),
        selectBox(model)),
      model.description || model.profile?.notes ? h("p", { class: "mdl-desc", text: model.profile?.notes || model.description }) : null,
      model.detail ? h("p", { class: "hint", text: model.detail }) : null,
      h("div", { class: "mdl-price" }, h("span", { class: price.sort === Infinity ? "hint" : "", text: price.text }),
        model.profile?.resources?.decodeTokPerS ? h("span", { class: "hint", text: ` · ~${model.profile.resources.decodeTokPerS} tok/s CPU (catalog)` }) : null),
      capTags(model),
      scoreBlock(model),
      strengths(model),
      h("footer", { class: "mdl-card-foot" },
        model.newSuites.length ? h("span", { class: "mdl-new", title: model.newSuites.map((id) => suiteById(id)?.title || id).join(", "), text: `${model.newSuites.length} new benchmark${model.newSuites.length > 1 ? "s" : ""}` }) : h("span", {}),
        h("span", { class: "mdl-card-actions" },
          button("Details", () => openDetail(model.key)),
          model.available && data.bench.found ? button("Benchmark…", () => openRunDialog([model.key], model.newSuites.length ? model.newSuites : model.applicable), "btn btn-small btn-primary") : null)));
  }

  function renderTable(list) {
    const cats = Object.keys(CATEGORY_NAME).filter((cat) => list.some((m) => m.scores?.categories?.[cat] !== undefined));
    const best = Object.fromEntries(cats.map((cat) => [cat, Math.max(...list.map((m) => m.scores?.categories?.[cat] ?? -1))]));
    return h("div", { class: "mdl-table-wrap" }, h("table", { class: "mdl-table" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col" }, ""), h("th", { scope: "col", text: "Model" }), h("th", { scope: "col", text: "Engine" }), h("th", { scope: "col", text: "Price" }),
        h("th", { scope: "col", text: "Context" }), h("th", { scope: "col", text: "Overall" }),
        cats.map((cat) => h("th", { scope: "col", text: CATEGORY_NAME[cat] })),
        h("th", { scope: "col", text: "Latency" }), h("th", { scope: "col", text: "$/task" }), h("th", { scope: "col", text: "New" }))),
      h("tbody", {}, list.map((m) => h("tr", { class: ui.selected.includes(m.key) ? "selected" : "" },
        h("td", {}, h("input", { type: "checkbox", checked: ui.selected.includes(m.key), "aria-label": `Compare ${m.label}`, onchange: () => { toggle(ui.selected, m.key); saveUi(); render(); } })),
        h("td", {}, h("button", { type: "button", class: "mdl-link", onclick: () => openDetail(m.key), text: m.label }), h("div", { class: "mdl-id mono", text: m.id })),
        h("td", { text: ENGINE_NAME[m.engine] }),
        h("td", { class: "num", text: priceOf(m).text }),
        h("td", { class: "num", text: tokens(m.profile?.contextTokens) }),
        h("td", { class: `num score ${scoreClass(m.scores?.overall)}`, text: pct(m.scores?.overall) }),
        cats.map((cat) => {
          const v = m.scores?.categories?.[cat];
          return h("td", { class: `num score ${scoreClass(v)}${v !== undefined && v === best[cat] ? " best" : ""}`, text: pct(v) });
        }),
        h("td", { class: "num", text: ms(m.scores?.avgLatencyMs) }),
        h("td", { class: "num", text: money(m.scores?.avgCostPerTask) }),
        h("td", { class: "num", text: m.newSuites.length || "" }))))));
  }

  /* ---------- compare tray ---------- */
  function renderTray() {
    if (!ui.selected.length || view === "compare") return null;
    return h("div", { class: "mdl-tray", role: "region", "aria-label": "Selected for comparison" },
      h("span", { class: "hint", text: `${ui.selected.length} selected` }),
      ui.selected.map((key) => h("span", { class: "mdl-tray-chip" }, modelByKey(key)?.label || key,
        h("button", { type: "button", class: "mdl-x", "aria-label": `Remove ${modelByKey(key)?.label || key}`, onclick: () => { toggle(ui.selected, key); saveUi(); render(); } }, "×"))),
      h("span", { class: "mdl-tray-actions" },
        button("Clear", () => { ui.selected = []; saveUi(); render(); }),
        data.bench.found ? button("Benchmark selected…", () => openRunDialog(ui.selected, null)) : null,
        button(`Compare ${ui.selected.length} →`, () => setView("compare"), "btn btn-small btn-primary", { disabled: ui.selected.length < 1 })));
  }

  /* ---------- Compare view ---------- */
  function renderCompare() {
    const models = ui.selected.map(modelByKey).filter(Boolean);
    if (!models.length) {
      return h("div", { class: "mdl-empty" },
        h("p", { text: "Pick models to compare: tick “Compare” on any card, or add one here." }),
        addModelSelect(), quickPicks());
    }
    const suites = data.suites
      .filter((s) => !ui.cats.length || ui.cats.includes(s.category))
      .filter((s) => !ui.suites.length || ui.suites.includes(s.id));
    const cats = Object.keys(CATEGORY_NAME).filter((cat) => suites.some((s) => s.category === cat));

    const filters = h("div", { class: "mdl-toolbar" },
      h("div", { class: "mdl-chips", role: "group", "aria-label": "Models compared" },
        models.map((m) => h("span", { class: "mdl-tray-chip" }, m.label,
          h("button", { type: "button", class: "mdl-x", "aria-label": `Remove ${m.label}`, onclick: () => { toggle(ui.selected, m.key); saveUi(); render(); } }, "×"))),
        ui.selected.length < MAX_COMPARE ? addModelSelect() : null),
      h("div", { class: "mdl-chips", role: "group", "aria-label": "Categories" },
        h("span", { class: "hint", text: "Categories" }),
        Object.keys(CATEGORY_NAME).filter((cat) => data.suites.some((s) => s.category === cat)).map((cat) =>
          chip(CATEGORY_NAME[cat], ui.cats.includes(cat), () => { toggle(ui.cats, cat); ui.suites = ui.suites.filter((id) => !ui.cats.length || ui.cats.includes(suiteById(id)?.category)); saveUi(); render(); }))),
      h("div", { class: "mdl-chips", role: "group", "aria-label": "Benchmarks" },
        h("span", { class: "hint", text: "Benchmarks" }),
        data.suites.filter((s) => !ui.cats.length || ui.cats.includes(s.category)).map((s) =>
          chip(s.title, ui.suites.includes(s.id), () => { toggle(ui.suites, s.id); saveUi(); render(); }))),
      h("div", { class: "mdl-toolbar-end" },
        h("label", { class: "mdl-inline" }, h("input", { type: "checkbox", checked: ui.onlyDiff, onchange: (e) => { ui.onlyDiff = e.target.checked; saveUi(); render(); } }), " Only rows that differ"),
        (ui.cats.length || ui.suites.length) ? button("Reset filters", () => { ui.cats = []; ui.suites = []; saveUi(); render(); }) : null,
        button("Copy link", () => { navigator.clipboard?.writeText(location.href).then(() => ctx.toast?.("Link copied"), () => ctx.toast?.(location.href)); }),
        data.bench.found ? fillGapsButton(models, suites) : null));

    const rows = [];
    const row = (section, label, values, opts = {}) => rows.push({ section, label, values, ...opts });
    // Overview
    row("Overview", "Engine", models.map((m) => ENGINE_NAME[m.engine]));
    row("Overview", "Vendor", models.map((m) => m.profile?.vendor || "—"));
    row("Overview", "Price (per MTok)", models.map((m) => priceOf(m).text), { numeric: models.map((m) => -priceOf(m).sort), higherBetter: true, noBestIf: (v) => v === -Infinity });
    row("Overview", "Context", models.map((m) => tokens(m.profile?.contextTokens)), { numeric: models.map((m) => m.profile?.contextTokens ?? null), higherBetter: true });
    row("Overview", "Max output", models.map((m) => tokens(m.profile?.maxOutputTokens)));
    row("Overview", "Thinking / effort", models.map((m) => capsOf(m).thinking ? (m.efforts.length ? m.efforts.join(" · ") : "yes") : "no"));
    row("Overview", "Vision", models.map((m) => capsOf(m).vision ? "yes" : "no"));
    row("Overview", "Runs locally", models.map((m) => capsOf(m).local ? "yes" : "no"));
    row("Overview", "Size", models.map((m) => bytes(m.sizeBytes || m.profile?.resources?.diskBytes) || "—"));
    // Scores
    const overall = models.map((m) => {
      const cells = suites.map((s) => m.scores?.suites?.[s.id]).filter((c) => c && !c.stale);
      return cells.length ? cells.reduce((a, c) => a + c.score, 0) / cells.length : null;
    });
    row("Scores", ui.cats.length || ui.suites.length ? "Score (filtered)" : "Overall", overall.map(pct), { numeric: overall, higherBetter: true, bars: overall, strong: true });
    for (const cat of cats) {
      const values = models.map((m) => {
        const cells = suites.filter((s) => s.category === cat).map((s) => m.scores?.suites?.[s.id]).filter((c) => c && !c.stale);
        return cells.length ? cells.reduce((a, c) => a + c.score, 0) / cells.length : null;
      });
      row("Scores", CATEGORY_NAME[cat], values.map(pct), { numeric: values, higherBetter: true, bars: values });
    }
    for (const suite of suites) {
      const cells = models.map((m) => m.scores?.suites?.[suite.id] || null);
      const values = cells.map((c) => c ? c.score : null);
      row("Benchmarks", suite.title, cells.map((c, i) => {
        if (!c) return models[i].applicable.includes(suite.id) ? "not run" : "n/a";
        return `${pct(c.score)}  ${c.passed}/${c.total}${c.stale ? " · old version" : ""}${c.effort ? ` · ${c.effort}` : ""}`;
      }), { numeric: values.map((v, i) => cells[i]?.stale ? null : v), higherBetter: true, bars: values, runIds: cells.map((c) => c?.runId || null), stale: cells.map((c) => !!c?.stale) });
    }
    // Performance
    const lat = models.map((m) => m.scores?.avgLatencyMs ?? null);
    row("Performance", "Avg latency / task", lat.map(ms), { numeric: lat, higherBetter: false });
    const cost = models.map((m) => m.scores?.avgCostPerTask ?? null);
    row("Performance", "Avg cost / task (API-equivalent)", cost.map(money), { numeric: cost, higherBetter: false });
    const speed = models.map((m) => m.scores?.tokPerS ?? null);
    row("Performance", "Decode speed", speed.map((v) => v ? `${v} tok/s` : "—"), { numeric: speed, higherBetter: true });
    const value = models.map((m, i) => overall[i] !== null && cost[i] ? overall[i] / Math.max(cost[i], 1e-6) : null);
    row("Performance", "Score per $ (filtered)", value.map((v) => v === null ? "—" : v > 1000 ? `${Math.round(v / 1000)}K` : Math.round(v)), { numeric: value, higherBetter: true });
    row("Performance", "Runs recorded", models.map((m) => m.scores?.runs || 0));
    // Strengths
    row("Strengths", "Best at", models.map((m) => [
      ...(m.insight?.strong || []).filter((s) => !ui.cats.length || ui.cats.includes(s.category)).map((s) => `▲ ${CATEGORY_NAME[s.category]} ${pct(s.score)}`),
      ...(m.profile?.bestAt || []),
    ]), { list: true });
    row("Strengths", "Not good at", models.map((m) => [
      ...(m.insight?.weak || []).filter((s) => !ui.cats.length || ui.cats.includes(s.category)).map((s) => `▼ ${CATEGORY_NAME[s.category]} ${pct(s.score)}`),
      ...(m.profile?.weakAt || []),
    ]), { list: true });

    const visible = rows.filter((r) => !ui.onlyDiff || models.length < 2 || new Set(r.values.map((v) => JSON.stringify(v))).size > 1);
    const table = h("table", { class: "mdl-compare" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "mdl-compare-label" }, ""),
        models.map((m) => h("th", { scope: "col" },
          h("button", { type: "button", class: "mdl-link", onclick: () => openDetail(m.key), text: m.label }),
          h("div", { class: "mdl-id mono", text: m.id }))))),
      h("tbody", {}, (() => {
        const out = [];
        let section = null;
        for (const r of visible) {
          if (r.section !== section) {
            section = r.section;
            out.push(h("tr", { class: "mdl-section" }, h("th", { scope: "rowgroup", colspan: models.length + 1, text: section })));
          }
          const nums = (r.numeric || []).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
          const bestValue = nums.length > 1 ? (r.higherBetter ? Math.max(...nums) : Math.min(...nums)) : null;
          const allSame = nums.length > 1 && nums.every((v) => v === nums[0]);
          out.push(h("tr", { class: r.strong ? "strong" : "" },
            h("th", { scope: "row", class: "mdl-compare-label", text: r.label }),
            r.values.map((v, i) => {
              const n = r.numeric?.[i];
              const isBest = bestValue !== null && !allSame && n === bestValue;
              const content = r.list
                ? (v.length ? h("ul", { class: "mdl-cmp-list" }, v.slice(0, 5).map((t) => h("li", { class: t.startsWith("▲") || t.startsWith("▼") ? "measured" : "", text: t }))) : "—")
                : r.runIds?.[i]
                  ? h("button", { type: "button", class: "mdl-link", title: "Open this run", onclick: () => openRun(r.runIds[i]), text: String(v) })
                  : String(v);
              return h("td", { class: `${isBest ? "best" : ""}${r.stale?.[i] ? " stale" : ""}` },
                r.bars && r.bars[i] !== null && r.bars[i] !== undefined ? h("span", { class: "mdl-bar cell" }, h("span", { class: scoreClass(r.bars[i]), style: `width:${Math.round(r.bars[i] * 100)}%` })) : null,
                content, isBest ? h("span", { class: "mdl-best", title: "Best in this row", text: " ★" }) : null);
            })));
        }
        return out;
      })()));
    return h("div", {}, filters, h("div", { class: "mdl-table-wrap" }, table),
      h("p", { class: "hint mdl-foot-note", text: "★ best in row. ▲▼ are measured by benchmarks; other strengths are curated in model-bench/profiles. Costs are API-equivalent: on a subscription a run spends your usage window instead. Results on an older benchmark version are shown but not counted." }));
  }

  function fillGapsButton(models, suites) {
    const gaps = [];
    for (const m of models) {
      if (!m.available) continue;
      for (const s of suites) {
        const cell = m.scores?.suites?.[s.id];
        if (m.applicable.includes(s.id) && (!cell || cell.stale)) gaps.push([m.key, s.id]);
      }
    }
    if (!gaps.length) return null;
    return button(`Run ${gaps.length} missing…`, () => openRunDialog([...new Set(gaps.map((g) => g[0]))], [...new Set(gaps.map((g) => g[1]))], gaps), "btn btn-small btn-primary", { title: "Benchmark only the model × benchmark cells without a current result" });
  }

  function addModelSelect() {
    const options = data.models.filter((m) => !ui.selected.includes(m.key) && (m.available || m.scores?.runs));
    return h("select", {
      class: "mdl-add", "aria-label": "Add a model to the comparison",
      onchange: (e) => { if (e.target.value) { ui.selected.push(e.target.value); saveUi(); render(); } },
    }, h("option", { value: "" }, "+ Add model…"),
    Object.keys(ENGINE_NAME).map((engine) => {
      const group = options.filter((m) => m.engine === engine);
      return group.length ? h("optgroup", { label: ENGINE_NAME[engine] }, group.map((m) => h("option", { value: m.key }, m.label))) : null;
    }));
  }

  function quickPicks() {
    const picks = [
      { label: "Top 4 measured", keys: data.models.filter((m) => m.scores?.overall !== null && m.scores?.overall !== undefined).slice().sort((a, b) => b.scores.overall - a.scores.overall).slice(0, 4).map((m) => m.key) },
      { label: "Current Claude family", keys: data.models.filter((m) => m.engine === "claude" && m.aliases.length).map((m) => m.key) },
      { label: "All local models", keys: data.models.filter((m) => (m.engine === "ollama" || m.engine === "gguf") && m.available).map((m) => m.key).slice(0, MAX_COMPARE) },
      { label: "Codex models", keys: data.models.filter((m) => m.engine === "codex").map((m) => m.key).slice(0, MAX_COMPARE) },
    ].filter((p) => p.keys.length);
    return h("div", { class: "mdl-chips" }, h("span", { class: "hint", text: "Quick picks" }),
      picks.map((p) => chip(p.label, false, () => { ui.selected = p.keys; saveUi(); render(); }, p.keys.length)));
  }

  /* ---------- Benchmarks view ---------- */
  function scopeText(scope) {
    if (scope.kind === "general") return "All models";
    if (scope.kind === "engines") return `Only ${scope.engines.map((e) => ENGINE_NAME[e]).join(", ")}`;
    return `Models matching ${scope.match.join(", ")}`;
  }

  function renderBenchmarks() {
    if (!data.bench.found) return h("div", { class: "mdl-empty" }, h("p", { text: "Clone or create model-bench next to psm to get the benchmark library." }));
    const cats = Object.keys(CATEGORY_NAME).filter((cat) => data.suites.some((s) => s.category === cat));
    const list = data.suites.filter((s) => !ui.benchCats.length || ui.benchCats.includes(s.category));
    const mcp = data.bench.mcp;
    const mcpJson = mcp ? JSON.stringify({ mcpServers: { "model-bench": { command: mcp.command, args: mcp.args } } }, null, 2) : "";
    return h("div", {},
      h("div", { class: "mdl-toolbar" }, h("div", { class: "mdl-chips" }, h("span", { class: "hint", text: "Category" }),
        cats.map((cat) => chip(CATEGORY_NAME[cat], ui.benchCats.includes(cat), () => { toggle(ui.benchCats, cat); saveUi(); render(); }, data.suites.filter((s) => s.category === cat).length)))),
      h("div", { class: "mdl-bench-list" }, list.map((suite) => {
        const applicable = data.models.filter((m) => m.applicable.includes(suite.id) && m.available);
        const measured = data.models.filter((m) => m.scores?.suites?.[suite.id] && !m.scores.suites[suite.id].stale);
        const ranked = measured.map((m) => [m, m.scores.suites[suite.id].score]).sort((a, b) => b[1] - a[1]);
        return h("article", { class: "mdl-bench" },
          h("header", {},
            h("h3", { text: suite.title }),
            h("span", { class: "mdl-tag", text: CATEGORY_NAME[suite.category] }),
            h("span", { class: "mdl-tag", text: `v${suite.version}` }),
            h("span", { class: "mdl-tag", text: `${suite.taskCount} tasks` }),
            suite.tags.map((t) => h("span", { class: "mdl-tag subtle", text: t }))),
          h("p", { class: "mdl-desc", text: suite.description }),
          h("p", { class: "hint", text: `${scopeText(suite.scope)} · added ${suite.addedAt} · measured on ${measured.length} of ${applicable.length} models` }),
          ranked.length ? h("ol", { class: "mdl-rank" }, ranked.slice(0, 5).map(([m, v]) => h("li", {},
            h("button", { type: "button", class: "mdl-link", onclick: () => openDetail(m.key), text: m.label }),
            h("span", { class: "mdl-bar" }, h("span", { class: scoreClass(v), style: `width:${Math.round(v * 100)}%` })),
            h("span", { class: "num", text: pct(v) })))) : null,
          h("div", { class: "mdl-card-actions" },
            button("Compare all measured", () => { ui.selected = ranked.slice(0, MAX_COMPARE).map(([m]) => m.key); ui.suites = [suite.id]; ui.cats = []; saveUi(); setView("compare"); }, "btn btn-small", { disabled: ranked.length < 1 }),
            button("Run on…", () => openRunDialog(applicable.filter((m) => !m.scores?.suites?.[suite.id] || m.scores.suites[suite.id].stale).slice(0, 4).map((m) => m.key), [suite.id]), "btn btn-small btn-primary")));
      })),
      h("section", { class: "mdl-howto" },
        h("h3", { text: "Let models read the library (MCP)" }),
        h("p", { class: "hint", text: "Models can list benchmarks, see which are new for them, read and compare results, and ask for a run. They cannot start a run or see answers: requests wait here for you." }),
        mcp ? h("pre", { class: "mdl-pre" }, mcpJson) : null,
        mcp ? button("Copy MCP config", () => navigator.clipboard?.writeText(mcpJson).then(() => ctx.toast?.("Copied"))) : null,
        h("h3", { text: "Add a benchmark" }),
        h("p", { class: "hint", text: `Drop a JSON file in ${data.bench.dir}/library (general/, coding/ or specific/), then run npm run validate there. Bump "version" when you change tasks so older results show as stale.` })));
  }

  /* ---------- Runs view ---------- */
  function renderRuns() {
    const list = runs.runs || [];
    const filter = h("div", { class: "mdl-toolbar" },
      h("label", { class: "mdl-inline" }, "Model ",
        h("select", { onchange: (e) => { ui.runsModel = e.target.value; saveUi(); void loadRuns(); } },
          h("option", { value: "" }, "All models"),
          data.models.filter((m) => m.scores?.runs).map((m) => h("option", { value: m.key, selected: ui.runsModel === m.key }, m.label)))),
      button("Reload", () => loadRuns()));
    if (!list.length) return h("div", {}, filter, h("p", { class: "mdl-empty hint", text: "No runs yet. Pick a model and press Benchmark…" }));
    return h("div", {}, filter, h("div", { class: "mdl-table-wrap" }, h("table", { class: "mdl-table" },
      h("thead", {}, h("tr", {}, ["When", "Model", "Benchmark", "Effort", "Status", "Score", "Passed", "Latency", "Cost", ""].map((t) => h("th", { scope: "col", text: t })))),
      h("tbody", {}, list.map((run) => h("tr", {},
        h("td", { text: ago(run.finishedAt || run.createdAt), title: new Date(run.createdAt).toLocaleString() }),
        h("td", { text: run.model.label }),
        h("td", {}, run.suite.title, h("span", { class: "hint", text: ` v${run.suite.version}` })),
        h("td", { text: run.effort || "default" }),
        h("td", {}, h("span", { class: `mdl-run-st st-${run.status}`, text: run.status, title: run.message || "" })),
        h("td", { class: `num score ${scoreClass(run.summary?.score)}`, text: pct(run.summary?.score) }),
        h("td", { class: "num", text: run.summary ? `${run.summary.passed}/${run.summary.total}` : "—" }),
        h("td", { class: "num", text: ms(run.summary?.avgLatencyMs) }),
        h("td", { class: "num", text: money(run.summary?.costUsd) }),
        h("td", { class: "mdl-row-actions" },
          button("Open", () => openRun(run.id)),
          run.status === "queued" || run.status === "running" ? button("Cancel", () => cancel(run.id)) : button("Delete", () => removeRun(run.id), "btn btn-small", { title: "Delete this result" }))))))));
  }

  async function removeRun(id) {
    try {
      await call(`/api/models/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
      ctx.toast?.("Result deleted");
      await refresh();
      await loadRuns();
    } catch (error) {
      ctx.toast?.(error.message);
    }
  }

  /* ---------- model detail ---------- */
  function openDetail(key) {
    detailKey = key;
    render();
    void (async () => {
      try {
        const body = await call(`/api/models/runs?model=${encodeURIComponent(key)}&limit=30`);
        if (detailKey === key) { detailRuns = body.runs; render(); }
      } catch { /* the panel works without history */ }
    })();
  }
  let detailRuns = null;

  function drawer(title, onclose, ...content) {
    const panel = h("aside", { class: "mdl-drawer", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "mdl-drawer-head" }, h("h2", { text: title }), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: onclose }, "✕")),
      h("div", { class: "mdl-drawer-body" }, content));
    const backdrop = h("div", { class: "mdl-backdrop", onclick: onclose });
    queueMicrotask(() => panel.querySelector("button")?.focus());
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") onclose(); });
    return h("div", {}, backdrop, panel);
  }

  function renderDetail() {
    const m = modelByKey(detailKey);
    if (!m) { detailKey = null; return null; }
    const p = m.profile;
    const close = () => { detailKey = null; detailRuns = null; render(); };
    const facts = [
      ["Engine", ENGINE_NAME[m.engine]],
      ["Model id", m.id],
      m.aliases.length ? ["Aliases", m.aliases.join(", ")] : null,
      p?.vendor ? ["Vendor", p.vendor] : null,
      p?.family ? ["Family", p.family] : null,
      ["Price", priceOf(m).text],
      p?.pricing?.note ? ["Pricing note", p.pricing.note] : null,
      p?.pricing?.asOf ? ["Price as of", `${p.pricing.asOf} (${p.pricing.source})`] : null,
      ["Context", tokens(p?.contextTokens)],
      ["Max output", tokens(p?.maxOutputTokens)],
      m.efforts.length ? ["Effort levels", m.efforts.join(", ")] : null,
      p?.license ? ["Licence", p.license] : null,
      p?.resources?.ramMB ? ["RAM needed", `${p.resources.ramMB} MB`] : null,
      bytes(m.sizeBytes || p?.resources?.diskBytes) ? ["On disk", bytes(m.sizeBytes || p?.resources?.diskBytes)] : null,
      p?.resources?.measuredOn ? ["Catalog measurement", `${p.resources.decodeTokPerS} tok/s on ${p.resources.measuredOn}`] : null,
    ].filter(Boolean);
    const usage = m.engine === "claude" || m.engine === "codex" ? (data.usage || []).find((u) => u.id === m.engine) : null;
    return drawer(m.label, close,
      h("p", { class: "mdl-desc", text: p?.notes || m.description || "" }),
      capTags(m),
      h("dl", { class: "mdl-facts" }, facts.map(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])),
      usage?.windows?.length ? h("div", { class: "mdl-usage block" }, h("span", { class: "mdl-usage-name", text: `${usage.name} usage now` }),
        usage.windows.map((w) => h("span", { class: `mdl-window sev-${w.severity}` }, h("span", { class: "mdl-window-label", text: w.label }), h("span", { class: "mdl-bar" }, h("span", { style: `width:${Math.min(100, w.usedPercent)}%` })), h("span", { class: "mdl-window-pct", text: `${Math.round(w.usedPercent)}%` })))) : null,
      h("h3", { text: "Scores" }),
      scoreBlock(m),
      m.scores?.runs ? h("table", { class: "mdl-table compact" },
        h("tbody", {}, data.suites.filter((s) => m.scores.suites[s.id]).map((s) => {
          const c = m.scores.suites[s.id];
          return h("tr", {}, h("td", {}, h("button", { type: "button", class: "mdl-link", onclick: () => openRun(c.runId), text: s.title })),
            h("td", { class: `num score ${scoreClass(c.score)}`, text: pct(c.score) }), h("td", { class: "num", text: `${c.passed}/${c.total}` }),
            h("td", { class: "hint", text: `${c.stale ? "old version · " : ""}${ago(c.finishedAt)}` }));
        }))) : null,
      strengths(m, 10),
      m.newSuites.length ? h("p", {}, h("span", { class: "mdl-new", text: `New for this model: ${m.newSuites.map((id) => suiteById(id)?.title || id).join(", ")}` })) : null,
      h("div", { class: "mdl-card-actions" },
        m.available && data.bench.found ? button("Benchmark…", () => { openRunDialog([m.key], m.newSuites.length ? m.newSuites : m.applicable); }, "btn btn-small btn-primary") : null,
        button(ui.selected.includes(m.key) ? "Remove from compare" : "Add to compare", () => { toggle(ui.selected, m.key); saveUi(); render(); })),
      h("h3", { text: "Run history" }),
      detailRuns === null ? h("p", { class: "hint", text: "Loading…" }) : detailRuns.length
        ? h("ul", { class: "mdl-history" }, detailRuns.map((run) => h("li", {},
          h("button", { type: "button", class: "mdl-link", onclick: () => openRun(run.id), text: `${run.suite.title} v${run.suite.version}` }),
          h("span", { class: `mdl-run-st st-${run.status}`, text: run.status }),
          h("span", { class: `score ${scoreClass(run.summary?.score)}`, text: ` ${pct(run.summary?.score)}` }),
          h("span", { class: "hint", text: ` · ${run.effort || "default effort"} · ${ago(run.finishedAt || run.createdAt)}` }))))
        : h("p", { class: "hint", text: "No runs yet." }));
  }

  /* ---------- run detail ---------- */
  async function openRun(id) {
    try {
      runDetail = await call(`/api/models/runs/${encodeURIComponent(id)}`);
      render();
    } catch (error) {
      ctx.toast?.(error.message);
    }
  }

  function renderRunDetail() {
    const { run, prompts } = runDetail;
    const close = () => { runDetail = null; render(); };
    const s = run.summary;
    return drawer(`${run.model.label} · ${run.suite.title}`, close,
      h("p", { class: "hint", text: `v${run.suite.version} · ${run.effort || "default effort"} · ${run.status} · started by ${run.startedBy} · ${new Date(run.createdAt).toLocaleString()}${run.servedBy ? ` · served by ${run.servedBy}` : ""}` }),
      run.message ? h("div", { class: "mdl-callout warn", text: run.message }) : null,
      s ? h("div", { class: "mdl-run-summary" },
        h("span", { class: `mdl-overall ${scoreClass(s.score)}` }, h("strong", { text: pct(s.score) })),
        h("span", { text: `${s.passed}/${s.total} passed${s.errors ? ` · ${s.errors} errors` : ""}` }),
        h("span", { class: "hint", text: `${ms(s.avgLatencyMs)}/task · ${tokens(s.inputTokens)} in · ${tokens(s.outputTokens)} out · ${money(s.costUsd)}${s.tokPerS ? ` · ${s.tokPerS} tok/s` : ""}` })) : null,
      h("div", { class: "mdl-tasks" }, run.tasks.map((t) => h("details", { class: `mdl-task ${t.passed ? "pass" : "fail"}` },
        h("summary", {},
          h("span", { class: "mdl-task-mark", text: t.passed ? "✓" : t.score > 0 ? "◐" : "✗", "aria-label": t.passed ? "passed" : "failed" }),
          h("span", { class: "mono", text: t.taskId }),
          h("span", { class: "hint", text: ` ${pct(t.score)} · ${t.error ? t.error : t.detail} · ${ms(t.latencyMs)}${t.costUsd ? ` · ${money(t.costUsd)}` : ""}` })),
        prompts[t.taskId] ? h("div", {}, h("span", { class: "mdl-sw-h", text: "Prompt" }), h("pre", { class: "mdl-pre", text: prompts[t.taskId] })) : null,
        h("span", { class: "mdl-sw-h", text: "Answer" }),
        h("pre", { class: "mdl-pre", text: t.output || "(empty)" })))));
  }

  /* ---------- run dialog ---------- */
  function estimate(models, suites, pairs) {
    let tasks = 0;
    let cost = 0;
    let unknown = 0;
    const cells = pairs || models.flatMap((m) => suites.filter((s) => m.applicable.includes(s.id)).map((s) => [m.key, s.id]));
    for (const [key, suiteId] of cells) {
      const m = modelByKey(key);
      const s = suiteById(suiteId);
      if (!m || !s) continue;
      tasks += s.taskCount;
      const p = m.profile?.pricing;
      const measured = m.scores?.avgCostPerTask;
      if (measured !== null && measured !== undefined) cost += measured * s.taskCount;
      else if (p && p.inputPerMTok !== null && p.outputPerMTok !== null) {
        const out = capsOf(m).thinking ? 900 : 250; // rough: thinking spends output tokens
        cost += s.taskCount * (300 * p.inputPerMTok + out * p.outputPerMTok) / 1e6;
      } else unknown += s.taskCount;
    }
    return { runs: cells.length, tasks, cost, unknown };
  }

  function openRunDialog(keys, suiteIds, pairs = null) {
    const chosen = new Set(keys.filter((k) => modelByKey(k)?.available));
    const suitesChosen = new Set(suiteIds || []);
    let effort = "";
    const dialog = h("div", { class: "mdl-modal-wrap" });
    const close = () => dialog.remove();
    function draw() {
      const models = [...chosen].map(modelByKey).filter(Boolean);
      const suites = data.suites.filter((s) => suitesChosen.has(s.id));
      const exactPairs = pairs ? pairs.filter(([k, s]) => chosen.has(k) && suitesChosen.has(s)) : null;
      const est = estimate(models, suites, exactPairs);
      const efforts = [...new Set(models.flatMap((m) => m.efforts))];
      const subscription = models.filter((m) => m.engine === "claude" || m.engine === "codex");
      dialog.replaceChildren(
        h("div", { class: "mdl-backdrop", onclick: close }),
        h("section", { class: "mdl-modal", role: "dialog", "aria-modal": "true", "aria-label": "Start a benchmark run" },
          h("div", { class: "mdl-drawer-head" }, h("h2", { text: "Benchmark" }), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, "✕")),
          h("div", { class: "mdl-drawer-body" },
            h("h3", { text: "Models" }),
            h("div", { class: "mdl-chips" },
              models.map((m) => h("span", { class: "mdl-tray-chip" }, m.label, h("button", { type: "button", class: "mdl-x", "aria-label": `Remove ${m.label}`, onclick: () => { chosen.delete(m.key); draw(); } }, "×"))),
              h("select", { "aria-label": "Add a model", onchange: (e) => { if (e.target.value) { chosen.add(e.target.value); draw(); } } },
                h("option", { value: "" }, "+ Add model…"),
                data.models.filter((m) => m.available && !chosen.has(m.key)).map((m) => h("option", { value: m.key }, `${ENGINE_NAME[m.engine]} · ${m.label}`)))),
            h("h3", { text: "Benchmarks" }),
            h("div", { class: "mdl-suite-picks" }, data.suites.map((s) => {
              const fits = models.filter((m) => m.applicable.includes(s.id)).length;
              return h("label", { class: `mdl-suite-pick${fits ? "" : " off"}` },
                h("input", { type: "checkbox", checked: suitesChosen.has(s.id), onchange: (e) => { if (e.target.checked) suitesChosen.add(s.id); else suitesChosen.delete(s.id); draw(); } }),
                h("span", {}, s.title, h("span", { class: "hint", text: ` · ${CATEGORY_NAME[s.category]} · ${s.taskCount} tasks${models.length ? ` · applies to ${fits}/${models.length}` : ""}` })));
            })),
            h("div", { class: "mdl-chips" }, h("span", { class: "hint", text: "Select" }),
              chip("New for these models", false, () => { suitesChosen.clear(); for (const m of models) for (const id of m.newSuites) suitesChosen.add(id); draw(); }),
              chip("All", false, () => { for (const s of data.suites) suitesChosen.add(s.id); draw(); }),
              chip("None", false, () => { suitesChosen.clear(); draw(); })),
            efforts.length ? h("label", { class: "mdl-inline" }, "Effort ",
              h("select", { onchange: (e) => { effort = e.target.value; draw(); } },
                h("option", { value: "", selected: effort === "" }, "Model default"),
                efforts.map((e) => h("option", { value: e, selected: effort === e }, e))),
              h("span", { class: "hint", text: " Applied to every model that supports it. Compare effort levels by running the same model twice." })) : null,
            h("div", { class: "mdl-estimate" },
              h("strong", { text: `${est.runs} run${est.runs === 1 ? "" : "s"} · ${est.tasks} tasks` }),
              h("span", { text: ` · ≈ ${money(est.cost)} API-equivalent${est.unknown ? ` + ${est.unknown} tasks with no price` : ""}` }),
              subscription.length ? h("p", { class: "hint", text: `${subscription.map((m) => m.label).join(", ")} run on your ${[...new Set(subscription.map((m) => ENGINE_NAME[m.engine]))].join(" and ")} subscription: this spends usage-window share, not money.` }) : null,
              models.some((m) => m.engine === "ollama" || m.engine === "gguf") ? h("p", { class: "hint", text: "Local models load onto the GPU one at a time; runs queue and never overlap." }) : null),
            h("div", { class: "mdl-card-actions" },
              button("Cancel", close),
              button(`Start ${est.runs} run${est.runs === 1 ? "" : "s"}`, () => start(models, suites, effort, exactPairs, close), "btn btn-primary", { disabled: !est.runs })))));
    }
    draw();
    ctx.root.append(dialog);
    dialog.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    queueMicrotask(() => dialog.querySelector(".icon-btn")?.focus());
  }

  async function start(models, suites, effort, pairs, close) {
    try {
      const labels = Object.fromEntries(models.map((m) => [m.key, m.label]));
      let started = 0;
      if (pairs) {
        // exact gaps: one request per model with its own missing suites
        const byModel = new Map();
        for (const [key, suite] of pairs) byModel.set(key, [...(byModel.get(key) || []), suite]);
        for (const [key, list] of byModel) {
          const body = await call("/api/models/runs", { method: "POST", body: JSON.stringify({ models: [key], suites: list, effort, labels }) });
          started += body.runs.length;
        }
      } else {
        // a suite that does not apply to a model is skipped for that model
        for (const m of models) {
          const list = suites.filter((s) => m.applicable.includes(s.id)).map((s) => s.id);
          if (!list.length) continue;
          const body = await call("/api/models/runs", { method: "POST", body: JSON.stringify({ models: [m.key], suites: list, effort, labels }) });
          started += body.runs.length;
        }
      }
      close();
      ctx.toast?.(`Queued ${started} run${started === 1 ? "" : "s"}`);
      await loadRuns();
      await refresh();
    } catch (error) {
      ctx.toast?.(error.message);
    }
  }

  /* ---------- public ---------- */
  window.PsmModels = {
    open(options, nextView = "models", params = new URLSearchParams()) {
      const first = !ctx;
      ctx = options;
      view = VIEWS.includes(nextView) ? nextView : "models";
      const m = params.get("m");
      if (m) ui.selected = m.split(",").filter(Boolean).slice(0, MAX_COMPARE);
      const c = params.get("c");
      if (c !== null) ui.cats = c.split(",").filter(Boolean);
      const s = params.get("s");
      if (s !== null) ui.suites = s.split(",").filter(Boolean);
      if (first || !data) void refresh();
      else render();
      void loadRuns();
    },
    close() {
      clearTimeout(pollTimer);
      ctx = null;
      detailKey = null;
      runDetail = null;
    },
    refresh: () => refresh(true),
  };
})();
