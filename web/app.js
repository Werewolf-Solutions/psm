const CAT_ORDER = [
  "Flagship & platform",
  "AI & automation",
  "Client & business websites",
  "Blockchain & DeFi",
  "Apps, libraries & other",
];

let STATE = {
  projects: [], meta: {}, version: "", filter: "all", query: "", procs: {}, sessions: [], sessionsSig: "",
  runtimeServices: {}, runtimeServicesSig: "",
  mode: "dev", can: { runsCommands: true, scansImplicitly: true, canLink: true },
};

/**
 * Every call about the machine goes through the agent.
 *
 * Served by psm itself these are `fetch` and `new EventSource` with the path
 * untouched — same-origin, exactly as the cockpit always worked. Served from
 * psm.werewolf.solutions they are re-pointed at the paired agent on loopback
 * and carry its token. Routing them one by one is what makes a hosted board
 * show *this* machine's projects rather than the hosted server's empty ones.
 *
 * Two things deliberately stay same-origin and so keep calling `fetch`:
 * `/api/auth/*`, which is the session of whichever origin served the page (and
 * is also how `detectHost` tells the two apart), and `/api/cloud/*` in
 * cloud.js, which is a passthrough to PSM Cloud rather than to a machine.
 */
const agentApi = (path, init) => PsmAgent.api(path, init);
const agentStream = (path) => PsmAgent.agentStream(path);

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
const MODEL_CATALOGS = new Map();
const modelCatalogKey = (project, engine) => JSON.stringify([project, engine]);
const MODEL_FETCH_TOKENS = new WeakMap();

function modelEntry(catalog, model) {
  const value = String(model || "").trim();
  return catalog?.models?.find((entry) => entry.id === value || entry.resolvedModel === value) || null;
}

function showModelCatalog(catalog, list, selected = "") {
  list.innerHTML = '<option value="">Provider default</option>';
  for (const model of catalog?.models || []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label && model.label !== model.id
      ? `${model.label}${model.resolvedModel ? ` · ${model.resolvedModel}` : ""}`
      : model.id;
    option.title = model.description || "";
    list.append(option);
  }
  if (selected && !catalog?.models?.some((model) => model.id === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = `${selected} (saved; availability unverified)`;
    list.append(option);
  }
  list.value = selected;
}

function renderEffortOptions(select, engine, model, selected = "", project = select.dataset.project) {
  select.dataset.project = project || "";
  const catalog = MODEL_CATALOGS.get(modelCatalogKey(project, engine));
  const modelSelect = document.getElementById(select.id.replace("-effort", "-model"));
  showModelCatalog(catalog, modelSelect, model);
  const entry = modelEntry(catalog, model);
  const levels = entry?.effortLevels || [];
  const value = String(selected || "").trim();
  select.innerHTML = "";
  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = entry?.defaultEffort
    ? `Default (${entry.defaultEffort})`
    : "Default effort";
  select.append(automatic);
  for (const level of levels) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    select.append(option);
  }
  if (value && !levels.includes(value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${value} (saved; availability unverified)`;
    select.append(option);
  }
  select.value = value;
  select.title = catalog?.source === "fallback" && catalog.message
    ? `Live model discovery failed: ${catalog.message}`
    : "Reasoning effort for the selected model";
  let status = document.getElementById(`${select.id}-status`);
  if (!status) {
    status = document.createElement("span");
    status.id = `${select.id}-status`;
    status.className = "model-catalog-status";
    status.setAttribute("role", "status");
    select.after(status);
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "btn";
    refresh.textContent = "Refresh models";
    refresh.onclick = () => modelSelect.dispatchEvent(new Event("focus"));
    status.after(refresh);
  }
  status.textContent = !catalog ? "Checking models…"
    : catalog.source !== "live" ? "Models unavailable — refresh to retry"
    : `Models checked ${new Date(catalog.updatedAt).toLocaleTimeString()}`;
  status.title = catalog?.message || "Current choices from the installed provider";
}

// `effortSelect` may be one select or several: the AI tab and the Web tab's dev
// bar show the same choice, and they must not each pay for their own discovery.
//
// `selection` is a getter, not a value: discovery can take seconds, and by the
// time it lands the user may have picked a different model or effort. Rendering
// the arguments captured at call time would silently undo that choice, so the
// current selection is read at render time instead.
async function refreshModelCatalog(project, engine, selection, effortSelect, base = `/api/projects/${encodeURIComponent(project)}`) {
  if (!engine || !project) return;
  const selects = [].concat(effortSelect).filter(Boolean);
  if (!selects.length) return;
  const token = {};
  for (const select of selects) {
    MODEL_FETCH_TOKENS.set(select, token);
    select.dataset.project = project;
    select.dataset.loading = "true";
    select.title = `Looking up ${engine} models…`;
    const status = document.getElementById(`${select.id}-status`);
    if (status) status.textContent = "Checking models…";
  }
  const mine = (select) => MODEL_FETCH_TOKENS.get(select) === token;
  try {
    const response = await agentApi(
      `${base}/ai/models?engine=${encodeURIComponent(engine)}`,
      { cache: "no-store" },
    );
    const catalog = await response.json();
    if (!response.ok) throw new Error(catalog.error || "Model discovery failed");
    if (!selects.some(mine)) return;
    MODEL_CATALOGS.set(modelCatalogKey(project, engine), catalog);
    const { model, effort } = selection();
    for (const select of selects) if (mine(select)) renderEffortOptions(select, engine, model, effort);
  } catch (error) {
    if (!selects.some(mine)) return;
    MODEL_CATALOGS.delete(modelCatalogKey(project, engine));
    const { model, effort } = selection();
    for (const select of selects) if (mine(select)) {
      renderEffortOptions(select, engine, model, effort);
      const status = document.getElementById(`${select.id}-status`);
      status.textContent = "Models unavailable — refresh to retry";
      status.title = error.message || "Model discovery failed";
    }
  } finally {
    for (const select of selects) if (mine(select)) delete select.dataset.loading;
  }
}

async function load() {
  const r = await agentApi("/api/projects");
  if (!r.ok) throw new Error(`projects unavailable (${r.status})`);
  const data = await r.json();
  STATE.projects = data.projects;
  STATE.meta = data.statusMeta;
  STATE.version = data.version || "";
  STATE.mode = data.mode || "dev";
  // what this psm can do at all — a hosted one has no disk, an agent scans only
  // what has been linked, so the board's empty state differs by posture
  STATE.can = data.capabilities || { runsCommands: true, scansImplicitly: true, canLink: true };
  await Promise.all([fetchSessions(false), fetchRuntimeServices(), window.PsmWorkspaces?.refresh()]);
  render();
}

async function fetchRuntimeServices(force = false) {
  try {
    const response = await agentApi("/api/runtime/services" + (force ? "?refresh=1" : ""));
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
let sessionsFetchSequence = 0;
async function fetchSessions(rerender = true) {
  const sequence = ++sessionsFetchSequence;
  const questionRevision = pendingQuestionRevision;
  try {
    const r = await agentApi("/api/sessions");
    if (!r.ok) throw new Error("Could not load sessions");
    const data = await r.json();
    if (sequence !== sessionsFetchSequence) return;
    const sessions = data.sessions || [];
    const sig = JSON.stringify(
      sessions.map((s) => ({
        name: s.name,
        kind: s.kind || "project",
        id: s.id || "",
        projects: s.projects || [],
        ready: s.ready !== false,
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
        effort: s.effort || "",
      })),
    );
    STATE.sessions = sessions;
    // A question arriving over SSE after this request started is newer than
    // the poll. Never erase it (or reopen an answered one) with an old snapshot.
    if (questionRevision === pendingQuestionRevision) syncPendingQuestions(sessions, data.questions);
    $("#questions-error").hidden = true;
    if (rerender && sig !== STATE.sessionsSig) renderBoard();
    STATE.sessionsSig = sig;
    renderQuickSwitch();
  } catch {
    if (sequence !== sessionsFetchSequence) return;
    $("#questions-error").textContent = "Could not refresh questions. Showing the last known list; it will retry automatically.";
    $("#questions-error").hidden = false;
  }
}

/**
 * Project pages are addressed by the project's stable id, so a bookmarked URL survives a
 * folder rename. Projects that have not been given an id yet fall back to their name, and
 * get canonicalised to the id URL the first time they are opened.
 */
function routeKey(project) {
  return project?.id || project?.name || "";
}

const PANE_MEMORY_KEY = "psm.selected-panes.v1";
const PROJECT_PANES = ["plan", "notes", "capabilities", "logs", "web", "ai", "session", "changes", "deploy"];
const SELECTED_PANES = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(PANE_MEMORY_KEY) || "{}");
    return new Map(Object.entries(saved).filter(([key, pane]) => /^(project|work):/.test(key) && PROJECT_PANES.includes(pane)).slice(-100));
  } catch { return new Map(); }
})();

function selectedPane(kind, key, requested = null) {
  const allowed = kind === "work" ? ["ai", "session", "changes"]
    : key === "__workspace__" ? ["ai", "session"] : PROJECT_PANES;
  const chosen = requested ?? SELECTED_PANES.get(`${kind}:${key}`);
  return allowed.includes(chosen) ? chosen : allowed[0];
}

function rememberPane(kind, key, pane) {
  if (!key) return;
  const id = `${kind}:${key}`;
  SELECTED_PANES.delete(id);
  SELECTED_PANES.set(id, selectedPane(kind, key, pane));
  while (SELECTED_PANES.size > 100) SELECTED_PANES.delete(SELECTED_PANES.keys().next().value);
  try { localStorage.setItem(PANE_MEMORY_KEY, JSON.stringify(Object.fromEntries(SELECTED_PANES))); } catch { /* memory still works when storage is unavailable */ }
}

function projectHash(key, pane = null) {
  pane = selectedPane("project", key, pane);
  return `#/p/${encodeURIComponent(key)}/${encodeURIComponent(pane)}`;
}

/** Rooms have their own space, so a room id can never be read as a project id. */
function workroomHash(id, pane = null) {
  pane = selectedPane("work", id, pane);
  return `#/w/${encodeURIComponent(id)}/${encodeURIComponent(pane)}`;
}

function projectByRouteKey(key) {
  return (
    STATE.projects.find((project) => project.id === key) ||
    STATE.projects.find((project) => project.name === key) ||
    null
  );
}

function projectByName(name) {
  return STATE.projects.find((project) => project.name === name) || null;
}

/** Mint this project's id server-side; throws so callers can decide how loud to be. */
async function assignProjectId(project) {
  const previousKey = routeKey(project);
  const response = await agentApi(`/api/projects/${encodeURIComponent(project.name)}/id`, { method: "POST" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "could not assign an id");
  project.id = data.id;
  if (previousKey !== data.id) rememberPane("project", data.id, selectedPane("project", previousKey));
  const known = projectByName(project.name);
  if (known) known.id = data.id;
  return data.id;
}

function renderQuickSwitch() {
  const nav = $("#quick-switch");
  if (!nav) return;
  nav.innerHTML = "";
  const names = [...new Set(STATE.sessions.filter((s) => s.kind !== "work").map((session) => session.name))]
    .filter((name) => STATE.projects.some((project) => project.name === name));
  const rooms = STATE.sessions.filter((session) => session.kind === "work");
  const show = names.length > 0 || rooms.length > 0 || !!WS?.name;
  nav.classList.toggle("has-items", show);
  if (!show) return;
  const home = el("button", "quick-pill", "Home");
  home.classList.toggle("on", !WS?.name);
  home.onclick = () => { location.hash = "#/"; };
  nav.append(home);
  for (const name of names) {
    const button = el("button", "quick-pill", esc(name));
    button.classList.toggle("on", WS?.name === name);
    button.onclick = () => {
      location.hash = projectHash(routeKey(projectByName(name)));
    };
    nav.append(button);
  }
  for (const room of rooms) {
    const button = el("button", "quick-pill quick-room", esc(room.name));
    button.classList.toggle("on", WS?.kind === "work" && WS?.id === room.id);
    button.title = `Workroom · ${(room.projects || []).join(", ")}`;
    button.onclick = () => openWorkroom(room.id);
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
    // Only the selected workspace's projects (unassigned ones are personal).
    if (window.PsmWorkspaces?.hides(p.name)) return false;
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

async function copyText(text) {
  try {
    // writeText can hang (not reject) when the document lacks focus — never wedge on it
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 1200)),
    ]);
    return true;
  } catch {
    // clipboard API also needs a secure context; fall back to a throwaway selection
    try {
      const ta = el("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** The project's stable id — copyable, or an offer to mint one when it has none yet. */
function cardId(p) {
  const row = el("div", "card-id");

  if (!p.id) {
    const assign = el("button", "id-assign", "assign id");
    assign.type = "button";
    assign.title = "Write a stable id to .psm/identity.json so this project keeps its identity across renames and clones";
    assign.onclick = async (e) => {
      e.stopPropagation();
      assign.disabled = true;
      try {
        toast(`Assigned ${await assignProjectId(p)}`);
        render();
      } catch (err) {
        assign.disabled = false;
        toast(err.message);
      }
    };
    row.append(assign);
    return row;
  }

  const chip = el("button", "id-chip");
  chip.type = "button";
  chip.title = `Copy ${p.id}`;
  chip.append(el("span", "id-icon", "⧉"), el("code", "id-text", esc(p.id)));
  chip.onclick = async (e) => {
    e.stopPropagation();
    if (await copyText(p.id)) {
      chip.classList.add("copied");
      setTimeout(() => chip.classList.remove("copied"), 900);
      toast("Project id copied");
    } else {
      toast("Could not copy the id");
    }
  };
  row.append(chip);
  return row;
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

  c.append(top, cardId(p), desc, meta);

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
    r = await agentApi(`/api/projects/${encodeURIComponent(name)}/working/stop`, { method: "POST" });
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
  const room = sess.kind === "work";
  const c = el(
    "div",
    "sess-card" + (room ? " sess-room" : "") + (sess.busy ? " busy" : "") + (sess.waiting ? " waiting" : ""),
  );
  const top = el("div", "sess-top");
  const name = el("div", "sess-name");
  name.append(el("span", "sess-dot"), document.createTextNode(sess.name));
  // A room is not a project, and the lane holds both. Say which this is, or the
  // two are told apart only by a title someone chose.
  if (room) name.append(el("span", "sess-kind", "workroom"));

  const actions = el("div", "sess-actions");
  actions.append(el("span", "sess-when", sessionWhen(sess)));
  if (sess.question) {
    const answer = el("button", "sess-answer", "Answer");
    answer.onclick = (e) => {
      e.stopPropagation();
      openQuestion(sessionConversationKey(sess), sess.question, true, "ai", null, sess.name);
    };
    actions.append(answer);
  }
  if (room) {
    // Archiving is the only way out of the lane for a room — there is no manual
    // mark to clear and no dev server of its own to stop.
    const archive = el("button", "sess-stop", "Archive");
    archive.title = "Close this workroom and take it off the board";
    archive.onclick = async (e) => {
      e.stopPropagation();
      archive.disabled = true;
      await agentApi(`/api/work-sessions/${encodeURIComponent(sess.id)}/archive`, { method: "POST" });
      await fetchSessions();
      renderBoard();
    };
    actions.append(archive);
  } else {
    const stop = el("button", "sess-stop", "Stop working");
    stop.title = "Stop AI and project processes, close the AI session, and clear the manual mark";
    stop.onclick = async (e) => {
      e.stopPropagation();
      stop.disabled = true;
      if (!(await stopWorking(sess.name))) stop.disabled = false;
    };
    actions.append(stop);
  }
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
  if (sess.effort) meta.append(el("span", "pill", esc(`${sess.effort} effort`)));
  if (sess.messages) meta.append(el("span", null, `${sess.messages} message${sess.messages === 1 ? "" : "s"}`));
  if (sess.queueDepth) meta.append(el("span", null, `${sess.queueDepth} queued`));

  if (room) {
    const members = el("div", "sess-members");
    for (const project of sess.projects || []) {
      const chip = el("span", "sess-member", project);
      if (!projectByName(project)) chip.classList.add("missing");
      members.append(chip);
    }
    c.append(top, members, snippet, reasonRow, meta);
    c.title = sess.ready
      ? "Open this workroom"
      : "A project in this workroom is missing — it cannot run until it is back";
    if (!sess.ready) c.classList.add("orphan");
    c.onclick = () => openWorkroom(sess.id);
    return c;
  }

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
    grid.append(
      sessionCard(sess, sess.kind === "work" ? null : STATE.projects.find((p) => p.name === sess.name)),
    );
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

  if (!vis.length) {
    // Nothing at all is different from "nothing matches the filter": a psm that
    // scans only what you link starts here, and needs to say what to do next.
    if (!STATE.projects.length) board.append(emptyStateCard());
    else board.append(el("div", "group-title", "No projects match."));
  }
}

function emptyStateCard() {
  const box = el("div", "board-empty");
  const linkable = STATE.can.canLink;
  box.append(el("h2", null, linkable ? "psm isn’t looking at anything yet" : "No projects on this account yet"));
  box.append(
    el(
      "p",
      null,
      linkable
        ? "Link a directory of projects to map a whole workspace at once, or link a single project folder on its own."
        : "This psm is hosted, so it has no filesystem of its own. Run the psm agent on your machine and pair it to map local projects.",
    ),
  );
  if (linkable) {
    const cta = el("button", "btn btn-primary", "🔗 Link a folder");
    cta.onclick = openLinks;
    box.append(cta);
  } else if (typeof PsmAgent !== "undefined" && !PsmAgent.servedByAgent()) {
    const cta = el("button", "btn btn-primary", "Connect to your machine");
    cta.onclick = openConnect;
    box.append(cta);
  }
  return box;
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
  $("#foot-version").textContent = STATE.version ? `v${STATE.version}` : "";
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
  const drawerEngine = $("#d-engine").value || p.aiEngine || "claude";
  const drawerEffort = p.overridden.includes("aiEffort") ? p.aiEffort || "" : "";
  renderEffortOptions($("#d-effort"), drawerEngine, p.aiModel || "", drawerEffort, p.name);
  refreshModelCatalog(p.name, drawerEngine, () => ({
    model: $("#d-model").value || p.aiModel || "",
    effort: $("#d-effort").value,
  }), $("#d-effort"));

  $("#d-full").checked = false;
  $("#d-full").disabled = true;
  $("#d-full").closest("label").title = "Project agent access is controlled in Capabilities → Agent permissions.";
  renderScopePicker(p);
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

/**
 * Which other projects this project's AI may edit.
 *
 * Checkboxes over a text field on purpose: the server takes project names and
 * looks the paths up itself before every turn, so there is nothing useful a
 * free-typed path could say. Archived projects are left out — pointing an agent
 * at something nobody is maintaining is not a thing to make easy.
 */
function renderScopePicker(p) {
  const list = $("#d-scope-list");
  const chosen = new Set(p.aiExtraProjects || []);
  const options = STATE.projects
    .filter((other) => other.name !== p.name && (!other.archived || chosen.has(other.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = options
    .map(
      (other) =>
        `<label class="scope-item"><input type="checkbox" value="${esc(other.name)}"${
          chosen.has(other.name) ? " checked" : ""
        } /> ${esc(other.name)}</label>`,
    )
    .join("") || '<span class="hint">No other projects to choose from.</span>';
  list.onchange = () => renderScopeSummary(p.name);
  renderScopeSummary(p.name);
}

function chosenScope() {
  return [...$("#d-scope-list").querySelectorAll("input:checked")].map((box) => box.value);
}

/** Say the scope back, in the same words the AI is given. */
function renderScopeSummary(name) {
  const chosen = chosenScope();
  $("#d-scope-summary").textContent = chosen.length
    ? `This AI may edit ${[name, ...chosen].join(" and ")}. No other project is writable.`
    : `This AI may edit ${name} only.`;
}

/** The same promise, kept in view beside the composer. */
function renderScopeChip() {
  // The server-resolved directories a turn is spawned with, not the saved names:
  // a project that moved or disappeared is not in the scope, so it is not shown.
  const dirs = WS.scopeDirs || [];
  const names = dirs.map((dir) => STATE.projects.find((project) => project.path === dir)?.name || dir.split("/").pop());
  for (const node of aiControlNodes("scope")) {
    node.hidden = !dirs.length;
    node.textContent = `+${dirs.length} repo${dirs.length === 1 ? "" : "s"}`;
    node.title = dirs.length
      ? `This AI may also edit ${names.join(", ")} (${dirs.join(", ")}). No other project is writable.`
      : "";
  }
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
    aiEffort: $("#d-effort").value,
    aiFullAccess: $("#d-full").checked,
    aiExtraProjects: chosenScope(),
    deployStaging: $("#d-deploy-staging").value.trim(),
    deployProduction: $("#d-deploy-production").value.trim(),
  };
  // don't send pinned:false as a stored override unless it was set; keep simple: always send
  const name = editing.name;
  const r = await agentApi(`/api/projects/${encodeURIComponent(name)}`, {
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
      // The scope chip is a promise about the open conversation, so it has to
      // follow the save rather than wait for the cockpit to be reopened.
      WS.extraProjects = projectByName(name)?.aiExtraProjects || [];
      WS.scopeDirs = projectByName(name)?.aiScopeDirs || [];
      renderScopeChip();
    }
    toast("Saved");
  } else {
    toast("Save failed");
  }
}

/* ---------- workspace / cockpit ---------- */

/* The log console renders a window over a buffer — see renderConsole below. */
const LOG_WINDOW = 100; // lines rendered at once
const LOG_BUFFER = 20000; // lines held in memory, well past the server's own cap

function emptyManagedDeploymentState() {
  return {
    loading: false,
    data: null,
    artifacts: [],
    artifactId: null,
    environment: null,
    plan: null,
    planEnvironment: null,
    readiness: null,
    readinessEnvironment: null,
    preparationRunId: null,
    readinessTimer: null,
    error: null,
    run: null,
    poll: null,
    preparation: null,
    preparationPlan: null,
    preparationPoll: null,
    preparationSignature: "",
    preparationObserved: false,
    preparationEngine: null,
    preparationModel: null,
    preparationEffort: null,
  };
}

let WS = {
  name: null, kind: "project", id: null, es: null, port: null, pane: "logs", chatOnly: false, workingOn: false,
  engine: "claude", model: "", effort: "", actualModel: null, fullAccess: false, extraProjects: [], aiEs: null, aiBusy: false, pending: [], aiLimited: false, sessionState: null, question: null,
  deploy: { staging: null, production: null }, depTarget: "staging", depEs: null, depArmed: false,
  managedDeploy: emptyManagedDeploymentState(),
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

// This project's notes: bugs and todos, features, ideas. Local to the machine,
// so unlike the board this pane replaced there is no signed-out state to handle.
let NOTES = {
  project: null,
  notes: [],
  loading: false,
  saving: false,
  filter: "all",
  kind: "bug",
  editing: null,
  error: null,
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
    const r = await agentApi(`/api/projects/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

for (const node of [$("#ws-scope"), $("#web-scope")].filter(Boolean)) {
  node.onclick = () => {
    const project = projectByName(WS.name);
    if (project) openDrawer(project);
  };
}

function setWsStatus(status) {
  const badge = $("#ws-status");
  badge.textContent = status;
  badge.dataset.state = status;
  const running = status === "running";
  $("#ws-run").disabled = running;
  $("#ws-stop").disabled = !running;
}

/* ---- the log console ----------------------------------------------------
 * A dev server can emit thousands of lines a minute, and every one of them used
 * to become a DOM node. The console now renders a *window* — the last hundred
 * lines — over a buffer that keeps the rest, and scrolling up widens the window
 * a hundred at a time. Anything older than the buffer is still on disk: the
 * Download button asks the agent for the whole transcript since the run started.
 */

/* Run and deploy each have a console, so the buffer belongs to the element
 * rather than to WS — otherwise a deploy's output would widen the run window. */
const LOG_VIEWS = new WeakMap();

function logView(con) {
  let view = LOG_VIEWS.get(con);
  if (!view) {
    view = { lines: [], window: LOG_WINDOW };
    LOG_VIEWS.set(con, view);
  }
  return view;
}

function logNode(entry) {
  const line = el("div", "logline s-" + entry.stream);
  const body = el("span", "logline-text");
  body.textContent = entry.line;
  line.append(eventTimeNode(entry.t), body);
  return line;
}

/** The "there is more above" header, and the control that reveals it. */
function renderLogWindowBanner(con) {
  const view = logView(con);
  const hidden = Math.max(0, view.lines.length - view.window);
  let banner = con.querySelector(".log-earlier");
  if (!hidden) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = el("div", "log-earlier");
    const more = el("button", "btn btn-small", `▲ Show ${LOG_WINDOW} earlier`);
    more.onclick = () => {
      view.window += LOG_WINDOW;
      renderConsole(con, { keepScroll: true });
    };
    banner.append(el("span", "log-earlier-count"), more);
  }
  banner.querySelector(".log-earlier-count").textContent =
    `${hidden.toLocaleString()} earlier ${hidden === 1 ? "line" : "lines"} not shown · Download for the full log`;
  if (con.firstElementChild !== banner) con.prepend(banner);
}

/** Rebuild a console from its buffer. */
function renderConsole(con = $("#ws-console"), { keepScroll = false } = {}) {
  if (!con) return;
  const view = logView(con);
  // Widening the window pushes content down; holding the distance from the
  // bottom keeps the line you were reading where you left it.
  const fromBottom = con.scrollHeight - con.scrollTop;
  con.innerHTML = "";
  for (const entry of view.lines.slice(-view.window)) con.append(logNode(entry));
  renderLogWindowBanner(con);
  con.scrollTop = keepScroll ? con.scrollHeight - fromBottom : con.scrollHeight;
}

function clearConsole(con = $("#ws-console")) {
  if (!con) return;
  LOG_VIEWS.set(con, { lines: [], window: LOG_WINDOW });
  con.innerHTML = "";
}

function appendLine(entry, con = $("#ws-console")) {
  const view = logView(con);
  view.lines.push(entry);
  // The buffer is a ring too; the transcript on disk is what "everything" means.
  if (view.lines.length > LOG_BUFFER) view.lines.splice(0, view.lines.length - LOG_BUFFER);
  const nearBottom = con.scrollHeight - con.scrollTop - con.clientHeight < 60;
  con.append(logNode(entry));
  // Retire the oldest rendered line rather than re-rendering the whole window:
  // this runs once per line on a busy stream.
  while (con.querySelectorAll(".logline").length > view.window) {
    con.querySelector(".logline").remove();
  }
  renderLogWindowBanner(con);
  if (nearBottom) con.scrollTop = con.scrollHeight;
}

/**
 * The whole log since the run started — more than the console holds, and more
 * than the server keeps in memory. Fetched through the agent rather than linked
 * directly, because a paired hosted page authenticates with a bearer token that
 * a plain <a download> could not carry.
 */
async function downloadLog(kind = "run") {
  if (!WS.name) return;
  try {
    const response = await agentApi(
      `/api/projects/${encodeURIComponent(WS.name)}/logs/download?kind=${encodeURIComponent(kind)}`,
    );
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return toast(error.error || "No log to download yet");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = el("a");
    link.href = url;
    link.download = (response.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1]
      || `${WS.name}-${kind.replace(":", "-")}.log`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    toast(error.message || "Could not download the log");
  }
}

function openWorkspace(p, pane = null, opts = {}) {
  pane = selectedPane(opts.kind || "project", opts.id || routeKey(p), pane);
  if (!opts.fromRoute) {
    location.hash = projectHash(routeKey(p), pane);
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
  if (NOTES.project !== p.name) {
    // The kind you were last writing carries over; the filter and any half-open
    // editor belong to the project you just left.
    NOTES = {
      project: p.name, notes: [], loading: false, saving: false,
      filter: "all", kind: NOTES.kind, editing: null, error: null,
    };
  }
  WS.chatOnly = chat;
  WS.kind = opts.kind || "project";
  WS.id = opts.id || null;
  WS.name = p.name;
  WS.workingOn = !!p.workingOn;
  WS.port = p.port ?? null;
  WS.engine = p.aiEngine || "claude";
  WS.model = p.aiModel || "";
  WS.effort = p.aiEffort || "";
  WS.actualModel = null;
  WS.fullAccess = !!p.aiFullAccess;
  WS.extraProjects = p.aiExtraProjects || [];
  WS.scopeDirs = p.aiScopeDirs || [];
  WS.deploy = { staging: p.deployStaging || null, production: p.deployProduction || null };
  WS.depTarget = "staging";
  WS.depArmed = false;
  clearDeploymentPoll();
  clearPreparationPoll();
  WS.managedDeploy = emptyManagedDeploymentState();
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
  window.PsmWorkspaces?.showProject(opts.room ? null : p.name);
  renderMembers(opts.room || null);
  renderRoomDependencies(opts.room || null);
  renderWorkingButton();
  // hide the run/web/deploy cockpit when this is the workspace-wide chat
  $("#ws-runbar").hidden = chat;
  $("#ws-status").hidden = chat;
  const roomPanes = new Set(["ai", "session", "changes"]);
  for (const t of document.querySelectorAll(".ws-tab"))
    t.hidden = chat && !roomPanes.has(t.dataset.pane);
  // The workspace-wide chat has no repositories of its own to show.
  $("#ws-tabs").querySelector('[data-pane="changes"]').hidden = chat && opts.kind !== "work";
  // A workroom has no working button of its own: it is not a project, and
  // "working on" is a mark psm keeps per project.
  $("#ws-working").hidden = WS.kind === "work";
  $("#ws-cmd").value = p.runCommand || "";
  clearConsole();
  clearConsole($("#ws-depconsole"));
  $("#ws-webframe").innerHTML = "";
  $("#ws-transcript").innerHTML = "";
  renderSessionPane(null);
  loadDraft(p.name); // restore this chat's own unsent text (empty if none)
  syncAiControls();
  refreshAiModels();
  loadDevNotes(p.name); // this project's un-applied preview notes come back with it
  setWsStatus("idle");
  setAiBusy(false);
  switchPane(pane);
  $("#home-page").hidden = true;
  $("#ws-backdrop").hidden = true;
  $("#workspace").hidden = false;
  // the cockpit owns the viewport while it is open — no page scroll behind it
  document.body.classList.add("ws-open");
  renderQuickSwitch();
  if (!chat) loadPlan();
  if (!chat) connectLogs(p.name);
}

/* ---------- workrooms: several projects, one conversation ---------- */

let WORKROOMS = [];

/**
 * The member projects, named across the top of the room.
 *
 * This is the answer to "which projects am I working on here", and it is also
 * the scope: every name shown is a repository the AI may edit, and nothing else
 * is. A member psm can no longer find is shown struck through — the room will
 * refuse to send rather than quietly work on the half of it that is left.
 */
function renderMembers(room) {
  const strip = $("#ws-members");
  WS.room = room;
  if (!room) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }
  strip.hidden = false;
  strip.innerHTML = "";
  strip.append(el("span", "ws-members-label", "Working on"));
  for (const member of room.members) {
    const chip = el("span", `ws-member${member.present ? "" : " missing"}`);
    const open = el("button", "ws-member-name", member.name);
    open.title = member.present
      ? `${member.path}${member.gitBranch ? ` · ${member.gitBranch}` : ""} — open this project`
      : "psm can no longer find this project — the workroom cannot run until it is back";
    open.onclick = () => {
      const project = projectByName(member.name);
      if (project) window.open(projectHash(routeKey(project), "plan"), "_blank");
    };
    chip.append(open);
    if (member.name === room.primaryProject) chip.append(el("span", "ws-member-primary", "start"));
    // Two is the floor: one project is a project, not a room.
    if (room.projects.length > 2) {
      const drop = el("button", "ws-member-drop", "×");
      drop.title = `Take ${member.name} out of this workroom`;
      drop.onclick = () => setRoomProjects(room.projects.filter((name) => name !== member.name));
      chip.append(drop);
    }
    strip.append(chip);
  }

  // Adding a project is a change of scope, so it belongs here beside the names
  // it changes rather than behind the dialog that created the room.
  const candidates = STATE.projects
    .filter((p) => !p.archived && !room.projects.includes(p.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length) {
    const add = el("select", "ws-member-add");
    add.title = "Add another project to this workroom";
    add.append(new Option("+ Add project", ""));
    for (const project of candidates) add.append(new Option(project.name, project.name));
    add.onchange = () => {
      const chosen = add.value;
      add.value = "";
      if (chosen) setRoomProjects([...room.projects, chosen]);
    };
    strip.append(add);
  }

  const note = el("span", "ws-members-note");
  note.textContent = room.ready
    ? "Only these projects are writable."
    : "A project is missing — sending is blocked.";
  strip.append(note);
}

/**
 * The managed dependency edges in this room that are not passing.
 *
 * A cross-project break is the reason a room exists: one repository is waiting on
 * something another one owns, and both are in this conversation. Each row links to
 * the owning project's Deploy pane, because that is where the edge is fixed — the
 * room reports it, the deployment engine is what enforces it.
 *
 * These are recorded observations, from whatever each project last planned. Opening
 * a room never probes anybody's endpoints, so a row can legitimately say "not
 * observed yet"; that is a different statement from "failing" and is marked as such.
 */
async function renderRoomDependencies(room) {
  const strip = $("#ws-room-deps");
  if (!room) {
    strip.hidden = true;
    strip.textContent = "";
    return;
  }
  const roomId = room.id;
  let edges = [];
  try {
    const response = await agentApi(`/api/work-sessions/${encodeURIComponent(roomId)}/deployments`);
    if (!response.ok) throw new Error("unavailable");
    ({ edges = [] } = await response.json());
  } catch {
    // Nothing to say: a room whose dependency state cannot be read is not a room
    // with a broken dependency, and a scary empty banner would imply otherwise.
    edges = [];
  }
  // The room may have moved on while that was in flight.
  if (WS.kind !== "work" || WS.id !== roomId) return;
  strip.textContent = "";
  if (!edges.length) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  const label = el("span", "ws-room-deps-label");
  label.textContent = edges.length === 1 ? "1 dependency not passing" : `${edges.length} dependencies not passing`;
  strip.append(label);

  for (const edge of edges) {
    const row = el("div", "ws-room-dep");
    const state = el("span", `ws-room-dep-state${edge.state === "unknown" ? " unknown" : ""}`);
    state.textContent = edge.state === "unknown" ? "not observed" : edge.state;
    row.append(state);

    const dependent = el("span");
    dependent.textContent = `${edge.dependentProjectName} · ${edge.dependentEnvironmentId}`;
    row.append(dependent);

    const arrow = el("span", "ws-room-dep-arrow");
    arrow.textContent = "needs";
    row.append(arrow);

    // The owning project, which is where this gets fixed.
    const owner = edge.ownerProjectName ? projectByName(edge.ownerProjectName) : null;
    const link = el("button", "ws-room-dep-link");
    link.textContent = edge.ownerProjectName
      ? `${edge.ownerProjectName}${edge.ownerEnvironmentId ? ` · ${edge.ownerEnvironmentId}` : ""}`
      : edge.ownerProjectId;
    if (owner) {
      link.title = edge.ownerInRoom
        ? "Open this project's Deploy pane — it is also in this room"
        : "Open this project's Deploy pane";
      link.onclick = () => window.open(projectHash(routeKey(owner), "deploy"), "_blank");
    } else {
      link.disabled = true;
      link.title = "psm can no longer find the project that owns this dependency";
    }
    row.append(link);

    const id = el("span", "ws-room-dep-id");
    id.textContent = edge.dependencyId;
    row.append(id);

    const detail = el("span", "ws-room-dep-detail");
    detail.textContent = edge.detail;
    row.append(detail);

    strip.append(row);
  }
}

/**
 * Change who is in the open room.
 *
 * The AI is not told directly. Reconnecting the transcript is what tells it: the
 * server resolves the room's scope on every connection, sees a different one,
 * and starts a fresh conversation — which is the point. A thread that was told
 * it could edit two repositories must not carry on believing that once there
 * are three, and the transcript says so where the user can read it.
 */
async function setRoomProjects(projects) {
  if (WS.kind !== "work" || !WS.id) return;
  const r = await agentApi(`/api/work-sessions/${encodeURIComponent(WS.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast(data.error || "Could not change the workroom");
  renderMembers(data.workSession);
  renderRoomDependencies(data.workSession);
  if (aiPaneOpen()) connectAi(WS.name);
  fetchSessions();
  toast(`Workroom now spans ${data.workSession.projects.join(", ")}`);
}

async function loadWorkrooms() {
  try {
    const r = await agentApi("/api/work-sessions");
    WORKROOMS = (await r.json()).workSessions || [];
  } catch {
    WORKROOMS = [];
  }
  return WORKROOMS;
}

function openWorkModal() {
  $("#work-backdrop").hidden = false;
  $("#work-modal").hidden = false;
  $("#work-title").value = "";
  $("#work-objective").value = "";
  renderWorkPicker();
  loadWorkrooms().then(renderWorkroomList);
}

function closeWorkModal() {
  $("#work-backdrop").hidden = true;
  $("#work-modal").hidden = true;
}

/** Rooms already open, so the button is a way back in and not only a way to start. */
function renderWorkroomList(rooms) {
  const list = $("#work-open-list");
  list.innerHTML = "";
  if (!rooms.length) {
    list.append(el("p", "hint", "No workrooms yet. Pick two projects below to start one."));
    return;
  }
  list.append(el("h3", null, "Open workrooms"));
  for (const room of rooms) {
    const row = el("div", "work-row");
    const main = el("div", "work-row-main");
    main.append(el("strong", null, room.title));
    main.append(el("span", "work-row-projects", room.projects.join(" · ")));
    if (!room.ready) main.append(el("span", "work-row-warn", "a project is missing"));
    const open = el("button", "btn btn-primary", "Open");
    open.onclick = () => {
      closeWorkModal();
      openWorkroom(room.id);
    };
    const archive = el("button", "btn", "Archive");
    archive.onclick = async () => {
      await agentApi(`/api/work-sessions/${encodeURIComponent(room.id)}/archive`, { method: "POST" });
      renderWorkroomList(await loadWorkrooms());
    };
    row.append(main, open, archive);
    list.append(row);
  }
}

function renderWorkPicker() {
  const picker = $("#work-picker");
  picker.innerHTML = STATE.projects
    .filter((p) => !p.archived)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `<label class="scope-item"><input type="checkbox" value="${esc(p.name)}" /> ${esc(p.name)}</label>`)
    .join("");
  picker.onchange = renderWorkSummary;
  renderWorkSummary();
}

function chosenWorkProjects() {
  return [...$("#work-picker").querySelectorAll("input:checked")].map((box) => box.value);
}

/** Say the scope back before it is created, in the words the AI will be given. */
function renderWorkSummary() {
  const chosen = chosenWorkProjects();
  const summary = $("#work-summary");
  if (chosen.length < 2) {
    summary.textContent = "Pick at least two projects.";
    return;
  }
  summary.textContent =
    `This AI may edit ${chosen.join(" and ")}. It starts in ${chosen[0]}. No other project is writable.`;
}

async function createWorkroom(event) {
  event.preventDefault();
  const projects = chosenWorkProjects();
  if (projects.length < 2) return toast("Pick at least two projects");
  const button = $("#work-create");
  button.disabled = true;
  try {
    const r = await agentApi("/api/work-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projects,
        title: $("#work-title").value.trim(),
        objective: $("#work-objective").value.trim(),
        engine: $("#work-engine").value,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast(data.error || "Could not open the workroom");
    closeWorkModal();
    openWorkroom(data.workSession.id);
  } finally {
    button.disabled = false;
  }
}

/**
 * Open a workroom.
 *
 * The same cockpit shell as a project — deliberately, because it is the same
 * work — with the project-only panes hidden and the members named across the
 * top. `chatOnly` is what the workspace-wide chat already uses for this.
 */
async function openWorkroom(id, fromRoute = false, pane = null) {
  pane = selectedPane("work", id, pane);
  if (!fromRoute) {
    location.hash = workroomHash(id, pane);
    return;
  }
  const requestedRoute = location.hash;
  let room;
  try {
    const r = await agentApi(`/api/work-sessions/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error("gone");
    room = (await r.json()).workSession;
  } catch {
    if (location.hash !== requestedRoute) return;
    toast("Workroom not found");
    history.replaceState(null, "", "#/");
    closeWorkspace(true);
    return;
  }
  if (location.hash !== requestedRoute) return;
  openWorkspace(
    {
      name: room.id, port: null, runCommand: null, deployStaging: null, deployProduction: null,
      aiExtraProjects: [], aiEngine: room.engine, aiModel: room.model, aiEffort: room.effort,
      aiFullAccess: false, // a workroom is never handed the sandbox-off flag
    },
    pane,
    { chatOnly: true, title: room.title, fromRoute: true, kind: "work", id: room.id, room },
  );
}

async function openWorkspaceChat(fromRoute = false, pane = null) {
  pane = selectedPane("project", "__workspace__", pane);
  if (!fromRoute) {
    location.hash = projectHash("__workspace__", pane);
    return;
  }
  const requestedRoute = location.hash;
  let w = { aiEngine: "claude", aiModel: null, aiEffort: null, aiFullAccess: false };
  try {
    w = await (await agentApi("/api/workspace")).json();
  } catch {}
  if (location.hash !== requestedRoute) return;
  openWorkspace(
    { name: "__workspace__", port: null, runCommand: null, deployStaging: null, deployProduction: null, aiExtraProjects: [],
      aiEngine: w.aiEngine || "claude", aiModel: w.aiModel || null, aiEffort: w.aiEffort || null, aiFullAccess: !!w.aiFullAccess },
    pane,
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
  const key = WS.kind === "work" ? WS.id : routeKey(projectByName(WS.name)) || WS.name;
  pane = selectedPane(WS.kind, key, pane);
  WS.pane = pane;
  rememberPane(WS.kind, key, pane);
  if (pane !== "deploy") {
    clearDeploymentPoll();
    clearPreparationPoll();
    if (WS.depEs) {
      WS.depEs.close();
      WS.depEs = null;
    }
  }
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
  if (pane === "changes") loadChanges();
  if (pane === "plan") loadPlan();
  if (pane === "capabilities") loadCapabilities();
  if (pane === "notes") loadNotes();
  if (pane === "ai" && !WS.recapFetched) {
    WS.recapFetched = true;
    fetchRecap(); // refresh "where we left off" (regenerates only if stale)
    fetchLimit(); // surface a usage limit before the user types anything
  }
  // A workroom lives under #/w/. Writing its id into a #/p/ URL — which is what
  // the project fallback did — pointed the router at a project that does not
  // exist, so the next tab click or reload answered "Project not found" and
  // closed the room.
  if (WS.kind === "work" && WS.id) {
    history.replaceState(null, "", workroomHash(WS.id, pane));
  } else if (WS.name) {
    history.replaceState(null, "", projectHash(routeKey(projectByName(WS.name)) || WS.name, pane));
  }
  renderQuickSwitch();
}

const webUrl = () => (WS.port ? `http://localhost:${WS.port}` : null);

/** What the iframe should show: the instrumented proxy in dev mode, else the app itself. */
const previewUrl = () => (DEV.on && DEV.proxyUrl ? DEV.proxyUrl : webUrl());

function renderWebPane() {
  const url = previewUrl();
  const frame = $("#ws-webframe");
  $("#ws-url").textContent = DEV.on
    ? `${webUrl() || "no port set"}${DEV.pagePath && DEV.pagePath !== "/" ? DEV.pagePath : ""} · dev mode`
    : url || "no port set";
  $("#ws-openext").disabled = !webUrl();
  $("#ws-reload").disabled = !url;
  renderDevMode();
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
      await agentApi(`/api/projects/${encodeURIComponent(WS.name)}`, {
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

/* ---- Web tab · dev mode ----------------------------------------------------
 * Click an element in the running app, say what should change about it, then
 * hand the whole batch to the project's AI. The preview is a foreign origin, so
 * the picking happens inside an inspector script the dev-mode proxy injects
 * (web/preview-inspector.js) and reaches us over postMessage.
 * -------------------------------------------------------------------------- */
let DEV = { on: false, picking: false, notes: [], proxyUrl: null, pagePath: "/", busy: false };

const DEV_NOTES = (() => {
  try {
    return JSON.parse(localStorage.getItem("psm.devnotes") || "{}");
  } catch {
    return {};
  }
})();

function saveDevNotes() {
  if (!WS.name) return;
  const keep = DEV.notes.filter((note) => !note.sent);
  if (keep.length) DEV_NOTES[WS.name] = keep;
  else delete DEV_NOTES[WS.name];
  try {
    localStorage.setItem("psm.devnotes", JSON.stringify(DEV_NOTES));
  } catch {}
}

function loadDevNotes(name) {
  DEV = { on: false, picking: false, notes: DEV_NOTES[name] || [], proxyUrl: null, pagePath: "/", busy: false };
}

const previewOrigin = () => {
  try {
    return new URL(DEV.proxyUrl).origin;
  } catch {
    return null;
  }
};

function postPreview(message) {
  const frame = $("#ws-webframe").querySelector("iframe");
  const origin = previewOrigin();
  if (!frame?.contentWindow || !origin) return;
  frame.contentWindow.postMessage({ source: "psm-devmode", ...message }, origin);
}

/**
 * Keep the in-page pin badges numbered the same way the notes rail is. The
 * selector rides along so a reloaded preview can find its elements again —
 * psm owns the notes, the page only owns the markers.
 */
function syncPreviewPins() {
  postPreview({
    type: "sync",
    pins: DEV.notes.map((note, i) => ({ id: note.id, n: i + 1, selector: note.target.selector })),
  });
  postPreview({ type: DEV.picking ? "arm" : "disarm" });
}

async function toggleDevMode(on = !DEV.on) {
  if (!WS.name) return;
  if (!on) {
    postPreview({ type: "disarm" });
    DEV.on = false;
    DEV.picking = false;
    DEV.proxyUrl = null;
    renderWebPane();
    return;
  }
  if (!WS.port) return toast("Set a web port first — dev mode previews the running app");
  const button = $("#ws-dev");
  button.disabled = true;
  try {
    const r = await agentApi(`/api/projects/${encodeURIComponent(WS.name)}/preview`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast(data.error || "Could not start the dev-mode preview");
    DEV.proxyUrl = data.url;
    DEV.on = true;
    DEV.picking = true; // armed straight away — the point of the mode is picking
    renderWebPane();
    toast("Dev mode on — click anything in the preview");
  } finally {
    button.disabled = false;
  }
}

function renderDevMode() {
  $("#ws-dev").classList.toggle("on", DEV.on);
  $("#ws-dev").setAttribute("aria-pressed", String(DEV.on));
  $("#ws-devbar").hidden = !DEV.on;
  $("#web-notes").hidden = !DEV.on;
  $("#ws-web").classList.toggle("dev-on", DEV.on);
  const pick = $("#web-pick");
  pick.classList.toggle("on", DEV.picking);
  pick.textContent = DEV.picking ? "◉ Picking… (Esc)" : "＋ Add note";
  renderApplyButton();
  if (DEV.on) renderDevNotes();
}

function renderApplyButton() {
  const ready = DEV.notes.filter((note) => !note.sent && note.note.trim()).length;
  const apply = $("#web-apply");
  apply.disabled = !ready || DEV.busy;
  apply.textContent = DEV.busy
    ? "Sending…"
    : ready
      ? `Make ${ready} change${ready === 1 ? "" : "s"}`
      : "Make changes";
}

function renderDevNotes() {
  const list = $("#web-notes-list");
  list.innerHTML = "";
  $("#web-notes-hint").hidden = DEV.notes.length > 0;
  $("#web-notes-clear").disabled = !DEV.notes.length;
  DEV.notes.forEach((note, i) => {
    const card = el("div", "note-card" + (note.sent ? " sent" : ""));
    card.dataset.noteId = note.id;
    const head = el("div", "note-head");
    const badge = el("span", "note-n", String(i + 1));
    const target = el("button", "note-target");
    target.type = "button";
    target.textContent = noteLabel(note);
    target.title = `${note.target.selector}\n${note.target.openTag || ""}`;
    target.onclick = () => postPreview({ type: "flash", id: note.id });
    const remove = el("button", "icon-btn note-remove", "✕");
    remove.title = "Remove this note";
    remove.onclick = () => {
      DEV.notes = DEV.notes.filter((n) => n.id !== note.id);
      saveDevNotes();
      renderDevMode();
      syncPreviewPins();
    };
    head.append(badge, target, remove);

    const text = el("textarea", "note-text");
    text.rows = 2;
    text.value = note.note;
    text.placeholder = "What should change here?";
    text.disabled = !!note.sent;
    text.oninput = () => {
      note.note = text.value;
      saveDevNotes();
      renderApplyButton(); // don't re-render the list — it would eat the caret
    };
    text.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        applyDevNotes();
      }
    };

    card.append(head, text);
    if (note.sent) card.append(el("div", "note-sent", "sent to the AI"));
    if (note.target.pathname && note.target.pathname !== "/")
      card.append(el("div", "note-path", esc(note.target.pathname)));
    list.append(card);
  });
}

function noteLabel(note) {
  const t = note.target;
  const attrs = t.attrs || {};
  let label = `<${t.tag}>`;
  if (attrs.id) label += ` #${attrs.id}`;
  else if (attrs["data-testid"]) label += ` [${attrs["data-testid"]}]`;
  if (t.text) label += ` “${t.text.slice(0, 34)}${t.text.length > 34 ? "…" : ""}”`;
  return label;
}

function addDevNote(id, target) {
  DEV.notes.push({ id, target, note: "", sent: false });
  saveDevNotes();
  renderDevMode();
  syncPreviewPins();
  // land the caret in the new note so the user can just start typing
  const card = $(`.note-card[data-note-id="${CSS.escape(id)}"]`);
  const text = card?.querySelector(".note-text");
  card?.scrollIntoView({ block: "nearest" });
  text?.focus();
}

/** Turn the notes into one prompt and send it to the selected AI. */
async function applyDevNotes() {
  if (!WS.name || DEV.busy) return;
  const pending = DEV.notes.filter((note) => !note.sent && note.note.trim());
  if (!pending.length) return toast("Write what should change first");
  if (WS.aiLimited) return toast("Usage limit reached — sending is paused");

  const lines = [
    "These change requests come from clicking elements in this project's live preview (psm dev mode).",
    `Preview: ${webUrl()}${DEV.pagePath && DEV.pagePath !== "/" ? DEV.pagePath : ""}`,
    "",
  ];
  pending.forEach((note, i) => {
    const t = note.target;
    const attrs = Object.entries(t.attrs || {}).map(([k, v]) => `${k}="${v}"`).join(" ");
    lines.push(`${i + 1}. Change: ${note.note.trim()}`);
    lines.push(`   Element: ${t.openTag || `<${t.tag}>`}`);
    lines.push(`   Selector: ${t.selector}`);
    if (t.text) lines.push(`   Visible text: "${t.text}"`);
    if (attrs) lines.push(`   Attributes: ${attrs}`);
    if (t.pathname) lines.push(`   On page: ${t.pathname}`);
    lines.push("");
  });
  lines.push(
    "Find where each element is rendered in this project's source, make the requested changes, and tell me which files you touched.",
  );
  const message = lines.join("\n");

  DEV.busy = true;
  renderDevMode();
  const name = WS.name;
  if (!WS.aiEs) connectAi(name);
  WS.pending.push(message);
  const optimistic = renderAiBubble({ t: Date.now(), role: "user", text: message });
  optimistic.pendingMessage = message;
  const wasBusy = WS.aiBusy;
  setAiBusy(true);
  const { ok, body } = await postAiMessage(name, message);
  DEV.busy = false;
  if (!ok) {
    toast(body.error || "AI request failed");
    if (!wasBusy) setAiBusy(false);
    const i = WS.pending.indexOf(message);
    if (i >= 0) WS.pending.splice(i, 1);
    optimistic.remove();
    if (body.limited) fetchLimit();
    if (body.question) fetchSessionState();
    renderDevMode();
    return;
  }
  for (const note of pending) note.sent = true;
  saveDevNotes();
  renderDevMode();
  switchPane("ai"); // watch the turn happen
  toast(body.queued ? "Queued — sends when the current turn finishes" : "Sent to the AI");
}

// Esc must disarm from either side: right after a pick the caret is in psm's
// note box, so the inspector's own Esc handler never sees the key.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !DEV.on || !DEV.picking) return;
  event.preventDefault();
  DEV.picking = false;
  renderDevMode();
  postPreview({ type: "disarm" });
});

// the inspector inside the preview reports picks, navigation, and pin clicks
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "psm-preview") return;
  const origin = previewOrigin();
  if (!origin || event.origin !== origin) return;
  if (data.type === "hello" || data.type === "navigate") {
    DEV.pagePath = data.pathname || "/";
    $("#ws-url").textContent = `${webUrl()}${DEV.pagePath !== "/" ? DEV.pagePath : ""} · dev mode`;
    syncPreviewPins(); // a fresh document starts with no pins and no arming
  } else if (data.type === "pick" && data.target) {
    addDevNote(data.id, data.target);
  } else if (data.type === "cancel") {
    DEV.picking = false;
    renderDevMode();
  } else if (data.type === "focus") {
    const card = $(`.note-card[data-note-id="${CSS.escape(data.id)}"]`);
    card?.scrollIntoView({ block: "center" });
    card?.querySelector(".note-text")?.focus();
  }
});

function connectLogs(name) {
  if (WS.es) WS.es.close();
  const es = agentStream(`/api/projects/${encodeURIComponent(name)}/logs/stream?kind=run`);
  WS.es = es;
  es.onopen = () => clearConsole(); // rebuild on (re)connect, don't duplicate
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
  saveDevNotes(); // un-applied preview notes come back with the project
  DEV = { on: false, picking: false, notes: [], proxyUrl: null, pagePath: "/", busy: false };
  clearTimeout(sessionRefreshTimer);
  if (WS.es) WS.es.close();
  if (WS.aiEs) WS.aiEs.close();
  disconnectPlanner();
  if (WS.depEs) WS.depEs.close();
  clearDeploymentPoll();
  clearPreparationPoll();
  WS = {
    name: null, kind: "project", id: null, es: null, port: null, pane: "logs", chatOnly: false, workingOn: false,
    engine: "claude", model: "", effort: "", actualModel: null, fullAccess: false, extraProjects: [], aiEs: null, aiBusy: false, pending: [], aiLimited: false, sessionState: null, question: null,
    deploy: { staging: null, production: null }, depTarget: "staging", depEs: null, depArmed: false,
    managedDeploy: emptyManagedDeploymentState(),
  };
  $("#ws-backdrop").hidden = true;
  $("#workspace").hidden = true;
  $("#home-page").hidden = false;
  document.body.classList.remove("ws-open");
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
  const room = location.hash.match(/^#\/w\/([^/]+)(?:\/([^/]+))?$/);
  if (room) {
    openWorkroom(decodeURIComponent(room[1]), true, room[2] ? decodeURIComponent(room[2]) : null);
    return;
  }
  const match = location.hash.match(/^#\/p\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    if (WS.name) closeWorkspace(true);
    else {
      $("#home-page").hidden = false;
      $("#workspace").hidden = true;
      document.body.classList.remove("ws-open");
      renderQuickSwitch();
    }
    return;
  }
  const key = decodeURIComponent(match[1]);
  const pane = match[2] ? decodeURIComponent(match[2]) : null;
  if (key === "__workspace__") {
    openWorkspaceChat(true, pane);
    return;
  }
  const project = projectByRouteKey(key);
  if (!project) {
    toast("Project not found");
    history.replaceState(null, "", "#/");
    closeWorkspace(true);
    return;
  }
  openWorkspace(project, pane, { fromRoute: true });
  // Opening a project is its "first need": give it an id now so the URL is stable from
  // here on, and rewrite a name-addressed URL (old bookmark) to the canonical id one.
  if (key !== project.id) canonicaliseRoute(project, pane);
}

async function canonicaliseRoute(project, pane) {
  try {
    if (!project.id) await assignProjectId(project);
  } catch {
    return; // no id: the name URL keeps working, just isn't rename-proof
  }
  if (!project.id || WS.kind !== "project" || WS.name !== project.name) return; // the user moved on meanwhile
  rememberPane("project", project.id, WS.pane);
  history.replaceState(null, "", projectHash(project.id, WS.pane));
  renderBoard(); // the card's "assign id" chip becomes a copyable id
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

/* ---- Notes pane ---------------------------------------------------------
 * The scratchpad beside each project. This tab used to mirror the Werewolf todo
 * board, which could show what was already tracked but not take down the thing
 * you just noticed — a crash you are looking at right now, a feature the project
 * is obviously asking for, a thought worth keeping. Notes are local files, so
 * writing one never waits on a network or a cloud session.
 */
const NOTE_KINDS = {
  bug: { label: "Bug / todo", icon: "\u{1F41E}", plural: "Bugs & todos" },
  feature: { label: "New feature", icon: "\u2728", plural: "New features" },
  idea: { label: "Idea / thought", icon: "\u{1F4A1}", plural: "Ideas & thoughts" },
};
const noteKind = (kind) => NOTE_KINDS[kind] || NOTE_KINDS.idea;

const notesPath = (suffix = "") =>
  `/api/projects/${encodeURIComponent(WS.name)}/notes${suffix}`;

async function loadNotes(force = false) {
  if (!WS.name || WS.chatOnly || NOTES.loading) return;
  if (!force && NOTES.project === WS.name && NOTES.notes.length) return;
  NOTES.loading = true;
  NOTES.error = null;
  renderNotes();
  try {
    const response = await agentApi(notesPath());
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load notes");
    NOTES.project = WS.name;
    NOTES.notes = data.notes || [];
  } catch (error) {
    NOTES.error = error.message || "Could not load notes";
  } finally {
    NOTES.loading = false;
    renderNotes();
  }
}

async function addNote() {
  const field = $("#note-text");
  const text = field.value.trim();
  if (!text || NOTES.saving) return;
  NOTES.saving = true;
  renderNotes();
  try {
    const response = await agentApi(notesPath(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: NOTES.kind, text }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not save the note");
    NOTES.notes = [data.note, ...NOTES.notes];
    field.value = "";
    // A filter that hides what was just written reads as the save having
    // failed, so widen it to where the new note actually is.
    if (NOTES.filter !== "all" && NOTES.filter !== data.note.kind) NOTES.filter = data.note.kind;
  } catch (error) {
    toast(error.message || "Could not save the note");
  } finally {
    NOTES.saving = false;
    renderNotes();
    field.focus();
  }
}

async function patchNote(id, body) {
  try {
    const response = await agentApi(notesPath(`/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not update the note");
    NOTES.notes = NOTES.notes.map((note) => (note.id === id ? data.note : note));
  } catch (error) {
    toast(error.message || "Could not update the note");
  } finally {
    NOTES.editing = null;
    renderNotes();
  }
}

async function deleteNote(id) {
  try {
    const response = await agentApi(notesPath(`/${encodeURIComponent(id)}`), { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Could not delete the note");
    }
    NOTES.notes = NOTES.notes.filter((note) => note.id !== id);
  } catch (error) {
    toast(error.message || "Could not delete the note");
  } finally {
    renderNotes();
  }
}

function visibleNotes() {
  if (NOTES.filter === "all") return NOTES.notes.filter((note) => !note.done);
  if (NOTES.filter === "done") return NOTES.notes.filter((note) => note.done);
  return NOTES.notes.filter((note) => note.kind === NOTES.filter && !note.done);
}

/** One note, either as a row or — while it is being edited — as a textarea. */
function noteCard(note) {
  const card = el("article", `pnote pnote-${note.kind}${note.done ? " is-done" : ""}`);
  card.dataset.noteId = note.id;

  const head = el("div", "pnote-head");
  const kind = el("span", "pnote-kind", `${noteKind(note.kind).icon} ${esc(noteKind(note.kind).label)}`);
  const when = el("time", "pnote-when", esc(relTime(note.updatedAt)));
  when.dateTime = new Date(note.updatedAt).toISOString();
  head.append(kind, when);

  if (NOTES.editing === note.id) {
    const field = el("textarea", "pnote-edit");
    field.value = note.text;
    field.rows = Math.min(12, note.text.split("\n").length + 1);
    const actions = el("div", "pnote-actions");
    const save = el("button", "btn btn-small btn-primary", "Save");
    save.onclick = () => patchNote(note.id, { text: field.value.trim() || note.text });
    const cancel = el("button", "btn btn-small", "Cancel");
    cancel.onclick = () => {
      NOTES.editing = null;
      renderNotes();
    };
    // The same chord that adds a note saves an edit.
    field.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") save.onclick();
      if (event.key === "Escape") cancel.onclick();
    };
    actions.append(save, cancel);
    card.append(head, field, actions);
    setTimeout(() => field.focus(), 0);
    return card;
  }

  // esc, because el() assigns innerHTML and a note is free-form prose the user
  // typed — stack traces and markdown are exactly what lands here.
  const text = el("p", "pnote-text", esc(note.text));
  const actions = el("div", "pnote-actions");
  const done = el("button", "btn btn-small", note.done ? "↩ Reopen" : "✓ Done");
  done.onclick = () => patchNote(note.id, { done: !note.done });
  const edit = el("button", "btn btn-small", "Edit");
  edit.onclick = () => {
    NOTES.editing = note.id;
    renderNotes();
  };
  const move = el("select", "pnote-move");
  for (const [value, meta] of Object.entries(NOTE_KINDS)) {
    const option = el("option", "", `${meta.icon} ${esc(meta.label)}`);
    option.value = value;
    if (value === note.kind) option.selected = true;
    move.append(option);
  }
  move.title = "Move this note to another kind";
  move.onchange = () => patchNote(note.id, { kind: move.value });
  const remove = el("button", "btn btn-small pnote-delete", "Delete");
  remove.title = "Delete this note";
  remove.onclick = () => {
    // Deleting is the one irreversible thing here, so it asks — inline, because
    // a browser confirm() would block the agent's own event loop conventions.
    if (remove.dataset.armed) return deleteNote(note.id);
    remove.dataset.armed = "1";
    remove.textContent = "Really delete?";
    setTimeout(() => {
      delete remove.dataset.armed;
      remove.textContent = "Delete";
    }, 4000);
  };
  actions.append(done, edit, move, remove);
  card.append(head, text, actions);
  return card;
}

function renderNotes() {
  const body = $("#note-body");
  if (!body) return;

  $("#note-save").disabled = NOTES.saving;
  $("#note-save").textContent = NOTES.saving ? "Saving…" : "Add note";
  for (const button of document.querySelectorAll("#note-kinds .note-kind")) {
    button.classList.toggle("on", button.dataset.kind === NOTES.kind);
  }
  for (const button of document.querySelectorAll("#note-filters .note-filter")) {
    button.classList.toggle("on", button.dataset.filter === NOTES.filter);
  }

  const openNotes = NOTES.notes.filter((note) => !note.done);
  const counts = Object.keys(NOTE_KINDS).map((kind) => {
    const total = openNotes.filter((note) => note.kind === kind).length;
    return total ? `${total} ${total === 1 ? noteKind(kind).label.toLowerCase() : noteKind(kind).plural.toLowerCase()}` : null;
  }).filter(Boolean);
  $("#note-count").textContent = counts.length ? counts.join(" · ") : "";

  body.innerHTML = "";

  if (NOTES.loading && !NOTES.notes.length) {
    body.append(el("div", "note-empty", "Loading notes…"));
    return;
  }
  if (NOTES.error) {
    body.append(el("div", "note-empty", esc(NOTES.error)));
    return;
  }

  const notes = visibleNotes();
  if (!notes.length) {
    const empty = el("div", "note-empty");
    empty.append(
      el("p", "", NOTES.notes.length
        ? "Nothing under this filter."
        : `No notes for ${esc(WS.name || "this project")} yet.`),
      el("p", "", "Write down a bug, a feature worth building, or a thought you do not want to lose."),
    );
    body.append(empty);
    return;
  }

  // Grouped by kind under the "All" filter, because bugs and daydreams are read
  // in different moods; a single-kind filter is already its own group.
  if (NOTES.filter === "all") {
    for (const kind of Object.keys(NOTE_KINDS)) {
      const group = notes.filter((note) => note.kind === kind);
      if (!group.length) continue;
      const section = el("section", "note-group");
      section.append(el("h3", "note-group-title", `${noteKind(kind).icon} ${esc(noteKind(kind).plural)}`));
      for (const note of group) section.append(noteCard(note));
      body.append(section);
    }
    return;
  }
  for (const note of notes) body.append(noteCard(note));
}

async function loadCapabilities(force = false) {
  if (WS.name && !WS.chatOnly) void PsmAgentPermissions.render(document.querySelector("#agent-permissions"), document.querySelector("#cap-deployment-connections"), {
    api: agentApi, project: currentProject(), onDeploy: () => switchPane("deploy"),
  });
  if (!WS.name || WS.chatOnly || CAPS.loading || (!force && CAPS.catalog.length)) return;
  CAPS.loading = true;
  renderCapabilities();
  try {
    const response = await agentApi("/api/catalog");
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
    const response = await agentApi("/api/catalog/custom/preview", {
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
    const response = await agentApi(`/api/projects/${encodeURIComponent(WS.name)}/attachments/preview`, {
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
      const response = await agentApi("/api/catalog/custom", {
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
    const response = await agentApi(url, {
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
  const effort = state.effort || configured.effort;
  const item = el("span", `planner-participant${state.busy ? " busy" : ""}`);
  item.append(
    el("strong", null, role === "planner" ? "Planner" : "Reviewer"),
    document.createTextNode(`${engine} · ${model}${effort ? ` · ${effort}` : ""}`),
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
      meta.append(eventTimeNode(event.t));
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
  const es = agentStream(
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
    const response = await agentApi(`/api/projects/${encodeURIComponent(project)}/planner/state`);
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
    const response = await agentApi(
      `/api/projects/${encodeURIComponent(WS.name)}/planner/${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [fresh ? "brief" : "message"]: message,
          engine: WS.engine,
          model: WS.model,
          effort: WS.effort,
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
  await agentApi(`/api/projects/${encodeURIComponent(WS.name)}/planner/cancel`, { method: "POST" });
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
    const response = await agentApi(`/api/projects/${encodeURIComponent(project)}/plans`);
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
    const response = await agentApi(
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
    const response = await agentApi(
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

// Absolute local times keep yesterday's history distinct from today's activity.
// Never substitute render time for a missing timestamp in an older saved event.
const EVENT_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const EVENT_TIME_DETAIL = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" });

function eventTimeNode(ms, className = "event-time") {
  const node = el("time", className);
  const date = typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    node.textContent = "Time unavailable";
    return node;
  }
  node.dateTime = date.toISOString();
  node.textContent = EVENT_TIME_FORMAT.format(date);
  node.title = `${EVENT_TIME_DETAIL.format(date)} (${EVENT_TIME_FORMAT.resolvedOptions().timeZone})`;
  return node;
}

function renderActivityTimes(node, entries) {
  node.replaceChildren();
  for (const [label, ms] of entries) {
    if (ms == null) continue;
    const item = el("span");
    item.textContent = `${label} `;
    item.append(eventTimeNode(ms));
    node.append(item);
  }
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
    effort: WS.effort || null,
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
  if (state.question && WS.name) openQuestion(conversationKey(), state.question, false, "ai", null, $("#ws-name").textContent);

  const rows = [
    ["engine", state.engine || WS.engine || "claude"],
    ["model", activeModel],
    ["configured", state.model || "default"],
    ["effort", state.effort || "default"],
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
    meta.append(el("span", null, ev.role), eventTimeNode(ev.t));
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
    const r = await agentApi(`${aiBase()}/ai/state`);
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
const PENDING_QUESTIONS = new Map();
let pendingQuestionRevision = 0;
let questionsListSignature = null;
let questionReturnFocus = null;

/**
 * The key one AI conversation's questions are filed under.
 *
 * A project is its name. A workroom has no name that means anything to the
 * server — its title is whatever the user typed and its session key is an
 * internal string — so it is `work:<id>`, which both the open cockpit and the
 * Working on lane can produce for the same room. They have to agree: the modal
 * is opened from whichever notices the question first, and closed by the other
 * when it goes away. When they disagreed, a workroom's question opened and then
 * immediately closed itself, and answering it asked for a project by the room's
 * title.
 */
function conversationKey(kind = WS.kind, id = WS.id, name = WS.name) {
  return kind === "work" ? `work:${id}` : name;
}

/** The same, for a row of the Working on lane. */
function sessionConversationKey(session) {
  return conversationKey(session.kind, session.id, session.name);
}

/** Where an answer for that conversation is posted. */
function questionBase(key) {
  return key.startsWith("work:")
    ? `/api/work-sessions/${encodeURIComponent(key.slice("work:".length))}`
    : `/api/projects/${encodeURIComponent(key)}`;
}

function questionKey(project, request, scope = "ai", role = "") {
  return `${scope}:${role || ""}:${project}:${request?.id || ""}`;
}

function closeQuestion() {
  ACTIVE_QUESTION = null;
  $("#question-backdrop").hidden = true;
  $("#question-modal").hidden = true;
  $("#question-body").innerHTML = "";
  if (questionReturnFocus?.isConnected) questionReturnFocus.focus();
  questionReturnFocus = null;
}

function clearQuestion(project, requestId = null, scope = "ai", role = null) {
  for (const [key, entry] of PENDING_QUESTIONS) {
    if (entry.project === project && entry.scope === scope && (!role || entry.role === role)
      && (!requestId || entry.request.id === requestId)) {
      PENDING_QUESTIONS.delete(key);
      pendingQuestionRevision++;
    }
  }
  renderQuestions();
  if (
    ACTIVE_QUESTION?.project === project &&
    ACTIVE_QUESTION.scope === scope &&
    (!role || ACTIVE_QUESTION.role === role) &&
    (!requestId || ACTIVE_QUESTION.request.id === requestId)
  ) closeQuestion();
  if (scope === "ai" && conversationKey() === project && (!requestId || WS.question?.id === requestId)) {
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

function openQuestion(project, request, force = false, scope = "ai", role = null, label = null) {
  if (!request?.id || !request.questions?.length) return;
  rememberQuestion({ project, request, scope, role, label });
  // Polling, navigation and stream replay only update the inbox. A dialog is
  // opened exclusively by an explicit Review/Answer click, even after reload.
  if (!force) return;
  questionReturnFocus = document.activeElement;
  ACTIVE_QUESTION = { project, request, scope, role };
  $("#question-project").textContent = label
    ? label
    : project === "__workspace__"
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

function rememberQuestion(entry) {
  if (!entry.request?.id || !entry.request.questions?.length) return;
  const key = questionKey(entry.project, entry.request, entry.scope, entry.role);
  for (const [oldKey, old] of PENDING_QUESTIONS) {
    if (old.project === entry.project && old.scope === entry.scope && old.role === entry.role && oldKey !== key) {
      PENDING_QUESTIONS.delete(oldKey);
      pendingQuestionRevision++;
    }
  }
  if (JSON.stringify(PENDING_QUESTIONS.get(key)) !== JSON.stringify(entry)) {
    PENDING_QUESTIONS.set(key, entry);
    pendingQuestionRevision++;
  }
  renderQuestions();
}

function syncPendingQuestions(sessions, questions) {
  // The fallback supports a refreshed page connected to a backend that has not
  // restarted yet. New backends also supply workspace, planner and reviewer questions.
  const pending = Array.isArray(questions) ? questions : [
    ...sessions.filter((session) => session.question).map((session) => ({
      project: sessionConversationKey(session), request: session.question,
      scope: "ai", role: null, label: session.name,
    })),
    ...[...PENDING_QUESTIONS.values()].filter((entry) => entry.scope === "planner" || entry.project === "__workspace__"),
  ];
  PENDING_QUESTIONS.clear();
  for (const entry of pending) {
    if (entry.request?.id && entry.request.questions?.length) {
      const normalized = { project: entry.project, request: entry.request, scope: entry.scope || "ai", role: entry.role || null, label: entry.label || null };
      PENDING_QUESTIONS.set(questionKey(normalized.project, normalized.request, normalized.scope, normalized.role), normalized);
    }
  }
  pendingQuestionRevision++;
  if (ACTIVE_QUESTION && !PENDING_QUESTIONS.has(questionKey(ACTIVE_QUESTION.project, ACTIVE_QUESTION.request, ACTIVE_QUESTION.scope, ACTIVE_QUESTION.role))) closeQuestion();
  renderQuestions();
}

function renderQuestions() {
  const entries = [...PENDING_QUESTIONS.values()].sort((a, b) => (a.request.askedAt || 0) - (b.request.askedAt || 0));
  const count = entries.length;
  $("#questions-count").textContent = String(count);
  $("#questions-count").hidden = count === 0;
  $("#questions-open").setAttribute("aria-label", `Questions: ${count} pending`);
  if ($("#questions-modal").hidden) return;
  const signature = JSON.stringify(entries);
  if (signature === questionsListSignature) return;
  questionsListSignature = signature;
  const list = $("#questions-list");
  list.innerHTML = "";
  if (!count) {
    const empty = el("p", "questions-empty");
    empty.textContent = "No pending questions.";
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = el("article", "questions-item");
    const title = el("h3");
    title.textContent = entry.label || (entry.project === "__workspace__" ? "Workspace chat" : entry.project);
    const meta = el("p", "questions-meta");
    meta.textContent = [entry.request.engine || "AI", entry.scope === "planner" ? entry.role : null, formatDateTime(entry.request.askedAt)].filter(Boolean).join(" · ");
    const preview = el("p", "questions-preview");
    preview.textContent = compactText(entry.request.questions.map((question) => question.question).join(" · "), 300);
    const review = el("button", "btn btn-primary");
    review.textContent = entry.request.questions.length > 1 ? `Review ${entry.request.questions.length} questions` : "Review question";
    review.onclick = () => openQuestion(entry.project, entry.request, true, entry.scope, entry.role, entry.label);
    row.append(title, meta, preview, review);
    list.append(row);
  }
}

function openQuestions() {
  openModal("#questions-modal");
  renderQuestions();
  fetchSessions();
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
    const fullAccess = conversationKey() === active.project ? WS.fullAccess : !!project?.aiFullAccess;
    const planner = active.scope === "planner";
    const r = await agentApi(`${questionBase(active.project)}/${planner ? "planner" : "ai"}/question`, {
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
    clearQuestion(active.project, active.request.id, active.scope, active.role);
    await fetchSessions();
    if (!planner) {
      if (conversationKey() === active.project) fetchSessionState();
    }
    toast("Answer sent");
  } catch {
    toast("Could not send the answer");
  } finally {
    submit.disabled = false;
  }
}

/* ---- Changes pane: git state, one block per repository ---- */

let CHANGES = { target: null, loading: false, repos: [], error: null };

function changesUrl() {
  return WS.kind === "work"
    ? `/api/work-sessions/${encodeURIComponent(WS.id)}/git`
    : `/api/projects/${encodeURIComponent(WS.name)}/git`;
}

async function loadChanges() {
  if (!WS.name) return;
  const target = conversationKey();
  CHANGES = { target, loading: true, repos: CHANGES.target === target ? CHANGES.repos : [], error: null };
  renderChanges();
  try {
    const r = await agentApi(changesUrl());
    const data = await r.json().catch(() => ({}));
    // The pane can be left while git is still running; a late answer must not
    // paint another target's repositories over this one.
    if (conversationKey() !== target) return;
    if (!r.ok) throw new Error(data.error || "could not read the repositories");
    CHANGES = { target, loading: false, repos: data.repos || [], error: null };
  } catch (err) {
    if (conversationKey() !== target) return;
    CHANGES = { target, loading: false, repos: [], error: err.message || "could not read the repositories" };
  }
  renderChanges();
}

/** "3 changes across 2 repositories", or the reason there is nothing to say. */
function changesSummaryText() {
  if (CHANGES.error) return CHANGES.error;
  if (CHANGES.loading && !CHANGES.repos.length) return "Reading…";
  const repos = CHANGES.repos.filter((repo) => repo.isRepo);
  if (!repos.length) return "No git repositories here.";
  const dirty = repos.filter((repo) => !repo.clean);
  if (!dirty.length) return `${repos.length} repositor${repos.length === 1 ? "y" : "ies"} · all clean`;
  const files = dirty.reduce((n, repo) => n + repo.staged + repo.unstaged + repo.untracked, 0);
  return `${files} change${files === 1 ? "" : "s"} across ${dirty.length} of ${repos.length} repositor${
    repos.length === 1 ? "y" : "ies"
  }`;
}

function renderChanges() {
  $("#changes-summary").textContent = changesSummaryText();
  const body = $("#changes-body");
  body.innerHTML = "";
  if (CHANGES.error) {
    body.append(el("p", "hint", CHANGES.error));
    return;
  }
  if (!CHANGES.repos.length) {
    body.append(el("p", "hint", CHANGES.loading ? "Reading the repositories…" : "Nothing to show."));
    return;
  }
  for (const repo of CHANGES.repos) body.append(repoBlock(repo));
}

function repoBlock(repo) {
  const block = el("section", "repo-block" + (repo.clean ? " clean" : ""));

  const head = el("div", "repo-head");
  const name = el("div", "repo-name");
  name.append(el("strong", null, repo.project));
  if (!repo.isRepo) {
    name.append(el("span", "repo-flag", repo.error ? "unreadable" : "not a git repository"));
  } else if (repo.detached) {
    name.append(el("span", "repo-branch detached", "detached HEAD"));
  } else if (repo.branch) {
    name.append(el("span", "repo-branch", repo.branch));
  }
  if (repo.upstream) {
    const track = el("span", "repo-track");
    track.textContent =
      repo.ahead || repo.behind
        ? `${repo.upstream} · ${repo.ahead ? `${repo.ahead} ahead` : ""}${
            repo.ahead && repo.behind ? ", " : ""
          }${repo.behind ? `${repo.behind} behind` : ""}`
        : `${repo.upstream} · in step`;
    name.append(track);
  } else if (repo.isRepo && repo.branch) {
    name.append(el("span", "repo-track", "no upstream"));
  }
  head.append(name);

  const counts = el("div", "repo-counts");
  if (repo.isRepo) {
    if (repo.clean) counts.append(el("span", "pill", "clean"));
    if (repo.staged) counts.append(el("span", "pill staged", `${repo.staged} staged`));
    if (repo.unstaged) counts.append(el("span", "pill unstaged", `${repo.unstaged} modified`));
    if (repo.untracked) counts.append(el("span", "pill untracked", `${repo.untracked} untracked`));
  }
  head.append(counts);
  block.append(head);

  if (repo.lastCommit) {
    const commit = el("div", "repo-commit");
    commit.append(el("code", null, repo.lastCommit.hash));
    commit.append(document.createTextNode(` ${repo.lastCommit.subject} · ${repo.lastCommit.when}`));
    block.append(commit);
  }

  if (repo.changes?.length) {
    const files = el("div", "repo-files");
    for (const change of repo.changes) {
      const row = el("div", "repo-file");
      row.append(el("code", `repo-code ${change.untracked ? "untracked" : change.staged ? "staged" : "unstaged"}`, change.code));
      row.append(el("span", "repo-path", change.path));
      files.append(row);
    }
    block.append(files);
    if (repo.truncated) block.append(el("p", "hint", "…and more — this repository has a lot of changes."));
  }

  if (repo.branches?.length > 1) {
    const branches = el("div", "repo-branches");
    branches.append(el("span", "repo-branches-label", "branches"));
    for (const branch of repo.branches) {
      const chip = el("span", `repo-branch-chip${branch.current ? " on" : ""}`, branch.name);
      chip.title = branch.when ? `last commit ${branch.when}` : "";
      branches.append(chip);
    }
    block.append(branches);
  }

  return block;
}

/* ---- AI pane ---- */

// The AI tab and the Web tab's dev bar both drive one selection: whichever set
// of controls the user touches, WS is the single source of truth and both
// mirrors are redrawn from it.
const AI_CONTROLS = [
  { engine: "#ws-engine", model: "#ws-model", effort: "#ws-effort", full: "#ws-full", current: "#ws-model-current", usage: "#usage-open", scope: "#ws-scope" },
  { engine: "#web-engine", model: "#web-model", effort: "#web-effort", full: "#web-full", current: "#web-model-current", usage: "#web-usage", scope: "#web-scope" },
];
const aiControlNodes = (key) => AI_CONTROLS.map((set) => $(set[key])).filter(Boolean);

function renderAiModel() {
  const configured = WS.model && WS.model.trim();
  const actual = WS.actualModel && WS.actualModel.trim();
  const text = actual || configured || "default";
  const title = actual && configured && actual !== configured
    ? `CLI reported ${actual}; configured as ${configured}`
    : configured
      ? `Configured model: ${configured}`
      : "Using the CLI default model";
  for (const node of aiControlNodes("current")) {
    node.textContent = `model: ${text}`;
    node.title = title;
  }
}

/** Push WS's engine/model/effort/full-access onto every mirror. */
function syncAiControls() {
  for (const set of AI_CONTROLS) {
    $(set.engine).value = WS.engine;
    $(set.model).value = WS.model;
    renderEffortOptions($(set.effort), WS.engine, WS.model, WS.effort, WS.name);
    const managed = WS.name !== "__workspace__";
    $(set.full).checked = managed ? false : WS.fullAccess;
    $(set.full).disabled = managed;
    $(set.full).closest("label").title = managed ? "Project and workroom agents use Capabilities → Agent permissions, never an unrestricted sandbox." : "Workspace chat only: run the AI with its sandbox off. It can run any command as you, on every project and file you can reach.";
  }
  renderScopeChip();
  renderAiModel();
}

function refreshAiModels() {
  return refreshModelCatalog(
    WS.name,
    WS.engine,
    () => ({ model: WS.model, effort: WS.effort }),
    aiControlNodes("effort"),
    aiBase(),
  );
}

/**
 * Remember an AI selection where this conversation actually lives.
 *
 * A project keeps it in its overrides; a workroom keeps it on the room. Sending
 * a room id to the project endpoint is how this used to fail silently — the
 * PATCH 404s, the catch swallows it, and the picker springs back on reload with
 * no sign anything went wrong.
 */
function rememberAiChoice({ engine, model, effort, fullAccess } = {}) {
  if (WS.kind === "work" && WS.id) {
    const body = {};
    if (engine !== undefined) body.engine = engine;
    if (model !== undefined) body.model = model;
    if (effort !== undefined) body.effort = effort;
    // A workroom is never handed the sandbox-off flag, so there is nothing to save.
    if (!Object.keys(body).length) return Promise.resolve(false);
    return agentApi(`/api/work-sessions/${encodeURIComponent(WS.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.ok).catch(() => false);
  }
  const body = {};
  if (engine !== undefined) body.aiEngine = engine;
  if (model !== undefined) body.aiModel = model;
  if (effort !== undefined) body.aiEffort = effort;
  if (fullAccess !== undefined) body.aiFullAccess = fullAccess;
  return patchProject(WS.name, body);
}

function applyEngine(engine) {
  WS.engine = engine;
  WS.model = "";
  WS.effort = "";
  WS.actualModel = null;
  syncAiControls();
  refreshAiModels();
  usageSelectionChanged();
  rememberAiChoice({ engine: WS.engine, model: "", effort: "" }); // remember per project or room
  fetchLimit(); // limits are per engine — re-check for the newly selected one
  if (aiPaneOpen()) connectAi(WS.name);
  scheduleSessionRefresh();
}

function applyModel(model) {
  WS.model = String(model || "").trim();
  WS.effort = "";
  WS.actualModel = null;
  syncAiControls();
  usageSelectionChanged();
  rememberAiChoice({ model: WS.model, effort: "" }); // remember per project or room
  if (aiPaneOpen()) connectAi(WS.name);
  scheduleSessionRefresh();
}

function applyEffort(effort) {
  WS.effort = effort;
  syncAiControls();
  rememberAiChoice({ effort: WS.effort });
  if (aiPaneOpen()) connectAi(WS.name);
  scheduleSessionRefresh();
}

function applyFullAccess(fullAccess) {
  // Sandbox-off is a machine-wide grant, so turning it on is a deliberate act.
  if (fullAccess && !WS.fullAccess && !window.confirm("Run workspace chat unrestricted?\n\nThe AI's sandbox is turned off: it can run any command as you, read and change any file you can, on every project. Project and workroom agents are unaffected; they use Agent permissions.")) {
    for (const node of aiControlNodes("full")) node.checked = false;
    return;
  }
  WS.fullAccess = fullAccess;
  for (const node of aiControlNodes("full")) node.checked = fullAccess;
  rememberAiChoice({ fullAccess: WS.fullAccess }); // remember per project
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

/* ---- Figures in the transcript ---------------------------------------------
 * The transcript is plain text on purpose, but data drawn as ASCII art is
 * unreadable in a proportional bubble — boxes and arrows land wherever the font
 * puts them. The interaction protocol (src/server/ai.ts) asks for a figure block
 * instead, and each one is rendered here, in place, between the paragraphs
 * around it:
 *
 *     ```psm-figure Optional title
 *     <div style="...">…</div>
 *     ```
 *
 * The tag is psm's own, not `html`, because a coding agent shows real HTML
 * source all day: a fenced `html` block means "here is some markup", and
 * `psm-figure` means "draw this".
 *
 * A figure draws in an iframe sandboxed to allow-same-origin and nothing else —
 * scripts, forms, popups, and navigation are all off, and the document's own CSP
 * cuts it off from the network, so nothing in it can run, reach psm's DOM, phone
 * home, or pull a font. allow-same-origin is there for one reason: so the height
 * can be measured after layout.
 *
 * The transcript keeps the source, not the rendering: the fenced block stays in
 * the AI log, so a figure survives a reload, and Copy/Download hand back exactly
 * what the model wrote.
 * -------------------------------------------------------------------------- */

// title is optional and free text; `figure` and `psm-html` are accepted spellings
const FIGURE_FENCE = /```(?:psm-figure|psm-html|figure)[^\S\n]*([^\n]*)\n([\s\S]*?)\n?```/gi;
const FIGURE_MAX_H = 640;
const FIGURE_ROOT = "psm-figure"; // the wrapper the height is measured on
const FIGURE_SOURCES = new WeakMap(); // frame → the model's markup, for redraws

const FIGURE_TOKENS = [
  "--bg", "--bg-soft", "--card", "--card-hover", "--line", "--text", "--muted", "--faint",
  "--accent", "--accent-ink",
  "--st-active", "--st-paused", "--st-library", "--st-utility", "--st-experiment",
  "--st-planning", "--st-archived",
];

function figureDoc(body) {
  const root = getComputedStyle(document.documentElement);
  const vars = FIGURE_TOKENS
    .map((name) => [name, root.getPropertyValue(name).trim()])
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return [
    '<!doctype html><meta charset="utf-8">',
    // no network at all: a figure cannot beacon, pull a font, or load a tracker
    '<meta http-equiv="Content-Security-Policy" ',
    `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">`,
    `<style>:root{${vars}}`,
    "html,body{margin:0}*{box-sizing:border-box}",
    "body{padding:12px;background:transparent;color:var(--text,#e6edf3);",
    "font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    "svg,img,table{max-width:100%}table{border-collapse:collapse}",
    "pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    "a{color:var(--accent);pointer-events:none}", // links cannot navigate anyway
    // flow-root so the figure's own margins stay inside the box we measure
    `#${FIGURE_ROOT}{display:flow-root}`,
    "</style>",
    `<div id="${FIGURE_ROOT}">`, body, "</div>",
  ].join("");
}

/**
 * Match the frame to the height its content actually took at this width.
 *
 * Measured on the figure's own wrapper, not on <body>: a document's scroll
 * height never reports less than the viewport it is in, so measuring the body
 * can grow a frame but can never shrink one back.
 */
function fitFigure(frame) {
  if (document.fullscreenElement?.contains(frame)) return; // fullscreen sizes itself
  let doc;
  try {
    doc = frame.contentDocument;
  } catch {
    return; // sandboxed away — leave the fallback height
  }
  const root = doc?.getElementById(FIGURE_ROOT);
  if (!root) return;
  const padding = 2 * parseFloat(doc.defaultView.getComputedStyle(doc.body).paddingTop || "0");
  const height = Math.ceil(root.getBoundingClientRect().height + padding);
  const next = Math.min(Math.max(height, 48), FIGURE_MAX_H) + "px";
  if (next !== frame.style.height) frame.style.height = next; // idempotent: see figureSizer
}

// The pane resizes, and a frame that was measured while the tab was in the
// background measured nothing at all — both are answered by re-fitting here.
// fitFigure only writes a height that differs, so our own writes settle after
// one extra pass instead of looping.
const figureSizer = typeof ResizeObserver === "function"
  ? new ResizeObserver((entries) => {
      for (const entry of entries) fitFigure(entry.target);
    })
  : null;

// The palette is baked into each frame, so a theme flip has to redraw them.
matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
  for (const frame of document.querySelectorAll(".ai-figure iframe")) {
    const source = FIGURE_SOURCES.get(frame);
    if (source != null) frame.srcdoc = figureDoc(source);
  }
});

document.addEventListener("fullscreenchange", () => {
  // leaving fullscreen restores the inline height, which was measured at the
  // old width — remeasure the frame that just came back.
  for (const frame of document.querySelectorAll(".ai-figure iframe")) fitFigure(frame);
});

function figureButton(glyph, title, onClick) {
  const button = el("button", "icon-btn figure-btn");
  button.type = "button";
  button.textContent = glyph;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.onclick = onClick;
  return button;
}

function figureFileName(title) {
  const slug = String(title || "figure").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `psm-${slug || "figure"}.html`;
}

async function copyFigureSource(source) {
  try {
    await navigator.clipboard.writeText(source);
    toast("Figure source copied");
  } catch {
    toast("The browser refused clipboard access");
  }
}

/** Hand back a standalone page — the frame's own document, tokens and all. */
function downloadFigure(source, title) {
  const url = URL.createObjectURL(new Blob([figureDoc(source)], { type: "text/html" }));
  const link = el("a");
  link.href = url;
  link.download = figureFileName(title);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleFigureFullscreen(wrap) {
  if (document.fullscreenElement === wrap) {
    document.exitFullscreen();
    return;
  }
  wrap.requestFullscreen?.().catch(() => toast("The browser refused fullscreen"));
}

function aiFigure(source, title) {
  const wrap = el("div", "ai-figure");
  const bar = el("div", "figure-bar");
  const label = el("span", "figure-title");
  label.textContent = title || "Figure";
  const actions = el("div", "figure-actions");
  actions.append(
    figureButton("⛶", "Fullscreen", () => toggleFigureFullscreen(wrap)),
    figureButton("⧉", "Copy the figure's HTML source", () => copyFigureSource(source)),
    figureButton("⭳", "Download the figure as an .html file", () => downloadFigure(source, title)),
  );
  bar.append(label, actions);

  const frame = el("iframe");
  frame.title = title || "Figure";
  // allow-same-origin *only* — enough to measure the laid-out height. Without
  // allow-scripts / allow-forms / allow-popups / allow-top-navigation, nothing
  // in the document can act on anything.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.addEventListener("load", () => {
    fitFigure(frame);
    // a hidden tab lays nothing out; the frame runs on its first painted frame
    requestAnimationFrame(() => fitFigure(frame));
    figureSizer?.observe(frame);
  });
  FIGURE_SOURCES.set(frame, source);
  frame.srcdoc = figureDoc(source);

  wrap.append(bar, frame);
  return wrap;
}

/** Assistant text with its figures drawn; every other part stays plain text. */
function renderAiText(node, text) {
  const source = String(text ?? "");
  let at = 0;
  for (const match of source.matchAll(FIGURE_FENCE)) {
    addAiText(node, source.slice(at, match.index));
    node.append(aiFigure(match[2], match[1].trim()));
    at = match.index + match[0].length;
  }
  if (!at) {
    node.textContent = source; // no figures — the ordinary case
    return false;
  }
  addAiText(node, source.slice(at));
  return true;
}

function addAiText(node, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const part = el("div", "ai-text");
  part.textContent = trimmed;
  node.append(part);
}

function preparationEntryLabel(ev) {
  if (ev.role !== "user") return null;
  const turn = ev.preparation;
  if (turn) return turn.purpose === "diagnose-external"
    ? `PSM · ${turn.environmentId} · External checks`
    : `PSM · ${turn.environmentId} · Repair attempt ${turn.attempt} of ${turn.maximumAttempts}${turn.attempt === 1 ? " · Preparation started" : ""}`;
  // Older saved sessions have only the generated brief. Keep them readable too.
  const legacy = /^psm is preparing this project for deployment to "([^"\n]+)" and these readiness checks are not passing\./.exec(ev.text || "");
  if (!legacy) return null;
  if (ev.text.includes("Diagnose these external deployment checks")) return `PSM · ${legacy[1]} · External checks`;
  const attempt = /This is attempt (\d+) of (\d+)/.exec(ev.text);
  return `PSM · ${legacy[1]} · Repair attempt ${attempt?.[1] || "1"} of ${attempt?.[2] || "3"}${!attempt || attempt[1] === "1" ? " · Preparation started" : ""}`;
}

function renderAiBubble(ev) {
  const t = $("#ws-transcript");
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  const preparation = preparationEntryLabel(ev);
  const b = el(preparation ? "details" : "div", preparation ? "ai-msg ai-preparation" : "ai-msg ai-" + ev.role);
  if (preparation) {
    const summary = el("summary");
    summary.textContent = preparation;
    summary.append(eventTimeNode(ev.t, "ai-time"));
    const brief = el("div", "ai-preparation-brief");
    brief.textContent = ev.text;
    b.append(summary, brief);
  } else if (ev.role === "assistant") {
    if (renderAiText(b, ev.text)) b.classList.add("has-figure"); // figures need the width
  } else {
    b.textContent = ev.text;
  }
  if (!preparation) b.append(eventTimeNode(ev.t, "ai-time"));
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
      const optimistic = [...$("#ws-transcript").children].find((node) => node.pendingMessage === ev.text);
      if (optimistic) {
        optimistic.querySelector(".ai-time").replaceWith(eventTimeNode(ev.t, "ai-time"));
        delete optimistic.pendingMessage;
      }
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
  const locked = busy || !!WS.question;
  for (const key of ["engine", "model", "effort"])
    for (const node of aiControlNodes(key)) node.disabled = locked;
  // Send stays available even while busy — extra messages get queued. Stop
  // shows alongside it so the running turn can still be cancelled.
  $("#ws-send").hidden = false;
  $("#ws-cancel").hidden = !busy;
  if (busy) setAiActivity("Thinking…");
  else $("#ws-ai-activity").hidden = true;
  refreshComposer();
  renderWorkingButton();
}

/**
 * Where this conversation's AI endpoints live.
 *
 * A project chat and a workroom chat are the same UI over different URLs, so the
 * base is looked up once here rather than spelled out at each call. Everything
 * below `${base}/ai` — stream, send, question, state, recap, cancel — is served
 * identically for both by the server.
 */
function aiBase(name = WS.name) {
  return WS.kind === "work"
    ? `/api/work-sessions/${encodeURIComponent(WS.id)}`
    : `/api/projects/${encodeURIComponent(name)}`;
}

function connectAi(name) {
  if (WS.aiEs) WS.aiEs.close();
  // send model/effort even when empty: empty means "the provider's default",
  // and leaving them out lets the server fall back to the project's saved
  // values — which is how switching engines used to drag the old model along
  const params = new URLSearchParams({
    engine: WS.engine,
    model: WS.model || "",
    effort: WS.effort || "",
  });
  const es = agentStream(`${aiBase(name)}/ai/stream?${params}`);
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
      WS.effort = status.effort || "";
      WS.actualModel = status.actualModel || null;
      WS.question = status.question || null;
      syncAiControls();
      usageSelectionChanged(); // the echoed model decides which windows apply
      if (WS.pane === "session") renderSessionPane({ ...(WS.sessionState || {}), ...status, recent: WS.sessionState?.recent || [] });
      if (WS.question) openQuestion(conversationKey(), WS.question, false, "ai", null, $("#ws-name").textContent);
      else clearQuestion(conversationKey());
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
      openQuestion(conversationKey(), question, false, "ai", null, $("#ws-name").textContent);
      fetchSessions();
    } catch {}
  });
  es.addEventListener("question-cleared", (e) => {
    try {
      clearQuestion(conversationKey(), JSON.parse(e.data).id);
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

/*
 * "Where we left off": open once, then remembered.
 *
 * Closing folds it into a one-line bar that opens again on a click. The choice
 * is kept per conversation across tabs, project switches and reloads, and the
 * recap only opens by itself again when it says something new — which the
 * server only produces once the conversation itself has moved on.
 */
function recapStateKey(key) { return `psm.recap.folded.${key}`; }
function recapDigest(summary) {
  let hash = 5381;
  for (let i = 0; i < summary.length; i++) hash = ((hash << 5) + hash + summary.charCodeAt(i)) | 0;
  return String(hash >>> 0);
}
function recapFolded(summary, key) {
  try { return localStorage.getItem(recapStateKey(key)) === recapDigest(summary); } catch { return false; }
}
function rememberRecapFolded(summary, key, folded) {
  try {
    if (folded) localStorage.setItem(recapStateKey(key), recapDigest(summary));
    else localStorage.removeItem(recapStateKey(key));
  } catch {}
}

function setRecap(summary) {
  const banner = $("#ws-ai-recap");
  banner.classList.remove("loading");
  if (!summary) {
    banner.hidden = true;
    banner.innerHTML = "";
    delete banner.dataset.summary;
    return;
  }
  const key = conversationKey(); // pinned for the handlers below
  const folded = recapFolded(summary, key);
  // The stream and the fetch both deliver the recap; the same one twice is not a redraw.
  if (!banner.hidden && banner.dataset.summary === summary && banner.dataset.folded === String(folded)) return;
  banner.dataset.summary = summary;
  banner.dataset.folded = String(folded);
  banner.innerHTML = "";
  banner.classList.toggle("collapsed", folded);
  const title = el("div", "ai-recap-title", "↩ Where we left off");
  if (folded) {
    const open = el("button", "ai-recap-toggle");
    open.type = "button";
    open.title = "Show where we left off";
    open.setAttribute("aria-expanded", "false");
    open.append(title, el("span", "ai-recap-chevron", "▸"));
    open.onclick = () => { rememberRecapFolded(summary, key, false); setRecap(summary); };
    banner.append(open);
  } else {
    const close = el("button", "ai-recap-close", "&times;");
    close.type = "button";
    close.title = "Fold away";
    close.setAttribute("aria-expanded", "true");
    close.onclick = () => { rememberRecapFolded(summary, key, true); setRecap(summary); };
    const head = el("div", "ai-recap-head");
    head.append(title, close);
    const body = el("div", "ai-recap-body");
    body.textContent = summary;
    banner.append(head, body);
  }
  banner.hidden = false;
}

async function fetchRecap() {
  if (!WS.name) return;
  // No placeholder: a saved recap arrives with the stream straight away, and a
  // "Recalling…" line on every visit was the flash this replaced.
  try {
    const r = await agentApi(`${aiBase()}/ai/recap`);
    setRecap((await r.json()).summary);
  } catch {}
}

/* ---- usage limit ---- */
function refreshComposer() {
  const blocked = WS.aiLimited;
  const waiting = !!WS.question;
  $("#ws-send").disabled = blocked || waiting;
  $("#ws-msg").disabled = blocked || waiting;
  $("#ws-question-answer").hidden = !waiting;
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
    const title = el("div", "ai-limit-title", hard ? "⚠ Usage limit reached" : "⚠ Approaching usage limit");
    banner.append(title, body);
    if (hard) {
      // psm's copy of the verdict can be wrong, and the provider is the
      // authority. Never leave the only way out as "wait for the reset".
      const dismiss = el("button", "btn ai-limit-dismiss");
      dismiss.textContent = "Dismiss and try anyway";
      dismiss.title = "Forget this limit and let the provider decide on the next message";
      dismiss.onclick = () => clearAiLimit();
      banner.append(dismiss);
    }
    banner.hidden = false;
  }
  refreshComposer();
}

async function clearAiLimit() {
  try {
    await agentApi(`/api/ai/limit?engine=${encodeURIComponent(WS.engine)}`, { method: "DELETE" });
  } catch {}
  setAiLimit(null);
  toast("Limit dismissed — the next message goes to the provider");
}

async function fetchLimit() {
  if (!WS.name) return;
  try {
    const model = WS.model || WS.actualModel || "";
    const r = await agentApi(
      `/api/ai/limit?engine=${encodeURIComponent(WS.engine)}&model=${encodeURIComponent(model)}`,
    );
    setAiLimit((await r.json()).limit);
  } catch {}
}

/** One place that hands a message to the project's AI with the current selection. */
async function postAiMessage(name, message) {
  const r = await agentApi(`${aiBase(name)}/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, engine: WS.engine, model: WS.model, effort: WS.effort, fullAccess: WS.fullAccess }),
  });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
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
  const optimistic = renderAiBubble({ t: Date.now(), role: "user", text: message });
  optimistic.pendingMessage = message;
  setAiBusy(true);
  const { ok, body: e } = await postAiMessage(name, message);
  if (!ok) {
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
  await agentApi(`${aiBase()}/ai/cancel`, { method: "POST" });
}

/* ---- Deploy pane ---- */
const depKind = () => `deploy:${WS.depTarget}`;
const deploymentKey = () => WS.id || WS.name;
const deploymentBase = (key = deploymentKey()) => `/api/projects/${encodeURIComponent(key)}/deployments`;
const DEPLOYMENT_TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted", "stale-plan", "rolled-back"]);

/**
 * Managed requests can outlive the project or environment that launched them.
 * Keep the state object itself in the scope: opening another project replaces
 * that object, so a late response cannot paint or approve against the new one.
 */
function deploymentRequestScope({ environment = false, artifact = false, plan = false, run = false } = {}) {
  const state = WS.managedDeploy;
  return {
    state,
    projectKey: deploymentKey(),
    ...(environment ? { environmentId: state?.environment } : {}),
    ...(artifact ? { artifactId: state?.artifactId } : {}),
    ...(plan ? { planId: state?.plan?.id, planDigest: state?.plan?.digest } : {}),
    ...(run ? { runId: state?.run?.id } : {}),
  };
}

function deploymentRequestIsCurrent(scope) {
  const state = WS.managedDeploy;
  if (!state || state !== scope.state || deploymentKey() !== scope.projectKey) return false;
  if ("environmentId" in scope && state.environment !== scope.environmentId) return false;
  if ("artifactId" in scope && state.artifactId !== scope.artifactId) return false;
  if ("planId" in scope && (state.plan?.id !== scope.planId || state.plan?.digest !== scope.planDigest)) return false;
  if ("runId" in scope && state.run?.id !== scope.runId) return false;
  return true;
}

function clearDeploymentPoll(state = WS.managedDeploy) {
  if (state?.poll) clearTimeout(state.poll);
  if (state?.readinessTimer) clearTimeout(state.readinessTimer);
  if (state) { state.poll = null; state.readinessTimer = null; }
}

function clearPreparationPoll(state = WS.managedDeploy) {
  if (state?.preparationPoll) clearTimeout(state.preparationPoll);
  if (state) state.preparationPoll = null;
}

function invalidateDeploymentReadiness(state = WS.managedDeploy) {
  state.readiness = null;
  state.readinessEnvironment = null;
  state.plan = null;
  state.planEnvironment = null;
  if (state.readinessTimer) clearTimeout(state.readinessTimer);
  state.readinessTimer = null;
}

function deploymentReadyToApprove() {
  const state = WS.managedDeploy;
  const plan = state.plan;
  const readiness = state.readiness;
  if (state.loading || state.preparationRunId || !plan || plan.blocked || !plan.id || !plan.digest) return false;
  if (state.run && !DEPLOYMENT_TERMINAL_STATES.has(state.run.state)) return false;
  if (state.planEnvironment !== state.environment || !(Number(plan.expiresAt) > Date.now())) return false;
  if (plan.operation !== "rollback" && (!readiness?.ready || state.readinessEnvironment !== state.environment
    || !(Number(readiness.expiresAt) > Date.now()) || (readiness.artifactId || null) !== state.artifactId)) return false;
  return !(plan.acknowledgements || []).length || $("#dep-ack").checked;
}

function deploymentReadinessControls(state, readiness, supersededPreparation) {
  const preparing = !!state.preparation?.active;
  const resumable = !!state.preparation && !preparing && state.preparation.state !== "succeeded" && !supersededPreparation;
  // A recovery-required run is held, not executing. It still blocks deployment
  // approval, but must not block the read-only check or preparation of new input.
  const activeRun = !!state.run && !DEPLOYMENT_TERMINAL_STATES.has(state.run.state) && state.run.state !== "recovery-required";
  return {
    busy: state.loading || !!state.preparationRunId || activeRun,
    preparing,
    resumable,
    showPreparation: resumable || !!readiness && !readiness.ready,
  };
}

function renderDeploymentReadiness() {
  scheduleDeploymentTodo();
  const state = WS.managedDeploy;
  const readiness = state.readinessEnvironment === state.environment ? state.readiness : null;
  const rows = (readiness?.items || []).map((item) => ({
    ...item,
    state: item.status === "ready" ? "ready" : item.status === "action-required" ? "warning" : "blocked",
    kind: item.status === "ready" ? "Ready" : item.automatic ? "Can prepare" : "Action needed",
  }));
  depRows($("#dep-readiness"), rows, "Check readiness to see the steps needed for this environment.");
  // When live already runs the committed source, an unchanged version is expected, not a step.
  const outstanding = rows.filter((item) => item.status !== "ready" && !(item.code === "version-not-increased" && deploymentUpToDate()));
  $("#dep-readiness-count").textContent = readiness ? `${outstanding.length} remaining` : "Not checked";
  renderActivityTimes($("#dep-readiness-times"), [["Checked", readiness?.checkedAt]]);
  for (const [index, item] of rows.entries()) {
    // The release controller's GitHub Environment is filled from here, with the CI key PSM enrolled.
    if (item.status !== "ready" && item.code === "executor-not-ready" && /controller-credentials/.test(item.id) && /Publish the CI release key/.test(item.detail || "")) {
      const publish = depText("button", "dep-mini-btn primary", "Publish to GitHub");
      publish.type = "button";
      const row = $("#dep-readiness").children[index];
      publish.onclick = async () => {
        publish.disabled = true;
        publish.textContent = "Publishing…";
        row?.querySelector(".dep-row-error")?.remove();
        try {
          const scope = deploymentRequestScope({ environment: true });
          const response = await agentApi(`/api/projects/${encodeURIComponent(scope.projectKey)}/deployments/${encodeURIComponent(state.environment)}/controller-credentials`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          void discoverDeploymentPlan();
        } catch (error) {
          publish.disabled = false;
          publish.textContent = "Try again";
          row?.append(depText("div", "dep-row-error", `Publishing failed: ${error.message}`));
        }
      };
      row?.append(publish);
    }
    // A target contract changed on the server is pinned from here, with the exact digest shown.
    const contractTo = item.status !== "ready" && /target-contract/.test(item.id) && /changed from \S+ to (sha256:[0-9a-f]{64})/.exec(item.detail || "");
    if (contractTo) {
      const row = $("#dep-readiness").children[index];
      const pin = depText("button", "dep-mini-btn primary", "Pin current contract");
      pin.type = "button";
      pin.title = `Release against target contract ${contractTo[1]}`;
      pin.onclick = async () => {
        pin.disabled = true;
        pin.textContent = "Pinning…";
        row?.querySelector(".dep-row-error")?.remove();
        try {
          const scope = deploymentRequestScope({ environment: true });
          const response = await agentApi(`/api/projects/${encodeURIComponent(scope.projectKey)}/deployments/${encodeURIComponent(state.environment)}/target-contract-pin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest: contractTo[1] }) });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          toast(`Target contract pinned to ${contractTo[1].slice(0, 19)}…`);
          void discoverDeploymentPlan();
        } catch (error) {
          pin.disabled = false;
          pin.textContent = "Try again";
          row?.append(depText("div", "dep-row-error", `Pinning failed: ${error.message}`));
        }
      };
      row?.append(pin);
    }
    // A moved controller branch is reviewed on GitHub, then pinned from here: the button
    // sends the exact commit shown, and PSM refuses if the branch moved again.
    const movedTo = item.status !== "ready" && /controller-pin/.test(item.id) && /moved from [0-9a-f]{12} to ([0-9a-f]{40})/.exec(item.detail || "");
    if (movedTo) {
      const row = $("#dep-readiness").children[index];
      const compare = /\((https:\/\/github\.com\/[^)\s]+\/compare\/[^)\s]+)\)/.exec(item.detail || "");
      if (compare) {
        const link = depText("a", "dep-mini-btn", "Review changes");
        link.href = compare[1];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        row?.append(link);
      }
      const pin = depText("button", "dep-mini-btn primary", "Pin new commit");
      pin.type = "button";
      pin.title = `Release with controller commit ${movedTo[1]}`;
      pin.onclick = async () => {
        pin.disabled = true;
        pin.textContent = "Pinning…";
        row?.querySelector(".dep-row-error")?.remove();
        try {
          const scope = deploymentRequestScope({ environment: true });
          const response = await agentApi(`/api/projects/${encodeURIComponent(scope.projectKey)}/deployments/${encodeURIComponent(state.environment)}/controller-pin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ headSha: movedTo[1] }) });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          toast(`Release controller pinned to ${movedTo[1].slice(0, 12)}`);
          void discoverDeploymentPlan();
        } catch (error) {
          pin.disabled = false;
          pin.textContent = "Try again";
          row?.append(depText("div", "dep-row-error", `Pinning failed: ${error.message}`));
        }
      };
      row?.append(pin);
    }
    // A connection that runs no release controller for this target is fixed in its own setup.
    if (item.status !== "ready" && /controller-pin/.test(item.id) && /pins no /.test(item.detail || "")) {
      const setup = depText("button", "dep-mini-btn", "Go to controller setup");
      setup.type = "button";
      setup.onclick = () => showMe(() => deploymentControllerSetupTarget(item.slot || "github"));
      $("#dep-readiness").children[index]?.append(setup);
    }
    // Building the release is one click from its own row.
    if (item.status !== "ready" && item.action === "prepare-artifact" && item.automatic) {
      const build = depText("button", "dep-mini-btn", "Prepare build");
      build.type = "button";
      // The full preparation flow, not a bare build: a commit that is not on GitHub yet
      // is shown for review and published first, which a bare build can only refuse.
      build.title = "Review and publish the source if needed, build it on GitHub Actions, then verify the artifact";
      build.onclick = () => { build.disabled = true; void checkDeploymentReadiness(true); };
      $("#dep-readiness").children[index]?.append(build);
    }
    if (item.status === "ready" || !["connect", "review-source", "review-capabilities"].includes(item.action)) continue;
    const button = depText("button", "dep-mini-btn", item.action === "connect" ? "Set up connection" : item.action === "review-capabilities" ? "Review permissions" : "Review changes");
    button.type = "button";
    button.onclick = () => item.action === "connect"
      ? $("#dep-connections-section").scrollIntoView({ behavior: "smooth", block: "start" })
      : switchPane(item.action === "review-capabilities" ? "capabilities" : "changes");
    $("#dep-readiness").children[index]?.append(button);
    // The server a deployment runs on can be set up from here, scoped to this project.
    if (item.action === "connect" && item.slot === "host") {
      const machine = depText("button", "dep-mini-btn", "Set up on a machine");
      machine.type = "button";
      machine.onclick = () => openMachines({
        project: currentProject(), environment: state.environment,
        onBound: () => { void discoverDeploymentPlan(); },
      });
      $("#dep-readiness").children[index]?.append(machine);
    }
  }
  // Highlight the first step the operator can act on right here.
  const next = [...$("#dep-readiness").children].find((row) => row.dataset.state !== "ready" && row.querySelector(".dep-mini-btn"));
  if (next) {
    next.classList.add("next");
    next.querySelector(".dep-mini-btn")?.classList.add("primary");
  }
  const expired = readiness && Number(readiness.expiresAt) <= Date.now();
  const { busy, preparing, resumable, showPreparation } = deploymentReadinessControls(state, readiness, preparationSuperseded(state));
  const heldRun = state.run?.state === "recovery-required";
  $("#dep-status").textContent = preparing ? state.preparation.message
    : state.preparationRunId ? "Preparing the release. Readiness will be checked again when it finishes."
    : state.loading ? "Checking deployment readiness…"
    : state.error ? "The check could not finish. Resolve the error and check again."
    : deploymentUpToDate() && (!readiness || expired || !outstanding.length) ? "Deployed and up to date. Check readiness again after you commit something new."
    : expired ? "Readiness has expired. Check again before deploying."
    : heldRun && readiness?.ready ? "Release inputs are ready, but the previous deployment is held. Resolve that run before deploying."
    : readiness?.ready ? "Ready to deploy. Review the plan below, then deploy."
    : readiness ? `${outstanding.length} step${outstanding.length === 1 ? "" : "s"} need attention before deployment.`
    : heldRun ? "The deployment run is held. You can still check readiness and prepare a new build."
    : "Check readiness to see what this environment needs.";
  $("#dep-discover").disabled = busy;
  $("#dep-discover").textContent = readiness ? "Check readiness again" : "Check readiness";
  // The button is no longer offered only for the steps psm can run unattended:
  // preparation repairs what it can and asks for the rest, so anything short of
  // ready is something it has a next move on.
  $("#dep-make-ready").hidden = !showPreparation;
  $("#dep-make-ready").disabled = state.loading || preparing;
  $("#dep-make-ready").textContent = resumable
    ? "Resume preparation"
    : "Make ready to deploy";
  $("#dep-make-ready").title = preparing
    ? "Preparation is already running"
    : "Fix what psm can fix, build the release, and check again";
  // Which AI clears the steps psm cannot do alone. It is offered beside the
  // button because that is where the choice is made — a provider or model that
  // has hit its usage window is a reason to switch, not a reason to give up.
  const engineWrap = $("#dep-prep-ai-wrap");
  engineWrap.hidden = $("#dep-make-ready").hidden;
  const engine = preparationEngine();
  const model = preparationModel();
  const effort = preparationEffort();
  $("#dep-prep-ai").value = engine;
  renderEffortOptions($("#dep-prep-effort"), engine, model, effort, WS.name);
  for (const control of [$("#dep-prep-ai"), $("#dep-prep-model"), $("#dep-prep-effort")]) {
    control.disabled = state.loading || preparing;
  }
  engineWrap.title = preparing
    ? "Stop preparation to change the AI it uses"
    : "The provider, model, and reasoning effort that fix what psm cannot fix alone";
  $("#dep-approve").disabled = busy;
  $("#dep-confirm").disabled = !deploymentReadyToApprove();
  $("#dep-confirm").textContent = state.plan?.operation === "rollback" ? "Confirm & roll back" : "Confirm & deploy";
  $("#dep-error").hidden = !state.error;
  $("#dep-error").textContent = state.error || "";
  // An error that names the next step offers it, even when the readiness it came from was cleared.
  if (state.error && /Make ready to deploy/.test(state.error) && !state.loading) {
    const next = depText("button", "dep-mini-btn primary", "Make ready to deploy");
    next.type = "button";
    next.style.marginLeft = "10px";
    next.onclick = () => { state.error = null; void checkDeploymentReadiness(true); };
    $("#dep-error").append(next);
  }
  if (state.readinessTimer) clearTimeout(state.readinessTimer);
  if (readiness && !expired && WS.pane === "deploy") {
    state.readinessTimer = setTimeout(() => {
      if (WS.managedDeploy === state && WS.pane === "deploy") renderDeploymentReadiness();
    }, Math.min(Number(readiness.expiresAt) - Date.now() + 20, 2_147_483_647));
  }
}

/** A deploy-page element, only while it is on screen. */
function shownDeployControl(selector) {
  const node = $(selector);
  return node && !node.hidden && !node.closest("[hidden]") ? node : null;
}

function deploymentConnectionRow(slot) {
  return [...document.querySelectorAll("#dep-connection-setup .dep-connection-row")].find((row) => row.dataset.slot === slot) || null;
}

/** The button that sets up a release controller on the bound GitHub connection, or its connection picker. */
function deploymentControllerSetupTarget(slot = "github") {
  const row = deploymentConnectionRow(slot);
  return row?.querySelector('[data-todo="controller-review"]') || row?.querySelector(".dep-connection-select") || row
    || $("#dep-connections-section");
}

/** Everything the operator has to do on this page now, in the order it must happen. */
function deploymentTodoItems() {
  const state = WS.managedDeploy;
  const environment = deploymentEnvironment();
  if (!environment) return [];
  const items = [];
  const named = (node, fallback) => `“${(node?.textContent || fallback).trim()}”`;
  if (state.error) {
    items.push({ kind: "read", title: "The last check could not finish", detail: state.error, target: () => shownDeployControl("#dep-error") });
  }

  const run = state.run;
  if (run?.state === "recovery-required") {
    const button = ["#dep-run-recover", "#dep-run-close-reload", "#dep-run-close-observation"].map(shownDeployControl).find(Boolean);
    items.push({
      title: `Resolve the held deployment: press ${named(button, "Recheck release outcome")}`,
      detail: $("#dep-run-reason").textContent || run.recoveryReason || "A submitted change has to be observed before anything else can deploy.",
      target: () => button, fallback: () => $("#dep-run-reason"),
    });
  } else if (run && ["failed", "interrupted", "stale-plan"].includes(run.state)) {
    const failed = (run.steps || []).find((step) => step.state === "failed")?.result?.data?.detail;
    const retry = shownDeployControl("#dep-run-retry");
    items.push(retry
      ? { title: "The build failed: press “Retry preparation”", detail: typeof failed === "string" ? failed : run.recoveryReason || "", target: () => shownDeployControl("#dep-run-retry") }
      : { kind: "read", title: `Read why the last ${run.kind === "prepare" ? "build" : "deployment"} stopped`, detail: typeof failed === "string" ? failed : run.recoveryReason || run.state,
        target: () => $("#dep-events .dep-event[data-level='error']"), fallback: () => $("#dep-run-section") });
  }

  const readiness = state.readinessEnvironment === state.environment ? state.readiness : null;
  const readinessRows = [...$("#dep-readiness").children];
  const outstanding = (readiness?.items || []).map((item, index) => ({ item, row: readinessRows[index] })).filter(({ item }) => item.status !== "ready");
  const controllerUnpinned = ({ item }) => /controller-pin/.test(item.id || "") && /pins no /.test(item.detail || "");

  // A connection action that just failed names its own fix.
  if (state.connectionIssue) items.push(state.connectionIssue);

  // What the server already knows, before or without a readiness check.
  for (const blocker of environment.blockers || []) {
    // A readiness check lists the same problem with its own button; one item per action.
    if (readiness && blocker.code === "connection-missing") continue;
    if (blocker.code === "release-controller-unpinned" && outstanding.some(controllerUnpinned)) continue;
    if (blocker.code === "release-controller-unpinned") {
      const slot = String(blocker.message || "").match(/^The (\S+) connection/)?.[1] || "github";
      items.push({ title: `Set up the release controller: press “Review controller setup / update”, or choose a ${slot} connection that has one`, detail: blocker.message, target: () => deploymentControllerSetupTarget(slot) });
    } else if (blocker.code === "connection-missing") {
      const slot = String(blocker.id || "").replace(/^connection:/, "");
      items.push({ title: `Choose a ${slot} connection`, detail: blocker.message, target: () => deploymentConnectionRow(slot)?.querySelector(".dep-connection-select") || deploymentConnectionRow(slot), fallback: () => $("#dep-connections-section") });
    } else if (blocker.code === "source-dirty") {
      items.push({ title: "Commit the deployment inputs", detail: blocker.message, action: () => switchPane("changes"), actionLabel: "Open Changes" });
    } else {
      items.push({ title: blocker.title || "Resolve this blocker", detail: blocker.message });
    }
  }

  // A runtime secret only the operator can type.
  for (const unit of environment.serviceSecrets || []) {
    for (const item of unit.names.filter((entry) => !entry.set)) {
      items.push({
        title: `Enter ${item.name} under “Runtime secrets” and press “Save”`,
        detail: "The service needs it at run time. It is stored on this machine and written only to the server, never to the repository.",
        target: () => document.querySelector(`#dep-secrets [data-secret="${CSS.escape(item.name)}"] input`),
        fallback: () => $("#dep-secrets-section"),
      });
    }
  }

  // Preparation repairs what it can; a blocker the server already named comes first.
  const job = preparationSuperseded(state) ? null : state.preparation;
  if (job) {
    const approve = shownDeployControl("#dep-prep-approve");
    const grants = shownDeployControl("#dep-prep-capabilities");
    if (job.state === "waiting-input") {
      items.push({ title: "Answer the preparation session's question: press “Open preparation session”", detail: job.message || "", target: () => shownDeployControl("#dep-prep-open"), fallback: () => $("#dep-prep-message") });
    } else if (approve && !approve.disabled) {
      items.push({ title: `Review, then press ${named(approve, "Approve")}`, detail: job.message || "", target: () => shownDeployControl("#dep-prep-approve") });
    } else if (grants) {
      items.push({ title: "Grant what preparation asked for: press “Open Capabilities”", detail: job.message || "", target: () => shownDeployControl("#dep-prep-capabilities") });
    } else if (job.state !== "succeeded" && !job.active && shownDeployControl("#dep-make-ready")?.textContent === "Resume preparation") {
      items.push({ title: "Press “Resume preparation”", detail: job.failure || job.message || "", target: () => shownDeployControl("#dep-make-ready") });
    } else if (job.state === "blocked") {
      items.push({ kind: "read", title: $("#dep-prep-title").textContent || "Preparation needs you", detail: job.failure || job.message || "", target: () => $("#dep-prep-failure:not([hidden])") || $("#dep-prep-message") });
    }
  }

  const busy = state.loading || !!state.preparationRunId;
  const expired = readiness && Number(readiness.expiresAt) <= Date.now();
  const upToDate = deploymentUpToDate(environment);
  // A fresh answer is only needed to deploy something new.
  if (!busy && (!readiness || expired) && !upToDate) {
    items.push({ title: `Press ${named($("#dep-discover"), "Check readiness")}`, detail: expired ? "The last answer expired; deploying needs a fresh one." : "psm has not checked what this environment needs yet.", target: () => $("#dep-discover") });
  } else if (readiness && !expired) {
    const makeReady = shownDeployControl("#dep-make-ready");
    const automatic = outstanding.filter(({ item }) => item.automatic);
    if (makeReady && automatic.length && !automatic.some(({ row }) => row?.querySelector(".dep-mini-btn"))) {
      items.push({ title: `Press ${named(makeReady, "Make ready to deploy")}`, detail: `psm can do ${automatic.length === 1 ? "this step" : `these ${automatic.length} steps`} itself: ${automatic.map(({ item }) => item.title).join(", ")}.`, target: () => shownDeployControl("#dep-make-ready") });
    }
    for (const entry of outstanding) {
      const { item, row } = entry;
      // Live already runs the committed source: an unchanged version is the expected state, not a step.
      if (upToDate && item.code === "version-not-increased") continue;
      if (item.automatic && makeReady && !row?.querySelector(".dep-mini-btn")) continue;
      if (controllerUnpinned(entry)) {
        items.push({ title: "Set up the release controller: press “Review controller setup / update”, or choose a GitHub connection that has one", detail: item.detail, target: () => deploymentControllerSetupTarget(item.slot || "github") });
        continue;
      }
      const button = row?.querySelector(".dep-mini-btn.primary") || row?.querySelector(".dep-mini-btn");
      items.push(button
        ? { title: `${item.title}: press ${named(button, "the button")}`, detail: item.detail, target: () => button.isConnected ? button : null, fallback: () => row }
        : { kind: "read", title: `${item.title}: read what it needs`, detail: item.detail, target: () => row });
    }
  }

  // Deploying is the last step: it is not offered while anything above it is still open.
  if (items.some((item) => item.kind !== "read")) return items;
  const plan = state.plan;
  const held = run?.state === "recovery-required";
  if (readiness?.ready && !expired && !held && !busy && !plan) {
    items.push({ title: "Press “Review plan”", detail: "Everything is ready. psm will show the exact changes before anything happens.", target: () => $("#dep-approve") });
  }
  if (plan && !plan.blocked && Number(plan.expiresAt) > Date.now()) {
    if ((plan.acknowledgements || []).length && !$("#dep-ack").checked) {
      items.push({ title: "Read the plan, then tick the acknowledgement", detail: $("#dep-ack-copy").textContent, target: () => $("#dep-ack-wrap") });
    } else if (!$("#dep-confirm").disabled) {
      items.push({ title: `Press ${named($("#dep-confirm"), "Confirm & deploy")}`, detail: $("#dep-approval-note").textContent, target: () => $("#dep-confirm") });
    }
  }
  return items;
}

/** Rebuilt once after any deploy-page render, so it reads what that render left on screen. */
function scheduleDeploymentTodo() {
  if (WS.managedDeploy.todoQueued) return;
  WS.managedDeploy.todoQueued = true;
  queueMicrotask(() => {
    WS.managedDeploy.todoQueued = false;
    const run = WS.managedDeploy.run;
    const running = run && !DEPLOYMENT_TERMINAL_STATES.has(run.state) && run.state !== "recovery-required";
    const environment = deploymentEnvironment();
    const live = environment?.activeRelease;
    renderTodoList($("#dep-todo-list"), $("#dep-todo-count"), deploymentTodoItems(),
      running ? "Nothing needs you right now. The deployment is running."
        : deploymentUpToDate(environment) ? `Nothing needs you right now. ${environment.hostname || environment.id} runs ${live.version || "the active release"} (${String(live.commit).slice(0, 10)}), the latest committed source.`
        : WS.managedDeploy.loading ? "Checking what this environment needs…"
        : "Nothing needs you right now.");
  });
}

function loadDeploymentConnectionSetup() {
  const scope = deploymentRequestScope({ environment: true });
  const environment = deploymentEnvironment();
  if (!environment) return;
  window.PsmDeploymentConnections.render($("#dep-connection-setup"), {
    projectKey: scope.projectKey, environment, api: agentApi,
    isCurrent: () => deploymentRequestIsCurrent(scope),
    onIssue: (issue) => {
      if (!deploymentRequestIsCurrent(scope)) return;
      WS.managedDeploy.connectionIssue = issue;
      scheduleDeploymentTodo();
    },
    onChanged: async () => {
      if (!deploymentRequestIsCurrent(scope)) return;
      WS.managedDeploy.connectionIssue = null;
      invalidateDeploymentReadiness();
      await loadManagedDeploy({ quiet: true });
      if (deploymentRequestIsCurrent(scope)) await checkDeploymentReadiness();
    },
  });
}

function depText(tag, className, text) {
  const node = el(tag, className);
  node.textContent = text == null ? "" : String(text);
  return node;
}

function deploymentEnvironment() {
  const environments = WS.managedDeploy.data?.environments || [];
  return environments.find((environment) => environment.id === WS.managedDeploy.environment)
    || environments[0]
    || null;
}

function usableDeploymentArtifacts() {
  const now = Date.now();
  return (WS.managedDeploy.artifacts || []).filter((artifact) =>
    artifact?.artifactId && artifact.tombstonedAt == null && Number(artifact.retainedUntil) > now
  );
}

function selectDeploymentArtifact(environment) {
  const artifacts = usableDeploymentArtifacts().filter((artifact) =>
    artifact.commitSha === environment?.source?.commit
    && environment?.units?.some((unit) => unit.sourceRepository === artifact.sourceRepository
      && unit.buildProfileDigest === artifact.buildProfileDigest)
  );
  if (!artifacts.some((artifact) => artifact.artifactId === WS.managedDeploy.artifactId)) {
    const next = artifacts[0]?.artifactId || null;
    if (WS.managedDeploy.artifactId !== next) {
      WS.managedDeploy.artifactId = next;
      invalidateDeploymentReadiness();
    }
  }
  return artifacts;
}

function renderDeploymentArtifacts(environment) {
  const select = $("#dep-artifact");
  const artifacts = selectDeploymentArtifact(environment);
  select.replaceChildren();
  if (!artifacts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = `No build for ${environment?.source?.version || "current source"} · ${environment?.source?.commit?.slice(0, 10) || "uncommitted"} — Prepare build`;
    select.append(option);
  } else {
    for (const artifact of artifacts) {
      const option = document.createElement("option");
      option.value = artifact.artifactId;
      option.textContent = [artifact.version || "unknown", artifact.commitSha?.slice?.(0, 10), artifact.artifactId].filter(Boolean).join(" · ");
      option.title = `${artifact.sourceRepository || "artifact"} · prepared ${relTime(artifact.createdAt) || "now"}`;
      select.append(option);
    }
    select.value = WS.managedDeploy.artifactId || "";
  }
  select.disabled = WS.managedDeploy.loading || !artifacts.length;
}

function depStateIcon(state) {
  if (["ready", "healthy", "in-sync", "succeeded", "completed", "active"].includes(state)) return "✓";
  if (["blocked", "conflict", "failed", "error", "stale-plan"].includes(state)) return "×";
  if (["update", "create", "warning", "degraded", "running", "queued"].includes(state)) return "~";
  return "?";
}

function depRows(target, rows, emptyCopy) {
  target.replaceChildren();
  if (!rows?.length) {
    target.append(depText("div", "dep-empty", emptyCopy));
    return;
  }
  for (const item of rows) {
    const row = depText("div", "dep-row", "");
    row.dataset.state = item.state || "unknown";
    row.append(depText("span", "dep-row-icon", depStateIcon(item.state)));
    const copy = depText("div", "", "");
    copy.append(depText("div", "dep-row-title", item.title || item.id || "Check"));
    if (item.detail || item.message) copy.append(depText("div", "dep-row-detail", item.detail || item.message));
    row.append(copy, depText("span", "dep-row-kind", item.kind || item.state || ""));
    target.append(row);
  }
}

function depCard(label, value, detail, accent = false) {
  const card = depText("div", `dep-card${accent ? " accent" : ""}`, "");
  card.append(
    depText("div", "dep-card-label", label),
    depText("div", "dep-card-value", value || "—"),
    depText("div", "dep-card-detail", detail || ""),
  );
  return card;
}

function renderManagedSummary(environment) {
  const summary = $("#dep-summary");
  summary.replaceChildren();
  const source = environment.source || {};
  const active = environment.activeRelease || null;
  const watch = environment.watch || {};
  summary.append(
    depCard("Source", source.version || "No artifact", [source.branch, source.commit?.slice?.(0, 10)].filter(Boolean).join(" · "), true),
    depCard("Active release", active?.version || "Not observed", active?.commit ? active.commit.slice(0, 10) : "No managed receipt"),
    depCard("Public Watch", watch.effectiveState || "not-monitored", watch.observedAt ? `Observed ${relTime(watch.observedAt)}` : "No fresh observation"),
    depCard("Target", environment.target?.targetId || "Not resolved", environment.target?.hostname || environment.hostname || ""),
  );
}

function renderManagedConnections(environment) {
  depRows(
    $("#dep-connections"),
    (environment.connections || []).map((connection) => ({
      state: connection.ready ? "ready" : "blocked",
      title: connection.slot,
      detail: connection.ready
        ? `${connection.profile || "bound"}${connection.principal ? ` · ${connection.principal}` : ""}`
        : connection.detail || "No local profile is bound",
      kind: connection.kind,
    })),
    "This environment declares no connections.",
  );
}

/**
 * The runtime secrets a Node service declares. A value is typed here once, goes
 * to PSM's secret store on this machine, and is never shown again; the server
 * receives it only while a reviewed plan writes it.
 */
function renderServiceSecrets(environment) {
  const units = environment.serviceSecrets || [];
  const section = $("#dep-secrets-section");
  section.hidden = !units.length;
  const list = $("#dep-secrets");
  list.replaceChildren();
  if (!units.length) return;
  const missing = units.flatMap((unit) => unit.names.filter((item) => !item.set));
  $("#dep-secrets-count").textContent = missing.length ? `${missing.length} not set` : "all set · stored on this machine";
  for (const unit of units) {
    for (const item of unit.names) {
      const row = depText("div", "dep-row dep-secret-row", "");
      row.dataset.state = item.set ? "ready" : "blocked";
      row.dataset.secret = item.name;
      row.append(depText("span", "dep-row-icon", item.set ? "✓" : "×"));
      const copy = depText("div", "", "");
      copy.append(depText("div", "dep-row-title", item.name));
      copy.append(depText("div", "dep-row-detail", item.set ? "Set in PSM. Saving a new value replaces it on the next deploy and restarts the service." : "Not set. Deploying is blocked until it is."));
      const form = el("form", "dep-secret-form");
      const input = el("input", "dep-connection-input");
      input.type = "password";
      input.autocomplete = "new-password";
      input.required = true;
      input.placeholder = item.set ? "New value" : "Value";
      input.setAttribute("aria-label", `Value for ${item.name}`);
      const save = depText("button", "dep-mini-btn primary", item.set ? "Replace" : "Save");
      save.type = "submit";
      const status = depText("div", "dep-row-detail", "");
      status.setAttribute("role", "status");
      form.append(input, save);
      form.onsubmit = async (event) => {
        event.preventDefault();
        save.disabled = true;
        status.textContent = "Saving…";
        try {
          const scope = deploymentRequestScope({ environment: true });
          const response = await agentApi(`/api/projects/${encodeURIComponent(scope.projectKey)}/deployments/${encodeURIComponent(environment.id)}/service-secrets/${encodeURIComponent(unit.unitId)}/${encodeURIComponent(item.name)}`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: input.value }),
          });
          input.value = "";
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          invalidateDeploymentReadiness();
          await loadManagedDeploy({ quiet: true });
        } catch (error) {
          save.disabled = false;
          status.textContent = `Not saved: ${error.message}`;
          status.dataset.state = "error";
        }
      };
      copy.append(form, status);
      row.append(copy, depText("span", "dep-row-kind", item.set ? "set" : "missing"));
      list.append(row);
    }
  }
}

function renderManagedReleases(environment) {
  const target = $("#dep-releases");
  target.replaceChildren();
  const releases = environment.releases || [];
  if (!releases.length) {
    target.append(depText("div", "dep-empty", "No managed releases have been observed."));
    return;
  }
  for (const release of releases) {
    const row = depText("div", "dep-row", "");
    row.dataset.state = release.active ? "active" : "ready";
    row.append(depText("span", "dep-row-icon", release.active ? "●" : "○"));
    const copy = depText("div", "", "");
    copy.append(depText("div", "dep-row-title", `${release.version || "unknown"}${release.active ? " · current" : ""}`));
    copy.append(depText("div", "dep-row-detail", [release.releaseId, release.commit?.slice?.(0, 10), release.activatedAt ? relTime(release.activatedAt) : null].filter(Boolean).join(" · ")));
    row.append(copy);
    const actions = depText("div", "dep-release-actions", "");
    if (!release.active && release.retained !== false) {
      const rollback = depText("button", "dep-mini-btn", "Plan rollback");
      rollback.type = "button";
      rollback.dataset.rollbackRelease = release.releaseId;
      actions.append(rollback);
    }
    row.append(actions);
    target.append(row);
  }
}

/** One exact plan's actions, grouped by phase. Shared by the deploy plan and the preparation plan. */
function renderPlanActions(target, plan) {
  target.replaceChildren();
  const grouped = new Map();
  for (const action of plan.actions || []) {
    const phase = action.phase || "plan";
    if (!grouped.has(phase)) grouped.set(phase, []);
    grouped.get(phase).push(action);
  }
  for (const [phase, actions] of grouped) {
    const group = depText("div", "dep-plan-group", "");
    group.append(depText("h4", "", `${phase[0].toUpperCase()}${phase.slice(1)} · ${actions.length}`));
    for (const action of actions) {
      const line = depText("div", "dep-plan-action", "");
      line.append(depText("span", "", depStateIcon(action.state || action.operation)), depText("strong", "", action.title || action.id || action.operation), depText("span", "", action.detail || ""));
      group.append(line);
    }
    target.append(group);
  }
  if (!grouped.size) target.append(depText("div", "dep-empty", "No mutations are required."));
}

function renderDeploymentPlan(plan) {
  scheduleDeploymentTodo();
  const changed = WS.managedDeploy.plan?.digest !== plan?.digest;
  WS.managedDeploy.plan = plan || null;
  WS.managedDeploy.planEnvironment = plan ? WS.managedDeploy.environment : null;
  const section = $("#dep-plan-section");
  section.hidden = !plan;
  if (!plan) { $("#dep-confirm").disabled = true; return; }
  $("#dep-plan-digest").textContent = plan.digest ? plan.digest.slice(0, 22) + "…" : "preview";
  $("#dep-plan-meta").textContent = plan.expiresAt
    ? `Exact plan · expires ${EVENT_TIME_FORMAT.format(new Date(plan.expiresAt))}`
    : "Exact plan ready for review";
  renderPlanActions($("#dep-plan"), plan);
  const acknowledgements = plan.acknowledgements || [];
  $("#dep-ack-wrap").hidden = !acknowledgements.length;
  $("#dep-ack-copy").textContent = acknowledgements.map((item) => item.label || item.message || item.id).join(" ") || "I reviewed this exact plan.";
  if (changed) $("#dep-ack").checked = false;
  $("#dep-approval-note").textContent = plan.blocked
    ? (plan.blockers || []).map((item) => item.message).filter(Boolean).join(" · ") || "Resolve the readiness blockers before deploying"
    : Number(plan.expiresAt) <= Date.now() ? "This plan expired. Check again to review a new exact plan"
    : plan.risk === "production" ? "Production requires the signed-in local operator" : "Approval is bound to this digest";
  $("#dep-confirm").disabled = !deploymentReadyToApprove();
}

function focusDeploymentPlan() {
  const section = $("#dep-plan-section");
  if (!section.hidden) section.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function reviewDeploymentPlan() {
  const state = WS.managedDeploy;
  const plan = state.plan;
  if (!plan || Number(plan.expiresAt) <= Date.now()
    || !state.readiness || Number(state.readiness.expiresAt) <= Date.now()) {
    await checkDeploymentReadiness();
  }
  focusDeploymentPlan();
}

const DEPLOY_PHASES = ["queued", "locks", "preflight", "reconcile", "dispatch", "executor", "verify"];

function deploymentWorkflowUrl(run) {
  for (const event of [...(run.events || [])].reverse()) {
    const receipt = event.data?.receipt;
    // Use only GitHub repository/run identities, never a URL from log text.
    if (typeof receipt?.repository === "string"
      && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(receipt.repository)
      && /^\d+$/.test(String(receipt.providerRunId || ""))) {
      return `https://github.com/${receipt.repository}/actions/runs/${receipt.providerRunId}`;
    }
  }
  return null;
}

function renderDeploymentRun(run) {
  scheduleDeploymentTodo();
  WS.managedDeploy.run = run || null;
  const section = $("#dep-run-section");
  section.hidden = !run;
  if (!run) return;
  $("#dep-run-title").textContent = run.kind === "prepare" ? "Artifact preparation" : "Deployment run";
  $("#dep-run-title").title = run.id || "";
  $("#dep-run-id").textContent = run.id || "";
  $("#dep-run-state").textContent = run.state || "queued";
  const recoveryReason = $("#dep-run-reason");
  recoveryReason.hidden = !run.recoveryReason;
  const heldStep = run.state === "recovery-required" ? (run.steps || []).find((step) => step.state === "recovery-required") : null;
  const heldDetail = heldStep?.result?.data?.detail;
  const missingDispatchReceipt = heldStep?.result?.data?.reason === "dispatch-receipt-unavailable";
  recoveryReason.textContent = missingDispatchReceipt
    ? `${run.recoveryReason || "Provider outcome is unknown"}. The release dispatch receipt is missing. Recheck release outcome will search GitHub and observe the target; it will close the run only when the outcome is established. You can prepare a new build while this deployment remains held.`
    : [run.recoveryReason, typeof heldDetail === "string" ? heldDetail : null].filter(Boolean).join(" · ");
  const progress = $("#dep-run-progress");
  const active = !DEPLOYMENT_TERMINAL_STATES.has(run.state) && run.state !== "recovery-required";
  const pendingAction = WS.managedDeploy.runAction?.runId === run.id ? WS.managedDeploy.runAction.label : null;
  progress.hidden = !active && !pendingAction;
  progress.replaceChildren();
  if (active || pendingAction) {
    progress.append(depText("span", "spinner", ""));
    const latest = run.events?.at(-1);
    const activity = latest?.data?.actionId ? `${latest.message} · ${latest.data.actionId}` : latest?.message || "Waiting for the first update";
    progress.append(depText("span", "", pendingAction || `${activity} · checking for updates…`));
  }
  const workflowUrl = deploymentWorkflowUrl(run);
  const githubLink = $("#dep-run-github");
  githubLink.hidden = !workflowUrl;
  if (workflowUrl) githubLink.href = workflowUrl;
  else githubLink.removeAttribute("href");
  const retry = $("#dep-run-retry");
  retry.hidden = run.kind !== "prepare" || !["failed", "cancelled", "interrupted"].includes(run.state);
  retry.disabled = WS.managedDeploy.loading || !!WS.managedDeploy.preparation?.active;
  retry.onclick = () => { retry.disabled = true; void checkDeploymentReadiness(true); };
  const uncertainReload = run.state === "recovery-required"
    && (run.steps || []).filter((step) => ["submitted", "observed", "recovery-required"].includes(step.state)).length === 1
    && (run.steps || []).some((step) => step.adapterKind === "reload-nginx@1" && ["submitted", "observed", "recovery-required"].includes(step.state));
  $("#dep-run-close-reload").hidden = !uncertainReload;
  const failedReadOnlyObservation = run.state === "recovery-required"
    && String(run.recoveryReason || "").startsWith("post-mutation observation ")
    && (run.steps || []).some((step) => step.state === "completed")
    && !(run.steps || []).some((step) => ["submitted", "observed", "recovery-required"].includes(step.state));
  $("#dep-run-close-observation").hidden = !failedReadOnlyObservation;
  $("#dep-run-recover").hidden = run.state !== "recovery-required" || uncertainReload || failedReadOnlyObservation;
  $("#dep-run-recover").textContent = "Recheck release outcome";
  $("#dep-run-recover").title = missingDispatchReceipt
    ? "Search the controller workflow and observe the target without dispatching another release"
    : "Observe the submitted release again; nothing is re-submitted";
  renderActivityTimes($("#dep-run-times"), [
    ["Created", run.createdAt], ["Started", run.startedAt],
    [run.finishedAt ? "Finished" : "Updated", run.finishedAt || run.updatedAt],
  ]);
  // Each phase's state comes from what the run actually recorded: a finished run's
  // phase is "complete", which is not on the strip, so it cannot say how far it got.
  const aliases = { "acquiring-locks": "locks", "checking-preconditions": "preflight", dependencies: "preflight", reconciling: "reconcile", dispatching: "dispatch", release: "executor", "waiting-executor": "executor", "observing-result": "executor", "importing-artifact": "verify", verifying: "verify", watch: "verify" };
  const phaseIndex = (name) => DEPLOY_PHASES.indexOf(aliases[name] || name);
  const reached = Math.max(0, phaseIndex(String(run.phase || "")), ...(run.events || []).map((event) => phaseIndex(String(event.phase || ""))));
  const stopped = ["failed", "cancelled", "interrupted", "stale-plan"].includes(run.state) ? "failed"
    : run.state === "recovery-required" ? "held" : null;
  const phases = $("#dep-phases");
  phases.replaceChildren();
  DEPLOY_PHASES.forEach((phase, index) => {
    const item = depText("div", "dep-phase", "");
    item.dataset.state = ["succeeded", "rolled-back"].includes(run.state) || index < reached ? "done"
      : index === reached ? stopped || "active" : "pending";
    item.title = { done: "Passed", active: "In progress", failed: "Stopped here", held: "Waiting for recovery here", pending: "Not reached" }[item.dataset.state];
    item.append(depText("span", "dep-phase-dot", ""), depText("span", "dep-phase-copy", phase));
    phases.append(item);
    if (index < DEPLOY_PHASES.length - 1) phases.append(depText("span", "dep-phase-line", ""));
  });
  const events = $("#dep-events");
  // Newest first, so the latest update is visible without scrolling.
  const lines = [];
  for (const event of run.events || []) {
    const line = depText("div", "dep-event", "");
    line.dataset.level = event.level || "info";
    line.append(
      eventTimeNode(event.at, "dep-event-time"),
      depText("span", "dep-event-phase", event.phase || "run"),
      depText("span", "dep-event-message", event.message || event.type || "event"),
    );
    lines.push({ at: event.at, line });
  }
  for (const step of run.steps || []) {
    if (step.state !== "failed") continue;
    const detail = step.result?.data?.detail;
    const line = depText("div", "dep-event", "");
    line.dataset.level = "error";
    line.append(
      eventTimeNode(step.observedAt || step.updatedAt, "dep-event-time"),
      depText("span", "dep-event-phase", "action"),
      depText("span", "dep-event-message", `${step.stepId}: ${typeof detail === "string" ? detail : "Failed; copy the full run log for details"}`),
    );
    lines.push({ at: step.observedAt || step.updatedAt, line });
  }
  events.replaceChildren(...lines.map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0) || b.index - a.index)
    .map((entry) => entry.line));
  if (!(run.events || []).length) events.append(depText("div", "dep-empty", "Waiting for the first durable event…"));
  $("#dep-cancel").disabled = ["succeeded", "failed", "cancelled", "interrupted", "stale-plan", "rolled-back", "recovery-required"].includes(run.state)
    || WS.managedDeploy.runAction?.label === "Requesting cancellation…";
}

function deploymentRunLog(run, { full = false } = {}) {
  const at = (value) => typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : "—";
  const events = run.events || [];
  const steps = run.steps || [];
  const selectedEvents = full || events.length <= 24 ? events : events.slice(-24);
  const lines = [
    `PSM ${run.kind === "prepare" ? "artifact preparation" : "deployment"} run ${run.id}`,
    `State: ${run.state || "unknown"} | Phase: ${run.phase || "unknown"}`,
    ...(run.recoveryReason ? [`Recovery reason: ${run.recoveryReason}`] : []),
    `Created: ${at(run.createdAt)} | Started: ${at(run.startedAt)} | Finished: ${at(run.finishedAt)}`,
    ...(full ? [] : [`Events: ${events.length} total | Steps: ${steps.length} total`,
      ...(selectedEvents.length < events.length ? [`Showing the last ${selectedEvents.length} events; ${events.length - selectedEvents.length} earlier events omitted.`] : [])]),
    "", "Events:",
  ];
  for (const event of selectedEvents) {
    lines.push(`[${at(event.at)}] [${event.phase || "run"}] [${event.level || "info"}] ${event.message || event.type || "event"}`);
    if (event.data != null && (full || ["error", "warning"].includes(event.level))) lines.push(`  data: ${JSON.stringify(event.data)}`);
  }
  if (!events.length) lines.push("(none)");
  lines.push("", "Steps:");
  const selectedSteps = full ? steps : steps.filter((step) => ["failed", "recovery-required", "submitted", "observed"].includes(step.state));
  if (!full && selectedSteps.length < steps.length) lines.push(`${steps.length - selectedSteps.length} completed or cancelled steps omitted.`);
  for (const step of selectedSteps) {
    lines.push(`${step.ordinal}. ${step.stepId} | ${step.state} | ${step.adapterKind}`);
    lines.push(`  submitted: ${at(step.submittedAt)} | observed: ${at(step.observedAt)} | completed: ${at(step.completedAt)}`);
    if (step.result != null) {
      if (full) lines.push(`  result: ${JSON.stringify(step.result)}`);
      else {
        const data = step.result.data || {};
        lines.push(`  outcome: ${step.result.outcome || "unknown"}${data.reason ? ` | reason: ${data.reason}` : ""}`);
        if (data.detail) lines.push(`  detail: ${data.detail}`);
        if (data.receipt?.providerRunId && data.receipt?.repository) lines.push(`  GitHub run: https://github.com/${data.receipt.repository}/actions/runs/${data.receipt.providerRunId}`);
      }
    }
  }
  if (!selectedSteps.length) lines.push("(none requiring attention)");
  return lines.join("\n");
}

function beginDeploymentRunAction(runId, label) {
  const action = { runId, label };
  WS.managedDeploy.runAction = action;
  if (WS.managedDeploy.run?.id === runId) renderDeploymentRun(WS.managedDeploy.run);
  return () => {
    if (WS.managedDeploy.runAction !== action) return;
    WS.managedDeploy.runAction = null;
    if (WS.managedDeploy.run?.id === runId) renderDeploymentRun(WS.managedDeploy.run);
  };
}

async function copyDeploymentRunLog(full = false) {
  const runId = WS.managedDeploy.run?.id;
  if (!runId) return;
  const button = $(full ? "#dep-run-copy-full" : "#dep-run-copy");
  button.disabled = true;
  const endAction = beginDeploymentRunAction(runId, full ? "Loading the complete run log…" : "Preparing run diagnostics…");
  try {
    const response = await agentApi(`/api/deployment-runs/${encodeURIComponent(runId)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.run?.id !== runId) throw new Error(body.error || "Could not load the complete run log");
    if (WS.managedDeploy.run?.id !== runId) return;
    if (!await copyText(deploymentRunLog(body.run, { full }))) throw new Error("The browser refused clipboard access");
    toast(full ? `Copied full run log (${body.run.events?.length || 0} events, ${body.run.steps?.length || 0} steps)` : "Copied recent events and steps requiring attention");
  } catch (error) {
    toast(error.message || "Could not copy the run log");
  } finally {
    button.disabled = false;
    endAction();
  }
}

async function closeUncertainDeploymentReload() {
  const runId = WS.managedDeploy.run?.id;
  if (!runId) return;
  const button = $("#dep-run-close-reload");
  button.disabled = true;
  const endAction = beginDeploymentRunAction(runId, "Closing the paused reload…");
  try {
    const response = await agentApi(`/api/deployment-runs/${encodeURIComponent(runId)}/close-uncertain-reload`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not close the paused run");
    renderDeploymentRun(body.run);
    await loadManagedDeploy({ quiet: true });
    toast("Paused run closed. Check readiness and review a fresh plan after repairing the host helper.");
  } catch (error) {
    toast(error.message || "Could not close the paused run");
  } finally {
    button.disabled = false;
    endAction();
  }
}

async function recoverDeploymentRun() {
  const runId = WS.managedDeploy.run?.id;
  if (!runId) return;
  const button = $("#dep-run-recover");
  button.disabled = true;
  const endAction = beginDeploymentRunAction(runId, "Checking the provider and target…");
  try {
    const response = await agentApi(`/api/deployment-runs/${encodeURIComponent(runId)}/recover`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not check the run again");
    renderDeploymentRun(body.run);
    toast("Checking the provider again…");
  } catch (error) {
    toast(error.message || "Could not check the run again");
  } finally {
    button.disabled = false;
    endAction();
  }
}

async function closeFailedDeploymentObservation() {
  const runId = WS.managedDeploy.run?.id;
  if (!runId) return;
  const button = $("#dep-run-close-observation");
  button.disabled = true;
  const endAction = beginDeploymentRunAction(runId, "Closing the paused observation…");
  try {
    const response = await agentApi(`/api/deployment-runs/${encodeURIComponent(runId)}/close-failed-read-only-observation`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not close the paused run");
    renderDeploymentRun(body.run);
    await loadManagedDeploy({ quiet: true });
    toast("Paused run closed. Check readiness and review a fresh plan.");
  } catch (error) {
    toast(error.message || "Could not close the paused run");
  } finally {
    button.disabled = false;
    endAction();
  }
}

function renderManagedDeploy() {
  scheduleDeploymentTodo();
  const data = WS.managedDeploy.data;
  const environment = deploymentEnvironment();
  if (!data?.managed || !environment) return;
  $("#ws-deploy-managed").hidden = false;
  $("#ws-deploy-setup").hidden = true;
  $("#ws-deploy-legacy").hidden = true;
  $("#dep-managed-title").textContent = `${data.project?.name || WS.name} · ${environment.id}`;
  $("#dep-managed-subtitle").textContent = environment.hostname || environment.target?.hostname || "Managed desired state";
  const recipe = environment.units?.[0]?.recipe;
  const where = `${environment.hostname || "the configured server"}. ${environment.id === "staging" ? "This is the staging environment." : "This is the production environment."}`;
  $("#dep-destination").textContent = recipe === "static-ssh-nginx@1"
    ? `Publish static files with GitHub Actions to ${where}`
    : recipe === "node-service-ssh-nginx@1"
      ? `Build a Node service with GitHub Actions and run it on ${where}`
      : `Deploy using the connections configured for ${environment.id}.`;
  $("#dep-risk").textContent = `${environment.risk || "unknown"} risk`;
  $("#dep-risk").dataset.risk = environment.risk || "unknown";
  const envs = $("#dep-envs");
  envs.replaceChildren();
  const declared = data.environments || [];
  for (const item of declared) {
    const button = el("button", `dep-env${item.id === environment.id ? " on" : ""}`);
    button.type = "button";
    button.dataset.environment = item.id;
    button.disabled = WS.managedDeploy.loading;
    button.setAttribute("aria-pressed", String(item.id === environment.id));
    button.append(depText("span", "dep-env-id", item.id));
    // The domain each environment publishes to, so this is a choice between two
    // places rather than between two words. An environment with no ingress and no
    // monitor has no domain to name, and says so rather than showing blank.
    const host = item.hostname || item.target?.hostname || "";
    const hostLabel = depText("span", "dep-env-host", host || "no domain declared");
    if (!host) hostLabel.classList.add("unset");
    button.append(hostLabel);
    button.title = host ? `${item.id} · ${host} · ${item.risk || "unknown"} risk` : `${item.id} · ${item.risk || "unknown"} risk`;
    envs.append(button);
  }
  // One environment is not a choice, and a single chip reads like a control that
  // is broken rather than one the manifest never asked for.
  if (declared.length === 1) {
    envs.append(depText(
      "span",
      "dep-env-note",
      `Only ${declared[0].id} is declared. Staging is another environment in .psm/deployments.json, not a switch here.`,
    ));
  }
  renderDeploymentArtifacts(environment);
  renderManagedSummary(environment);
  renderManagedConnections(environment);
  renderServiceSecrets(environment);
  renderManagedReleases(environment);
  renderDeploymentPlan(WS.managedDeploy.plan);
  renderDeploymentRun(WS.managedDeploy.run || environment.latestRun || null);
  $("#dep-prepare").disabled = WS.managedDeploy.loading || !environment.canPrepare;
  renderDeploymentPreparation();
  renderDeploymentReadiness();
}

async function loadManagedDeploy({ quiet = false } = {}) {
  if (!WS.name || WS.kind !== "project") return;
  const scope = deploymentRequestScope();
  const state = scope.state;
  const hadData = !!state.data;
  if (!quiet) state.loading = true;
  try {
    const projectBase = deploymentBase(scope.projectKey);
    const [response, artifactsResponse] = await Promise.all([
      agentApi(projectBase),
      agentApi(`${projectBase.slice(0, -"/deployments".length)}/deployment-artifacts`),
    ]);
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw Object.assign(new Error("managed deployment is unavailable"), { code: failure.code });
    }
    const data = await response.json();
    if (!data.managed) throw new Error("no managed manifest");
    const artifactBody = artifactsResponse.ok ? await artifactsResponse.json().catch(() => ({})) : {};
    if (!deploymentRequestIsCurrent(scope)) return;
    const previousEnvironment = state.environment;
    const previousSource = deploymentEnvironment()?.source;
    state.data = data;
    state.artifacts = Array.isArray(artifactBody.artifacts) ? artifactBody.artifacts : state.artifacts;
    if (!state.environment || !data.environments.some((item) => item.id === state.environment)) {
      state.environment = data.environments.find((item) => item.id === "staging")?.id || data.environments[0]?.id || null;
    }
    const environment = deploymentEnvironment();
    if (previousSource?.commit !== environment?.source?.commit || previousSource?.inputsDirty !== environment?.source?.inputsDirty) invalidateDeploymentReadiness(state);
    selectDeploymentArtifact(environment);
    if (!hadData || previousEnvironment !== state.environment) {
      state.plan = environment?.latestPlan || null;
      state.planEnvironment = state.plan ? state.environment : null;
      state.run = environment?.latestRun || null;
      // Preparation belongs to one environment. Carrying the last one's job
      // across the switch would show this environment somebody else's progress.
      state.preparation = null;
      state.preparationPlan = null;
      state.preparationPublication = null;
      state.preparationSignature = "";
      state.preparationObserved = false;
      state.preparationEngine = null;
      state.preparationModel = null;
      state.preparationEffort = null;
    } else if (!state.run && environment?.latestRun) {
      state.run = environment.latestRun;
    }
    state.loading = false;
    if (WS.depEs) {
      WS.depEs.close();
      WS.depEs = null;
    }
    // Show the last answer instead of checking every provider again on each visit.
    if (!state.readiness || state.readinessEnvironment !== state.environment) await restoreDeploymentReadiness(scope);
    renderManagedDeploy();
    loadDeploymentConnectionSetup();
    scheduleDeploymentPreparationPoll(0);
    const run = state.run;
    if (run && !DEPLOYMENT_TERMINAL_STATES.has(run.state)) scheduleDeploymentPoll();
  } catch (error) {
    if (!deploymentRequestIsCurrent(scope)) return;
    state.loading = false;
    $("#ws-deploy-managed").hidden = true;
    // No manifest yet, or no PSM id yet: offer the managed setup first.
    const settingUp = error?.code === "manifest-missing" || error?.code === "project-not-found";
    $("#ws-deploy-setup").hidden = !settingUp;
    if (settingUp) void renderDeploymentSetup(scope);
    $("#ws-deploy-legacy").hidden = false;
    renderDeployControls();
    connectDeployLogs();
  }
}

function offerProjectId(subtitle, body) {
  subtitle.textContent = "Managed deployment keeps its plans and releases under the project's stable id, and this project has none yet.";
  const assign = depText("button", "btn btn-primary", "Give this project a PSM id");
  assign.type = "button";
  assign.title = "Writes .psm/identity.json in the project; nothing else changes";
  assign.onclick = async () => {
    assign.disabled = true;
    try {
      const id = await assignProjectId(projectByName(WS.name) || { name: WS.name });
      WS.id = id;
      toast(`Assigned ${id}`);
      openDeployPane();
    } catch (error) {
      assign.disabled = false;
      toast(error.message);
    }
  };
  body.append(assign);
}

/**
 * A project with no deployment manifest: show what PSM detected and, when the
 * static recipe fits, draft the manifest and its build files from a hostname.
 */
async function renderDeploymentSetup(scope) {
  const body = $("#dep-setup-body");
  const subtitle = $("#dep-setup-subtitle");
  body.replaceChildren();
  subtitle.textContent = "Reading this project…";
  const base = deploymentBase(scope.projectKey).slice(0, -"/deployments".length);
  let setup;
  try {
    const response = await agentApi(`${base}/deployment-setup`);
    const payload = await response.json().catch(() => ({}));
    // Managed deployment is keyed by the project's stable id; a folder without one gets it first.
    if (payload.code === "project-not-found") {
      if (deploymentRequestIsCurrent(scope)) offerProjectId(subtitle, body);
      return;
    }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    setup = payload.setup;
  } catch (error) {
    if (deploymentRequestIsCurrent(scope)) subtitle.textContent = `Could not read this project: ${error.message}`;
    return;
  }
  if (!deploymentRequestIsCurrent(scope)) return;
  subtitle.textContent = setup.recipe === "node-service-ssh-nginx@1"
    ? "PSM can build this client and its Express server on GitHub Actions, run the server as a supervised service behind nginx, and verify and roll back every release."
    : setup.recipe
      ? "PSM can build this project on GitHub Actions and serve it through nginx on your server, with plans, readiness checks, verification and rollback."
      : "This project needs a few changes before managed deployment. The command deploy below still works.";
  const facts = depText("dl", "dep-setup-facts", "");
  for (const [label, value] of [
    ["Repository", setup.repository || "no GitHub origin"],
    ["Branch", setup.branch || "detached"],
    ["Version", setup.version || "none"],
    ["App", setup.app ? `${setup.app.dir || "repository root"} → ${setup.app.output}` : "no Vite app found"],
    ["Server", setup.server ? `${setup.server.framework} in ${setup.server.dir}` : "none"],
  ]) facts.append(depText("dt", "", label), depText("dd", "", value));
  body.append(facts);
  if (!setup.recipe) {
    // What the project needs is known exactly: say it as steps, first.
    const panel = depText("section", "todo-panel", "");
    const head = depText("div", "todo-head", "");
    const count = depText("span", "", "");
    head.append(depText("h3", "", "To do in this project"), count);
    const list = el("ol", "todo-list");
    panel.append(head, list);
    renderTodoList(list, count, setup.blockers.map((blocker) => ({ title: blocker })), "Nothing to change.");
    body.prepend(panel);
    const plan = depText("button", "btn btn-primary", "Ask AI to make these changes");
    plan.type = "button";
    plan.onclick = () => {
      switchPane("ai");
      $("#ws-msg").value = `Prepare ${WS.name} for PSM's managed deployment. Make exactly these changes, as small reviewed commits, and nothing else:\n${setup.blockers.map((blocker, index) => `${index + 1}. ${blocker}`).join("\n")}\nDo not deploy or change any live server.`;
      stashDraft();
      $("#ws-msg").focus();
      toast("Loaded the changes as a prompt — review and Send");
    };
    body.append(plan);
    return;
  }
  if (setup.service) {
    const facts2 = depText("dl", "dep-setup-facts", "");
    for (const [label, value] of [
      ["Runs", `node ${setup.service.entry} in ${setup.service.root}/, as its own service behind nginx`],
      ["Builds", `npm run ${setup.service.buildScript}, then production dependencies of ${setup.service.root}/`],
      ["Config", Object.keys(setup.service.config).join(", ") || "none"],
      ["Secrets", setup.service.secrets.length ? `${setup.service.secrets.join(", ")}: you enter them on the Deploy page; never committed` : "none"],
    ]) facts2.append(depText("dt", "", label), depText("dd", "", value));
    body.append(facts2);
  }
  const form = document.createElement("form");
  form.className = "dep-setup-form";
  const field = (label, value, help) => {
    const wrap = depText("label", "dep-setup-field", "");
    const input = document.createElement("input");
    input.value = value;
    input.required = true;
    input.spellcheck = false;
    wrap.append(depText("span", "", label), input, depText("small", "dep-connection-help", help));
    form.append(wrap);
    return input;
  };
  const hostname = field("Hostname", setup.suggested.hostname, "Where the site will be served. PSM creates its DNS record, nginx site and certificate.");
  const zone = field("DNS zone", setup.suggested.zone, "The domain whose DNS PSM manages; the hostname must be inside it.");
  const environment = document.createElement("select");
  for (const value of ["staging", "production"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    environment.append(option);
  }
  const envWrap = depText("label", "dep-setup-field", "");
  envWrap.append(depText("span", "", "Environment"), environment, depText("small", "dep-connection-help", "Start with staging; add production once staging deploys cleanly."));
  form.append(envWrap);
  const submit = depText("button", "btn btn-primary", "Create deployment setup");
  submit.type = "submit";
  const status = depText("p", "dep-connection-help", "Writes .psm/deployments.json, a GitHub build workflow and its prepare script into this project. Nothing is committed or pushed; readiness then walks you through connections, the server and publishing.");
  form.append(submit, status);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "Writing…";
    try {
      const response = await agentApi(`${base}/deployment-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: hostname.value, zone: zone.value, environment: environment.value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      toast(`Wrote ${payload.files.join(", ")}${payload.skipped.length ? `; kept your ${payload.skipped.join(", ")}` : ""}`);
      openDeployPane();
    } catch (error) {
      submit.disabled = false;
      submit.textContent = "Create deployment setup";
      status.textContent = `Setup failed: ${error.message}`;
    }
  };
  body.append(form);
}

function scheduleDeploymentPoll() {
  const state = WS.managedDeploy;
  clearDeploymentPoll(state);
  if (!state || WS.pane !== "deploy") return;
  const scope = deploymentRequestScope({ environment: true, run: true });
  state.poll = setTimeout(async () => {
    state.poll = null;
    if (!deploymentRequestIsCurrent(scope) || WS.pane !== "deploy") return;
    const runId = scope.runId;
    if (!runId) return loadManagedDeploy({ quiet: true });
    try {
      const response = await agentApi(`/api/deployment-runs/${encodeURIComponent(runId)}`);
      const body = response.ok ? await response.json() : null;
      if (body && deploymentRequestIsCurrent(scope)) renderDeploymentRun(body.run);
    } catch {}
    if (!deploymentRequestIsCurrent({ ...scope, runId: state.run?.id }) || WS.pane !== "deploy") return;
    const run = state.run;
    if (run && !DEPLOYMENT_TERMINAL_STATES.has(run.state)) scheduleDeploymentPoll();
    else {
      const prepared = state.preparationRunId === run?.id;
      state.preparationRunId = null;
      await loadManagedDeploy({ quiet: true });
      if (prepared && deploymentRequestIsCurrent({ ...scope, runId: state.run?.id })) await checkDeploymentReadiness();
    }
  }, 1500);
}

function openDeployPane() {
  $("#ws-deploy-managed").hidden = true;
  $("#ws-deploy-setup").hidden = true;
  $("#ws-deploy-legacy").hidden = true;
  loadManagedDeploy();
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
  clearConsole($("#ws-depconsole"));
  setDepStatus("idle");
  const es = agentStream(
    `/api/projects/${encodeURIComponent(WS.name)}/logs/stream?kind=${encodeURIComponent(depKind())}`,
  );
  WS.depEs = es;
  es.onopen = () => clearConsole($("#ws-depconsole")); // rebuild on (re)connect, don't duplicate
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
  for (const b of document.querySelectorAll(".ws-target"))
    b.classList.toggle("on", b.dataset.target === WS.depTarget);
  renderDeployControls();
  connectDeployLogs();
}

async function prepareDeploymentArtifact() {
  const environment = deploymentEnvironment();
  if (!environment) return;
  const scope = deploymentRequestScope({ environment: true, artifact: true });
  const state = scope.state;
  invalidateDeploymentReadiness(state);
  state.loading = true;
  state.error = null;
  renderManagedDeploy();
  try {
    const response = await agentApi(`/api/projects/${encodeURIComponent(scope.projectKey)}/deployment-artifacts/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment: environment.id, unitId: environment.units?.[0]?.id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Artifact preparation could not start");
    if (!deploymentRequestIsCurrent(scope)) return;
    state.run = body.run;
    state.preparationRunId = body.run?.id;
    renderDeploymentRun(body.run);
    scheduleDeploymentPoll();
  } catch (error) {
    if (deploymentRequestIsCurrent(scope)) state.error = error.message || "Artifact preparation failed";
  } finally {
    if (deploymentRequestIsCurrent(scope)) {
      state.loading = false;
      renderManagedDeploy();
    }
  }
}

async function restoreDeploymentReadiness(scope) {
  const state = scope.state;
  const environmentId = state.environment;
  if (!environmentId) return;
  try {
    const response = await agentApi(`${deploymentBase(scope.projectKey)}/${encodeURIComponent(environmentId)}/readiness`);
    const body = response.ok ? await response.json() : null;
    if (!body?.readiness || !deploymentRequestIsCurrent(scope) || state.environment !== environmentId) return;
    state.readiness = body.readiness;
    state.readinessEnvironment = environmentId;
    if (body.plan) {
      state.plan = body.plan;
      state.planEnvironment = environmentId;
    }
  } catch {}
}

async function checkDeploymentReadiness(makeReady = false) {
  const scope = deploymentRequestScope({ environment: true });
  const state = scope.state;
  if (!scope.environmentId || state.loading) return;
  const artifactId = state.artifactId;
  invalidateDeploymentReadiness(state);
  state.loading = true;
  state.error = null;
  renderManagedDeploy();
  try {
    const action = makeReady ? "make-ready" : "readiness";
    const response = await agentApi(`${deploymentBase(scope.projectKey)}/${encodeURIComponent(scope.environmentId)}/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      // The whole AI selection goes with the press, so starting or resuming is
      // one choice and one click rather than an edit somewhere else first.
      body: JSON.stringify(makeReady ? {
        artifactId,
        engine: preparationEngine(),
        model: preparationModel(),
        effort: preparationEffort(),
      } : { artifactId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not check deployment readiness");
    if (!deploymentRequestIsCurrent(scope)) return;
    // A preparation poll can discover a new artifact while this page still has
    // the pre-build list. Refresh before rendering, or selection discards it.
    if (body.readiness?.artifactId && !state.artifacts.some((item) => item.artifactId === body.readiness.artifactId)) {
      const artifactsResponse = await agentApi(`${deploymentBase(scope.projectKey).slice(0, -"/deployments".length)}/deployment-artifacts`);
      if (!artifactsResponse.ok) throw new Error("The build finished, but its artifact list could not be refreshed. Check again.");
      const artifactsBody = await artifactsResponse.json();
      if (!deploymentRequestIsCurrent(scope)) return;
      state.artifacts = Array.isArray(artifactsBody.artifacts) ? artifactsBody.artifacts : [];
    }
    state.readiness = body.readiness;
    state.readinessEnvironment = scope.environmentId;
    state.artifactId = body.readiness?.artifactId || null;
    // Only "make ready" reports a preparation job. A plain readiness check must
    // not clear the one already running underneath it.
    if (body.preparation !== undefined) {
      state.preparation = body.preparation;
      state.preparationPlan = null;
      state.preparationPublication = null;
      state.preparationSignature = preparationStep(body.preparation);
      state.preparationObserved = true;
      if (body.preparation?.active) scheduleDeploymentPreparationPoll();
    }
    const index = state.data.environments.findIndex((item) => item.id === scope.environmentId);
    if (body.environment && index >= 0) state.data.environments[index] = body.environment;
    renderDeploymentPlan(body.plan);
    if (body.run) {
      state.run = body.run;
      state.preparationRunId = body.run.id;
      scheduleDeploymentPoll();
    }
  } catch (error) {
    if (deploymentRequestIsCurrent(scope)) state.error = error.message || "Could not check deployment readiness";
  } finally {
    if (deploymentRequestIsCurrent(scope)) {
      state.loading = false;
      renderManagedDeploy();
      loadDeploymentConnectionSetup();
    }
  }
}

/**
 * "Make ready to deploy", watched from the page.
 *
 * The button hands the whole preparation to psm and then this polls one cheap
 * endpoint until it stops moving. Only a real transition — a new state or a new
 * phase — costs a fresh readiness check, so the checklist beside it keeps step
 * with the flow without rebuilding a plan every two seconds.
 */
const PREPARATION_PHASES = {
  check: "Checking",
  repair: "Repairing",
  build: "Building",
  publish: "Publishing source for",
  infrastructure: "Preparing infrastructure for",
};

/** The AI preparation would use next: the operator's pick, else what it last ran, else the project's. */
function preparationEngine() {
  const state = WS.managedDeploy;
  return state.preparationEngine || state.preparation?.engine || WS.engine || "claude";
}

/** Model the next preparation press uses; an empty string explicitly selects the provider default. */
function preparationModel() {
  const state = WS.managedDeploy;
  if (state.preparationModel !== null) return state.preparationModel;
  const engine = preparationEngine();
  if (state.preparation?.engine === engine) return state.preparation.model || "";
  return WS.engine === engine ? WS.model || "" : "";
}

/** Effort the next preparation press uses; an empty string explicitly selects the model default. */
function preparationEffort() {
  const state = WS.managedDeploy;
  if (state.preparationEffort !== null) return state.preparationEffort;
  const engine = preparationEngine();
  if (state.preparation?.engine === engine) return state.preparation.effort || "";
  return WS.engine === engine && WS.model === preparationModel() ? WS.effort || "" : "";
}

function refreshPreparationModels() {
  return refreshModelCatalog(
    WS.name,
    preparationEngine(),
    () => ({ model: preparationModel(), effort: preparationEffort() }),
    $("#dep-prep-effort"),
  );
}

function preparationStep(job) {
  return job ? `${job.state}:${job.phase}` : "";
}

function scheduleDeploymentPreparationPoll(delay = 2000) {
  const state = WS.managedDeploy;
  clearPreparationPoll(state);
  if (!state || WS.pane !== "deploy") return;
  const scope = deploymentRequestScope({ environment: true });
  state.preparationPoll = setTimeout(() => { void pollDeploymentPreparation(scope); }, delay);
}

async function pollDeploymentPreparation(scope) {
  const state = scope.state;
  state.preparationPoll = null;
  if (!deploymentRequestIsCurrent(scope) || WS.pane !== "deploy") return;
  let body;
  try {
    const response = await agentApi(`${deploymentBase(scope.projectKey)}/${encodeURIComponent(scope.environmentId)}/preparation`);
    if (!response.ok) throw new Error("unavailable");
    body = await response.json();
  } catch {
    // A status read that fails is not a preparation that stopped; back off and
    // keep watching rather than telling the operator it is over.
    scheduleDeploymentPreparationPoll(5000);
    return;
  }
  if (!deploymentRequestIsCurrent(scope) || WS.pane !== "deploy") return;
  const job = body.preparation || null;
  // Only a step that changes while the page watches it calls for a new check;
  // the first answer after opening the page is where it already was.
  const moved = state.preparationObserved && preparationStep(job) !== state.preparationSignature;
  state.preparationObserved = true;
  state.preparation = job;
  state.preparationPlan = body.plan || null;
  state.preparationPublication = body.publication || null;
  state.preparationSignature = preparationStep(job);
  if (body.run) renderDeploymentRun(body.run);
  renderDeploymentPreparation();
  renderDeploymentReadiness();
  // A job waiting on grants or on its checkout resumes on the server once that is
  // fixed, so keep watching it: the banner should move without another click.
  if (job?.active) scheduleDeploymentPreparationPoll();
  else if (job?.state === "blocked" && (job.blockedBy === "capabilities" || job.blockedBy === "checkout")) scheduleDeploymentPreparationPoll(3000);
  if (moved) await checkDeploymentReadiness();
}

async function stopDeploymentPreparation() {
  const scope = deploymentRequestScope({ environment: true });
  const state = scope.state;
  if (!scope.environmentId) return;
  clearPreparationPoll(state);
  $("#dep-prep-stop").disabled = true;
  try {
    const response = await agentApi(`${deploymentBase(scope.projectKey)}/${encodeURIComponent(scope.environmentId)}/preparation/cancel`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Preparation could not be stopped");
    if (!deploymentRequestIsCurrent(scope)) return;
    state.preparation = body.preparation || null;
    state.preparationPlan = null;
    state.preparationSignature = preparationStep(state.preparation);
  } catch (error) {
    if (deploymentRequestIsCurrent(scope)) state.error = error.message || "Preparation could not be stopped";
  } finally {
    $("#dep-prep-stop").disabled = false;
    if (deploymentRequestIsCurrent(scope)) renderManagedDeploy();
  }
}

/**
 * Approve the one thing preparation will not do for itself.
 *
 * psm never approves or queues an infrastructure change: it builds the exact
 * plan, shows it here, and waits. Approval is bound to this digest, so what
 * runs is what is on the screen.
 */
async function approvePreparationInfrastructure() {
  const scope = deploymentRequestScope({ environment: true });
  const state = scope.state;
  if (state.preparation?.phase === "publish") return approvePreparationPublication();
  const plan = state.preparationPlan;
  if (!plan || plan.blocked) return;
  $("#dep-prep-approve").disabled = true;
  try {
    const body = await submitPlanApproval(plan, (plan.acknowledgements || []).map((item) => item.id));
    if (!deploymentRequestIsCurrent(scope)) return;
    renderDeploymentRun(body.run);
    scheduleDeploymentPoll();
    scheduleDeploymentPreparationPoll(500);
  } catch (error) {
    if (deploymentRequestIsCurrent(scope)) {
      state.error = error.message || "The infrastructure plan could not be approved";
      renderManagedDeploy();
    }
  } finally {
    if (deploymentRequestIsCurrent(scope)) renderDeploymentPreparation();
  }
}

async function approvePreparationPublication() {
  const scope = deploymentRequestScope({ environment: true });
  const publication = scope.state.preparationPublication;
  if (!publication || !window.confirm(`Publish ${publication.commit} to ${publication.repository}:${publication.branch}?\n\nThis may trigger GitHub workflows.`)) return;
  $("#dep-prep-approve").disabled = true;
  try {
    const base = `/api/source-publications/${encodeURIComponent(publication.id)}`;
    const intentResponse = await agentApi(`${base}/approval-intents`, { method: "POST" });
    const intent = await intentResponse.json();
    if (!intentResponse.ok) throw new Error(intent.error || "Publication review failed");
    const response = await agentApi(`${base}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest: publication.digest, intent: intent.intent }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Publication failed");
  } catch (error) { if (deploymentRequestIsCurrent(scope)) scope.state.error = error.message; }
  finally { if (deploymentRequestIsCurrent(scope)) { scheduleDeploymentPreparationPoll(100); renderManagedDeploy(); } }
}

/**
 * A stopped preparation's external blockers describe the environment as it was
 * then; a readiness check made since is the current answer. The newest check
 * time is kept apart from the readiness itself, which is cleared while a new
 * check runs, so the old banner does not come back during it.
 */
/** The environment already runs the committed source: there is nothing new to deploy. */
function deploymentUpToDate(environment = deploymentEnvironment()) {
  const active = environment?.activeRelease?.commit || "";
  const source = environment?.source || {};
  const commit = source.commit || "";
  return active.length >= 7 && commit.length >= 7 && (active.startsWith(commit) || commit.startsWith(active))
    && source.committed !== false && !source.inputsDirty;
}

function preparationSuperseded(state) {
  const readiness = state.readinessEnvironment === state.environment ? state.readiness : null;
  state.lastCheckedAt ||= {};
  if (readiness) state.lastCheckedAt[state.environment] = Math.max(state.lastCheckedAt[state.environment] || 0, Number(readiness.checkedAt) || 0);
  const job = state.preparation;
  if (!job || job.active) return false;
  // A release that went live after this preparation began, and is the committed
  // source, finished what the preparation was for.
  const environment = deploymentEnvironment();
  if (job.state !== "succeeded" && deploymentUpToDate(environment)
    && Number(environment.activeRelease?.activatedAt) > Number(job.createdAt)) return true;
  return job.state === "blocked" && job.blockedBy === "external"
    && (state.lastCheckedAt[state.environment] || 0) > Number(job.updatedAt);
}

function renderDeploymentPreparation() {
  scheduleDeploymentTodo();
  const state = WS.managedDeploy;
  const job = preparationSuperseded(state) ? null : state.preparation;
  const section = $("#dep-preparation");
  section.hidden = !job;
  if (!job) return;
  section.dataset.state = job.state;
  renderActivityTimes($("#dep-prep-times"), [["Started", job.createdAt], ["Updated", job.updatedAt]]);
  const waitingForGrants = job.state === "blocked" && job.blockedBy === "capabilities";
  const waitingForCheckout = job.state === "blocked" && job.blockedBy === "checkout";
  $("#dep-prep-title").textContent = job.state === "succeeded" ? "This deployment is ready"
    : job.state === "cancelled" ? "Preparation stopped"
    : waitingForGrants ? "Grant capabilities to continue"
    : waitingForCheckout ? "Fix the Git checkout to continue"
    : job.state === "blocked" ? "Preparation needs you"
    : `${PREPARATION_PHASES[job.phase] || "Preparing"} this deployment`;
  // Name the AI on the panel: when a run stops on a usage limit, the provider
  // that stopped it is the first thing the operator needs to know.
  $("#dep-prep-state").textContent = job.engine
    ? `${String(job.state).replace(/-/g, " ")} · ${job.engine}`
    : String(job.state).replace(/-/g, " ");
  $("#dep-prep-message").textContent = waitingForGrants
    ? `${job.message || ""} Preparation resumes on its own once they are granted.`
    : waitingForCheckout
      ? `${job.message || ""} Preparation resumes on its own once it is fixed.`
      : job.message || "";
  $("#dep-prep-capabilities").hidden = !waitingForGrants;
  $("#dep-prep-failure").hidden = !job.failure;
  $("#dep-prep-failure").textContent = job.failure || "";
  const plan = job.state === "awaiting-approval" ? state.preparationPlan : null;
  $("#dep-prep-plan").hidden = !plan;
  if (plan) renderPlanActions($("#dep-prep-plan"), plan);
  $("#dep-prep-approve").textContent = "Approve infrastructure plan";
  $("#dep-prep-approve").hidden = !plan;
  $("#dep-prep-approve").disabled = !plan || !!plan.blocked;
  const publication = job.phase === "publish" && job.state === "awaiting-approval" ? state.preparationPublication : null;
  if (publication) {
    const panel = $("#dep-prep-plan"); panel.hidden = false; panel.replaceChildren();
    const card = depText("div", "dep-publication", "");
    card.append(depText("h3", "", "Publish source to GitHub"));
    const facts = depText("dl", "dep-publication-facts", "");
    const fact = (label, value, title) => {
      const dd = depText("dd", "", value);
      if (title) dd.title = title;
      facts.append(depText("dt", "", label), dd);
    };
    fact("Repository", publication.repository);
    fact("Branch", publication.branch);
    fact("Moves from", String(publication.previousCommit).slice(0, 12), publication.previousCommit);
    fact("To", String(publication.commit).slice(0, 12), publication.commit);
    card.append(facts);
    const commits = String(publication.commits || "").split("\n").filter(Boolean);
    card.append(depText("div", "dep-publication-label", `${commits.length} commit${commits.length === 1 ? "" : "s"}`));
    const list = depText("ul", "dep-publication-commits", "");
    for (const line of commits) {
      const item = depText("li", "", "");
      const [sha, ...subject] = line.split(" ");
      item.append(depText("code", "", sha), document.createTextNode(` ${subject.join(" ")}`));
      list.append(item);
    }
    card.append(list);
    card.append(depText("div", "dep-publication-label", "Files changed"));
    card.append(depText("pre", "dep-publication-changes", publication.changes));
    card.append(depText("p", "dep-publication-note", "Publishes these commits and may trigger GitHub workflows. The deployment build continues after publication is verified."));
    panel.append(card);
    $("#dep-prep-approve").hidden = false;
    $("#dep-prep-approve").disabled = publication.state !== "pending" || publication.expiresAt <= Date.now();
    $("#dep-prep-approve").textContent = "Approve source publication";
  }
  $("#dep-prep-open").hidden = !job.workroomId;
  // Waiting on grants or the checkout is armed, not idle: fixing either restarts it, so it can be stopped.
  $("#dep-prep-stop").hidden = !job.active && !waitingForGrants && !waitingForCheckout;
}

async function discoverDeploymentPlan(operation = "deploy", releaseId = null) {
  if (operation === "deploy") return checkDeploymentReadiness();
  const environment = deploymentEnvironment();
  if (!environment) return;
  const scope = deploymentRequestScope({ environment: true });
  const state = scope.state;
  invalidateDeploymentReadiness(state);
  state.loading = true;
  renderManagedDeploy();
  try {
    const response = await agentApi(`/api/projects/${encodeURIComponent(scope.projectKey)}/deployment-plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment: environment.id, operation, releaseId, artifactId: state.artifactId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not discover deployment changes");
    if (!deploymentRequestIsCurrent(scope)) return;
    renderDeploymentPlan(body.plan);
    if (body.environment) {
      const index = WS.managedDeploy.data.environments.findIndex((item) => item.id === environment.id);
      if (index >= 0) WS.managedDeploy.data.environments[index] = body.environment;
      renderManagedDeploy();
    }
  } catch (error) {
    if (deploymentRequestIsCurrent(scope)) state.error = error.message || "Discovery failed";
  } finally {
    if (deploymentRequestIsCurrent(scope)) { state.loading = false; renderManagedDeploy(); }
  }
}

/**
 * Approve one exact plan.
 *
 * The intent is minted and spent against the same digest the page is showing,
 * so an approval can only ever apply to the plan that was actually reviewed —
 * which is why both the Deploy button and the preparation flow go through here
 * rather than each assembling the pair themselves.
 */
async function submitPlanApproval(plan, acknowledgementIds) {
  const intentResponse = await agentApi(`/api/deployment-plans/${encodeURIComponent(plan.id)}/approval-intents`, { method: "POST" });
  const intentBody = await intentResponse.json().catch(() => ({}));
  if (!intentResponse.ok) throw new Error(intentBody.error || "Could not create an approval intent");
  const response = await agentApi(`/api/deployment-plans/${encodeURIComponent(plan.id)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision: plan.revision,
      digest: plan.digest,
      intent: intentBody.intent,
      acknowledgementIds,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The plan could not be approved");
  return body;
}

async function approveDeploymentPlan() {
  if (!deploymentReadyToApprove()) return;
  const scope = deploymentRequestScope({ environment: true, plan: true, artifact: true });
  const state = scope.state;
  const plan = WS.managedDeploy.plan;
  if (!plan || plan.blocked) return;
  const acknowledgements = plan.acknowledgements || [];
  if (acknowledgements.length && !$("#dep-ack").checked) return toast("Review and acknowledge the production plan first");
  state.loading = true;
  state.error = null;
  let started = false;
  renderDeploymentReadiness();
  $("#dep-approval-note").textContent = "Submitting the approved deployment plan…";
  try {
    const body = await submitPlanApproval(plan, acknowledgements.map((item) => item.id));
    if (!deploymentRequestIsCurrent(scope)) return;
    renderDeploymentRun(body.run);
    started = true;
    scheduleDeploymentPoll();
  } catch (error) {
    if (deploymentRequestIsCurrent(scope)) {
      state.error = error.message || "Deployment could not start";
      invalidateDeploymentReadiness(state);
    }
  } finally {
    // A failed approval clears the plan, so compare project/environment here.
    if (deploymentRequestIsCurrent({ state, projectKey: scope.projectKey, environmentId: scope.environmentId })) {
      state.loading = false;
      renderManagedDeploy();
      if (started) $("#dep-run-section").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

async function cancelDeploymentRun() {
  const run = WS.managedDeploy.run;
  if (!run) return;
  const button = $("#dep-cancel");
  button.disabled = true;
  const endAction = beginDeploymentRunAction(run.id, "Requesting cancellation…");
  try {
    const response = await agentApi(`/api/deployment-runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Cancellation request failed");
    if (WS.managedDeploy.run?.id === run.id) renderDeploymentRun(body.run);
  } catch (error) {
    toast(error.message || "Cancellation request failed");
  } finally {
    endAction();
    if (WS.managedDeploy.run?.id === run.id) renderDeploymentRun(WS.managedDeploy.run);
  }
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
  const r = await agentApi(`/api/projects/${encodeURIComponent(WS.name)}/run`, {
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
  await agentApi(`/api/projects/${encodeURIComponent(WS.name)}/stop`, {
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
  const r = await agentApi(`/api/projects/${encodeURIComponent(WS.name)}/run`, {
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
  await agentApi(`/api/projects/${encodeURIComponent(WS.name)}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "run" }),
  });
  pollProcs();
}

async function pollProcs() {
  try {
    const r = await agentApi("/api/procs");
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
$("#ws-clear").onclick = () => clearConsole();
$("#ws-download").onclick = () => downloadLog();
$("#ws-tabs").onclick = (e) => {
  const t = e.target.closest(".ws-tab");
  if (t) switchPane(t.dataset.pane);
};

/* ---- Notes pane controls ---- */
$("#note-compose").onsubmit = (e) => {
  e.preventDefault();
  addNote();
};
$("#note-text").onkeydown = (e) => {
  // The composer is a textarea because a stack trace is worth pasting whole, so
  // Enter has to stay Enter and the chord is what saves.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    addNote();
  }
};
$("#note-kinds").onclick = (e) => {
  const button = e.target.closest(".note-kind");
  if (!button) return;
  NOTES.kind = button.dataset.kind;
  renderNotes();
  $("#note-text").focus();
};
$("#note-filters").onclick = (e) => {
  const button = e.target.closest(".note-filter");
  if (!button) return;
  NOTES.filter = button.dataset.filter;
  renderNotes();
};
$("#ws-reload").onclick = () => {
  const iframe = $("#ws-webframe").querySelector("iframe");
  if (iframe) iframe.src = iframe.src; // reassigning src forces a reload
};
$("#ws-openext").onclick = () => {
  const url = webUrl(); // always the real app, never the dev-mode proxy
  if (url) window.open(url, "_blank");
};
$("#ws-dev").onclick = () => toggleDevMode();
$("#web-pick").onclick = () => {
  DEV.picking = !DEV.picking;
  renderDevMode();
  postPreview({ type: DEV.picking ? "arm" : "disarm" });
};
$("#web-apply").onclick = applyDevNotes;
$("#web-notes-clear").onclick = () => {
  if (!DEV.notes.length) return;
  DEV.notes = [];
  saveDevNotes();
  renderDevMode();
  syncPreviewPins();
};
for (const set of AI_CONTROLS) {
  $(set.engine).onchange = (e) => applyEngine(e.target.value);
  $(set.model).onchange = (e) => {
    applyModel(e.target.value);
    $(set.effort).focus();
  };
  $(set.model).onfocus = refreshAiModels;
  $(set.effort).onfocus = refreshAiModels;
  $(set.effort).onchange = (e) => applyEffort(e.target.value);
  $(set.full).onchange = (e) => applyFullAccess(e.target.checked);
}
$("#web-usage").onclick = openUsage;
$("#ws-send").onclick = sendAi;
$("#ws-cancel").onclick = cancelAi;
$("#ws-session-refresh").onclick = fetchSessionState;
$("#ws-session-answer").onclick = $("#ws-question-answer").onclick = () => {
  const question = WS.question || WS.sessionState?.question;
  if (WS.name && question) openQuestion(conversationKey(), question, true, "ai", null, $("#ws-name").textContent);
};
$("#questions-open").onclick = openQuestions;
$("#questions-close").onclick = closeModals;
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
$("#dep-envs").onclick = (e) => {
  const button = e.target.closest("[data-environment]");
  if (!button || button.dataset.environment === WS.managedDeploy.environment) return;
  if (WS.managedDeploy.loading || WS.managedDeploy.preparationRunId) return;
  clearDeploymentPoll();
  clearPreparationPoll();
  invalidateDeploymentReadiness();
  WS.managedDeploy.environment = button.dataset.environment;
  WS.managedDeploy.error = null;
  WS.managedDeploy.artifactId = null;
  WS.managedDeploy.run = deploymentEnvironment()?.latestRun || null;
  renderManagedDeploy();
  loadDeploymentConnectionSetup();
  if (WS.managedDeploy.run && !DEPLOYMENT_TERMINAL_STATES.has(WS.managedDeploy.run.state)) scheduleDeploymentPoll();
};
$("#dep-releases").onclick = (e) => {
  const button = e.target.closest("[data-rollback-release]");
  if (button) discoverDeploymentPlan("rollback", button.dataset.rollbackRelease);
};
$("#dep-prepare").onclick = prepareDeploymentArtifact;
$("#dep-discover").onclick = async () => { await discoverDeploymentPlan(); focusDeploymentPlan(); };
$("#dep-make-ready").onclick = () => checkDeploymentReadiness(true);
$("#dep-artifact").onchange = (event) => {
  WS.managedDeploy.artifactId = event.target.value || null;
  invalidateDeploymentReadiness();
  renderManagedDeploy();
};
$("#dep-prep-ai").onchange = (event) => {
  WS.managedDeploy.preparationEngine = event.target.value;
  WS.managedDeploy.preparationModel = "";
  WS.managedDeploy.preparationEffort = "";
  renderDeploymentReadiness();
  refreshPreparationModels();
};
$("#dep-prep-model").onchange = (event) => {
  WS.managedDeploy.preparationModel = event.target.value.trim();
  WS.managedDeploy.preparationEffort = "";
  renderDeploymentReadiness();
  $("#dep-prep-effort").focus();
};
$("#dep-prep-model").onfocus = refreshPreparationModels;
$("#dep-prep-effort").onfocus = refreshPreparationModels;
$("#dep-prep-effort").onchange = (event) => {
  WS.managedDeploy.preparationEffort = event.target.value;
  renderDeploymentReadiness();
};
$("#dep-prep-stop").onclick = stopDeploymentPreparation;
$("#dep-prep-capabilities").onclick = () => switchPane("capabilities");
$("#dep-prep-approve").onclick = approvePreparationInfrastructure;
$("#dep-prep-open").onclick = () => {
  const roomId = WS.managedDeploy.preparation?.workroomId;
  if (roomId) openWorkroom(roomId, false, "ai");
};
$("#dep-approve").onclick = reviewDeploymentPlan;
$("#dep-confirm").onclick = approveDeploymentPlan;
$("#dep-run-copy").onclick = () => copyDeploymentRunLog();
$("#dep-run-copy-full").onclick = () => copyDeploymentRunLog(true);
$("#dep-run-close-reload").onclick = closeUncertainDeploymentReload;
$("#dep-run-close-observation").onclick = closeFailedDeploymentObservation;
$("#dep-run-recover").onclick = recoverDeploymentRun;
$("#dep-cancel").onclick = cancelDeploymentRun;
$("#dep-ack").onchange = () => {
  renderDeploymentReadiness();
};
$("#ws-dep-run").onclick = deployRun;
$("#ws-dep-stop").onclick = deployStop;
$("#ws-dep-ai").onclick = guideWithAI;
$("#ws-dep-download").onclick = () => downloadLog(depKind());

/* ---------- actions ---------- */
let toastTimer;
/**
 * Scroll to the exact control or sentence a to-do item names and make it stand
 * out for a moment. `target` may be a function, so content rendered after the
 * list (connection setup loads on its own) still resolves when it is clicked.
 */
function showMe(target) {
  const node = typeof target === "function" ? target() : target;
  if (!node || !node.isConnected) return false;
  const details = node.closest("details");
  if (details) details.open = true;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.remove("attention");
  void node.offsetWidth; // restart the animation when the same item is clicked twice
  node.classList.add("attention");
  clearTimeout(node.attentionTimer);
  node.attentionTimer = setTimeout(() => node.classList.remove("attention"), 2600);
  if (node.matches("button, a[href], input, select, textarea") && !node.disabled) node.focus({ preventScroll: true });
  return true;
}

/**
 * The pinned "To do" list a page opens with (house rule: what to do comes first).
 * Each item: { title, detail?, kind?: "do" | "read", target?, fallback?, action?, actionLabel?, link? }.
 * `link` ({ href, label }) is the direct page on another site, for work psm cannot do itself.
 */
function renderTodoList(list, count, items, emptyCopy) {
  list.replaceChildren();
  const actions = items.filter((item) => item.kind !== "read").length;
  count.textContent = actions ? `${actions} to do` : items.length ? "Read first" : "All clear";
  if (!items.length) {
    const empty = el("li", "todo-empty");
    empty.textContent = emptyCopy;
    list.append(empty);
    return;
  }
  for (const item of items) {
    const row = el("li", "todo-item");
    row.dataset.kind = item.kind || "do";
    const copy = el("div");
    const title = el("div", "todo-title");
    title.textContent = item.title;
    copy.append(title);
    if (item.detail) {
      const detail = el("div", "todo-detail");
      if (window.PsmExternalLinks) window.PsmExternalLinks.linkify(detail, item.detail);
      else detail.textContent = item.detail;
      copy.append(detail);
    }
    row.append(copy);
    const controls = el("div", "todo-actions");
    // Pages on other sites named in the detail are offered directly, not left to be copied.
    const links = item.link ? [item.link] : (window.PsmExternalLinks?.find(item.detail) || []).slice(0, 3);
    for (const link of links) {
      const open = el("a", "dep-mini-btn primary");
      open.href = link.href;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.title = link.href;
      open.textContent = `${link.label || "Open"} ↗`;
      controls.append(open);
    }
    if (item.target || item.action) {
      const go = el("button", "dep-mini-btn");
      go.type = "button";
      go.textContent = item.actionLabel || (item.kind === "read" ? "Show me" : "Take me there");
      go.onclick = () => {
        if (item.action) return item.action();
        if (!showMe(item.target) && item.fallback) showMe(item.fallback);
      };
      controls.append(go);
    }
    if (controls.children.length) row.append(controls);
    list.append(row);
  }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---- is this page still the page psm is serving? -------------------------
 * web/ has no build step and no hashed filenames, so a cockpit left open in a
 * tab keeps running whatever it loaded — through restarts, upgrades, and an edit
 * made a minute ago. It then calls routes this build may no longer have, and the
 * first sign of trouble is whichever button is pressed first failing in a way
 * that looks like the feature is broken rather than the page being old.
 *
 * Only for an agent-served page: a paired hosted page is *meant* to be a
 * different build from the agent it talks to.
 */
let PAGE_ASSETS = null;

async function checkPageFreshness() {
  if (hostedPage() || $("#stale-page").dataset.dismissed) return;
  try {
    const r = await fetch("/api/version", { credentials: "same-origin" });
    if (!r.ok) return;
    const { assets } = await r.json();
    if (!assets) return;
    if (PAGE_ASSETS === null) PAGE_ASSETS = assets; // what this page was loaded from
    else if (assets !== PAGE_ASSETS) $("#stale-page").hidden = false;
  } catch {
    /* the agent being down is a different problem, with its own screen */
  }
}

/* ---------- new project + house rules modals ---------- */
function openModal(id) {
  $("#modal-backdrop").hidden = false;
  $(id).hidden = false;
}
function closeModals() {
  $("#modal-backdrop").hidden = true;
  $("#procs-modal").hidden = true;
  $("#links-modal").hidden = true;
  $("#machines-modal").hidden = true;
  $("#questions-modal").hidden = true;
  $("#new-modal").hidden = true;
  $("#rules-modal").hidden = true;
  $("#usage-modal").hidden = true;
  $("#cap-custom-modal").hidden = true;
  $("#cloud-modal").hidden = true;
  $("#skills-modal").hidden = true;
}

/* ---------- signing in ----------
 * One flow, one application row (`psm`), run by this page in every posture —
 * web/auth.js has it, and it is todo-app's flow. What differs is only who
 * redeems the code, because dapp gives a web client its refresh credential as a
 * SameSite=Lax cookie:
 *
 *   the hosted page   psm.werewolf.solutions is same-*site* with dapp, so the
 *                     page exchanges directly and the cookie rides along.
 *   the cockpit       localhost is cross-site with dapp and the browser would
 *                     drop that cookie, so the page hands its code to the agent
 *                     and asks /api/auth/session who is signed in.
 *
 * Either way the page never holds a refresh credential, which is the property
 * that matters. `SERVED_BY_AGENT` is the switch, and detectHost() sets it.
 * ---------------------------------------------------------------------- */
let AUTH = { user: null, required: false, checked: false, sso: { available: false } };

/**
 * Is there a psm server behind this page?
 *
 * Not a guess from the hostname — the static host runs on localhost:8080 during
 * testing and is every bit as serverless as psm.werewolf.solutions. So ask: the
 * cockpit answers /api/auth/session, and a static host returns 404 (the vhost
 * seals /api/ off deliberately, so this is a designed signal rather than luck).
 */
let SERVED_BY_AGENT = null;
const STARTUP_REQUEST_MS = 8_000;
async function detectHost() {
  if (SERVED_BY_AGENT !== null) return SERVED_BY_AGENT;
  try {
    const r = await fetch("/api/auth/session", {
      credentials: "same-origin",
      signal: AbortSignal.timeout(STARTUP_REQUEST_MS),
    });
    SERVED_BY_AGENT = r.ok && (r.headers.get("content-type") || "").includes("json");
  } catch {
    SERVED_BY_AGENT = false;
  }
  // agent.js starts from a hostname guess; this is the answer.
  PsmAgent.setServedByAgent(SERVED_BY_AGENT);
  // auth.js needs it before the callback is redeemed: the agent-served page
  // hands its code to the agent, which can keep dapp's refresh cookie.
  PsmAuth.configure({ servedByAgent: SERVED_BY_AGENT });
  return SERVED_BY_AGENT;
}
const hostedPage = () => SERVED_BY_AGENT === false;

async function loadSession({ justSignedIn = false } = {}) {
  try {
    await detectHost();
    if (hostedPage()) {
      // Don't re-restore what we just established: the exchange already returned
      // the user, and firing a refresh straight after it would discard a working
      // sign-in if that one call happened to fail.
      if (justSignedIn && AUTH.user) {
        AUTH.checked = true;
        renderAccount();
        return AUTH.user;
      }
      // Otherwise the cookie is the only evidence, and refreshing is how we find
      // out. `restore()` no-ops when there was never a session.
      AUTH.user = (await PsmAuth.restore()) ? AUTH.user || PsmAuth.cachedUser() || { id: "me" } : null;
      AUTH.required = false; // the board degrades to "pair an agent", not a wall
      // Whether dapp will accept this page is only knowable by asking dapp, and
      // beginSignIn() asks before it redirects. Offer the button; it explains
      // itself if the row is missing.
      AUTH.sso = { available: true };
    } else {
      // The agent holds the session — it keeps dapp's refresh cookie, which this
      // page could not. The same call tells us which dapp to sign in against.
      const r = await fetch("/api/auth/session", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(STARTUP_REQUEST_MS),
      });
      const data = await r.json();
      AUTH.user = data.user || null;
      AUTH.required = !!data.required;
      AUTH.sso = data.sso || { available: true };
      PsmAuth.configure({ servedByAgent: true, ...(data.dapp || {}) });
    }
  } catch {
    AUTH.user = null;
  }
  AUTH.checked = true;
  renderAccount();
  return AUTH.user;
}

function renderAccount() {
  const chip = $("#account-chip");
  // Visible everywhere: signing in to a *local* cockpit without retyping a
  // password is the whole point of the redirect flow (docs/werewolf-sso-plan.md).
  // It is optional there — psm works signed out — and required when hosted.
  chip.hidden = false;
  if (AUTH.user) {
    const label = AUTH.user.name || AUTH.user.email || "Account";
    chip.textContent = label.length > 18 ? label.slice(0, 17) + "…" : label;
    chip.title = `Signed in as ${AUTH.user.email || label} — click to sign out`;
    chip.classList.add("on");
  } else {
    chip.textContent = "Sign in";
    chip.title = "Sign in with your Werewolf account";
    chip.classList.remove("on");
  }
  // Signing in or out changes which business workspaces are real (never the
  // personal one); re-ask the agent rather than trusting what was listed before.
  if (AUTH.checked) window.PsmWorkspaces?.refresh();
}

/** Hosted psm cannot show anything until someone is signed in. */
function authGateRequired() {
  return AUTH.required && !AUTH.user;
}

function openAuth() {
  setAuthError("");
  $("#auth-page").hidden = false;
  document.body.classList.add("auth-open");
  renderAuthMode();
}

function closeAuth() {
  if (authGateRequired()) return; // there is nothing behind the gate to show
  $("#auth-page").hidden = true;
  document.body.classList.remove("auth-open");
}

function renderAuthMode() {
  $("#auth-sub").textContent = AUTH.required
    ? "Sign in with your Werewolf account to use psm."
    : "Optional here — psm works signed out. Signing in enables cloud sync and backups.";

  // The handoff is offered only where dapp will accept this instance's callback;
  // elsewhere the panel explains what has to be registered.
  const ssoOk = !!AUTH.sso?.available;
  $("#auth-sso").hidden = !ssoOk;
  const note = $("#auth-sso-note");
  note.hidden = ssoOk || !AUTH.sso?.reason;
  note.textContent = AUTH.sso?.reason || "";
  $("#auth-dismiss").hidden = AUTH.required;
}

function setAuthError(message) {
  const node = $("#auth-error");
  node.textContent = message || "";
  node.hidden = !message;
}

async function signOutOfPsm() {
  // PsmAuth knows which end holds the session — dapp directly, or the agent.
  await PsmAuth.signOut().catch(() => {});
  AUTH.user = null;
  renderAccount();
  toast("Signed out");
  if (AUTH.required) openAuth();
  else load();
}

/* ---------- what's running on this machine ----------
 * psm accounts for the processes it started; this is about the ones it did not.
 * Yesterday's dev server still holding 5173 is why today's climbs to 5176, and
 * nothing in a terminal tells you that. Stopping is two clicks, never one.
 * ---------------------------------------------------------------------- */
let PROCS = { list: [], loading: false, armed: null, error: null };

const fmtAge = (seconds) => {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${Math.round(seconds / 86400)}d`;
};
const fmtMem = (bytes) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)}GB` : `${Math.round(bytes / 1048576)}MB`);

async function openProcs() {
  closeModals();
  openModal("#procs-modal");
  PROCS.armed = null;
  await loadProcs();
}

async function loadProcs() {
  PROCS.loading = true;
  renderProcs();
  try {
    const r = await agentApi("/api/machine/processes");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not read the process list");
    PROCS.list = data.processes || [];
    PROCS.error = null;
  } catch (err) {
    PROCS.error = err.message || "Could not reach psm";
    PROCS.list = [];
  } finally {
    PROCS.loading = false;
    renderProcs();
  }
}

function renderProcs() {
  const body = $("#procs-body");
  const stale = PROCS.list.filter((p) => p.duplicateOf);
  $("#procs-stale").hidden = !stale.length;
  $("#procs-stale").textContent = `Stop ${stale.length} stale`;

  if (PROCS.loading && !PROCS.list.length) {
    $("#procs-summary").textContent = "Reading…";
    body.innerHTML = '<div class="procs-empty">Looking at what\'s running…</div>';
    return;
  }
  if (PROCS.error) {
    $("#procs-summary").textContent = "Unavailable";
    body.innerHTML = "";
    body.append(el("div", "procs-empty", esc(PROCS.error)));
    return;
  }

  const ports = PROCS.list.filter((p) => p.ports.length).length;
  $("#procs-summary").textContent =
    `${PROCS.list.length} process${PROCS.list.length === 1 ? "" : "es"} · ${ports} holding a port` +
    (stale.length ? ` · ${stale.length} look left over` : "");

  body.innerHTML = "";
  if (!PROCS.list.length) {
    body.append(el("div", "procs-empty", "Nothing of note is running."));
    return;
  }

  // group by project so three copies of one dev server read as three copies
  const groups = new Map();
  for (const proc of PROCS.list) {
    const key = proc.project || "Elsewhere on this machine";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(proc);
  }
  for (const [name, procs] of groups) {
    body.append(el("div", "procs-group", esc(name)));
    for (const proc of procs) body.append(procRow(proc));
  }
}

function procRow(proc) {
  const row = el("div", "proc-row" + (proc.duplicateOf ? " stale" : ""));
  const main = el("div", "proc-main");

  const title = el("div", "proc-title");
  title.append(el("span", "proc-label", esc(proc.label)));
  for (const port of proc.ports) title.append(el("span", "proc-port", `:${port}`));
  if (!proc.ports.length && proc.expectedPort) {
    // it is meant to serve this, but nothing is listening — a crashed dev server
    const chip = el("span", "proc-port expected", `:${proc.expectedPort}?`);
    chip.title = "The port psm has for this project — nothing is listening on it";
    title.append(chip);
  }
  if (proc.self) title.append(el("span", "proc-tag self", "this psm"));
  else if (proc.psmManaged) title.append(el("span", "proc-tag psm", "started by psm"));
  if (proc.duplicateOf) {
    const tag = el("span", "proc-tag stale", "left over");
    tag.title = `A newer copy of the same thing is running as pid ${proc.duplicateOf}`;
    title.append(tag);
  }

  const meta = el("div", "proc-meta");
  meta.append(
    el("span", null, `pid ${proc.pid}`),
    el("span", null, `up ${fmtAge(proc.ageSeconds)}`),
    el("span", null, fmtMem(proc.rssBytes)),
  );
  if (proc.cwd) {
    const cwd = el("span", "proc-cwd", esc(proc.cwd));
    cwd.title = proc.command;
    meta.append(cwd);
  }
  main.append(title, meta);
  row.append(main);

  if (proc.self) {
    const note = el("span", "proc-selfnote", "in use");
    note.title = "This is the psm you are looking at";
    row.append(note);
  } else {
    const stop = el("button", "btn proc-stop" + (PROCS.armed === proc.pid ? " danger" : ""));
    stop.textContent = PROCS.armed === proc.pid ? "Confirm stop" : "Stop";
    stop.onclick = () => {
      // two clicks: stopping someone's editor or database by mistake is not
      // something an undo button can fix
      if (PROCS.armed !== proc.pid) {
        PROCS.armed = proc.pid;
        renderProcs();
        setTimeout(() => {
          if (PROCS.armed === proc.pid) {
            PROCS.armed = null;
            renderProcs();
          }
        }, 4000);
        return;
      }
      PROCS.armed = null;
      stopProc(proc);
    };
    row.append(stop);
  }
  return row;
}

async function stopProc(proc, quiet = false) {
  const r = await agentApi(`/api/machine/processes/${proc.pid}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (!quiet) toast(data.error || "Could not stop that process");
    return false;
  }
  if (!quiet) toast(`Stopped ${proc.label} (pid ${proc.pid})`);
  return true;
}

async function stopStale() {
  const stale = PROCS.list.filter((p) => p.duplicateOf && !p.self);
  if (!stale.length) return;
  const button = $("#procs-stale");
  if (button.dataset.armed !== "1") {
    button.dataset.armed = "1";
    button.classList.add("danger");
    button.textContent = `Confirm — stop ${stale.length}`;
    setTimeout(() => {
      button.dataset.armed = "0";
      button.classList.remove("danger");
      renderProcs();
    }, 4000);
    return;
  }
  button.dataset.armed = "0";
  button.classList.remove("danger");
  let stopped = 0;
  for (const proc of stale) if (await stopProc(proc, true)) stopped++;
  toast(stopped ? `Stopped ${stopped} leftover process${stopped === 1 ? "" : "es"}` : "Nothing was stopped");
  // give them a moment to die before asking again
  setTimeout(loadProcs, 600);
}

/* ---------- connecting to the agent ----------
 * The hosted page has no API. Until it is paired with an agent on the user's own
 * machine there is nothing to show, so this screen replaces the board — and,
 * crucially, says *why* rather than spinning.
 * ---------------------------------------------------------------------- */

/** Every state that is not "we can talk to an agent". */
function agentReady() {
  const s = PsmAgent.state();
  return s === "same-origin" || s === "paired";
}

function openConnect() {
  $("#connect-page").hidden = false;
  document.body.classList.add("auth-open");
  $("#connect-base").value = PsmAgent.base() || PsmAgent.defaultBase;
  $("#connect-token").value = PsmAgent.token() || "";
  renderConnect();
}

function closeConnect() {
  $("#connect-page").hidden = true;
  document.body.classList.remove("auth-open");
}

function setConnectError(message) {
  const node = $("#connect-error");
  node.textContent = message || "";
  node.hidden = !message;
}

function setConnectNote(message) {
  const node = $("#connect-note");
  node.textContent = message || "";
  node.hidden = !message;
}

function renderConnect() {
  const state = PsmAgent.state();
  setConnectError(state === "unpaired" && !PsmAgent.detail() ? "" : PsmAgent.detail());
  // A browser that is blocking local-network access is not the user's mistake and
  // not the agent's fault, so it gets its own line rather than an error tone.
  if (state === "blocked-by-browser") {
    setConnectError("");
    setConnectNote(PsmAgent.detail());
  } else {
    setConnectNote("");
  }
}

async function connectToAgent() {
  const button = $("#connect-go");
  button.disabled = true;
  button.textContent = "Connecting…";
  setConnectError("");
  setConnectNote("");
  try {
    const ok = await PsmAgent.connect($("#connect-base").value.trim(), $("#connect-token").value.trim());
    if (!ok) return renderConnect();
    closeConnect();
    toast(`Connected to ${PsmAgent.identity()?.hostname || "your machine"}`);
    await boot();
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
}

async function findAgent() {
  const button = $("#connect-find");
  button.disabled = true;
  button.textContent = "Looking…";
  setConnectError("");
  setConnectNote("");
  try {
    const found = await PsmAgent.discover();
    if (!found) {
      setConnectError("No agent answered on the usual ports. Start one with `npm run agent`.");
      // Say so if the browser is what stopped us, rather than blaming the agent.
      const permission = await PsmAgent.localNetworkPermission();
      if (permission !== "granted" && permission !== "unsupported") {
        setConnectNote(
          "This browser has not granted local-network access to this site, which can look " +
            "exactly like a missing agent. Check the address bar for a permission prompt.",
        );
      }
      return;
    }
    $("#connect-base").value = found.base;
    toast(`Found an agent at ${found.base}`);
  } finally {
    button.disabled = false;
    button.textContent = "Find my agent";
  }
}

/* ---------- linked folders ----------
 * What psm looks at. Dev mode has the configured workspace root baked in and
 * shows it as an unremovable link; agent and hosted modes start with nothing,
 * so this is where a deployed psm gets pointed at real folders.
 * ---------------------------------------------------------------------- */
let LINKS = { links: [], mode: "dev", canLink: true, kind: "workspace", browse: null, busy: false };

const MODE_BLURB = {
  dev: "Dev mode — the workspace root from psm.config.json is scanned automatically. Link more folders to widen it.",
  agent: "Agent mode — nothing is scanned until you link it. Linked folders are read from this machine.",
  hosted: "Hosted mode — this psm has no filesystem. Projects come from a paired agent running on your machine.",
};

async function openLinks() {
  closeModals();
  openModal("#links-modal");
  setLinkError("");
  $("#link-browser").hidden = true;
  await loadLinks();
}

/* ---- pairing: the only thing that lets a hosted page drive this machine ---- */
let PAIRING = { token: null, shown: false };

async function loadPairing() {
  const box = $("#pairing");
  box.hidden = LINKS.mode !== "agent";
  if (box.hidden) return;
  try {
    const r = await agentApi("/api/agent/token");
    if (!r.ok) return (box.hidden = true);
    const data = await r.json();
    PAIRING.token = data.token;
    PAIRING.shown = false;
    $("#pairing-origin").textContent = (data.origins || []).join(", ") || "no origin allowed";
    renderPairing();
  } catch {
    box.hidden = true;
  }
}

function renderPairing() {
  $("#pairing-token").textContent = PAIRING.shown ? PAIRING.token : "•".repeat(24);
  $("#pairing-reveal").textContent = PAIRING.shown ? "Hide" : "Reveal";
}

async function loadLinks() {
  const list = $("#links-list");
  list.innerHTML = '<div class="links-empty">Loading…</div>';
  try {
    const r = await agentApi("/api/links");
    const data = await r.json();
    LINKS.links = data.links || [];
    LINKS.mode = data.mode || "dev";
    LINKS.canLink = !!data.canLink;
  } catch {
    LINKS.links = [];
  }
  renderLinks();
  loadPairing();
}

function renderLinks() {
  $("#links-mode").textContent = MODE_BLURB[LINKS.mode] || MODE_BLURB.dev;
  $("#link-add").disabled = !LINKS.canLink || LINKS.busy;
  $("#link-browse").disabled = !LINKS.canLink;
  $("#link-path").disabled = !LINKS.canLink;

  const list = $("#links-list");
  list.innerHTML = "";
  if (!LINKS.links.length) {
    list.append(el("div", "links-empty", LINKS.canLink
      ? "No folders linked yet."
      : "Hosted psm links nothing directly — pair an agent instead."));
    return;
  }
  for (const link of LINKS.links) {
    const row = el("div", "link-row" + (link.exists ? "" : " missing"));
    const icon = el("span", "link-icon", link.kind === "workspace" ? "📁" : "📦");
    const body = el("div", "link-body");
    const title = el("div", "link-title");
    title.append(el("span", "link-label", esc(link.label)));
    title.append(el("span", "link-kind-tag", link.kind === "workspace" ? "directory of projects" : "single project"));
    if (link.implicit) {
      const tag = el("span", "link-implicit", "from psm.config.json");
      tag.title = "Configured, not linked — edit psm.config.json to change it";
      title.append(tag);
    }
    if (!link.exists) title.append(el("span", "link-missing", "missing"));
    body.append(title, el("code", "link-path", esc(link.path)));
    row.append(icon, body);

    if (!link.implicit) {
      const remove = el("button", "icon-btn", "✕");
      remove.title = "Unlink — the folder itself is not touched";
      remove.onclick = () => unlink(link);
      row.append(remove);
    }
    list.append(row);
  }
}

function setLinkError(message) {
  const node = $("#link-error");
  node.textContent = message || "";
  node.hidden = !message;
}

async function addLink() {
  if (LINKS.busy) return;
  const path = $("#link-path").value.trim();
  if (!path) return setLinkError("Enter or browse to a folder");
  LINKS.busy = true;
  renderLinks();
  setLinkError("");
  try {
    const r = await agentApi("/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: LINKS.kind, path }),
    });
    const data = await r.json();
    if (!r.ok) return setLinkError(data.error || "Could not link that folder");
    LINKS.links = data.links || LINKS.links;
    $("#link-path").value = "";
    $("#link-browser").hidden = true;
    toast(LINKS.kind === "workspace" ? "Linked — scanning its projects" : "Project linked");
    load(); // the board is now different
  } finally {
    LINKS.busy = false;
    renderLinks();
  }
}

async function unlink(link) {
  const r = await agentApi(`/api/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast(data.error || "Could not unlink");
  LINKS.links = data.links || LINKS.links.filter((l) => l.id !== link.id);
  renderLinks();
  toast(`Unlinked ${link.label}`);
  load();
}

/* ---- the folder browser: psm reads the machine it runs on, one level deep ---- */
async function browseTo(path) {
  const panel = $("#link-browser");
  panel.hidden = false;
  const list = $("#link-browser-list");
  list.innerHTML = '<div class="links-empty">Reading…</div>';
  try {
    const params = path ? `?path=${encodeURIComponent(path)}` : "";
    const r = await agentApi(`/api/fs/browse${params}`);
    const data = await r.json();
    if (!r.ok) {
      list.innerHTML = "";
      list.append(el("div", "links-empty", data.error || "Could not read that folder"));
      return;
    }
    LINKS.browse = data;
    renderBrowser();
  } catch {
    list.innerHTML = "";
    list.append(el("div", "links-empty", "Could not reach psm"));
  }
}

function renderBrowser() {
  const data = LINKS.browse;
  if (!data) return;
  $("#link-browser-path").textContent = data.path;
  $("#link-up").disabled = !data.parent;
  const list = $("#link-browser-list");
  list.innerHTML = "";
  if (!data.entries.length) {
    list.append(el("div", "links-empty", "No folders in here."));
    return;
  }
  for (const entry of data.entries) {
    const row = el("button", "browse-row");
    row.type = "button";
    row.append(el("span", "browse-name", esc(entry.name)));
    // the hint is the whole point of browsing: it tells you which kind to pick
    if (entry.projectChildren > 1)
      row.append(el("span", "browse-hint dir", `${entry.projectChildren} projects inside`));
    else if (entry.isProject) row.append(el("span", "browse-hint proj", "project"));
    row.onclick = () => {
      $("#link-path").value = entry.path;
      // a folder full of projects is almost certainly a workspace link; a lone
      // project is almost certainly a single link — preselect, don't force
      if (entry.projectChildren > 1) setLinkKind("workspace");
      else if (entry.isProject) setLinkKind("project");
      browseTo(entry.path);
    };
    list.append(row);
  }
}

function setLinkKind(kind) {
  LINKS.kind = kind;
  for (const button of document.querySelectorAll(".link-kind"))
    button.classList.toggle("on", button.dataset.kind === kind);
}

/* ---------- subscription usage ---------- */
const USAGE_REFRESH_MS = 60_000;
const USAGE_STATE = {
  cache: new Map(),
  inFlight: new Map(),
  failedAt: new Map(), // scope key → when reading it last failed, so we back off
  activeKey: null,
  renderedKey: null,
};

// Which windows apply depends on the model actually in use, not just the one
// typed into the box. With no model configured, Claude reports the one it chose
// on the session's first status — scoping to it keeps a maxed-out weekly Opus
// window from reading as "you are out of usage" while on Sonnet.
function selectedUsageScope() {
  if (!WS.name || WS.chatOnly) return null;
  const configured = WS.model?.trim() || null;
  const model = configured || WS.actualModel?.trim() || null;
  return {
    project: WS.name,
    engine: WS.engine,
    model,
    label: model ? (configured ? model : `${model} (default)`) : "default model",
    key: `${WS.engine}:${model || "default"}`,
  };
}

function resetUsageButton() {
  for (const button of aiControlNodes("usage")) {
    button.textContent = "Usage";
    button.classList.remove("usage-warning", "usage-critical");
  }
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
  $("#usage-scope").textContent = `${scope.project} · ${scope.engine} · ${scope.label}`;
  for (const button of aiControlNodes("usage"))
    button.title = `View ${scope.engine} subscription usage for ${scope.label}`;
  const cached = USAGE_STATE.cache.get(scope.key);
  if (cached && (changed || USAGE_STATE.renderedKey !== scope.key)) {
    renderUsage(cached.snapshot, scope);
    if (Date.now() - cached.checkedAt >= USAGE_REFRESH_MS) fetchUsage(true, true);
  } else if (!cached) {
    resetUsageButton();
    // a status event arrives several times a turn; a provider that cannot be
    // read must not be re-spawned on each one
    const failedAt = USAGE_STATE.failedAt.get(scope.key) || 0;
    if (Date.now() - failedAt >= USAGE_REFRESH_MS) fetchUsage(false, true);
    else markUsageUnreadable();
  }
}

function markUsageUnreadable() {
  for (const button of aiControlNodes("usage")) {
    button.textContent = "Usage ?";
    button.title = "Subscription usage could not be read for this provider";
    button.classList.remove("usage-warning", "usage-critical");
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
  $("#usage-scope").textContent = `${scope.project} · ${scope.engine} · ${scope.label}`;

  // the button shows the window closest to its cap — say which one, so a number
  // driven by one weekly window is never mistaken for "everything is spent"
  const all = providers.flatMap((provider) => provider.windows || [])
    .filter((window) => Number.isFinite(Number(window.usedPercent)));
  const highest = all.length ? Math.max(...all.map((window) => Number(window.usedPercent))) : null;
  const detail = all.map((window) => `${window.label} ${usagePercent(window.usedPercent)}`).join("\n");
  for (const button of aiControlNodes("usage")) {
    button.textContent = highest == null ? "Usage" : `Usage ${Math.round(highest)}%`;
    button.title = detail
      ? `${scope.engine} · ${scope.label}\n${detail}`
      : `View ${scope.engine} subscription usage for ${scope.label}`;
    button.classList.toggle("usage-warning", highest != null && highest >= 80 && highest < 100);
    button.classList.toggle("usage-critical", highest != null && highest >= 100);
  }
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
    const response = await agentApi(url);
    if (!response.ok) throw new Error("usage request failed");
    const snapshot = await response.json();
    const signature = usageSnapshotSignature(snapshot);
    const previous = USAGE_STATE.cache.get(scope.key);
    const changed = !previous || previous.signature !== signature;
    const stored = changed ? snapshot : previous.snapshot;
    USAGE_STATE.failedAt.delete(scope.key);
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
      USAGE_STATE.failedAt.set(scope.key, Date.now());
      if (selectedUsageScope()?.key !== scope.key) return;
      if (!USAGE_STATE.cache.has(scope.key)) {
        $("#usage-body").innerHTML = '<div class="usage-empty usage-empty-error">Usage could not be loaded.</div>';
        markUsageUnreadable(); // the modal may be shut — the button has to carry it
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
  const r = await agentApi("/api/projects/new", {
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
    const r = await agentApi("/api/practices");
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
  RULES.global = await agentApi("/api/house-rules").then((r) => r.json()).then((d) => d.content || "").catch(() => "");
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
  const data = await agentApi("/api/projects/" + encodeURIComponent(scope) + "/rules")
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
    const ok = await agentApi("/api/house-rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: $("#rules-text").value }),
    }).then((r) => r.ok).catch(() => false);
    return ok ? (closeModals(), toast("Workspace rules saved")) : toast("Could not save rules");
  }
  const name = RULES.scope;
  try {
    await agentApi("/api/projects/" + encodeURIComponent(name) + "/practices", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ practices: checkedPractices("#rules-practices-list") }),
    });
    await agentApi("/api/projects/" + encodeURIComponent(name) + "/rules", {
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
  const data = await agentApi("/api/skills-usage" + (project ? "?project=" + encodeURIComponent(project) : ""))
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
$("#account-chip").onclick = () => (AUTH.user ? signOutOfPsm() : openAuth());
$("#auth-form").onsubmit = (e) => e.preventDefault();
$("#auth-dismiss").onclick = closeAuth;
$("#auth-sso").onclick = async () => {
  // A full-page handoff, not a popup: the consent screen needs the
  // werewolf.solutions session cookie, and we get the browser back on a callback.
  // One flow for both postures now, against the one `psm` application row.
  try {
    await PsmAuth.beginSignIn();
  } catch (err) {
    setAuthError(err.message || "Could not start sign-in");
  }
};
$("#connect-go").onclick = connectToAgent;
$("#connect-find").onclick = findAgent;
$("#connect-skip").onclick = closeConnect;
$("#connect-base").addEventListener("keydown", (e) => { if (e.key === "Enter") connectToAgent(); });
$("#connect-token").addEventListener("keydown", (e) => { if (e.key === "Enter") connectToAgent(); });
$("#procs-open").onclick = openProcs;
$("#procs-close").onclick = closeModals;
$("#procs-refresh").onclick = loadProcs;
$("#procs-stale").onclick = stopStale;
$("#stale-reload").onclick = () => location.reload();
$("#stale-dismiss").onclick = () => {
  // Dismissing is for "I know, I am mid-thought" — it does not un-stale the page,
  // so it stays dismissed rather than reappearing every twenty seconds.
  $("#stale-page").dataset.dismissed = "1";
  $("#stale-page").hidden = true;
};
$("#links-open").onclick = openLinks;
$("#machines-open").onclick = () => openMachines();
$("#machines-close").onclick = closeModals;

/** Machines inventory and setup wizard; optionally for one project's environment. */
function openMachines(options = {}) {
  closeModals();
  openModal("#machines-modal");
  void PsmMachines.open({
    api: agentApi,
    root: $("#machines-body"),
    workspace: $("#workspace-select")?.value || "personal",
    projects: () => STATE.projects,
    ...options,
  });
}
$("#links-close").onclick = closeModals;
$("#link-kinds").onclick = (e) => {
  const button = e.target.closest(".link-kind");
  if (button) setLinkKind(button.dataset.kind);
};
$("#link-add").onclick = addLink;
$("#link-path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addLink();
  }
});
$("#link-browse").onclick = () => browseTo($("#link-path").value.trim() || undefined);
$("#link-up").onclick = () => LINKS.browse?.parent && browseTo(LINKS.browse.parent);
$("#link-browser-use").onclick = () => {
  if (!LINKS.browse) return;
  $("#link-path").value = LINKS.browse.path;
  $("#link-browser").hidden = true;
};
$("#link-browser-close").onclick = () => ($("#link-browser").hidden = true);
$("#pairing-reveal").onclick = () => {
  PAIRING.shown = !PAIRING.shown;
  renderPairing();
};
$("#pairing-copy").onclick = async () => {
  if (!PAIRING.token) return;
  try {
    await navigator.clipboard.writeText(PAIRING.token);
    toast("Pairing token copied");
  } catch {
    PAIRING.shown = true; // clipboard blocked — at least let them read it
    renderPairing();
    toast("Copy failed — select the token manually");
  }
};
$("#pairing-rotate").onclick = async () => {
  const r = await agentApi("/api/agent/token/rotate", { method: "POST" });
  if (!r.ok) return toast("Could not rotate the token");
  PAIRING.token = (await r.json()).token;
  PAIRING.shown = true;
  renderPairing();
  toast("Rotated — paired browsers must be paired again");
};
$("#skills-close").onclick = closeModals;
$("#skills-refresh").onclick = () => loadSkills();
$("#skills-scope").onchange = () => loadSkills();
$("#ws-chat-open").onclick = () => openWorkspaceChat();
$("#work-open").onclick = () => openWorkModal();
$("#work-close").onclick = () => closeWorkModal();
$("#work-backdrop").onclick = () => closeWorkModal();
$("#work-form").onsubmit = createWorkroom;
$("#changes-refresh").onclick = () => loadChanges();
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
  const r = await agentApi("/api/export", { method: "POST" });
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
$("#d-engine").onchange = () => {
  if (!editing) return;
  const engine = $("#d-engine").value || "claude";
  $("#d-model").value = "";
  renderEffortOptions($("#d-effort"), engine, "", "");
  refreshModelCatalog(editing.name, engine, () => ({
    model: $("#d-model").value.trim(),
    effort: $("#d-effort").value,
  }), $("#d-effort"));
};
$("#d-model").onchange = () => {
  const engine = $("#d-engine").value || "claude";
  renderEffortOptions($("#d-effort"), engine, $("#d-model").value.trim(), "");
  $("#d-effort").focus();
};
$("#d-model").onfocus = () => {
  if (!editing) return;
  const engine = $("#d-engine").value || editing.aiEngine || "claude";
  refreshModelCatalog(editing.name, engine, () => ({
    model: $("#d-model").value.trim(),
    effort: $("#d-effort").value,
  }), $("#d-effort"));
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#question-modal").hidden) closeQuestion(true);
  else if (!$("#modal-backdrop").hidden) closeModals();
  else closeDrawer();
});

/**
 * Startup. The session comes first: hosted psm has nothing to render until
 * somebody is signed in, and asking the API before that just produces 401s.
 */
async function boot() {
  // The hosted page lands here after the consent screen. Redeem before anything
  // else asks who is signed in, then put the URL back so a reload does not
  // replay a code that is already spent.
  let callbackError = null;
  await detectHost();
  // Take the fingerprint now, while the page and what served it still agree.
  checkPageFreshness();
  // Every posture comes back here now — the cockpit and the hosted page run the
  // same flow, and differ only in who redeems the code (see web/auth.js).
  if (PsmAuth.isCallback()) {
    try {
      AUTH.user = await PsmAuth.completeSignIn(location.search);
    } catch (err) {
      callbackError = err.message || "Sign-in failed";
    }
    history.replaceState(null, "", "/" + PsmAuth.returnTo());
  }

  const ssoError = callbackError;
  await loadSession({ justSignedIn: !!AUTH.user && !callbackError });
  if (authGateRequired() || (ssoError && !AUTH.user)) {
    openAuth();
    if (ssoError) setAuthError(ssoError);
    if (authGateRequired()) return;
  }
  if (ssoError && AUTH.user) toast(ssoError);
  closeAuth();

  // A hosted page has no API of its own until an agent is paired. That is an
  // ordinary state with its own screen, not a crash.
  if (hostedPage()) {
    await PsmAgent.refreshState();
    if (!agentReady()) {
      STATE.projects = [];
      STATE.can = { runsCommands: false, scansImplicitly: false, canLink: false };
      render();
      return openConnect();
    }
  }
  closeConnect();

  try {
    await load();
    pollProcs();
    routeFromHash();
  } catch (err) {
    if (!hostedPage()) throw err;
    STATE.projects = [];
    STATE.can = { runsCommands: false, scansImplicitly: false, canLink: false };
    render();
    openConnect();
  }
}

boot();
window.addEventListener("hashchange", routeFromHash);
setInterval(() => {
  pollProcs();
  fetchSessions(); // questions from other sessions remain visible on every page
  if (!$("#workspace").hidden && WS.pane === "session") fetchSessionState();
  else if (WS.pane === "plan" && PLAN.saved?.status === "reviewing") loadPlan(true);
}, 3000);
setInterval(() => fetchUsage(true, true), USAGE_REFRESH_MS);
setInterval(() => fetchRuntimeServices(), 15_000);
setInterval(checkPageFreshness, 20_000);
