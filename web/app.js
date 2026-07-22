const CAT_ORDER = [
  "Flagship & platform",
  "AI & automation",
  "Client & business websites",
  "Blockchain & DeFi",
  "Apps, libraries & other",
];

let STATE = {
  projects: [], meta: {}, filter: "all", query: "", procs: {}, sessions: [], sessionsSig: "",
  runtimeServices: {}, runtimeServicesSig: "",
};

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
  await Promise.all([fetchSessions(false), fetchRuntimeServices()]);
  render();
}

async function fetchRuntimeServices(force = false) {
  try {
    const response = await fetch("/api/runtime/services" + (force ? "?refresh=1" : ""));
    const services = (await response.json()).services || {};
    const signature = JSON.stringify(Object.values(services).map((service) => ({
      id: service.id,
      activeUrl: service.activeUrl,
      source: service.source,
      localAvailable: service.localAvailable,
      error: service.error || "",
    })));
    if (signature !== STATE.runtimeServicesSig) {
      STATE.runtimeServices = services;
      STATE.runtimeServicesSig = signature;
    }
  } catch {}
}

// refresh the "Working on" lane; re-render only when it actually changed
async function fetchSessions(rerender = true) {
  try {
    const r = await fetch("/api/sessions");
    const sessions = (await r.json()).sessions || [];
    const sig = JSON.stringify(
      sessions.map((s) => ({
        name: s.name,
        reasons: s.reasons || [],
        busy: !!s.busy,
        waiting: !!s.waiting,
        questionId: s.question?.id || "",
        running: !!s.running,
        manual: !!s.manual,
        open: !!s.open,
        queueDepth: s.queueDepth || 0,
        messages: s.messages || 0,
        lastActive: s.lastActive || 0,
        snippet: s.snippet || "",
        engine: s.engine || "",
        model: s.model || "",
        actualModel: s.actualModel || "",
      })),
    );
    STATE.sessions = sessions;
    syncPendingQuestions(sessions);
    if (rerender && sig !== STATE.sessionsSig) renderBoard();
    STATE.sessionsSig = sig;
    renderQuickSwitch();
  } catch {}
}

function projectHash(name, pane = "plan") {
  return `#/p/${encodeURIComponent(name)}/${encodeURIComponent(pane)}`;
}

function renderQuickSwitch() {
  const nav = $("#quick-switch");
  if (!nav) return;
  nav.innerHTML = "";
  const names = [...new Set(STATE.sessions.map((session) => session.name))]
    .filter((name) => STATE.projects.some((project) => project.name === name));
  const show = names.length > 0 || !!WS?.name;
  nav.classList.toggle("has-items", show);
  if (!show) return;
  const home = el("button", "quick-pill", "Home");
  home.classList.toggle("on", !WS?.name);
  home.onclick = () => { location.hash = "#/"; };
  nav.append(home);
  for (const name of names) {
    const button = el("button", "quick-pill", esc(name));
    button.classList.toggle("on", WS?.name === name);
    button.onclick = () => { location.hash = projectHash(name, WS?.name === name ? WS.pane : "plan"); };
    nav.append(button);
  }
}

function relTime(ms) {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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
  const classes = ["card"];
  if (p.pinned) classes.push("pinned");
  if (p.workingOn) classes.push("working");
  const c = el("div", classes.join(" "));
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
  if (p.workingOn) bits.push(`<span class="pill work-pill">working</span>`);
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

function sessionWhen(sess) {
  if (sess.waiting) return "needs answer";
  if (sess.busy) return "working…";
  if (sess.queueDepth) return "queued";
  if (sess.running) return "running";
  if (sess.open) return "open";
  return relTime(sess.lastActive) || "marked";
}

async function stopWorking(name) {
  const current = WS.name === name;
  if (current && aiPaneOpen()) switchPane("logs");

  let r;
  try {
    r = await fetch(`/api/projects/${encodeURIComponent(name)}/working/stop`, { method: "POST" });
  } catch {
    toast("Could not stop working");
    return false;
  }
  if (!r.ok) {
    toast("Could not stop working");
    return false;
  }

  const p = STATE.projects.find((x) => x.name === name);
  if (p) {
    p.workingOn = false;
    p.workingOnAt = null;
  }
  if (current) {
    WS.workingOn = false;
    WS.pending = [];
    setAiBusy(false);
    renderWorkingButton();
  }
  clearQuestion(name);
  await pollProcs();
  await load();
  toast("Stopped working");
  return true;
}

function sessionCard(sess, proj) {
  const c = el("div", "sess-card" + (sess.busy ? " busy" : "") + (sess.waiting ? " waiting" : ""));
  const top = el("div", "sess-top");
  const name = el("div", "sess-name");
  name.append(el("span", "sess-dot"), document.createTextNode(sess.name));

  const actions = el("div", "sess-actions");
  actions.append(el("span", "sess-when", sessionWhen(sess)));
  if (sess.question) {
    const answer = el("button", "sess-answer", "Answer");
    answer.onclick = (e) => {
      e.stopPropagation();
      openQuestion(sess.name, sess.question, true);
    };
    actions.append(answer);
  }
  const stop = el("button", "sess-stop", "Stop working");
  stop.title = "Stop AI and project processes, close the AI session, and clear the manual mark";
  stop.onclick = async (e) => {
    e.stopPropagation();
    stop.disabled = true;
    if (!(await stopWorking(sess.name))) stop.disabled = false;
  };
  actions.append(stop);
  top.append(name, actions);

  const snippetText =
    sess.snippet ||
    (sess.running
      ? "Project process is running."
      : sess.open
        ? "AI chat is open."
        : "Manually marked as being worked on.");
  const snippet = el("div", "sess-snippet", esc(snippetText));

  const reasons = sess.reasons?.length
    ? sess.reasons
    : [sess.busy ? "AI working" : sess.running ? "running" : sess.open ? "AI open" : "marked"];
  const reasonRow = el("div", "sess-reasons");
  for (const reason of reasons) reasonRow.append(el("span", "pill", esc(reason)));

  const meta = el("div", "sess-meta");
  const model = sess.actualModel || sess.model;
  if (sess.engine) meta.append(el("span", "pill", esc(sess.engine)));
  if (model) meta.append(el("span", "pill", esc(model)));
  if (sess.messages) meta.append(el("span", null, `${sess.messages} message${sess.messages === 1 ? "" : "s"}`));
  if (sess.queueDepth) meta.append(el("span", null, `${sess.queueDepth} queued`));

  c.append(top, snippet, reasonRow, meta);
  c.title = proj ? "Open session" : "Project no longer in the workspace";
  if (proj) c.onclick = () => openWorkspace(proj, "session");
  else c.classList.add("orphan");
  return c;
}

function renderWorkLane(board) {
  if (STATE.filter !== "all" || STATE.query.trim() || !STATE.sessions.length) return;
  board.append(el("div", "group-title", `Working on (${STATE.sessions.length})`));
  const grid = el("div", "sess-grid");
  for (const sess of STATE.sessions) {
    grid.append(sessionCard(sess, STATE.projects.find((p) => p.name === sess.name)));
  }
  board.append(grid);
}

function renderBoard() {
  const board = $("#board");
  board.innerHTML = "";
  renderWorkLane(board);
  const vis = visible();
  const active = vis.filter((p) => !p.archived);
  const archived = vis.filter((p) => p.archived);

  // pinned float to the very top, out of their category
  const pinned = active.filter((p) => p.pinned);
  const rest = active.filter((p) => !p.pinned);
  if (pinned.length) {
    board.append(el("div", "group-title", "📌 Pinned"));
    const grid = el("div", "grid");
    for (const p of pinned) grid.append(card(p));
    board.append(grid);
  }

  const cats = [...new Set(rest.map((p) => p.category))].sort(
    (a, b) => catRank(a) - catRank(b),
  );
  for (const cat of cats) {
    board.append(el("div", "group-title", esc(cat)));
    const grid = el("div", "grid");
    for (const p of rest.filter((x) => x.category === cat)) grid.append(card(p));
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
  renderQuickSwitch();
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
  $("#d-working").checked = !!p.workingOn;
  $("#d-description").value = p.overridden.includes("description") ? p.description : "";
  $("#d-description").placeholder = p.description || "Override the auto description…";
  $("#d-next").value = p.overridden.includes("next") ? p.next || "" : "";
  $("#d-next").placeholder = p.next || "What's the next action?";
  $("#d-run").value = p.overridden.includes("runCommand") ? p.runCommand || "" : "";
  $("#d-run").placeholder = p.runCommand || "e.g. npm run dev";
  $("#d-port").value = p.overridden.includes("port") ? p.port || "" : "";
  $("#d-port").placeholder = p.port ? String(p.port) : "e.g. 3000";
  $("#d-engine").value = p.overridden.includes("aiEngine") ? p.aiEngine : "";
  $("#d-model").value = p.overridden.includes("aiModel") ? p.aiModel || "" : "";
  $("#d-model").placeholder = p.aiModel || "default for selected engine";
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
    workingOn: $("#d-working").checked,
    description: $("#d-description").value.trim(),
    next: $("#d-next").value.trim(),
    category: $("#d-category").value.trim(),
    runCommand: $("#d-run").value.trim(),
    port: $("#d-port").value.trim() ? Number($("#d-port").value.trim()) : "",
    aiEngine: $("#d-engine").value,
    aiModel: $("#d-model").value.trim(),
    aiFullAccess: $("#d-full").checked,
    deployStaging: $("#d-deploy-staging").value.trim(),
    deployProduction: $("#d-deploy-production").value.trim(),
  };
  // don't send pinned:false as a stored override unless it was set; keep simple: always send
  const name = editing.name;
  const r = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) {
    closeDrawer();
    await load();
    if (WS.name === name) {
      WS.workingOn = body.workingOn;
      renderWorkingButton();
    }
    toast("Saved");
  } else {
    toast("Save failed");
  }
}

/* ---------- workspace / cockpit ---------- */
let WS = {
  name: null, es: null, port: null, pane: "logs", chatOnly: false, workingOn: false,
  engine: "claude", model: "", actualModel: null, fullAccess: false, aiEs: null, aiBusy: false, pending: [], aiLimited: false, sessionState: null, question: null,
  deploy: { staging: null, production: null }, depTarget: "staging", depEs: null, depArmed: false,
};

let PLAN = {
  saved: null,
  draft: null,
  dirty: false,
  loading: false,
  drag: null,
};

const emptyPlannerState = (project = null) => ({
  project,
  role: "planner",
  forceNew: false,
  streams: { planner: null, reviewer: null },
  events: { planner: [], reviewer: [] },
  status: { planner: null, reviewer: null },
  loop: null,
  loading: false,
});
let PLANNER = emptyPlannerState();

let CAPS = {
  project: null,
  catalog: [],
  loading: false,
  applying: false,
  preview: null,
};

// unsent composer text, kept separately per project (and per the workspace-wide
// chat, keyed "__workspace__"). the single #ws-msg textarea is reused across all
// of them, so without this a draft typed for one chat would bleed into the next.
const DRAFTS = (() => {
  try {
    return JSON.parse(localStorage.getItem("psm.drafts") || "{}");
  } catch {
    return {};
  }
})();
function saveDrafts() {
  try {
    localStorage.setItem("psm.drafts", JSON.stringify(DRAFTS));
  } catch {}
}
/** Stash the current composer text under whichever chat is open. */
function stashDraft() {
  if (!WS.name) return;
  const v = $("#ws-msg").value;
  if (v.trim()) DRAFTS[WS.name] = v;
  else delete DRAFTS[WS.name];
  saveDrafts();
}
/** Load (or clear) the composer for the chat named `name`. */
function loadDraft(name) {
  $("#ws-msg").value = DRAFTS[name] || "";
}

function isRunning(name) {
  return STATE.procs[`${name}::run`]?.status === "running";
}

function hasRunningProcess(name) {
  const prefix = `${name}::`;
  return Object.entries(STATE.procs).some(([key, proc]) => key.startsWith(prefix) && proc.status === "running");
}

function workspaceIsWorking() {
  return !!WS.name && (WS.workingOn || WS.aiBusy || !!WS.question || !!WS.aiEs || hasRunningProcess(WS.name));
}

function renderWorkingButton() {
  const b = $("#ws-working");
  if (!b) return;
  b.hidden = !!WS.chatOnly || !WS.name;
  const active = workspaceIsWorking();
  b.textContent = active ? "Stop working" : "Mark working";
  b.classList.toggle("danger", active);
  b.title = active
    ? "Stop AI and project processes, close the AI session, and clear the manual mark"
    : "Manually show this project in Working on";
}

async function toggleWorking() {
  if (!WS.name || WS.chatOnly) return;
  if (workspaceIsWorking()) return stopWorking(WS.name);

  WS.workingOn = true;
  renderWorkingButton();
  const ok = await patchProject(WS.name, { workingOn: true });
  if (!ok) {
    WS.workingOn = false;
    renderWorkingButton();
    return toast("Could not update Working on");
  }
  const p = STATE.projects.find((x) => x.name === WS.name);
  if (p) {
    p.workingOn = true;
    p.workingOnAt = Date.now();
  }
  await load();
  toast("Marked as working");
}

// persist an override so per-project choices are remembered
async function patchProject(name, body) {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
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

function openWorkspace(p, pane = "logs", opts = {}) {
  if (!opts.fromRoute) {
    location.hash = projectHash(p.name, pane);
    return;
  }
  const chat = !!opts.chatOnly; // the workspace-wide chat: AI pane only
  stashDraft(); // remember the outgoing chat's unsent text before we switch
  if (PLAN.saved?.project !== p.name) {
    PLAN = { saved: null, draft: null, dirty: false, loading: false, drag: null };
  }
  if (PLANNER.project !== p.name) {
    disconnectPlanner();
    PLANNER = emptyPlannerState(p.name);
  }
  if (CAPS.project !== p.name) {
    CAPS = { project: p.name, catalog: [], loading: false, applying: false, preview: null };
  }
  WS.chatOnly = chat;
  WS.name = p.name;
  WS.workingOn = !!p.workingOn;
  WS.port = p.port ?? null;
  WS.engine = p.aiEngine || "claude";
  WS.model = p.aiModel || "";
  WS.actualModel = null;
  WS.fullAccess = !!p.aiFullAccess;
  WS.deploy = { staging: p.deployStaging || null, production: p.deployProduction || null };
  WS.depTarget = "staging";
  WS.depArmed = false;
  WS.pending = [];
  WS.sessionState = null;
  WS.question = null;
  WS.recapFetched = false;
  WS.aiLimited = false;
  $("#usage-open").hidden = chat;
  usageSelectionChanged();
  $("#ws-ai-recap").hidden = true;
  $("#ws-ai-recap").innerHTML = "";
  $("#ws-ai-limit").hidden = true;
  $("#ws-ai-limit").innerHTML = "";
  $("#ws-name").textContent = opts.title || p.name;
  renderWorkingButton();
  // hide the run/web/deploy cockpit when this is the workspace-wide chat
  $("#ws-runbar").hidden = chat;
  $("#ws-status").hidden = chat;
  for (const t of document.querySelectorAll(".ws-tab"))
    t.hidden = chat && t.dataset.pane !== "ai" && t.dataset.pane !== "session";
  $("#ws-cmd").value = p.runCommand || "";
  $("#ws-console").innerHTML = "";
  $("#ws-depconsole").innerHTML = "";
  $("#ws-webframe").innerHTML = "";
  $("#ws-transcript").innerHTML = "";
  renderSessionPane(null);
  loadDraft(p.name); // restore this chat's own unsent text (empty if none)
  $("#ws-engine").value = WS.engine;
  $("#ws-model").value = WS.model;
  renderAiModel();
  $("#ws-full").checked = WS.fullAccess;
  setWsStatus("idle");
  setAiBusy(false);
  switchPane(chat ? "ai" : pane);
  $("#home-page").hidden = true;
  $("#ws-backdrop").hidden = true;
  $("#workspace").hidden = false;
  renderQuickSwitch();
  if (!chat) loadPlan();
  if (!chat) connectLogs(p.name);
}

async function openWorkspaceChat(fromRoute = false) {
  if (!fromRoute) {
    location.hash = projectHash("__workspace__", "ai");
    return;
  }
  let w = { aiEngine: "claude", aiModel: null, aiFullAccess: false };
  try {
    w = await (await fetch("/api/workspace")).json();
  } catch {}
  openWorkspace(
    { name: "__workspace__", port: null, runCommand: null, deployStaging: null, deployProduction: null,
      aiEngine: w.aiEngine || "claude", aiModel: w.aiModel || null, aiFullAccess: !!w.aiFullAccess },
    "ai",
    { chatOnly: true, title: "psm · all projects", fromRoute: true },
  );
}

function aiPaneOpen() {
  return WS.pane === "ai" || WS.pane === "session";
}

function ensureAiConnected() {
  if (!WS.name || WS.aiEs) return;
  connectAi(WS.name);
}

function disconnectAi() {
  if (!WS.aiEs) return;
  WS.aiEs.close();
  WS.aiEs = null;
  renderWorkingButton();
}

function switchPane(pane) {
  const allowed = WS.chatOnly
    ? new Set(["ai", "session"])
    : new Set(["plan", "capabilities", "logs", "web", "ai", "session", "deploy"]);
  if (!allowed.has(pane)) pane = WS.chatOnly ? "ai" : "plan";
  WS.pane = pane;
  for (const t of document.querySelectorAll(".ws-tab"))
    t.classList.toggle("on", t.dataset.pane === pane);
  for (const el of document.querySelectorAll(".ws-panes > [data-pane]"))
    el.hidden = el.dataset.pane !== pane;
  if (aiPaneOpen()) ensureAiConnected();
  else disconnectAi();
  if (pane === "plan") connectPlanner();
  else disconnectPlanner();
  renderWorkingButton();
  if (pane === "web") renderWebPane();
  if (pane === "deploy") openDeployPane();
  if (pane === "session") fetchSessionState();
  if (pane === "plan") loadPlan();
  if (pane === "capabilities") loadCapabilities();
  if (pane === "ai" && !WS.recapFetched) {
    WS.recapFetched = true;
    fetchRecap(); // refresh "where we left off" (regenerates only if stale)
    fetchLimit(); // surface a usage limit before the user types anything
  }
  if (WS.name) history.replaceState(null, "", projectHash(WS.name, pane));
  renderQuickSwitch();
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
  es.onopen = () => ($("#ws-console").innerHTML = ""); // rebuild on (re)connect, don't duplicate
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

function closeWorkspace(fromRoute = false) {
  if (!fromRoute) {
    location.hash = "#/";
    return;
  }
  stashDraft(); // keep the unsent text so it's there when this chat reopens
  clearTimeout(sessionRefreshTimer);
  if (WS.es) WS.es.close();
  if (WS.aiEs) WS.aiEs.close();
  disconnectPlanner();
  if (WS.depEs) WS.depEs.close();
  WS = {
    name: null, es: null, port: null, pane: "logs", chatOnly: false, workingOn: false,
    engine: "claude", model: "", actualModel: null, fullAccess: false, aiEs: null, aiBusy: false, pending: [], aiLimited: false, sessionState: null, question: null,
    deploy: { staging: null, production: null }, depTarget: "staging", depEs: null, depArmed: false,
  };
  $("#ws-backdrop").hidden = true;
  $("#workspace").hidden = true;
  $("#home-page").hidden = false;
  PLAN = { saved: null, draft: null, dirty: false, loading: false, drag: null };
  PLANNER = emptyPlannerState();
  CAPS = { project: null, catalog: [], loading: false, applying: false, preview: null };
  // restore the full cockpit for the next (normal) workspace
  $("#ws-runbar").hidden = false;
  $("#ws-status").hidden = false;
  for (const t of document.querySelectorAll(".ws-tab")) t.hidden = false;
  fetchSessions(); // the "Working on" lane may have gained/updated a session
  renderQuickSwitch();
}

function routeFromHash() {
  const match = location.hash.match(/^#\/p\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    if (WS.name) closeWorkspace(true);
    else {
      $("#home-page").hidden = false;
      $("#workspace").hidden = true;
      renderQuickSwitch();
    }
    return;
  }
  const name = decodeURIComponent(match[1]);
  const pane = decodeURIComponent(match[2] || "plan");
  if (name === "__workspace__") {
    openWorkspaceChat(true);
    return;
  }
  const project = STATE.projects.find((item) => item.name === name);
  if (!project) {
    toast("Project not found");
    history.replaceState(null, "", "#/");
    closeWorkspace(true);
    return;
  }
  openWorkspace(project, pane, { fromRoute: true });
}

/* ---- capability catalog and attachment preview ---- */

function currentProject() {
  return STATE.projects.find((project) => project.name === WS.name) || null;
}

function closeCapabilityPreview() {
  CAPS.preview = null;
  $("#cap-preview").hidden = true;
  $("#cap-preview").closest(".cap-body").classList.remove("has-preview");
}

function capabilityBadge(text, tone = "") {
  const badge = el("span", `cap-badge${tone ? " " + tone : ""}`);
  badge.textContent = text;
  return badge;
}

function renderCapabilities() {
  const list = $("#cap-list");
  list.innerHTML = "";
  if (CAPS.loading && !CAPS.catalog.length) {
    list.append(el("div", "cap-empty", "Loading workspace capabilities…"));
    return;
  }
  if (!CAPS.catalog.length) {
    list.append(el("div", "cap-empty", "No capability surfaces were found in this workspace."));
    return;
  }
  for (const capability of CAPS.catalog) {
    const attached = capability.attachedTo?.includes(WS.name);
    const card = el("article", `cap-card${attached ? " attached" : ""}${capability.ready ? "" : " unready"}`);
    const copy = el("div", "cap-copy");
    const title = el("div", "cap-title-row");
    const name = el("span", "cap-title");
    name.textContent = capability.title;
    title.append(
      name,
      capabilityBadge(capability.kind.toUpperCase()),
      capabilityBadge(capability.source),
      capabilityBadge(
        capability.integrity === "workspace-mutable" ? "mutable workspace" : capability.integrity,
        capability.integrity === "artifact-pinned" ? "good" : "warn",
      ),
    );
    if (attached) title.append(capabilityBadge("attached", "good"));
    if (capability.updateAvailable) title.append(capabilityBadge("update available", "warn"));
    const summary = el("p", "cap-summary");
    summary.textContent = capability.summary;
    const provider = el("div", "cap-provider");
    provider.textContent = capability.providerProject
      ? `Provider: ${capability.providerProject} · ${capability.ref}`
      : capability.ref;
    copy.append(title, summary, provider);
    if (capability.warnings?.length) {
      const warnings = el("ul", "cap-warnings");
      for (const warning of capability.warnings) {
        const item = document.createElement("li");
        item.textContent = warning;
        warnings.append(item);
      }
      copy.append(warnings);
    }
    const actions = el("div", "cap-actions");
    const button = el("button", attached ? "btn" : "btn btn-primary", attached ? "Detach" : "Review & attach");
    button.disabled = CAPS.applying || (!attached && !capability.ready);
    button.title = !capability.ready ? "This detected surface needs an explicit, valid manifest first" : "";
    button.onclick = () => previewCapability(capability.ref, attached ? "detach" : "attach");
    actions.append(button);
    card.append(copy, actions);
    list.append(card);
  }
}

async function loadCapabilities(force = false) {
  if (!WS.name || WS.chatOnly || CAPS.loading || (!force && CAPS.catalog.length)) return;
  CAPS.loading = true;
  renderCapabilities();
  try {
    const response = await fetch("/api/catalog");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load capability catalog");
    CAPS.project = WS.name;
    CAPS.catalog = data.capabilities || [];
  } catch (error) {
    toast(error.message || "Could not load capabilities");
  } finally {
    CAPS.loading = false;
    renderCapabilities();
  }
}

function previewSection(title) {
  const section = el("section", "cap-preview-section");
  const heading = document.createElement("h4");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function renderCapabilityPreview() {
  const pending = CAPS.preview;
  if (!pending) return closeCapabilityPreview();
  const panel = $("#cap-preview");
  panel.hidden = false;
  panel.closest(".cap-body").classList.add("has-preview");
  const verb = pending.action === "attach" ? "Attach" : pending.action === "detach" ? "Detach" : "Add custom";
  $("#cap-preview-title").textContent = `${verb} ${pending.capability.title}`;
  const body = $("#cap-preview-body");
  body.innerHTML = "";
  const commands = previewSection("Runtime wiring");
  if (!pending.preview.commands.length) {
    commands.append(el("div", "cap-env", "No executable runtime entry changes."));
  }
  for (const item of pending.preview.commands) {
    const block = el("div", "cap-command");
    if (item.transport === "stdio") {
      const executable = el("div");
      executable.append(el("span", "cap-command-label", "Executable "), document.createElement("br"));
      const command = document.createElement("code");
      command.textContent = JSON.stringify(item.command);
      executable.append(command);
      const argsLabel = el("div", "cap-command-label", "Arguments (exact array)");
      argsLabel.style.marginTop = "8px";
      const args = document.createElement("code");
      args.textContent = JSON.stringify(item.args || [], null, 2);
      block.append(executable, argsLabel, args);
      if (item.providerDirectory) {
        const provider = el("div", "cap-command-label", "Provider directory");
        provider.style.marginTop = "8px";
        const providerPath = document.createElement("code");
        providerPath.textContent = item.providerDirectory;
        block.append(provider, providerPath);
      }
    } else {
      block.append(el("span", "cap-command-label", "HTTP URL "));
      const url = document.createElement("code");
      url.textContent = item.url || "";
      block.append(document.createElement("br"), url);
    }
    commands.append(block);
  }
  body.append(commands);

  const files = previewSection("Project file operations");
  if (!pending.preview.operations.length) {
    files.append(el("div", "cap-env", "No file changes are required."));
  }
  for (const operation of pending.preview.operations) {
    const row = el("div", "cap-file-op");
    const action = el("span", `cap-file-action ${operation.action}`);
    action.textContent = operation.action;
    const file = document.createElement("code");
    file.textContent = operation.file;
    row.append(action, file);
    files.append(row);
  }
  body.append(files);

  if (pending.preview.warnings?.length) {
    const warnings = previewSection("Warnings");
    const list = el("ul", "cap-warnings");
    for (const warning of pending.preview.warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      list.append(item);
    }
    warnings.append(list);
    body.append(warnings);
  }

  const envNames = [...new Set(pending.preview.commands.flatMap((item) => item.environmentNames || []))];
  if (envNames.length || pending.preview.missingEnv?.length) {
    const environment = previewSection("Environment variable names");
    const block = el("div", "cap-env");
    const code = document.createElement("code");
    code.textContent = envNames.join("\n") || "none";
    block.append(code);
    environment.append(block);
    body.append(environment);
  }
  const note = el("div", "cap-preview-note");
  note.textContent = pending.action === "custom"
    ? "Confirming stores this manifest in psm's private custom catalog. It does not attach or execute it. Attaching is a second review and confirmation step."
    : pending.action === "attach"
      ? "Confirming writes only the listed project configuration. psm will not start the capability. Open a new Claude or Codex session after attaching so it reloads project config."
      : "Confirming removes only psm-owned configuration. Unmanaged edits are preserved; changes inside a psm-owned region cause a conflict instead of being overwritten.";
  body.append(note);
  const confirm = $("#cap-preview-confirm");
  confirm.disabled = CAPS.applying || (pending.action !== "custom" && !!pending.preview.missingEnv?.length);
  confirm.textContent = CAPS.applying
    ? "Applying…"
    : pending.action === "attach"
      ? "Confirm attachment"
      : pending.action === "detach"
        ? "Confirm detach"
        : "Confirm custom catalog entry";
}

function openCustomCapabilityForm() {
  for (const id of [
    "cap-custom-id", "cap-custom-title", "cap-custom-summary", "cap-custom-command",
    "cap-custom-args", "cap-custom-url", "cap-custom-bearer", "cap-custom-env", "cap-custom-usage",
  ]) $("#" + id).value = "";
  $("#cap-custom-transport").value = "stdio";
  toggleCustomTransport();
  openModal("#cap-custom-modal");
  $("#cap-custom-id").focus();
}

function toggleCustomTransport() {
  const http = $("#cap-custom-transport").value === "http";
  $("#cap-custom-stdio").hidden = http;
  $("#cap-custom-http").hidden = !http;
  $("#cap-custom-review").textContent = http ? "Review exact URL" : "Review exact command";
}

async function reviewCustomCapability() {
  let args = [];
  try {
    const value = $("#cap-custom-args").value.trim();
    args = value ? JSON.parse(value) : [];
    if (!Array.isArray(args)) throw new Error("Arguments must be a JSON array");
  } catch (error) {
    return toast(error.message || "Arguments must be a JSON array");
  }
  const transport = $("#cap-custom-transport").value;
  const bearer = $("#cap-custom-bearer").value.trim();
  const raw = {
    id: $("#cap-custom-id").value.trim(),
    kind: "mcp",
    title: $("#cap-custom-title").value.trim(),
    summary: $("#cap-custom-summary").value.trim(),
    usage: $("#cap-custom-usage").value.trim(),
    requiredEnv: $("#cap-custom-env").value.split(",").map((name) => name.trim()).filter(Boolean),
    mcp: transport === "stdio"
      ? { transport: "stdio", command: $("#cap-custom-command").value.trim(), args }
      : {
          transport: "http",
          url: $("#cap-custom-url").value.trim(),
          ...(bearer ? { bearerTokenEnvVar: bearer } : {}),
        },
  };
  try {
    const response = await fetch("/api/catalog/custom/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(raw),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not preview custom capability");
    closeModals();
    CAPS.preview = { ...data, ref: data.capability.ref, action: "custom", capability: data.capability };
    renderCapabilityPreview();
  } catch (error) {
    toast(error.message || "Could not preview custom capability");
  }
}

async function previewCapability(ref, action) {
  const capability = CAPS.catalog.find((item) => item.ref === ref);
  if (!capability || !WS.name || CAPS.applying) return;
  CAPS.preview = null;
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(WS.name)}/attachments/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "attach" ? { add: ref } : { remove: ref }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not build wiring preview");
    CAPS.preview = { ...data, ref, action, capability };
    renderCapabilityPreview();
  } catch (error) {
    toast(error.message || "Could not preview attachment");
  }
}

async function confirmCapabilityChange() {
  const pending = CAPS.preview;
  if (!pending || !WS.name || CAPS.applying) return;
  CAPS.applying = true;
  renderCapabilityPreview();
  try {
    if (pending.action === "custom") {
      const response = await fetch("/api/catalog/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          previewToken: pending.previewToken,
          manifest: pending.manifest,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save custom capability");
      closeCapabilityPreview();
      CAPS.catalog = [];
      await loadCapabilities(true);
      toast(`${pending.capability.title} added to the custom catalog. Review it again to attach.`);
      return;
    }
    const encodedProject = encodeURIComponent(WS.name);
    const attach = pending.action === "attach";
    const url = attach
      ? `/api/projects/${encodedProject}/attachments`
      : `/api/projects/${encodedProject}/attachments/${encodeURIComponent(pending.ref)}`;
    const response = await fetch(url, {
      method: attach ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        previewToken: pending.previewToken,
        ...(attach ? { capabilityRef: pending.ref } : {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not ${pending.action} capability`);
    const project = currentProject();
    if (project) project.attachments = data.attachments || [];
    closeCapabilityPreview();
    CAPS.catalog = [];
    await loadCapabilities(true);
    toast(`${pending.capability.title} ${attach ? "attached" : "detached"}. Start a new AI session to reload config.`);
  } catch (error) {
    toast(error.message || `Could not ${pending.action} capability`);
  } finally {
    CAPS.applying = false;
    if (CAPS.preview) renderCapabilityPreview();
    renderCapabilities();
  }
}

/* ---- dedicated planner + cross-model reviewer sessions ---- */

function disconnectPlanner() {
  for (const role of ["planner", "reviewer"]) {
    PLANNER.streams[role]?.close();
    PLANNER.streams[role] = null;
  }
}

function plannerHasSession() {
  return ["planner", "reviewer"].some(
    (role) => PLANNER.status[role]?.hasSession || PLANNER.events[role].length,
  );
}

function renderPlannerParticipant(role) {
  const state = PLANNER.status[role] || {};
  const configured = PLANNER.loop?.[role] || {};
  const engine = state.engine || configured.engine || (role === "planner" ? WS.engine : WS.engine === "claude" ? "codex" : "claude");
  const model = state.actualModel || state.model || configured.model || "default model";
  const item = el("span", `planner-participant${state.busy ? " busy" : ""}`);
  item.append(
    el("strong", null, role === "planner" ? "Planner" : "Reviewer"),
    document.createTextNode(`${engine} · ${model}`),
  );
  return item;
}

function renderPlanner() {
  if (!$("#planner-session")) return;
  const loop = PLANNER.loop;
  const stage = loop?.stage || (plannerHasSession() ? "idle" : "idle");
  const badge = $("#planner-loop-status");
  badge.textContent = loop?.active
    ? `${stage}${loop.round ? ` · round ${loop.round + (stage === "reviewing" ? 1 : 0)}/${loop.maxRounds}` : ""}`
    : stage;
  badge.dataset.stage = stage;
  $("#planner-loop-message").textContent = loop?.message ||
    "Start a read-only planner session. A second model reviews each revision before confirmation.";
  const participants = $("#planner-participants");
  participants.innerHTML = "";
  participants.append(renderPlannerParticipant("planner"), renderPlannerParticipant("reviewer"));

  for (const tab of document.querySelectorAll(".planner-agent-tab")) {
    tab.classList.toggle("on", tab.dataset.plannerRole === PLANNER.role);
  }
  const transcript = $("#planner-transcript");
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
  transcript.innerHTML = "";
  const events = PLANNER.events[PLANNER.role] || [];
  if (!events.length) {
    transcript.append(el(
      "div",
      "planner-empty",
      PLANNER.role === "planner"
        ? "Describe the task below to start a fresh planning session."
        : "The independent review transcript will appear after the planner produces a revision.",
    ));
  } else {
    for (const event of events.slice(-250)) {
      const row = el("div", `planner-event ${event.role}`);
      const meta = el("div", "planner-event-meta");
      meta.textContent = `${PLANNER.role} · ${event.role}`;
      const body = el("div");
      body.textContent = event.text;
      row.append(meta, body);
      transcript.append(row);
    }
  }
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;

  const busyRole = ["planner", "reviewer"].find((role) => PLANNER.status[role]?.busy);
  $("#planner-activity").hidden = !busyRole;
  if (busyRole) {
    $("#planner-activity-text").textContent = busyRole === "planner" ? "Planner is thinking…" : "Reviewer is checking the plan…";
  }
  $("#planner-cancel").hidden = !loop?.active && !busyRole;
  const waiting = !!PLANNER.status.planner?.question;
  const loopBusy = !!loop?.active;
  const send = $("#planner-send");
  send.disabled = PLANNER.loading || waiting || loopBusy;
  send.textContent = PLANNER.forceNew || !plannerHasSession() ? "Start planning" : "Send to planner";
  $("#planner-message").disabled = PLANNER.loading || waiting || loopBusy;
  $("#plan-new-session").disabled = PLANNER.loading || loopBusy || !!busyRole;
  $("#planner-message").placeholder = waiting
    ? "Answer the planner's question to continue"
    : loopBusy
      ? "Wait for the planner/reviewer loop to finish, or stop it"
    : PLANNER.forceNew
      ? "Describe the work for the new planning session…"
      : "Describe the work to plan, or send feedback on the current plan…";
}

function applyPlannerPlan(plan) {
  if (!plan || plan.project !== WS.name || PLAN.dirty) return;
  PLAN.saved = plan;
  PLAN.draft = clonePlan(plan);
  PLAN.loading = false;
  renderPlan();
}

function connectPlannerRole(project, role) {
  const es = new EventSource(
    `/api/projects/${encodeURIComponent(project)}/planner/stream?role=${encodeURIComponent(role)}`,
  );
  PLANNER.streams[role] = es;
  es.onopen = () => {
    if (PLANNER.project !== project || PLANNER.streams[role] !== es) return;
    PLANNER.events[role] = [];
    renderPlanner();
  };
  es.onmessage = (event) => {
    try {
      PLANNER.events[role].push(JSON.parse(event.data));
      if (PLANNER.events[role].length > 400) PLANNER.events[role].shift();
      renderPlanner();
    } catch {}
  };
  es.addEventListener("reset", () => {
    PLANNER.events[role] = [];
    renderPlanner();
  });
  es.addEventListener("status", (event) => {
    try {
      const status = JSON.parse(event.data);
      PLANNER.status[role] = status;
      if (status.question) openQuestion(project, status.question, false, "planner", role);
      else clearQuestion(project, null, "planner", role);
      renderPlanner();
    } catch {}
  });
  es.addEventListener("planning", (event) => {
    try {
      PLANNER.loop = JSON.parse(event.data).state || null;
      PLANNER.forceNew = false;
      renderPlanner();
    } catch {}
  });
  es.addEventListener("plan", (event) => {
    try {
      applyPlannerPlan(JSON.parse(event.data).plan);
    } catch {}
  });
  es.addEventListener("question", (event) => {
    try {
      const question = JSON.parse(event.data);
      PLANNER.status[role] = { ...(PLANNER.status[role] || {}), question };
      openQuestion(project, question, false, "planner", role);
      renderPlanner();
    } catch {}
  });
  es.addEventListener("question-cleared", (event) => {
    try {
      const id = JSON.parse(event.data).id;
      PLANNER.status[role] = { ...(PLANNER.status[role] || {}), question: null };
      clearQuestion(project, id, "planner", role);
      renderPlanner();
    } catch {}
  });
  es.onerror = () => {};
}

async function connectPlanner() {
  if (!WS.name || WS.chatOnly || WS.pane !== "plan") return;
  const project = WS.name;
  if (PLANNER.project !== project) PLANNER = emptyPlannerState(project);
  if (!PLANNER.streams.planner) connectPlannerRole(project, "planner");
  if (!PLANNER.streams.reviewer) connectPlannerRole(project, "reviewer");
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project)}/planner/state`);
    const data = await response.json();
    if (PLANNER.project !== project) return;
    PLANNER.loop = data.state || null;
    PLANNER.status.planner = data.planner || PLANNER.status.planner;
    PLANNER.status.reviewer = data.reviewer || PLANNER.status.reviewer;
    renderPlanner();
  } catch {}
}

function focusNewPlanner() {
  if (PLANNER.loop?.active) return toast("Stop the active planning loop before starting a new session");
  if (["planner", "reviewer"].some((role) => PLANNER.status[role]?.busy)) {
    return toast("Wait for the current planner turn to finish, or stop it");
  }
  PLANNER.forceNew = true;
  PLANNER.role = "planner";
  renderPlanner();
  $("#planner-message").focus();
}

async function sendPlannerMessage() {
  if (!WS.name || PLANNER.loading) return;
  if (PLAN.dirty) return toast("Save or discard your plan edits before messaging the planner");
  const input = $("#planner-message");
  const message = input.value.trim();
  if (!message) {
    input.focus();
    return toast("Describe what you want the planner to work on");
  }
  const fresh = PLANNER.forceNew || !plannerHasSession();
  PLANNER.loading = true;
  renderPlanner();
  try {
    const endpoint = fresh ? "start" : "message";
    const response = await fetch(
      `/api/projects/${encodeURIComponent(WS.name)}/planner/${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [fresh ? "brief" : "message"]: message,
          engine: WS.engine,
          model: WS.model,
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not start the planner");
    input.value = "";
    PLANNER.forceNew = false;
    if (data.state) PLANNER.loop = data.state;
    toast(fresh ? "New read-only planning session started" : data.queued ? "Planner message queued" : "Sent to planner");
  } catch (err) {
    toast(err.message || "Could not message the planner");
  } finally {
    PLANNER.loading = false;
    renderPlanner();
  }
}

async function cancelPlanner() {
  if (!WS.name) return;
  await fetch(`/api/projects/${encodeURIComponent(WS.name)}/planner/cancel`, { method: "POST" });
  toast("Planning stopped");
}

/* ---- structured implementation plan ---- */

const clonePlan = (value) => value ? JSON.parse(JSON.stringify(value)) : null;
const planUid = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function planLocked() {
  return PLAN.loading || ["reviewing", "confirmed", "in-progress", "done"].includes(PLAN.saved?.status);
}

function setPlanDirty() {
  if (!PLAN.draft || planLocked()) return;
  PLAN.dirty = JSON.stringify(PLAN.draft) !== JSON.stringify(PLAN.saved);
  $("#ws-plan").classList.toggle("plan-dirty", PLAN.dirty);
  $("#plan-discard").hidden = !PLAN.dirty;
  $("#plan-save").hidden = !PLAN.dirty;
  const confirmable = ["ai-reviewed", "confirmed"].includes(PLAN.saved?.status);
  $("#plan-confirm").hidden = PLAN.dirty || !confirmable;
  const status = $("#plan-status");
  status.textContent = PLAN.dirty ? "unsaved" : PLAN.saved.status;
  status.dataset.status = PLAN.dirty ? "edited" : PLAN.saved.status;
}

function findStepLocation(id, phases = PLAN.draft?.phases || []) {
  const walk = (steps, phase, parentStep = null, parentArray = null, parentIndex = -1) => {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (step.id === id) {
        return { step, array: steps, index, phase, parentStep, parentArray, parentIndex };
      }
      const nested = walk(step.children || [], phase, step, steps, index);
      if (nested) return nested;
    }
    return null;
  };
  for (const phase of phases) {
    const found = walk(phase.steps || [], phase);
    if (found) return found;
  }
  return null;
}

function removePlanStep(id) {
  const location = findStepLocation(id);
  if (!location) return null;
  return location.array.splice(location.index, 1)[0] || null;
}

function planStepContains(step, id) {
  return step.id === id || (step.children || []).some((child) => planStepContains(child, id));
}

function editableText(node, value, onChange, multiline = false) {
  const original = value || "";
  node.textContent = value || "";
  node.contentEditable = String(!planLocked());
  node.spellcheck = true;
  node.oninput = () => {
    onChange(node.textContent);
    setPlanDirty();
  };
  node.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onChange(original);
      node.textContent = original;
      node.blur();
      renderPlan();
    } else if (event.key === "Enter" && !multiline) {
      event.preventDefault();
      node.blur();
    }
  };
}

function renderPlanReview(plan) {
  const box = $("#plan-review");
  const review = plan?.review;
  if (!review || review.revision !== plan.revision) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.innerHTML = "";
  const summary = el("div", "plan-review-summary");
  summary.textContent = review.summary || "AI review completed.";
  box.append(summary);
  if (review.issues?.length) {
    const issues = el("div", "plan-review-issues");
    for (const issue of review.issues) {
      const row = el("div", `plan-review-issue ${issue.severity || "info"}`);
      const anchor = issue.stepId || issue.phaseId;
      row.textContent = `${issue.severity === "blocking" ? "Blocking" : issue.severity === "warning" ? "Warning" : "Note"}: ${issue.message}${anchor ? ` (${anchor})` : ""}`;
      issues.append(row);
    }
    box.append(issues);
  }
  box.hidden = false;
}

function clearPlanDropClasses() {
  for (const node of document.querySelectorAll(
    ".plan-phase.drop-before,.plan-phase.drop-after,.plan-step.drop-before,.plan-step.drop-after,.plan-step.drop-inside",
  )) {
    node.classList.remove("drop-before", "drop-after", "drop-inside");
  }
}

function renderPlanStep(step, phase) {
  const row = el("div", `plan-step${step.done ? " done" : ""}${step.blocked ? " blocked" : ""}`);
  row.dataset.stepId = step.id;

  const handle = el("button", "drag-handle", "⠿");
  handle.type = "button";
  handle.title = "Drag step";
  handle.draggable = !planLocked();
  handle.ondragstart = (event) => {
    PLAN.drag = { type: "step", id: step.id };
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", step.id);
  };
  handle.ondragend = () => {
    PLAN.drag = null;
    row.classList.remove("dragging");
    clearPlanDropClasses();
  };

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = !!step.done;
  checkbox.disabled = planLocked();
  checkbox.onchange = () => {
    step.done = checkbox.checked;
    setPlanDirty();
    renderPlan();
  };

  const text = el("span", "plan-inline plan-step-text");
  editableText(text, step.text, (value) => { step.text = value; });

  const actions = el("div", "plan-icon-actions");
  const controls = [
    ["step-up", "↑", "Move step up"],
    ["step-down", "↓", "Move step down"],
    ["step-indent", "→", "Nest under previous step"],
    ["step-outdent", "←", "Move out one level"],
    ["step-add-child", "＋", "Add nested step"],
    ["step-delete", "×", "Delete step"],
  ];
  for (const [action, label, title] of controls) {
    const button = el("button", "plan-icon", label);
    button.type = "button";
    button.dataset.action = action;
    button.dataset.stepId = step.id;
    button.title = title;
    button.disabled = planLocked();
    actions.append(button);
  }
  row.append(handle, checkbox, text, actions);

  row.ondragover = (event) => {
    if (PLAN.drag?.type !== "step" || PLAN.drag.id === step.id) return;
    event.preventDefault();
    event.stopPropagation();
    clearPlanDropClasses();
    const rect = row.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
    const mode = ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : "inside";
    row.classList.add(`drop-${mode}`);
    row.dataset.dropMode = mode;
  };
  row.ondrop = (event) => {
    if (PLAN.drag?.type !== "step" || PLAN.drag.id === step.id) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = PLAN.drag.id;
    const mode = row.dataset.dropMode || "after";
    const source = findStepLocation(sourceId);
    if (!source || planStepContains(source.step, step.id)) {
      PLAN.drag = null;
      renderPlan();
      return;
    }
    const moved = removePlanStep(sourceId);
    const target = findStepLocation(step.id);
    if (!moved || !target) {
      renderPlan();
      return;
    }
    if (mode === "inside") target.step.children.push(moved);
    else target.array.splice(target.index + (mode === "after" ? 1 : 0), 0, moved);
    PLAN.drag = null;
    setPlanDirty();
    renderPlan();
  };

  if (step.children?.length) {
    const children = el("div", "plan-children");
    for (const child of step.children) children.append(renderPlanStep(child, phase));
    row.append(children);
  }
  return row;
}

function renderPlanPhase(phase, phaseIndex) {
  const card = el("section", "plan-phase");
  card.dataset.phaseId = phase.id;
  const head = el("div", "plan-phase-head");
  const handle = el("button", "drag-handle", "⠿");
  handle.type = "button";
  handle.title = "Drag phase";
  handle.draggable = !planLocked();
  handle.ondragstart = (event) => {
    PLAN.drag = { type: "phase", id: phase.id };
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", phase.id);
  };
  handle.ondragend = () => {
    PLAN.drag = null;
    card.classList.remove("dragging");
    clearPlanDropClasses();
  };

  const copy = el("div", "plan-phase-copy");
  const title = el("span", "plan-inline plan-phase-title");
  editableText(title, phase.title, (value) => { phase.title = value; });
  const summary = el("span", "plan-inline plan-phase-summary");
  editableText(summary, phase.summary, (value) => { phase.summary = value; }, true);
  copy.append(title, summary);

  const actions = el("div", "plan-icon-actions");
  for (const [action, label, tooltip] of [
    ["phase-up", "↑", "Move phase up"],
    ["phase-down", "↓", "Move phase down"],
    ["phase-delete", "×", "Delete phase"],
  ]) {
    const button = el("button", "plan-icon", label);
    button.type = "button";
    button.dataset.action = action;
    button.dataset.phaseId = phase.id;
    button.title = tooltip;
    button.disabled = planLocked();
    actions.append(button);
  }
  head.append(handle, copy, actions);

  const steps = el("div", "plan-steps");
  for (const step of phase.steps || []) steps.append(renderPlanStep(step, phase));
  steps.ondragover = (event) => {
    if (PLAN.drag?.type !== "step" || event.target.closest(".plan-step")) return;
    event.preventDefault();
  };
  steps.ondrop = (event) => {
    if (PLAN.drag?.type !== "step" || event.target.closest(".plan-step")) return;
    event.preventDefault();
    const moved = removePlanStep(PLAN.drag.id);
    if (moved) {
      phase.steps.push(moved);
      setPlanDirty();
    }
    PLAN.drag = null;
    renderPlan();
  };
  const add = el("button", "plan-add-step", "＋ Add step");
  add.type = "button";
  add.disabled = planLocked();
  add.onclick = () => {
    phase.steps.push({ id: planUid("step"), text: "New step", done: false, children: [] });
    setPlanDirty();
    renderPlan();
  };
  steps.append(add);
  card.append(head, steps);

  card.ondragover = (event) => {
    if (PLAN.drag?.type !== "phase" || PLAN.drag.id === phase.id) return;
    event.preventDefault();
    clearPlanDropClasses();
    const rect = card.getBoundingClientRect();
    const mode = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    card.classList.add(`drop-${mode}`);
    card.dataset.dropMode = mode;
  };
  card.ondrop = (event) => {
    if (PLAN.drag?.type !== "phase" || PLAN.drag.id === phase.id) return;
    event.preventDefault();
    const sourceIndex = PLAN.draft.phases.findIndex((item) => item.id === PLAN.drag.id);
    if (sourceIndex < 0) return;
    const [moved] = PLAN.draft.phases.splice(sourceIndex, 1);
    const targetIndex = PLAN.draft.phases.findIndex((item) => item.id === phase.id);
    const insertAt = targetIndex + (card.dataset.dropMode === "after" ? 1 : 0);
    PLAN.draft.phases.splice(insertAt, 0, moved);
    PLAN.drag = null;
    setPlanDirty();
    renderPlan();
  };
  return card;
}

function renderPlan() {
  const editor = $("#plan-editor");
  const saved = PLAN.saved;
  const plan = PLAN.draft;
  editor.innerHTML = "";
  $("#ws-plan").classList.toggle("plan-dirty", PLAN.dirty);
  if (!plan) {
    $("#plan-title").textContent = "Implementation plan";
    $("#plan-title").contentEditable = "false";
    $("#plan-notes").textContent = "";
    $("#plan-status").textContent = PLAN.loading ? "loading" : "none";
    $("#plan-status").dataset.status = "";
    $("#plan-revision").textContent = "";
    $("#plan-review").hidden = true;
    $("#plan-add-phase").hidden = true;
    $("#plan-discard").hidden = true;
    $("#plan-save").hidden = true;
    $("#plan-confirm").hidden = true;
    const empty = el("div", "plan-empty");
    const content = el("div");
    content.innerHTML = "<strong>No structured plan yet.</strong><br>Start a dedicated read-only planner session below.";
    const ask = el("button", "btn btn-primary", "Start planner session");
    ask.style.marginTop = "14px";
    ask.onclick = focusNewPlanner;
    content.append(document.createElement("br"), ask);
    empty.append(content);
    editor.append(empty);
    return;
  }

  const title = $("#plan-title");
  editableText(title, plan.title, (value) => { plan.title = value; });
  const notes = $("#plan-notes");
  editableText(notes, plan.notes, (value) => { plan.notes = value; }, true);
  const status = $("#plan-status");
  status.textContent = PLAN.dirty ? "unsaved" : saved.status;
  status.dataset.status = PLAN.dirty ? "edited" : saved.status;
  $("#plan-revision").textContent = `revision ${saved.revision}`;
  $("#plan-add-phase").hidden = planLocked();
  $("#plan-discard").hidden = !PLAN.dirty;
  $("#plan-save").hidden = !PLAN.dirty;
  const confirmable = !PLAN.dirty && ["ai-reviewed", "confirmed"].includes(saved.status);
  $("#plan-confirm").hidden = !confirmable;
  $("#plan-confirm").textContent =
    saved.status === "confirmed" ? "Retry start" : "Confirm & start working";
  renderPlanReview(saved);
  for (let index = 0; index < plan.phases.length; index += 1) {
    editor.append(renderPlanPhase(plan.phases[index], index));
  }
}

async function loadPlan(force = false) {
  if (!WS.name || WS.chatOnly || PLAN.loading || (PLAN.dirty && !force)) return;
  const project = WS.name;
  PLAN.loading = true;
  if (!PLAN.saved) renderPlan();
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project)}/plans`);
    const data = await response.json();
    if (WS.name !== project) return;
    PLAN.saved = data.latest || null;
    PLAN.draft = clonePlan(PLAN.saved);
    PLAN.dirty = false;
  } catch {
    if (WS.name === project) toast("Could not load implementation plan");
  } finally {
    if (WS.name === project) {
      PLAN.loading = false;
      renderPlan();
    }
  }
}

async function savePlan() {
  if (!WS.name || !PLAN.saved || !PLAN.draft || !PLAN.dirty || PLAN.loading) return;
  PLAN.loading = true;
  renderPlan();
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(WS.name)}/plans/${encodeURIComponent(PLAN.saved.id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: PLAN.draft,
          expectedRevision: PLAN.saved.revision,
          review: true,
        }),
      },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save plan");
    PLAN.saved = data.plan;
    PLAN.draft = clonePlan(data.plan);
    PLAN.dirty = false;
    toast(data.reviewQueued ? "Plan saved · cross-model review queued" : "Plan saved · review unavailable");
  } catch (err) {
    toast(err.message || "Could not save plan");
  } finally {
    PLAN.loading = false;
    renderPlan();
  }
}

async function confirmPlan() {
  if (!WS.name || !PLAN.saved || PLAN.dirty || PLAN.loading) return;
  PLAN.loading = true;
  renderPlan();
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(WS.name)}/plans/${encodeURIComponent(PLAN.saved.id)}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: PLAN.saved.revision }),
      },
    );
    const data = await response.json();
    PLAN.saved = data.plan || PLAN.saved;
    PLAN.draft = clonePlan(PLAN.saved);
    if (!response.ok) throw new Error(data.ai?.error || data.error || "Could not start plan");
    toast("Confirmed · fresh project-agent session started");
    switchPane("ai");
  } catch (err) {
    toast(err.message || "Could not start plan");
  } finally {
    PLAN.loading = false;
    renderPlan();
  }
}

function planAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button || !PLAN.draft || planLocked()) return;
  const action = button.dataset.action;
  const phaseId = button.dataset.phaseId;
  const stepId = button.dataset.stepId;
  if (phaseId) {
    const index = PLAN.draft.phases.findIndex((phase) => phase.id === phaseId);
    if (index < 0) return;
    if (action === "phase-up" && index > 0) {
      [PLAN.draft.phases[index - 1], PLAN.draft.phases[index]] =
        [PLAN.draft.phases[index], PLAN.draft.phases[index - 1]];
    } else if (action === "phase-down" && index < PLAN.draft.phases.length - 1) {
      [PLAN.draft.phases[index + 1], PLAN.draft.phases[index]] =
        [PLAN.draft.phases[index], PLAN.draft.phases[index + 1]];
    } else if (action === "phase-delete") {
      if (PLAN.draft.phases.length === 1) return toast("A plan needs at least one phase");
      PLAN.draft.phases.splice(index, 1);
    }
  } else if (stepId) {
    const location = findStepLocation(stepId);
    if (!location) return;
    if (action === "step-up" && location.index > 0) {
      [location.array[location.index - 1], location.array[location.index]] =
        [location.array[location.index], location.array[location.index - 1]];
    } else if (action === "step-down" && location.index < location.array.length - 1) {
      [location.array[location.index + 1], location.array[location.index]] =
        [location.array[location.index], location.array[location.index + 1]];
    } else if (action === "step-indent" && location.index > 0) {
      const [moved] = location.array.splice(location.index, 1);
      location.array[location.index - 1].children.push(moved);
    } else if (action === "step-outdent" && location.parentStep && location.parentArray) {
      const [moved] = location.array.splice(location.index, 1);
      location.parentArray.splice(location.parentIndex + 1, 0, moved);
    } else if (action === "step-add-child") {
      location.step.children.push({
        id: planUid("step"),
        text: "New nested step",
        done: false,
        children: [],
      });
    } else if (action === "step-delete") {
      location.array.splice(location.index, 1);
    }
  }
  setPlanDirty();
  renderPlan();
}

/* ---- Session pane ---- */
let sessionRefreshTimer = null;

function formatDateTime(ms) {
  return ms ? new Date(ms).toLocaleString() : "—";
}

function compactText(text, max = 260) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function renderSessionPane(data) {
  const state = data || {
    busy: false,
    engine: WS.engine,
    model: WS.model || null,
    actualModel: WS.actualModel || null,
    hasSession: false,
    sessionId: null,
    queueDepth: 0,
    messages: 0,
    events: 0,
    lastActive: null,
    activity: "No AI session yet",
    question: null,
    recent: [],
  };
  WS.sessionState = state;
  WS.question = state.question || null;
  const activeModel = state.actualModel || state.model || "default";
  const dot = $("#session-state-dot");
  dot.classList.toggle("busy", !!state.busy);
  dot.classList.toggle("waiting", !!state.question);
  $("#session-state-text").textContent = state.question ? "needs answer" : state.busy ? "working" : state.hasSession ? "idle" : state.events ? "local" : "no session";
  $("#ws-session-answer").hidden = !state.question;
  refreshComposer();
  if (state.question && WS.name) openQuestion(WS.name, state.question);

  const rows = [
    ["engine", state.engine || WS.engine || "claude"],
    ["model", activeModel],
    ["configured", state.model || "default"],
    ["session", state.sessionId || "—"],
    ["messages", String(state.messages || 0)],
    ["queue", String(state.queueDepth || 0)],
    ["events", String(state.events || 0)],
    ["last active", formatDateTime(state.lastActive)],
  ];
  $("#ws-session-summary").innerHTML = rows
    .map(([k, v]) => `<div class="session-stat"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`)
    .join("");

  $("#ws-session-current").textContent = state.activity || (state.hasSession ? "Idle" : "No AI session yet");

  const recent = state.recent || [];
  const log = $("#ws-session-log");
  log.innerHTML = "";
  if (!recent.length) {
    log.append(el("div", "session-empty", "No session events yet."));
    return;
  }
  for (const ev of recent) {
    const row = el("div", "session-event session-" + ev.role);
    const meta = el("div", "session-event-meta");
    meta.append(el("span", null, ev.role), el("time", null, formatDateTime(ev.t)));
    const body = el("div", "session-event-body");
    body.textContent = compactText(ev.text, 900);
    row.append(meta, body);
    log.append(row);
  }
  log.scrollTop = log.scrollHeight;
}

async function fetchSessionState() {
  if (!WS.name) return;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(WS.name)}/ai/state`);
    if (!r.ok) return;
    renderSessionPane(await r.json());
  } catch {}
}

function scheduleSessionRefresh(delay = 150) {
  if (WS.pane !== "session" || !WS.name) return;
  clearTimeout(sessionRefreshTimer);
  sessionRefreshTimer = setTimeout(fetchSessionState, delay);
}

/* ---- AI questions ---- */
let ACTIVE_QUESTION = null;
const QUESTIONS_LATER = new Set();

function questionKey(project, request, scope = "ai", role = "") {
  return `${scope}:${role || ""}:${project}:${request?.id || ""}`;
}

function closeQuestion(markLater = false) {
  if (markLater && ACTIVE_QUESTION) {
    QUESTIONS_LATER.add(questionKey(
      ACTIVE_QUESTION.project,
      ACTIVE_QUESTION.request,
      ACTIVE_QUESTION.scope,
      ACTIVE_QUESTION.role,
    ));
  }
  ACTIVE_QUESTION = null;
  $("#question-backdrop").hidden = true;
  $("#question-modal").hidden = true;
  $("#question-body").innerHTML = "";
}

function clearQuestion(project, requestId = null, scope = "ai", role = null) {
  if (
    ACTIVE_QUESTION?.project === project &&
    ACTIVE_QUESTION.scope === scope &&
    (!role || ACTIVE_QUESTION.role === role) &&
    (!requestId || ACTIVE_QUESTION.request.id === requestId)
  ) closeQuestion();
  if (scope === "ai" && WS.name === project && (!requestId || WS.question?.id === requestId)) {
    WS.question = null;
    if (WS.sessionState) WS.sessionState.question = null;
    $("#ws-session-answer").hidden = true;
    refreshComposer();
    renderWorkingButton();
  }
}

function questionOption(input, title, description = "") {
  const label = el("label", "ai-question-option");
  const strong = el("strong");
  strong.textContent = title;
  label.append(input, strong);
  if (description) {
    const detail = el("span");
    detail.textContent = description;
    label.append(detail);
  }
  return label;
}

function renderQuestionField(question, index) {
  const field = el("fieldset", "ai-question-field");
  field.dataset.questionId = question.id;
  const legend = el("legend");
  legend.textContent = question.header || `Question ${index + 1}`;
  const prompt = el("p", "ai-question-prompt");
  prompt.textContent = question.question;
  field.append(legend, prompt);

  if (!question.options?.length) {
    const input = el("input", "ai-question-free");
    input.type = question.isSecret ? "password" : "text";
    input.autocomplete = "off";
    input.placeholder = question.isSecret ? "Enter answer (hidden from the transcript)" : "Type your answer";
    field.append(input);
    return field;
  }

  const choices = el("div", "ai-question-options");
  const type = question.multiSelect ? "checkbox" : "radio";
  const group = `ai-question-${index}`;
  for (const option of question.options) {
    const input = el("input");
    input.type = type;
    input.name = group;
    input.dataset.answer = option.label;
    choices.append(questionOption(input, option.label, option.description));
  }

  const otherChoice = el("input");
  otherChoice.type = type;
  otherChoice.name = group;
  otherChoice.dataset.other = "true";
  choices.append(questionOption(otherChoice, "Other", "Provide a different answer"));
  const other = el("input", "ai-question-other");
  other.type = question.isSecret ? "password" : "text";
  other.autocomplete = "off";
  other.placeholder = "Type another answer";
  other.disabled = true;
  const updateOther = () => {
    other.disabled = !otherChoice.checked;
    if (!other.disabled) other.focus();
  };
  for (const input of choices.querySelectorAll("input")) input.addEventListener("change", updateOther);
  field.append(choices, other);
  return field;
}

function openQuestion(project, request, force = false, scope = "ai", role = null) {
  if (!request?.id || !request.questions?.length) return;
  const key = questionKey(project, request, scope, role || "");
  if (!force && QUESTIONS_LATER.has(key)) return;
  if (ACTIVE_QUESTION && !$("#question-modal").hidden && !force) return;
  if (force) QUESTIONS_LATER.delete(key);
  ACTIVE_QUESTION = { project, request, scope, role };
  $("#question-project").textContent = project === "__workspace__"
    ? "Workspace chat"
    : scope === "planner"
      ? `${project} · ${role}`
      : project;
  $("#question-title").textContent = `${request.engine || "AI"} needs your input`;
  const body = $("#question-body");
  body.innerHTML = "";
  request.questions.forEach((question, index) => body.append(renderQuestionField(question, index)));
  $("#question-backdrop").hidden = false;
  $("#question-modal").hidden = false;
  requestAnimationFrame(() => body.querySelector("input")?.focus());
}

function syncPendingQuestions(sessions) {
  const pending = sessions.filter((session) => session.question);
  if (ACTIVE_QUESTION?.scope === "ai") {
    const stillPending = pending.some(
      (session) => session.name === ACTIVE_QUESTION.project && session.question.id === ACTIVE_QUESTION.request.id,
    );
    if (!stillPending) closeQuestion();
  }
  if (!ACTIVE_QUESTION) {
    const next = pending.find((session) => !QUESTIONS_LATER.has(questionKey(session.name, session.question)));
    if (next) openQuestion(next.name, next.question);
  }
}

function collectQuestionAnswers() {
  if (!ACTIVE_QUESTION) return null;
  const fields = [...$("#question-body").querySelectorAll(".ai-question-field")];
  const answers = {};
  let firstInvalid = null;
  ACTIVE_QUESTION.request.questions.forEach((question, index) => {
    const field = fields[index];
    field.classList.remove("invalid");
    let values;
    if (!question.options?.length) {
      values = [field.querySelector(".ai-question-free").value.trim()].filter(Boolean);
    } else {
      values = [...field.querySelectorAll(".ai-question-options input:checked")]
        .map((input) => input.dataset.other === "true"
          ? field.querySelector(".ai-question-other").value.trim()
          : input.dataset.answer)
        .filter(Boolean);
    }
    if (!values.length) {
      field.classList.add("invalid");
      firstInvalid ||= field;
      return;
    }
    answers[question.id] = question.multiSelect ? values : values[0];
  });
  if (firstInvalid) {
    firstInvalid.scrollIntoView({ block: "nearest" });
    firstInvalid.querySelector("input")?.focus();
    return null;
  }
  return answers;
}

async function answerQuestion(event) {
  event.preventDefault();
  if (!ACTIVE_QUESTION) return;
  const answers = collectQuestionAnswers();
  if (!answers) return toast("Answer each question before continuing");
  const active = ACTIVE_QUESTION;
  const submit = $("#question-submit");
  submit.disabled = true;
  try {
    const project = STATE.projects.find((p) => p.name === active.project);
    const fullAccess = WS.name === active.project ? WS.fullAccess : !!project?.aiFullAccess;
    const planner = active.scope === "planner";
    const r = await fetch(`/api/projects/${encodeURIComponent(active.project)}/${planner ? "planner" : "ai"}/question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: active.request.id,
        answers,
        ...(planner ? { role: active.role } : { fullAccess }),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 409) {
        clearQuestion(active.project, active.request.id, active.scope, active.role);
        if (!planner) fetchSessions();
      }
      return toast(data.error || "Could not send the answer");
    }
    QUESTIONS_LATER.delete(questionKey(active.project, active.request, active.scope, active.role || ""));
    clearQuestion(active.project, active.request.id, active.scope, active.role);
    if (!planner) {
      await fetchSessions();
      if (WS.name === active.project) fetchSessionState();
    }
    toast("Answer sent");
  } catch {
    toast("Could not send the answer");
  } finally {
    submit.disabled = false;
  }
}

/* ---- AI pane ---- */
function renderAiModel() {
  const configured = WS.model && WS.model.trim();
  const actual = WS.actualModel && WS.actualModel.trim();
  const text = actual || configured || "default";
  const node = $("#ws-model-current");
  node.textContent = `model: ${text}`;
  node.title = actual && configured && actual !== configured
    ? `CLI reported ${actual}; configured as ${configured}`
    : configured
      ? `Configured model: ${configured}`
      : "Using the CLI default model";
  $("#ws-model").placeholder = WS.engine === "codex" ? "default from Codex config" : "default from Claude Code";
}

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

function renderAiBubble(ev) {
  const t = $("#ws-transcript");
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  const b = el("div", "ai-msg ai-" + ev.role);
  b.textContent = ev.text;
  t.append(b);
  if (nearBottom) t.scrollTop = t.scrollHeight;
  return b;
}

function appendAiEvent(ev) {
  // we render just-sent messages optimistically — skip each one's server echo
  if (ev.role === "user") {
    const i = WS.pending.indexOf(ev.text);
    if (i >= 0) {
      WS.pending.splice(i, 1);
      scheduleSessionRefresh();
      return;
    }
  }
  renderAiBubble(ev);
  scheduleSessionRefresh();
  if (WS.aiBusy) {
    const label = activityFor(ev);
    if (label) setAiActivity(label);
  }
}

function setAiBusy(busy) {
  WS.aiBusy = busy;
  $("#ws-ai-status").textContent = busy ? "working…" : "";
  $("#ws-engine").disabled = busy || !!WS.question;
  $("#ws-model").disabled = busy || !!WS.question;
  // Send stays available even while busy — extra messages get queued. Stop
  // shows alongside it so the running turn can still be cancelled.
  $("#ws-send").hidden = false;
  $("#ws-cancel").hidden = !busy;
  if (busy) setAiActivity("Thinking…");
  else $("#ws-ai-activity").hidden = true;
  refreshComposer();
  renderWorkingButton();
}

function connectAi(name) {
  if (WS.aiEs) WS.aiEs.close();
  const params = new URLSearchParams({ engine: WS.engine });
  if (WS.model) params.set("model", WS.model);
  const es = new EventSource(`/api/projects/${encodeURIComponent(name)}/ai/stream?${params}`);
  WS.aiEs = es;
  // on every (re)connection the server replays the whole transcript, so wipe
  // first — this makes a dropped/reconnected stream rebuild cleanly instead of
  // duplicating or going blank
  es.onopen = () => {
    WS.pending = [];
    $("#ws-transcript").innerHTML = "";
  };
  es.onmessage = (e) => {
    try {
      appendAiEvent(JSON.parse(e.data));
    } catch {}
  };
  es.addEventListener("status", (e) => {
    try {
      const status = JSON.parse(e.data);
      WS.engine = status.engine || WS.engine;
      WS.model = status.model || "";
      WS.actualModel = status.actualModel || null;
      WS.question = status.question || null;
      $("#ws-engine").value = WS.engine;
      $("#ws-model").value = WS.model;
      renderAiModel();
      if (WS.pane === "session") renderSessionPane({ ...(WS.sessionState || {}), ...status, recent: WS.sessionState?.recent || [] });
      if (WS.question) openQuestion(name, WS.question);
      else clearQuestion(name);
      setAiBusy(status.busy);
    } catch {}
  });
  // the server sends the last saved recap on (re)connect
  es.addEventListener("recap", (e) => {
    try {
      setRecap(JSON.parse(e.data).summary);
    } catch {}
  });
  // a usage limit — pushed on connect if already limited, or when a turn hits one
  es.addEventListener("limit", (e) => {
    try {
      setAiLimit(JSON.parse(e.data));
    } catch {}
  });
  es.addEventListener("question", (e) => {
    try {
      const question = JSON.parse(e.data);
      WS.question = question;
      if (WS.sessionState) WS.sessionState.question = question;
      $("#ws-session-answer").hidden = false;
      refreshComposer();
      renderWorkingButton();
      openQuestion(name, question);
      fetchSessions();
    } catch {}
  });
  es.addEventListener("question-cleared", (e) => {
    try {
      clearQuestion(name, JSON.parse(e.data).id);
      fetchSessions();
    } catch {}
  });
  es.addEventListener("plan", (e) => {
    try {
      const plan = JSON.parse(e.data).plan;
      if (!plan || plan.project !== WS.name || PLAN.dirty) return;
      PLAN.saved = plan;
      PLAN.draft = clonePlan(plan);
      PLAN.loading = false;
      renderPlan();
    } catch {}
  });
  es.addEventListener("working-stopped", () => {
    if (WS.name !== name || WS.aiEs !== es) return;
    WS.workingOn = false;
    WS.pending = [];
    clearQuestion(name);
    setAiBusy(false);
    if (aiPaneOpen()) switchPane("logs");
    else disconnectAi();
  });
  es.onerror = () => {};
}

// recaps the user has dismissed this session, keyed by project name — so a
// closed recap stays closed when you switch away and come back (until reload)
const RECAP_DISMISSED = new Set();

function setRecap(summary) {
  const banner = $("#ws-ai-recap");
  banner.classList.remove("loading");
  if (!summary || RECAP_DISMISSED.has(WS.name)) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }
  banner.innerHTML = "";
  const name = WS.name; // pin it for the close handler
  const close = el("button", "ai-recap-close", "&times;");
  close.title = "Dismiss";
  close.onclick = () => {
    RECAP_DISMISSED.add(name);
    banner.hidden = true;
    banner.innerHTML = "";
  };
  const head = el("div", "ai-recap-head");
  head.append(el("div", "ai-recap-title", "↩ Where we left off"), close);
  const body = el("div", "ai-recap-body");
  body.textContent = summary;
  banner.append(head, body);
  banner.hidden = false;
}

async function fetchRecap() {
  if (!WS.name || RECAP_DISMISSED.has(WS.name)) return;
  const banner = $("#ws-ai-recap");
  if (banner.hidden) {
    banner.hidden = false;
    banner.classList.add("loading");
    banner.textContent = "Recalling where we left off…";
  }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(WS.name)}/ai/recap`);
    setRecap((await r.json()).summary);
  } catch {
    banner.classList.remove("loading");
  }
}

/* ---- usage limit ---- */
function refreshComposer() {
  const blocked = WS.aiLimited;
  const waiting = !!WS.question;
  $("#ws-send").disabled = blocked || waiting;
  $("#ws-msg").disabled = blocked || waiting;
  $("#ws-msg").placeholder = waiting
    ? "Answer the AI's question to continue"
    : blocked
    ? "Sending paused — usage limit reached"
    : "Ask the project's AI to make a change…  (Enter to send, Shift+Enter for newline)";
}

function setAiLimit(limit) {
  const banner = $("#ws-ai-limit");
  // only a hard limit pauses sending; a warning just shows an advisory banner
  const hard = !!(limit && limit.hard);
  WS.aiLimited = hard;
  if (!limit) {
    banner.hidden = true;
    banner.innerHTML = "";
  } else {
    banner.innerHTML = "";
    const body = el("div", "ai-limit-body");
    const until = limit.until ? new Date(limit.until).toLocaleString() : null;
    const fallback = hard ? "Usage limit reached." : "You're approaching your usage limit.";
    body.textContent = (limit.message || fallback) + (until ? `  Resets ${until}.` : "");
    banner.classList.toggle("ai-limit-soft", !hard);
    banner.append(el("div", "ai-limit-title", hard ? "⚠ Usage limit reached" : "⚠ Approaching usage limit"), body);
    banner.hidden = false;
  }
  refreshComposer();
}

async function fetchLimit() {
  if (!WS.name) return;
  try {
    const r = await fetch(`/api/ai/limit?engine=${encodeURIComponent(WS.engine)}`);
    setAiLimit((await r.json()).limit);
  } catch {}
}

async function sendAi() {
  // note: no aiBusy guard — you can send while a turn is running; the server
  // queues it and runs it when the current turn finishes
  if (!WS.name) return;
  if (WS.aiLimited) return toast("Usage limit reached — sending is paused");
  const box = $("#ws-msg");
  const name = WS.name; // pin it: the user may switch chats during the round-trip
  if (!WS.aiEs) connectAi(name);
  const message = box.value.trim();
  if (!message) return;
  box.value = "";
  delete DRAFTS[name]; // the draft was sent — don't resurrect it on the next open
  saveDrafts();
  const wasBusy = WS.aiBusy; // a real turn already running? then SSE owns the busy state
  // show the message immediately — never depend on the round-trip for feedback.
  // pending is a multiset: several messages may be in flight/queued at once, and
  // each server echo cancels one so we don't double-render it.
  WS.pending.push(message);
  const optimistic = renderAiBubble({ role: "user", text: message });
  setAiBusy(true);
  const r = await fetch(`/api/projects/${encodeURIComponent(name)}/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, engine: WS.engine, model: WS.model, fullAccess: WS.fullAccess }),
  });
  const e = await r.json().catch(() => ({}));
  if (!r.ok) {
    toast(e.error || "AI request failed");
    if (!wasBusy) setAiBusy(false); // our optimistic "busy" was bogus — undo it
    // don't lose the message — put it back on its own chat only
    DRAFTS[name] = message;
    saveDrafts();
    if (WS.name === name) box.value = message;
    const i = WS.pending.indexOf(message);
    if (i >= 0) WS.pending.splice(i, 1);
    optimistic.remove(); // undo the optimistic bubble
    if (e.limited) fetchLimit(); // surface the limit banner + pause sending
    if (e.question) fetchSessionState();
  } else if (e.queued) {
    toast("Queued — sends when the current turn finishes");
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
  es.onopen = () => ($("#ws-depconsole").innerHTML = ""); // rebuild on (re)connect, don't duplicate
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
  stashDraft(); // keep this deploy prompt tied to the current chat
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
  renderWorkingButton();
}

$("#ws-working").onclick = toggleWorking;
$("#ws-close").onclick = () => closeWorkspace();
$("#ws-backdrop").onclick = () => closeWorkspace();
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
  WS.model = "";
  WS.actualModel = null;
  $("#ws-model").value = "";
  renderAiModel();
  usageSelectionChanged();
  patchProject(WS.name, { aiEngine: WS.engine, aiModel: "" }); // remember per project
  fetchLimit(); // limits are per engine — re-check for the newly selected one
  if (aiPaneOpen()) connectAi(WS.name);
  scheduleSessionRefresh();
};
$("#ws-model").onchange = (e) => {
  WS.model = e.target.value.trim();
  WS.actualModel = null;
  e.target.value = WS.model;
  renderAiModel();
  usageSelectionChanged();
  patchProject(WS.name, { aiModel: WS.model }); // remember per project
  if (aiPaneOpen()) connectAi(WS.name);
  scheduleSessionRefresh();
};
$("#ws-full").onchange = (e) => {
  WS.fullAccess = e.target.checked;
  patchProject(WS.name, { aiFullAccess: WS.fullAccess }); // remember per project
};
$("#ws-send").onclick = sendAi;
$("#ws-cancel").onclick = cancelAi;
$("#ws-session-refresh").onclick = fetchSessionState;
$("#ws-session-answer").onclick = () => {
  const question = WS.question || WS.sessionState?.question;
  if (WS.name && question) openQuestion(WS.name, question, true);
};
$("#plan-editor").onclick = planAction;
$("#plan-add-phase").onclick = () => {
  if (!PLAN.draft || planLocked()) return;
  PLAN.draft.phases.push({
    id: planUid("phase"),
    title: "New phase",
    summary: "",
    steps: [],
  });
  setPlanDirty();
  renderPlan();
};
$("#plan-discard").onclick = () => {
  PLAN.draft = clonePlan(PLAN.saved);
  PLAN.dirty = false;
  renderPlan();
};
$("#plan-save").onclick = savePlan;
$("#plan-confirm").onclick = confirmPlan;
$("#plan-new-session").onclick = focusNewPlanner;
$("#planner-send").onclick = sendPlannerMessage;
$("#planner-cancel").onclick = cancelPlanner;
$("#planner-agent-tabs").onclick = (event) => {
  const tab = event.target.closest("[data-planner-role]");
  if (!tab) return;
  PLANNER.role = tab.dataset.plannerRole;
  renderPlanner();
};
$("#planner-message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendPlannerMessage();
  }
});
$("#cap-refresh").onclick = () => {
  CAPS.catalog = [];
  closeCapabilityPreview();
  loadCapabilities(true);
};
$("#cap-preview-close").onclick = closeCapabilityPreview;
$("#cap-preview-cancel").onclick = closeCapabilityPreview;
$("#cap-preview-confirm").onclick = confirmCapabilityChange;
$("#cap-custom-open").onclick = openCustomCapabilityForm;
$("#cap-custom-close").onclick = closeModals;
$("#cap-custom-cancel").onclick = closeModals;
$("#cap-custom-transport").onchange = toggleCustomTransport;
$("#cap-custom-review").onclick = reviewCustomCapability;
$("#question-form").addEventListener("submit", answerQuestion);
$("#question-close").onclick = () => closeQuestion(true);
$("#question-later").onclick = () => closeQuestion(true);
$("#question-backdrop").onclick = () => closeQuestion(true);
$("#ws-msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendAi();
  }
});
// persist the draft as it's typed, so it survives reloads and rapid chat switches
$("#ws-msg").addEventListener("input", stashDraft);
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
  $("#usage-modal").hidden = true;
  $("#cap-custom-modal").hidden = true;
  $("#cloud-modal").hidden = true;
  $("#skills-modal").hidden = true;
}

/* ---------- subscription usage ---------- */
const USAGE_REFRESH_MS = 60_000;
const USAGE_STATE = {
  cache: new Map(),
  inFlight: new Map(),
  activeKey: null,
  renderedKey: null,
};

function selectedUsageScope() {
  if (!WS.name || WS.chatOnly) return null;
  const model = WS.model?.trim() || null;
  return {
    project: WS.name,
    engine: WS.engine,
    model,
    key: `${WS.engine}:${model || "default"}`,
  };
}

function resetUsageButton() {
  const button = $("#usage-open");
  button.textContent = "Usage";
  button.classList.remove("usage-warning", "usage-critical");
}

function usageSelectionChanged() {
  const scope = selectedUsageScope();
  if (!scope) {
    USAGE_STATE.activeKey = null;
    USAGE_STATE.renderedKey = null;
    resetUsageButton();
    return;
  }
  const changed = scope.key !== USAGE_STATE.activeKey;
  USAGE_STATE.activeKey = scope.key;
  $("#usage-scope").textContent = `${scope.project} · ${scope.engine} · ${scope.model || "default model"}`;
  $("#usage-open").title = `View ${scope.engine} subscription usage for ${scope.model || "the default model"}`;
  const cached = USAGE_STATE.cache.get(scope.key);
  if (cached && (changed || USAGE_STATE.renderedKey !== scope.key)) {
    renderUsage(cached.snapshot, scope);
    if (Date.now() - cached.checkedAt >= USAGE_REFRESH_MS) fetchUsage(true, true);
  } else if (!cached) {
    resetUsageButton();
    fetchUsage(false, true);
  }
}

function usageSnapshotSignature(snapshot) {
  return JSON.stringify((snapshot.providers || []).map((provider) => {
    const { updatedAt, ...content } = provider;
    return content;
  }));
}

function usageText(tag, cls, text) {
  const node = el(tag, cls);
  node.textContent = text;
  return node;
}

function usagePercent(value) {
  const percent = Number(value);
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function usageResetText(resetsAt) {
  if (!resetsAt) return "Reset time unavailable";
  const remaining = resetsAt - Date.now();
  if (remaining <= 0) return `Reset due · ${new Date(resetsAt).toLocaleString()}`;
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && mins) parts.push(`${mins}m`);
  return `Resets in ${parts.join(" ")} · ${new Date(resetsAt).toLocaleString()}`;
}

function usageProvider(provider) {
  const section = el("section", `usage-provider usage-provider-${provider.status}`);
  section.dataset.provider = provider.id;

  const header = el("div", "usage-provider-head");
  const identity = el("div", "usage-provider-identity");
  const mark = usageText("span", "usage-provider-mark", provider.name.slice(0, 1));
  const names = el("div", "usage-provider-names");
  names.append(usageText("h3", null, provider.name));
  if (provider.plan) names.append(usageText("span", "usage-plan", provider.plan));
  identity.append(mark, names);
  const status = usageText(
    "span",
    `usage-status usage-status-${provider.status}`,
    provider.status === "available" ? "Live" : provider.status,
  );
  header.append(identity, status);
  section.append(header);

  if (provider.windows?.length) {
    const windows = el("div", "usage-windows");
    for (const window of provider.windows) {
      const item = el("div", "usage-window");
      const top = el("div", "usage-window-head");
      top.append(
        usageText("span", null, window.label),
        usageText("strong", null, `${usagePercent(window.usedPercent)} used`),
      );
      const track = el("div", "usage-track");
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-label", `${provider.name} ${window.label} usage`);
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(window.usedPercent));
      const bar = el("div", `usage-bar usage-bar-${window.severity}`);
      bar.style.width = `${Math.min(100, Math.max(0, Number(window.usedPercent)))}%`;
      track.append(bar);
      item.append(top, track, usageText("div", "usage-reset", usageResetText(window.resetsAt)));
      windows.append(item);
    }
    section.append(windows);
  }

  const metrics = [...(provider.metrics || [])];
  if (provider.credits) {
    metrics.push({
      label: "Credits",
      value: provider.credits.unlimited ? "Unlimited" : provider.credits.balance ?? "Unavailable",
    });
  }
  if (metrics.length) {
    const wrap = el("div", "usage-metrics");
    for (const metric of metrics) {
      const item = el("div", "usage-metric");
      item.append(usageText("span", null, metric.label), usageText("strong", null, metric.value));
      wrap.append(item);
    }
    section.append(wrap);
  }

  if (provider.message) section.append(usageText("div", "usage-provider-message", provider.message));
  return section;
}

function renderUsage(snapshot, scope = selectedUsageScope()) {
  if (!scope) return;
  USAGE_STATE.renderedKey = scope.key;
  const body = $("#usage-body");
  body.innerHTML = "";
  const providers = snapshot.providers || [];
  if (!providers.length) {
    body.append(usageText("div", "usage-empty", "No usage data is available for the selected provider."));
  } else {
    for (const provider of providers) body.append(usageProvider(provider));
  }

  $("#usage-updated").textContent = snapshot.updatedAt
    ? `Updated ${new Date(snapshot.updatedAt).toLocaleString()}`
    : "Not refreshed";
  $("#usage-scope").textContent = `${scope.project} · ${scope.engine} · ${scope.model || "default model"}`;

  const percentages = providers.flatMap((provider) =>
    (provider.windows || []).map((window) => Number(window.usedPercent)).filter(Number.isFinite),
  );
  const highest = percentages.length ? Math.max(...percentages) : null;
  const button = $("#usage-open");
  button.textContent = highest == null ? "Usage" : `Usage ${Math.round(highest)}%`;
  button.classList.toggle("usage-warning", highest != null && highest >= 80 && highest < 100);
  button.classList.toggle("usage-critical", highest != null && highest >= 100);
}

async function fetchUsage(force = false, quiet = false) {
  const scope = selectedUsageScope();
  if (!scope) return;
  const existingRequest = USAGE_STATE.inFlight.get(scope.key);
  if (existingRequest) return existingRequest;
  const cached = USAGE_STATE.cache.get(scope.key);
  const refresh = $("#usage-refresh");
  refresh.disabled = true;
  if (!quiet && !cached) {
    $("#usage-body").innerHTML = '<div class="usage-empty">Reading provider usage...</div>';
  }
  const request = (async () => {
    const params = new URLSearchParams({
      engine: scope.engine,
      model: scope.model || "",
    });
    if (force) params.set("refresh", "1");
    const url = `/api/projects/${encodeURIComponent(scope.project)}/ai/usage?${params}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("usage request failed");
    const snapshot = await response.json();
    const signature = usageSnapshotSignature(snapshot);
    const previous = USAGE_STATE.cache.get(scope.key);
    const changed = !previous || previous.signature !== signature;
    const stored = changed ? snapshot : previous.snapshot;
    USAGE_STATE.cache.set(scope.key, {
      snapshot: stored,
      signature,
      checkedAt: Date.now(),
    });
    const active = selectedUsageScope();
    if (active?.key === scope.key && (changed || USAGE_STATE.renderedKey !== scope.key)) {
      renderUsage(stored, active);
    }
  })()
    .catch(() => {
      if (selectedUsageScope()?.key !== scope.key) return;
      if (!USAGE_STATE.cache.has(scope.key)) {
        $("#usage-body").innerHTML = '<div class="usage-empty usage-empty-error">Usage could not be loaded.</div>';
      }
      if (!quiet) toast("Could not refresh subscription usage");
    })
    .finally(() => {
      USAGE_STATE.inFlight.delete(scope.key);
      refresh.disabled = USAGE_STATE.inFlight.has(selectedUsageScope()?.key);
    });
  USAGE_STATE.inFlight.set(scope.key, request);
  return request;
}

function openUsage() {
  const scope = selectedUsageScope();
  if (!scope) return toast("Open a project to view its selected model usage");
  usageSelectionChanged();
  openModal("#usage-modal");
  const cached = USAGE_STATE.cache.get(scope.key);
  if (cached) {
    renderUsage(cached.snapshot, scope);
    if (Date.now() - cached.checkedAt >= USAGE_REFRESH_MS) fetchUsage(true, true);
  } else {
    fetchUsage(false);
  }
}

async function createProject() {
  const name = $("#new-name").value.trim();
  if (!name) return toast("Give the project a name");
  const body = {
    name,
    description: $("#new-desc").value.trim(),
    gitInit: $("#new-git").checked,
    applyHouseRules: $("#new-rules").checked,
    practices: checkedPractices("#new-practices-list"),
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

async function brainstormNewProject() {
  const name = $("#new-name").value.trim();
  const description = $("#new-desc").value.trim();
  if (!name && !description) return toast("Add a name or description to brainstorm");

  const prompt = [
    "I want to brainstorm a new project before creating it in this workspace.",
    "",
    `Proposed name: ${name || "(not decided)"}`,
    `Idea: ${description || "(not written yet)"}`,
    "",
    "Use the psm workspace context before suggesting a scaffold.",
    "Check for existing projects that overlap with this idea, and tell me whether I should extend one of them or create a new folder.",
    "List reusable bits I can take from this workspace: libraries, APIs, MCP servers, docs, UI patterns, data stores, run/deploy commands, and attachable capabilities.",
    "Suggest the smallest initial scaffold and the psm capabilities that should be attached after creation.",
    "Do not create files yet.",
  ].join("\n");

  DRAFTS.__workspace__ = prompt;
  saveDrafts();
  closeModals();
  history.pushState(null, "", projectHash("__workspace__", "ai"));
  await openWorkspaceChat(true);
  loadDraft("__workspace__");
  $("#ws-msg").focus();
  toast("Brainstorm prompt ready");
}

/* ---------- practices (shared between new-project and rules modals) ---------- */

let PRACTICES = [];

async function loadPractices() {
  if (PRACTICES.length) return PRACTICES;
  try {
    const r = await fetch("/api/practices");
    const data = await r.json();
    PRACTICES = data.practices || [];
  } catch {
    PRACTICES = [];
  }
  return PRACTICES;
}

function renderPracticeList(containerSel, enabled) {
  const box = $(containerSel);
  const on = new Set(enabled || []);
  box.innerHTML = PRACTICES.map((p) => [
    '<label class="check practice">',
    '<input type="checkbox" value="' + esc(p.id) + '"' + (on.has(p.id) ? " checked" : "") + " />",
    "<span><strong>" + esc(p.title) + "</strong>" + (p.scaffolds ? ' <em class="tag">scaffolds files</em>' : "") + "<br />",
    '<span class="hint">' + esc(p.summary) + "</span></span>",
    "</label>",
  ].join("")).join("");
}

function checkedPractices(containerSel) {
  return [...document.querySelectorAll(containerSel + " input[type=checkbox]:checked")].map((c) => c.value);
}

/* ---------- house rules: workspace baseline + per-project overlay ---------- */

const RULES = { scope: "__global__", global: "", project: null };

async function openRules(projectName) {
  await loadPractices();
  RULES.global = await fetch("/api/house-rules").then((r) => r.json()).then((d) => d.content || "").catch(() => "");
  const select = $("#rules-scope");
  select.innerHTML =
    '<option value="__global__">Workspace baseline (all projects)</option>' +
    STATE.projects
      .filter((p) => !p.archived)
      .map((p) => '<option value="' + esc(p.name) + '">' + esc(p.name) + "</option>")
      .join("");
  select.value = projectName || "__global__";
  await selectRulesScope(select.value);
  openModal("#rules-modal");
}

async function selectRulesScope(scope) {
  RULES.scope = scope;
  if (scope === "__global__") {
    RULES.project = null;
    $("#rules-text").value = RULES.global;
    $("#rules-hint").textContent = "Applied to every project's AI system prompt. Markdown.";
    $("#rules-practices").hidden = true;
    return;
  }
  const data = await fetch("/api/projects/" + encodeURIComponent(scope) + "/rules")
    .then((r) => r.json())
    .catch(() => ({ rules: "", practices: [] }));
  RULES.project = { name: scope, practices: data.practices || [] };
  $("#rules-text").value = data.rules || "";
  $("#rules-hint").innerHTML =
    "Overlay for <strong>" + esc(scope) + "</strong>, layered under the workspace baseline. Stored in <code>.psm/rules.md</code>.";
  renderPracticeList("#rules-practices-list", data.practices);
  $("#rules-practices").hidden = false;
}

async function saveRules() {
  if (RULES.scope === "__global__") {
    const ok = await fetch("/api/house-rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: $("#rules-text").value }),
    }).then((r) => r.ok).catch(() => false);
    return ok ? (closeModals(), toast("Workspace rules saved")) : toast("Could not save rules");
  }
  const name = RULES.scope;
  try {
    await fetch("/api/projects/" + encodeURIComponent(name) + "/practices", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ practices: checkedPractices("#rules-practices-list") }),
    });
    await fetch("/api/projects/" + encodeURIComponent(name) + "/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: $("#rules-text").value }),
    });
    closeModals();
    toast("Rules for " + name + " saved");
  } catch {
    toast("Could not save project rules");
  }
}

/* ---------- skills used by the agents ---------- */

async function openSkills() {
  const select = $("#skills-scope");
  select.innerHTML =
    '<option value="">Whole workspace</option>' +
    STATE.projects
      .filter((p) => !p.archived)
      .map((p) => '<option value="' + esc(p.name) + '">' + esc(p.name) + "</option>")
      .join("");
  openModal("#skills-modal");
  await loadSkills();
}

async function loadSkills() {
  const project = $("#skills-scope").value;
  $("#skills-body").innerHTML = '<div class="cloud-empty">Loading…</div>';
  const data = await fetch("/api/skills-usage" + (project ? "?project=" + encodeURIComponent(project) : ""))
    .then((r) => r.json())
    .catch(() => ({ skills: [] }));
  const skills = data.skills || [];
  if (!skills.length) {
    $("#skills-body").innerHTML = '<div class="cloud-empty">No skill invocations recorded' + (project ? " for this project." : " yet.") + "</div>";
    return;
  }
  $("#skills-body").innerHTML = [
    '<table class="skills-table"><thead><tr><th>Skill</th><th>Uses</th><th>Last used</th><th>Projects</th></tr></thead><tbody>',
    ...skills.map((s) => [
      "<tr><td><code>" + esc(s.skill) + "</code></td>",
      "<td>" + Number(s.count) + "</td>",
      "<td>" + (s.lastUsed ? esc(new Date(s.lastUsed).toLocaleString()) : "—") + "</td>",
      "<td>" + (s.projects || []).map((p) => esc(p.split("/").pop())).join(", ") + "</td></tr>",
    ].join("")),
    "</tbody></table>",
  ].join("");
}

$("#new-open").onclick = async () => {
  $("#new-name").value = "";
  $("#new-desc").value = "";
  $("#new-git").checked = true;
  $("#new-rules").checked = true;
  await loadPractices();
  renderPracticeList("#new-practices-list", []);
  openModal("#new-modal");
  $("#new-name").focus();
};
$("#new-close").onclick = closeModals;
$("#new-cancel").onclick = closeModals;
$("#new-brainstorm").onclick = brainstormNewProject;
$("#new-create").onclick = createProject;
$("#new-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createProject();
  }
});
$("#rules-open").onclick = () => openRules();
$("#skills-open").onclick = openSkills;
$("#skills-close").onclick = closeModals;
$("#skills-refresh").onclick = () => loadSkills();
$("#skills-scope").onchange = () => loadSkills();
$("#ws-chat-open").onclick = () => openWorkspaceChat();
$("#usage-open").onclick = openUsage;
$("#usage-refresh").onclick = () => fetchUsage(true);
$("#usage-close").onclick = closeModals;
$("#rules-close").onclick = closeModals;
$("#rules-cancel").onclick = closeModals;
$("#rules-scope").onchange = (e) => selectRulesScope(e.target.value);
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
  if (!$("#question-modal").hidden) closeQuestion(true);
  else if (!$("#modal-backdrop").hidden) closeModals();
  else closeDrawer();
});

load().then(() => {
  pollProcs();
  routeFromHash();
});
window.addEventListener("hashchange", routeFromHash);
setInterval(() => {
  pollProcs();
  if ($("#workspace").hidden) fetchSessions(); // keep the lane fresh while on the board
  else if (WS.pane === "session") fetchSessionState();
  else if (WS.pane === "plan" && PLAN.saved?.status === "reviewing") loadPlan(true);
}, 3000);
setInterval(() => fetchUsage(true, true), USAGE_REFRESH_MS);
setInterval(() => fetchRuntimeServices(), 15_000);
