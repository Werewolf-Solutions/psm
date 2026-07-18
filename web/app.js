const CAT_ORDER = [
  "Flagship & platform",
  "AI & automation",
  "Client & business websites",
  "Blockchain & DeFi",
  "Apps, libraries & other",
];

let STATE = { projects: [], meta: {}, filter: "all", query: "", procs: {} };

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const scVar = (status) => `var(--st-${status})`;

async function load() {
  const r = await fetch("/api/projects");
  const data = await r.json();
  STATE.projects = data.projects;
  STATE.meta = data.statusMeta;
  render();
}

function statusList() {
  return Object.keys(STATE.meta);
}

function visible() {
  const q = STATE.query.trim().toLowerCase();
  return STATE.projects.filter((p) => {
    if (STATE.filter === "active" && (p.archived || p.status !== "active")) return false;
    if (STATE.filter !== "all" && STATE.filter !== "active" && p.status !== STATE.filter) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.description || "").toLowerCase().includes(q) ||
      (p.stack || "").toLowerCase().includes(q) ||
      p.status.includes(q) ||
      (p.category || "").toLowerCase().includes(q)
    );
  });
}

function renderStats() {
  const p = STATE.projects;
  const by = (s) => p.filter((x) => x.status === s).length;
  const cards = [
    ["Total", p.length],
    ["Active", by("active")],
    ["Paused", by("paused")],
    ["Archived", p.filter((x) => x.archived).length],
    ["Utility / lib", by("utility") + by("library")],
  ];
  const wrap = $("#stats");
  wrap.innerHTML = "";
  for (const [l, n] of cards) {
    const s = el("div", "stat");
    s.append(el("div", "n", String(n)), el("div", "l", l));
    wrap.append(s);
  }
}

function renderFilters() {
  const nav = $("#filters");
  nav.innerHTML = "";
  const counts = {};
  for (const p of STATE.projects) counts[p.status] = (counts[p.status] || 0) + 1;
  const chips = [
    ["all", "All", STATE.projects.length, null],
    ["active", "Active", counts.active || 0, "active"],
    ...statusList()
      .filter((s) => s !== "active")
      .map((s) => [s, STATE.meta[s].label, counts[s] || 0, s]),
  ];
  for (const [key, label, cnt, sc] of chips) {
    const c = el("div", "chip" + (STATE.filter === key ? " on" : ""));
    if (sc) {
      const d = el("span", "dot");
      d.style.background = scVar(sc);
      c.append(d);
    }
    c.append(document.createTextNode(label + " "));
    c.append(el("span", "cnt", String(cnt)));
    c.onclick = () => {
      STATE.filter = key;
      render();
    };
    nav.append(c);
  }
}

function card(p) {
  const c = el("div", "card" + (p.pinned ? " pinned" : ""));
  c.style.setProperty("--sc", scVar(p.status));
  c.dataset.name = p.name;
  if (isRunning(p.name)) c.classList.add("is-running");
  const m = STATE.meta[p.status] || { emoji: "", label: p.status };

  const top = el("div", "card-top");
  const name = el("div", "card-name");
  const rdot = el("span", "run-dot");
  rdot.title = "running";
  name.append(rdot, document.createTextNode(p.name));
  if (p.pinned) name.append(el("span", "pin", "📌"));
  const badge = el("div", "badge");
  badge.append(el("span", "dot"), document.createTextNode(m.label));
  const open = el("button", "card-open", "▶");
  open.title = "Open workspace";
  open.onclick = (e) => {
    e.stopPropagation();
    openWorkspace(p);
  };
  top.append(name, badge, open);

  const desc = el("div", "card-desc clamp", esc(p.description));

  const meta = el("div", "meta");
  const bits = [];
  if (p.stack && p.stack !== "—") bits.push(`<span class="pill">${esc(p.stack)}</span>`);
  if (p.lastActivity)
    bits.push(
      `<span><span class="k">seen</span> ${esc(p.lastActivity)}${p.lastActivitySource === "files" ? " ·mtime" : ""}</span>`,
    );
  const ver = [p.gitBranch, p.gitVersion].filter(Boolean).map((v) => esc(v)).join(" · ");
  if (ver) bits.push(`<span><span class="k">git</span> ${ver}</span>`);
  if (p.priority) bits.push(`<span class="prio ${p.priority}">${p.priority}</span>`);
  meta.innerHTML = bits.join("");

  c.append(top, desc, meta);

  if (p.next) {
    const nx = el("div", "next");
    nx.innerHTML = `<span class="k">Next</span> · ${esc(p.next)}`;
    c.append(nx);
  }

  c.onclick = () => openDrawer(p);
  return c;
}

function renderBoard() {
  const board = $("#board");
  board.innerHTML = "";
  const vis = visible();
  const active = vis.filter((p) => !p.archived);
  const archived = vis.filter((p) => p.archived);

  const cats = [...new Set(active.map((p) => p.category))].sort(
    (a, b) => catRank(a) - catRank(b),
  );
  for (const cat of cats) {
    board.append(el("div", "group-title", esc(cat)));
    const grid = el("div", "grid");
    for (const p of active.filter((x) => x.category === cat)) grid.append(card(p));
    board.append(grid);
  }

  if (archived.length) {
    board.append(el("div", "group-title", `Archived · demos · templates (${archived.length})`));
    const wrap = el("div", "arch-wrap");
    const t = el("table", "arch");
    t.innerHTML =
      "<thead><tr><th>Folder</th><th>What it is</th><th>Last touched</th></tr></thead>";
    const tb = el("tbody");
    for (const p of archived) {
      const tr = el("tr");
      tr.innerHTML = `<td class="name">${esc(p.name)}</td><td>${esc(p.note || p.description)}</td><td class="date">${esc(p.lastActivity || "—")}</td>`;
      tr.style.cursor = "pointer";
      tr.onclick = () => openDrawer(p);
      tb.append(tr);
    }
    t.append(tb);
    wrap.append(t);
    board.append(wrap);
  }

  if (!vis.length) board.append(el("div", "group-title", "No projects match."));
}

function catRank(c) {
  const i = CAT_ORDER.indexOf(c);
  return i === -1 ? CAT_ORDER.length : i;
}

function render() {
  renderStats();
  renderFilters();
  renderBoard();
  $("#foot-note").textContent = `${STATE.projects.length} projects · click a card to edit · Export MD writes PROJECTS.md`;
}

/* ---------- drawer ---------- */
let editing = null;

function openDrawer(p) {
  editing = p;
  $("#d-name").textContent = p.name;
  const sel = $("#d-status");
  sel.innerHTML = statusList()
    .map((s) => `<option value="${s}">${STATE.meta[s].emoji} ${STATE.meta[s].label}</option>`)
    .join("");
  sel.value = p.status;
  $("#d-priority").value = p.priority || "";
  $("#d-pinned").checked = !!p.pinned;
  $("#d-description").value = p.overridden.includes("description") ? p.description : "";
  $("#d-description").placeholder = p.description || "Override the auto description…";
  $("#d-next").value = p.overridden.includes("next") ? p.next || "" : "";
  $("#d-next").placeholder = p.next || "What's the next action?";
  $("#d-run").value = p.overridden.includes("runCommand") ? p.runCommand || "" : "";
  $("#d-run").placeholder = p.runCommand || "e.g. npm run dev";
  $("#d-port").value = p.overridden.includes("port") ? p.port || "" : "";
  $("#d-port").placeholder = p.port ? String(p.port) : "e.g. 3000";
  $("#d-engine").value = p.overridden.includes("aiEngine") ? p.aiEngine : "";
  $("#d-full").checked = !!p.aiFullAccess;
  $("#d-deploy-staging").value = p.deployStaging || "";
  $("#d-deploy-production").value = p.deployProduction || "";
  $("#d-category").value = p.overridden.includes("category") ? p.category : "";
  $("#d-category").placeholder = p.category || "Category";

  $("#d-auto").innerHTML = [
    ["path", p.path],
    ["git", [p.gitBranch, p.gitVersion].filter(Boolean).join(" · ") || "—"],
    ["last commit", p.gitLastSubject || "—"],
    ["detected", p.stack],
  ]
    .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${esc(v)}</span></div>`)
    .join("");

  $("#backdrop").hidden = false;
  $("#drawer").hidden = false;
}

function closeDrawer() {
  $("#backdrop").hidden = true;
  $("#drawer").hidden = true;
  editing = null;
}

async function saveDrawer() {
  if (!editing) return;
  const body = {
    status: $("#d-status").value,
    priority: $("#d-priority").value,
    pinned: $("#d-pinned").checked,
    description: $("#d-description").value.trim(),
    next: $("#d-next").value.trim(),
    category: $("#d-category").value.trim(),
    runCommand: $("#d-run").value.trim(),
    port: $("#d-port").value.trim() ? Number($("#d-port").value.trim()) : "",
    aiEngine: $("#d-engine").value,
    aiFullAccess: $("#d-full").checked,
    deployStaging: $("#d-deploy-staging").value.trim(),
    deployProduction: $("#d-deploy-production").value.trim(),
  };
  // don't send pinned:false as a stored override unless it was set; keep simple: always send
  const r = await fetch(`/api/projects/${encodeURIComponent(editing.name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) {
    closeDrawer();
    await load();
    toast("Saved");
  } else {
    toast("Save failed");
  }
}

/* ---------- workspace / cockpit ---------- */
let WS = {
  name: null, es: null, port: null, pane: "logs",
  engine: "claude", fullAccess: false, aiEs: null, aiBusy: false,
  deploy: { staging: null, production: null }, depTarget: "staging", depEs: null, depArmed: false,
};

function isRunning(name) {
  return STATE.procs[`${name}::run`]?.status === "running";
}

// persist an override so per-project choices are remembered
async function patchProject(name, body) {
  try {
    await fetch(`/api/projects/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {}
}

function setWsStatus(status) {
  const badge = $("#ws-status");
  badge.textContent = status;
  badge.dataset.state = status;
  const running = status === "running";
  $("#ws-run").disabled = running;
  $("#ws-stop").disabled = !running;
}

function appendLine(entry, con = $("#ws-console")) {
  const nearBottom = con.scrollHeight - con.scrollTop - con.clientHeight < 60;
  const line = el("div", "logline s-" + entry.stream);
  line.textContent = entry.line;
  con.append(line);
  // keep the DOM from growing without bound
  while (con.childElementCount > 4000) con.firstElementChild.remove();
  if (nearBottom) con.scrollTop = con.scrollHeight;
}

function openWorkspace(p) {
  WS.name = p.name;
  WS.port = p.port ?? null;
  WS.engine = p.aiEngine || "claude";
  WS.fullAccess = !!p.aiFullAccess;
  WS.deploy = { staging: p.deployStaging || null, production: p.deployProduction || null };
  WS.depTarget = "staging";
  WS.depArmed = false;
  $("#ws-name").textContent = p.name;
  $("#ws-cmd").value = p.runCommand || "";
  $("#ws-console").innerHTML = "";
  $("#ws-depconsole").innerHTML = "";
  $("#ws-webframe").innerHTML = "";
  $("#ws-transcript").innerHTML = "";
  $("#ws-engine").value = WS.engine;
  $("#ws-full").checked = WS.fullAccess;
  setWsStatus("idle");
  setAiBusy(false);
  switchPane("logs");
  $("#ws-backdrop").hidden = false;
  $("#workspace").hidden = false;
  connectLogs(p.name);
  connectAi(p.name);
}

function switchPane(pane) {
  WS.pane = pane;
  for (const t of document.querySelectorAll(".ws-tab"))
    t.classList.toggle("on", t.dataset.pane === pane);
  for (const el of document.querySelectorAll(".ws-panes > [data-pane]"))
    el.hidden = el.dataset.pane !== pane;
  if (pane === "web") renderWebPane();
  if (pane === "deploy") openDeployPane();
}

const webUrl = () => (WS.port ? `http://localhost:${WS.port}` : null);

function renderWebPane() {
  const url = webUrl();
  const frame = $("#ws-webframe");
  $("#ws-url").textContent = url || "no port set";
  $("#ws-openext").disabled = !url;
  $("#ws-reload").disabled = !url;
  if (!url) {
    frame.innerHTML = "";
    const box = el("div", "ws-noport");
    box.append(
      el("p", null, "No web port set for this project."),
      el("p", "sub", "If it serves a page, enter the port to preview it here."),
    );
    const row = el("div", "ws-noport-row");
    const inp = el("input");
    inp.type = "number";
    inp.placeholder = "e.g. 3000";
    inp.min = "1";
    inp.max = "65535";
    const save = el("button", "btn btn-primary", "Save &amp; preview");
    save.onclick = async () => {
      const port = Number(inp.value.trim());
      if (!port) return;
      await fetch(`/api/projects/${encodeURIComponent(WS.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      });
      WS.port = port;
      load(); // refresh cards so the drawer/board pick up the new port
      renderWebPane();
    };
    row.append(inp, save);
    box.append(row);
    frame.append(box);
    return;
  }
  // (re)build the iframe only when the target url changed
  const existing = frame.querySelector("iframe");
  if (existing && existing.dataset.url === url) return;
  frame.innerHTML = "";
  const iframe = el("iframe");
  iframe.dataset.url = url;
  iframe.src = url;
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
  frame.append(iframe);
}

function connectLogs(name) {
  if (WS.es) WS.es.close();
  const es = new EventSource(`/api/projects/${encodeURIComponent(name)}/logs/stream?kind=run`);
  WS.es = es;
  es.onmessage = (e) => {
    try {
      appendLine(JSON.parse(e.data));
    } catch {}
  };
  es.addEventListener("status", (e) => {
    try {
      setWsStatus(JSON.parse(e.data).status);
    } catch {}
  });
  // the running project told us its real web port — trust it over the guess
  es.addEventListener("port", (e) => {
    try {
      const { port } = JSON.parse(e.data);
      if (port && port !== WS.port) {
        WS.port = port;
        patchProject(name, { port }); // remember it for next time
        if (WS.pane === "web") renderWebPane();
        toast(`Detected web port ${port}`);
      }
    } catch {}
  });
  es.onerror = () => {}; // EventSource auto-reconnects
}

function closeWorkspace() {
  if (WS.es) WS.es.close();
  if (WS.aiEs) WS.aiEs.close();
  if (WS.depEs) WS.depEs.close();
  WS = {
    name: null, es: null, port: null, pane: "logs",
    engine: "claude", fullAccess: false, aiEs: null, aiBusy: false,
    deploy: { staging: null, production: null }, depTarget: "staging", depEs: null, depArmed: false,
  };
  $("#ws-backdrop").hidden = true;
  $("#workspace").hidden = true;
}

/* ---- AI pane ---- */
function setAiActivity(text) {
  $("#ws-ai-activity-text").textContent = text;
  $("#ws-ai-activity").hidden = false;
}

// turn a system line into a short "what's happening now" label
function activityFor(ev) {
  if (ev.role === "assistant") return "Thinking…";
  if (ev.role === "system") {
    const m = ev.text.match(/^→\s*(.+)$/); // tool call, e.g. "→ Write(foo.ts)"
    if (m) return "Working: " + m[1];
    if (/session /.test(ev.text)) return "Thinking…";
  }
  return null;
}

function appendAiEvent(ev) {
  const t = $("#ws-transcript");
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  const b = el("div", "ai-msg ai-" + ev.role);
  b.textContent = ev.text;
  t.append(b);
  if (WS.aiBusy) {
    const label = activityFor(ev);
    if (label) setAiActivity(label);
  }
  if (nearBottom) t.scrollTop = t.scrollHeight;
}

function setAiBusy(busy) {
  WS.aiBusy = busy;
  $("#ws-ai-status").textContent = busy ? "working…" : "";
  $("#ws-send").hidden = busy;
  $("#ws-cancel").hidden = !busy;
  if (busy) setAiActivity("Thinking…");
  else $("#ws-ai-activity").hidden = true;
}

function connectAi(name) {
  if (WS.aiEs) WS.aiEs.close();
  const es = new EventSource(
    `/api/projects/${encodeURIComponent(name)}/ai/stream?engine=${encodeURIComponent(WS.engine)}`,
  );
  WS.aiEs = es;
  es.onmessage = (e) => {
    try {
      appendAiEvent(JSON.parse(e.data));
    } catch {}
  };
  es.addEventListener("status", (e) => {
    try {
      setAiBusy(JSON.parse(e.data).busy);
    } catch {}
  });
  es.onerror = () => {};
}

async function sendAi() {
  if (!WS.name || WS.aiBusy) return;
  const box = $("#ws-msg");
  const message = box.value.trim();
  if (!message) return;
  box.value = "";
  setAiBusy(true);
  const r = await fetch(`/api/projects/${encodeURIComponent(WS.name)}/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, engine: WS.engine, fullAccess: WS.fullAccess }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    toast(e.error || "AI request failed");
    setAiBusy(false);
    box.value = message; // don't lose the message
  }
}

async function cancelAi() {
  if (!WS.name) return;
  await fetch(`/api/projects/${encodeURIComponent(WS.name)}/ai/cancel`, { method: "POST" });
}

/* ---- Deploy pane ---- */
const depKind = () => `deploy:${WS.depTarget}`;

function openDeployPane() {
  for (const b of document.querySelectorAll(".ws-target"))
    b.classList.toggle("on", b.dataset.target === WS.depTarget);
  renderDeployControls();
  connectDeployLogs();
}

function renderDeployControls() {
  const cmd = WS.deploy[WS.depTarget];
  $("#ws-depcmd").textContent = cmd || "no command set — use “Guide me with AI”, or set one in the project’s edit drawer";
  $("#ws-depcmd").classList.toggle("unset", !cmd);
  const run = $("#ws-dep-run");
  run.disabled = !cmd;
  run.textContent = "Deploy";
  run.classList.toggle("danger", WS.depTarget === "production");
  WS.depArmed = false;
}

function setDepStatus(status) {
  const badge = $("#ws-dep-status");
  badge.textContent = status === "idle" ? "" : status;
  badge.dataset.state = status;
  const running = status === "running";
  $("#ws-dep-run").hidden = running;
  $("#ws-dep-stop").hidden = !running;
}

function connectDeployLogs() {
  if (WS.depEs) WS.depEs.close();
  $("#ws-depconsole").innerHTML = "";
  setDepStatus("idle");
  const es = new EventSource(
    `/api/projects/${encodeURIComponent(WS.name)}/logs/stream?kind=${encodeURIComponent(depKind())}`,
  );
  WS.depEs = es;
  es.onmessage = (e) => {
    try {
      appendLine(JSON.parse(e.data), $("#ws-depconsole"));
    } catch {}
  };
  es.addEventListener("status", (e) => {
    try {
      setDepStatus(JSON.parse(e.data).status);
    } catch {}
  });
  es.onerror = () => {};
}

function selectDeployTarget(target) {
  if (target === WS.depTarget) return;
  WS.depTarget = target;
  openDeployPane();
}

async function deployRun() {
  const target = WS.depTarget;
  const cmd = WS.deploy[target];
  if (!cmd) return toast("No deploy command set for " + target);
  // production needs a second, confirming click
  if (target === "production" && !WS.depArmed) {
    WS.depArmed = true;
    $("#ws-dep-run").textContent = "⚠ Confirm production deploy";
    return;
  }
  WS.depArmed = false;
  $("#ws-dep-run").textContent = "Deploy";
  setDepStatus("running");
  const r = await fetch(`/api/projects/${encodeURIComponent(WS.name)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: depKind() }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    toast(e.error || "Deploy failed to start");
    setDepStatus("error");
  }
}

async function deployStop() {
  await fetch(`/api/projects/${encodeURIComponent(WS.name)}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: depKind() }),
  });
}

function guideWithAI() {
  const target = WS.depTarget;
  const cmd = WS.deploy[target];
  switchPane("ai");
  const prompt =
    `I want to deploy this project to ${target}. ` +
    (cmd
      ? `The deploy command configured in psm is: \`${cmd}\`. Walk me through what it does, then run it when I confirm.`
      : `No deploy command is configured yet. Figure out how this project should be deployed to ${target}, explain the steps briefly, and once I confirm, carry it out.`) +
    (target === "production" ? " This is PRODUCTION — be careful and confirm with me before anything irreversible." : "");
  $("#ws-msg").value = prompt;
  $("#ws-msg").focus();
  toast("Loaded a deploy prompt into the AI — review and Send");
}

async function wsRun() {
  if (!WS.name) return;
  const command = $("#ws-cmd").value.trim();
  if (!command) return toast("Set a run command first");
  setWsStatus("running");
  const r = await fetch(`/api/projects/${encodeURIComponent(WS.name)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    toast(e.error || "Run failed");
    setWsStatus("error");
  } else {
    patchProject(WS.name, { runCommand: command }); // remember what actually runs it
  }
  pollProcs();
}

async function wsStop() {
  if (!WS.name) return;
  await fetch(`/api/projects/${encodeURIComponent(WS.name)}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "run" }),
  });
  pollProcs();
}

async function pollProcs() {
  try {
    const r = await fetch("/api/procs");
    STATE.procs = (await r.json()).procs || {};
  } catch {
    return;
  }
  // update card running indicators without a full re-render
  for (const c of document.querySelectorAll(".card[data-name]")) {
    c.classList.toggle("is-running", isRunning(c.dataset.name));
  }
}

$("#ws-close").onclick = closeWorkspace;
$("#ws-backdrop").onclick = closeWorkspace;
$("#ws-run").onclick = wsRun;
$("#ws-stop").onclick = wsStop;
$("#ws-clear").onclick = () => ($("#ws-console").innerHTML = "");
$("#ws-tabs").onclick = (e) => {
  const t = e.target.closest(".ws-tab");
  if (t) switchPane(t.dataset.pane);
};
$("#ws-reload").onclick = () => {
  const iframe = $("#ws-webframe").querySelector("iframe");
  if (iframe) iframe.src = iframe.src; // reassigning src forces a reload
};
$("#ws-openext").onclick = () => {
  const url = webUrl();
  if (url) window.open(url, "_blank");
};
$("#ws-engine").onchange = (e) => {
  WS.engine = e.target.value;
  patchProject(WS.name, { aiEngine: WS.engine }); // remember per project
};
$("#ws-full").onchange = (e) => {
  WS.fullAccess = e.target.checked;
  patchProject(WS.name, { aiFullAccess: WS.fullAccess }); // remember per project
};
$("#ws-send").onclick = sendAi;
$("#ws-cancel").onclick = cancelAi;
$("#ws-msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendAi();
  }
});
$("#ws-targets").onclick = (e) => {
  const b = e.target.closest(".ws-target");
  if (b) selectDeployTarget(b.dataset.target);
};
$("#ws-dep-run").onclick = deployRun;
$("#ws-dep-stop").onclick = deployStop;
$("#ws-dep-ai").onclick = guideWithAI;

/* ---------- actions ---------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- new project + house rules modals ---------- */
function openModal(id) {
  $("#modal-backdrop").hidden = false;
  $(id).hidden = false;
}
function closeModals() {
  $("#modal-backdrop").hidden = true;
  $("#new-modal").hidden = true;
  $("#rules-modal").hidden = true;
}

async function createProject() {
  const name = $("#new-name").value.trim();
  if (!name) return toast("Give the project a name");
  const body = {
    name,
    description: $("#new-desc").value.trim(),
    gitInit: $("#new-git").checked,
    applyHouseRules: $("#new-rules").checked,
  };
  const r = await fetch("/api/projects/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast(data.error || "Could not create project");
  closeModals();
  toast(`Created ${data.name}`);
  await load();
  const p = STATE.projects.find((x) => x.name === data.name);
  if (p) openWorkspace(p); // jump straight into the new project
}

async function openRules() {
  const r = await fetch("/api/house-rules");
  const data = await r.json().catch(() => ({ content: "" }));
  $("#rules-text").value = data.content || "";
  openModal("#rules-modal");
}

async function saveRules() {
  const r = await fetch("/api/house-rules", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: $("#rules-text").value }),
  });
  if (r.ok) {
    closeModals();
    toast("House rules saved");
  } else {
    toast("Could not save house rules");
  }
}

$("#new-open").onclick = () => {
  $("#new-name").value = "";
  $("#new-desc").value = "";
  $("#new-git").checked = true;
  $("#new-rules").checked = true;
  openModal("#new-modal");
  $("#new-name").focus();
};
$("#new-close").onclick = closeModals;
$("#new-cancel").onclick = closeModals;
$("#new-create").onclick = createProject;
$("#new-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createProject();
  }
});
$("#rules-open").onclick = openRules;
$("#rules-close").onclick = closeModals;
$("#rules-cancel").onclick = closeModals;
$("#rules-save").onclick = saveRules;
$("#modal-backdrop").onclick = closeModals;

$("#rescan").onclick = async () => {
  toast("Rescanning…");
  await load();
  toast("Rescanned");
};
$("#export").onclick = async () => {
  const r = await fetch("/api/export", { method: "POST" });
  toast(r.ok ? "PROJECTS.md written" : "Export failed");
};
$("#search").oninput = (e) => {
  STATE.query = e.target.value;
  renderBoard();
};
$("#d-close").onclick = closeDrawer;
$("#d-cancel").onclick = closeDrawer;
$("#backdrop").onclick = closeDrawer;
$("#d-save").onclick = saveDrawer;
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#modal-backdrop").hidden) closeModals();
  else if (!$("#workspace").hidden) closeWorkspace();
  else closeDrawer();
});

load().then(pollProcs);
setInterval(pollProcs, 3000);
