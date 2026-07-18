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
let WS = { name: null, es: null };

function isRunning(name) {
  return STATE.procs[`${name}::run`]?.status === "running";
}

function setWsStatus(status) {
  const badge = $("#ws-status");
  badge.textContent = status;
  badge.dataset.state = status;
  const running = status === "running";
  $("#ws-run").disabled = running;
  $("#ws-stop").disabled = !running;
}

function appendLine(entry) {
  const con = $("#ws-console");
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
  $("#ws-name").textContent = p.name;
  $("#ws-cmd").value = p.runCommand || "";
  $("#ws-console").innerHTML = "";
  setWsStatus("idle");
  $("#ws-backdrop").hidden = false;
  $("#workspace").hidden = false;
  connectLogs(p.name);
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
  es.onerror = () => {}; // EventSource auto-reconnects
}

function closeWorkspace() {
  if (WS.es) WS.es.close();
  WS = { name: null, es: null };
  $("#ws-backdrop").hidden = true;
  $("#workspace").hidden = true;
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

/* ---------- actions ---------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

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
  if (!$("#workspace").hidden) closeWorkspace();
  else closeDrawer();
});

load().then(pollProcs);
setInterval(pollProcs, 3000);
