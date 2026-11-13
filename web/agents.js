/* The Agents page (#/agents): everything working on this machine's projects.
 *
 * The rail lists the executor and the jobs it runs, other executors the hub
 * shows, psm's AI conversations, script agents and other processes psm
 * started, and the MCP clients that call psm. Choosing the executor shows its
 * own page (executor.js: queue, activity, composer); any other agent shows
 * where it runs, what it is doing, its queue and what it is connected to.
 * Nothing is polled while the tab is hidden or the page is closed. */
(() => {
  const node = (tag, text = "", className = "") => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const ago = (ms) => {
    if (!ms) return "—";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(ms).toLocaleDateString();
  };
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const STATE = {
    working: ["Working", "busy"],
    waiting: ["Needs you", "warn"],
    idle: ["Idle", ""],
    off: ["Off", ""],
    error: ["Error", "bad"],
    stopped: ["Stopped", ""],
  };
  // Agents without a project; project agents sit in collapsible project folders.
  const GROUPS = [
    ["ai", "AI sessions", (agent) => agent.group === "ai"],
    ["script", "Script agents", (agent) => agent.group === "process" && agent.agentLike],
    ["process", "Processes", (agent) => agent.group === "process" && !agent.agentLike],
    ["mcp", "MCP clients", (agent) => agent.group === "mcp"],
  ];
  // Inside a project: its project agent, then AI sessions, script agents, other processes.
  const IN_PROJECT = { project: 0, ai: 1, process: 3 };
  const projectRank = (agent) => (agent.group === "process" && agent.agentLike ? 2 : IN_PROJECT[agent.group] ?? 4);
  const STATE_RANK = { waiting: 0, error: 1, working: 2, idle: 3, stopped: 4, off: 5 };

  // Which project folders are open: the user's own choice wins, remembered per browser.
  const FOLDERS_KEY = "psm.agents.openProjects";
  const folders = (() => {
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(FOLDERS_KEY) || "{}"))); } catch { return new Map(); }
  })();
  const saveFolders = () => { try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(Object.fromEntries(folders))); } catch { /* private window */ } };
  const CONNECTION = { hub: "Hub", model: "Model", repo: "Folder", mcp: "MCP", capability: "Capability", port: "Port", sandbox: "Sandbox", agent: "Agent", project: "Project", psm: "psm" };

  let ctx = null;
  let agents = [];
  let stacks = [];
  let stackDraft = null; // the stack being created or edited: { id|null, title, units }
  let unitChoices = null; // { project, units } for the editor's unit picker
  let selected = "executor";
  let filter = "";
  let timer = null;
  let detailToken = 0;
  const watching = () => !!ctx && !document.hidden && (!ctx.isOpen || ctx.isOpen());

  async function get(path) {
    const response = await ctx.api(path);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function badge(state) {
    const [label, tone] = STATE[state] || [state, ""];
    return node("span", label, `exec-badge${tone ? ` exec-${tone}` : ""}`);
  }

  const byId = (id) => agents.find((agent) => agent.id === id) || null;

  function renderSummary(machine) {
    const working = agents.filter((agent) => agent.state === "working").length;
    const waiting = agents.filter((agent) => agent.state === "waiting").length;
    const parts = [`${agents.length} agent${agents.length === 1 ? "" : "s"} on ${machine}`];
    if (working) parts.push(`${working} working`);
    if (waiting) parts.push(`${waiting} waiting for you`);
    ctx.summary.textContent = parts.join(" · ");
  }

  function renderRail() {
    const rail = ctx.rail;
    const search = rail.querySelector(".agents-search") || (() => {
      const input = node("input", "", "agents-search");
      input.type = "search";
      input.placeholder = "Filter by name or project";
      input.setAttribute("aria-label", "Filter agents");
      input.oninput = () => { filter = input.value.trim().toLowerCase(); renderRail(); };
      return input;
    })();
    const list = node("div", "", "agents-groups");
    list.append(stackGroup());
    const matches = (agent) => !filter || `${agent.name} ${agent.project || ""} ${agent.type}`.toLowerCase().includes(filter);
    const shown = agents.filter(matches);

    const executors = shown.filter((agent) => agent.group === "executor");
    if (executors.length) list.append(plainGroup("Executor", executors));

    const byProject = new Map();
    for (const agent of shown) if (agent.project) byProject.set(agent.project, [...(byProject.get(agent.project) || []), agent]);
    if (byProject.size) {
      const group = node("section", "", "agents-group");
      group.append(node("h4", `Projects · ${byProject.size}`, "agents-group-title"));
      const top = (members) => Math.min(...members.map((agent) => STATE_RANK[agent.state] ?? 9));
      const projects = [...byProject].sort(([a, am], [b, bm]) => Math.min(top(am), 3) - Math.min(top(bm), 3) || a.localeCompare(b));
      for (const [project, members] of projects) group.append(projectFolder(project, members));
      list.append(group);
    }

    const loose = shown.filter((agent) => !agent.project && agent.group !== "executor");
    for (const [, title, match] of GROUPS) {
      const members = loose.filter(match);
      if (members.length) list.append(plainGroup(title, members));
    }
    if (!shown.length) list.append(node("div", filter ? "No agent matches." : "No agents yet.", "procs-empty"));
    rail.replaceChildren(search, list);
  }

  function plainGroup(title, members) {
    const group = node("section", "", "agents-group");
    group.append(node("h4", `${title} · ${members.length}`, "agents-group-title"));
    for (const agent of members) group.append(row(agent));
    return group;
  }

  function projectFolder(project, members) {
    members = [...members].sort((a, b) => projectRank(a) - projectRank(b) || (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || a.name.localeCompare(b.name));
    const folder = node("details", "", "agents-folder");
    const needsYou = members.some((agent) => agent.state === "waiting" || agent.state === "error");
    const holdsSelected = members.some((agent) => agent.id === selected);
    // Closed unless you opened it, it needs you, it holds the selected agent or you are filtering.
    folder.open = !!filter || (folders.has(project) ? folders.get(project) : needsYou || holdsSelected);
    const summary = node("summary", "", "agents-folder-head");
    const working = members.filter((agent) => agent.state === "working").length;
    const waiting = members.filter((agent) => agent.state === "waiting").length;
    const counts = [`${members.length} agent${members.length === 1 ? "" : "s"}`];
    if (working) counts.push(`${working} working`);
    if (waiting) counts.push(`${waiting} need${waiting === 1 ? "s" : ""} you`);
    summary.append(node("strong", project), node("span", counts.join(" · "), "agents-folder-meta"));
    const worst = members.reduce((best, agent) => ((STATE_RANK[agent.state] ?? 9) < (STATE_RANK[best] ?? 9) ? agent.state : best), "off");
    if (worst !== "off" && worst !== "stopped") summary.append(badge(worst));
    // Record the choice before the browser toggles it; filtering opens folders without remembering.
    summary.onclick = () => { if (!filter) { folders.set(project, !folder.open); saveFolders(); } };
    folder.append(summary);
    for (const agent of members) folder.append(row(agent));
    return folder;
  }

  function row(agent) {
    const button = node("button", "", `exec-job agents-row${agent.id === selected ? " on" : ""}${agent.parent && agent.group === "executor" ? " agents-child" : ""}`);
    button.type = "button";
    button.dataset.agent = agent.id;
    const head = node("div", "", "exec-job-head");
    head.append(node("strong", agent.name), badge(agent.state));
    const meta = node("div", "", "exec-job-meta");
    const parts = [agent.type];
    if (agent.queue) parts.push(`${agent.queue} queued`);
    if (agent.since) parts.push(ago(agent.since));
    meta.textContent = parts.join(" · ");
    button.append(head, node("div", agent.activity, "exec-job-text"), meta);
    button.onclick = () => select(agent.id, true);
    return button;
  }

  /* ---- stacks: named sets of units, started together ---- */

  const stackId = (id) => `stack:${id}`;
  const runningCount = (stack) => stack.units.filter((unit) => unit.status === "running").length;

  function stackGroup() {
    const group = node("section", "", "agents-group");
    const head = node("div", "", "agents-group-head");
    head.append(node("h4", `Stacks · ${stacks.length}`, "agents-group-title"));
    const add = node("button", "+ New", "agents-link");
    add.type = "button";
    add.onclick = () => { stackDraft = { id: null, title: "", units: [] }; select("stack:new", true); };
    head.append(add);
    group.append(head);
    for (const stack of stacks) {
      const running = runningCount(stack);
      const button = node("button", "", `exec-job agents-row${selected === stackId(stack.id) ? " on" : ""}`);
      button.type = "button";
      button.dataset.agent = stackId(stack.id);
      const top = node("div", "", "exec-job-head");
      top.append(node("strong", stack.title), badge(running === stack.units.length ? "working" : running ? "idle" : "stopped"));
      button.append(top, node("div", stack.units.map((unit) => `${unit.project} ${unit.unit}`).join(" + "), "exec-job-text"), node("div", `${running}/${stack.units.length} running`, "exec-job-meta"));
      button.onclick = () => { stackDraft = null; if (selected !== stackId(stack.id)) lastResults = []; select(stackId(stack.id), true); };
      group.append(button);
    }
    if (!stacks.length) group.append(node("div", "Group units you start together, like a server and the clients that use it.", "exec-job-meta"));
    return group;
  }

  async function send(path, method, body) {
    const response = await ctx.api(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `Request failed (${response.status})`);
    return json;
  }

  const OUTCOME = { started: "started", reused: "already running", external: "already served", blocked: "port taken", "not-startable": "not startable", unknown: "unknown", skipped: "skipped", failed: "failed" };

  function resultLines(results) {
    return results.map((result) => {
      if ("outcome" in result) return `${result.project} ${result.unit}: ${OUTCOME[result.outcome] || result.outcome}${result.reason && result.reason !== "requested" ? ` (${result.reason})` : ""}${result.message ? ` — ${result.message}` : ""}`;
      return `${result.project} ${result.unit}: ${result.stopped ? "stopped" : result.keptFor?.length ? `kept, ${result.keptFor.join(", ")} needs it` : "was not running"}`;
    });
  }

  let lastResults = [];
  async function stackAction(stack, action, force = false) {
    try {
      ctx.detail.querySelector(".agents-stack-note")?.replaceChildren(node("span", action === "start" ? "Starting, dependencies first…" : "Stopping…"));
      const body = await send(`/api/stacks/${encodeURIComponent(stack.id)}/${action}`, "POST", { force });
      lastResults = resultLines(body.results);
    } catch (error) {
      lastResults = [error.message];
    }
    await poll();
    renderStack();
  }

  function renderStack() {
    if (selected === "stack:new" || stackDraft) return renderStackEditor();
    const stack = stacks.find((entry) => stackId(entry.id) === selected);
    if (!stack) {
      ctx.detail.replaceChildren(node("div", "That stack is gone.", "procs-empty"));
      return;
    }
    const head = node("div", "", "exec-detail-head");
    const title = node("div");
    title.append(node("h3", stack.title), node("div", `Stack · ${runningCount(stack)}/${stack.units.length} running`, "hint"));
    const actions = node("div", "", "exec-detail-actions");
    actions.append(
      actionButton("▶ Start", () => void stackAction(stack, "start")),
      actionButton("■ Stop", () => void stackAction(stack, "stop"), runningCount(stack) === 0),
      actionButton("Edit", () => { stackDraft = { id: stack.id, title: stack.title, units: stack.units.map(({ project, unit }) => ({ project, unit })) }; renderStack(); }),
    );
    head.append(title, actions);
    const list = node("ul", "", "agents-connections");
    for (const unit of stack.units) {
      const item = node("li", "", `agents-conn${unit.status === "running" ? " agents-conn-ok" : unit.status === "error" ? " agents-conn-bad" : ""}`);
      item.append(node("span", unit.status === "idle" ? "not started" : unit.status, "agents-conn-kind"));
      const go = node("button", `${unit.project} ${unit.unit}`, "agents-link");
      go.type = "button";
      go.onclick = () => ctx.openProject(unit.project, "scripts");
      item.append(go);
      if (!unit.known) item.append(node("span", "no such script any more", "agents-conn-detail"));
      list.append(item);
    }
    const note = node("div", "", "agents-stack-note");
    if (lastResults.length) note.append(pre(lastResults));
    ctx.detail.replaceChildren(head, section("Units", list), note,
      node("p", "Start brings up what each unit needs first, across projects, and reuses anything already running. Stop keeps a unit that something outside the stack still needs.", "hint"));
  }

  async function loadUnitChoices(project) {
    unitChoices = { project, units: null };
    renderStackEditor();
    try {
      const body = await send(`/api/projects/${encodeURIComponent(project)}/runbook`, "GET");
      if (unitChoices?.project !== project) return;
      unitChoices.units = body.runbook.units.filter((unit) => ["service", "agent", "task"].includes(unit.kind));
    } catch (error) {
      unitChoices.units = [];
      ctx.toast(error.message);
    }
    renderStackEditor();
  }

  function renderStackEditor() {
    const draft = stackDraft || (stackDraft = { id: null, title: "", units: [] });
    const form = node("form", "", "agents-stack-editor");
    form.append(node("h3", draft.id ? "Edit stack" : "New stack"));
    const title = node("input");
    title.maxLength = 60;
    title.value = draft.title;
    title.placeholder = "Todo work";
    title.oninput = () => { draft.title = title.value; };
    const titleField = node("label", "", "scripts-field");
    titleField.append(node("span", "Name"), title);
    form.append(titleField);

    const list = node("ul", "", "agents-connections");
    draft.units.forEach((unit, index) => {
      const item = node("li", "", "agents-conn");
      item.append(node("span", unit.project, "agents-conn-kind"), node("span", unit.unit, "agents-conn-label"));
      const remove = node("button", "Remove", "agents-link");
      remove.type = "button";
      remove.onclick = () => { draft.units.splice(index, 1); renderStackEditor(); };
      item.append(remove);
      list.append(item);
    });
    if (!draft.units.length) list.append(node("li", "No units yet.", "agents-conn-detail"));
    form.append(section("Units", list));

    const picker = node("div", "", "agents-stack-picker");
    const projectSelect = node("select");
    projectSelect.append(Object.assign(node("option", "Project…"), { value: "" }));
    for (const project of ctx.projects()) projectSelect.append(Object.assign(node("option", project), { value: project }));
    projectSelect.value = unitChoices?.project || "";
    projectSelect.onchange = () => projectSelect.value && void loadUnitChoices(projectSelect.value);
    const unitSelect = node("select");
    unitSelect.disabled = !unitChoices?.units?.length;
    unitSelect.append(Object.assign(node("option", unitChoices?.project ? (unitChoices.units ? (unitChoices.units.length ? "Unit…" : "No startable units") : "Reading…") : "Pick a project first"), { value: "" }));
    for (const unit of unitChoices?.units || []) unitSelect.append(Object.assign(node("option", `${unit.id} · ${unit.kind}${unit.port ? ` :${unit.port}` : ""}`), { value: unit.id }));
    const add = actionButton("Add", () => {
      if (!unitChoices?.project || !unitSelect.value) return;
      if (!draft.units.some((unit) => unit.project === unitChoices.project && unit.unit === unitSelect.value)) draft.units.push({ project: unitChoices.project, unit: unitSelect.value });
      renderStackEditor();
    });
    picker.append(projectSelect, unitSelect, add);
    form.append(picker, node("p", "Add only what you start yourself: a client's server comes along on its own when the client's script says it needs it.", "hint"));

    const actions = node("div", "", "exec-detail-actions");
    const save = node("button", "Save stack", "btn btn-primary");
    save.type = "submit";
    actions.append(save, actionButton("Cancel", () => { const id = draft.id; stackDraft = null; unitChoices = null; select(id ? stackId(id) : "executor", true); }));
    if (draft.id) actions.append(actionButton("Delete stack", async () => {
      try {
        await send(`/api/stacks/${encodeURIComponent(draft.id)}`, "DELETE");
        stackDraft = null;
        await poll();
        select("executor", true);
      } catch (error) {
        ctx.toast(error.message);
      }
    }));
    form.append(actions);
    const error = node("div", "", "scripts-warning");
    form.append(error);
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        const body = await send(draft.id ? `/api/stacks/${encodeURIComponent(draft.id)}` : "/api/stacks", draft.id ? "PUT" : "POST", { title: draft.title, units: draft.units });
        stackDraft = null;
        unitChoices = null;
        await poll();
        select(stackId(body.stack.id), true);
      } catch (err) {
        error.textContent = err.message;
      }
    };
    ctx.detail.replaceChildren(form);
  }

  function fact(list, label, value) {
    if (value == null || value === "") return;
    list.append(node("dt", label), node("dd", String(value)));
  }

  function section(title, ...children) {
    const wrap = node("section", "", "agents-section");
    wrap.append(node("h4", title), ...children);
    return wrap;
  }

  function connections(agent) {
    const list = node("ul", "", "agents-connections");
    for (const link of agent.connections) {
      const item = node("li", "", `agents-conn${link.state ? ` agents-conn-${link.state}` : ""}`);
      item.append(node("span", CONNECTION[link.kind] || link.kind, "agents-conn-kind"));
      if (link.agentId && byId(link.agentId)) {
        const go = node("button", link.label, "agents-link");
        go.type = "button";
        go.onclick = () => select(link.agentId, true);
        item.append(go);
      } else item.append(node("span", link.label, "agents-conn-label"));
      if (link.detail) item.append(node("span", link.detail, "agents-conn-detail"));
      list.append(item);
    }
    for (const id of agent.related) {
      const other = byId(id);
      if (!other) continue;
      const item = node("li", "", "agents-conn");
      item.append(node("span", "Same project", "agents-conn-kind"));
      const go = node("button", other.name, "agents-link");
      go.type = "button";
      go.onclick = () => select(id, true);
      item.append(go, node("span", other.type, "agents-conn-detail"));
      list.append(item);
    }
    if (!list.children.length) list.append(node("li", "No connections.", "agents-conn-detail"));
    return list;
  }

  function pre(lines) {
    const box = node("pre", "", "exec-pre agents-log");
    box.textContent = lines.join("\n");
    return box;
  }

  function transcript(events) {
    const list = node("div", "", "agents-transcript");
    for (const event of events) {
      const item = node("div", "", `agents-turn agents-turn-${event.role}`);
      item.append(node("div", `${event.role === "user" ? "You" : event.role === "assistant" ? "AI" : "Tool"} · ${time(event.t)}`, "exec-who"), node("div", event.text, "agents-turn-text"));
      list.append(item);
    }
    if (!events.length) list.append(node("div", "Nothing said yet.", "procs-empty"));
    return list;
  }

  function actionButton(label, onclick, disabled = false) {
    const button = node("button", label, "btn");
    button.type = "button";
    button.disabled = disabled;
    button.onclick = onclick;
    return button;
  }

  /* ---- start and stop a script agent or process ---- */
  let controlNote = null; // { id, lines } from the last start/stop on this page
  let controlBusy = null;
  async function controlAgent(agent, action, force = false) {
    const control = agent.control;
    if (!control || controlBusy) return;
    if (action === "start" && control.costs && !await window.psmConfirm(`${agent.name} calls a paid API while it runs.\n\nStart it?`, "Start agent")) return;
    controlBusy = agent.id;
    controlNote = { id: agent.id, lines: [action === "start" ? "Starting…" : "Stopping…"] };
    renderDetail(agent, lastDetail);
    try {
      if (control.unit) {
        const body = await send(`/api/units/${action}`, "POST", { targets: [{ project: control.project, unit: control.unit }], force });
        controlNote = { id: agent.id, lines: resultLines(body.results || []), keptFor: (body.results || []).some((result) => result.keptFor?.length) };
      } else {
        const body = await send(`/api/projects/${encodeURIComponent(control.project)}/${action === "start" ? "run" : "stop"}`, "POST", { kind: control.kind });
        controlNote = { id: agent.id, lines: [action === "start" ? `Started: ${body.command || agent.name}` : body.stopped === false ? "Was not running." : "Stopped."] };
      }
    } catch (error) {
      controlNote = { id: agent.id, lines: [error.message] };
    } finally {
      controlBusy = null;
    }
    await poll();
    await loadDetail();
  }

  let lastDetail = {};
  function renderDetail(agent, detail) {
    lastDetail = detail;
    const head = node("div", "", "exec-detail-head");
    const title = node("div");
    title.append(node("h3", agent.name), node("div", agent.type, "hint"));
    const actions = node("div", "", "exec-detail-actions");
    actions.append(badge(agent.state));
    if (agent.kind === "ai-session" && agent.project) actions.append(actionButton("Open conversation", () => ctx.openProject(agent.project, "ai")));
    if (agent.control) {
      const busy = controlBusy === agent.id;
      if (agent.control.running) actions.append(actionButton("■ Stop", () => void controlAgent(agent, "stop"), busy));
      else actions.append(actionButton(agent.state === "off" ? "▶ Start" : "▶ Start again", () => void controlAgent(agent, "start"), busy));
    }
    if (agent.kind === "process" && agent.project) actions.append(actionButton(agent.state === "off" ? "Open scripts" : "Open logs", () => ctx.openProject(agent.project, agent.state === "off" ? "scripts" : "logs")));
    if (agent.kind === "project-agent" && detail.jobId) actions.append(actionButton(agent.state === "working" ? "Open in executor activity" : "Last task in executor activity", () => { select("executor", true); ctx.showJob(detail.jobId); }));
    head.append(title, actions);

    const facts = node("dl", "", "agents-facts");
    fact(facts, "Where", agent.where);
    fact(facts, "Project", agent.project);
    fact(facts, "Doing", agent.activity);
    fact(facts, "Since", agent.since ? `${ago(agent.since)} (${new Date(agent.since).toLocaleString()})` : null);
    fact(facts, "Queue", agent.queue ? `${agent.queue} waiting` : "empty");
    if (detail.session) {
      fact(facts, "Session", detail.session.sessionId || "not started");
      fact(facts, "Model", [detail.session.actualModel || detail.session.model || "default", detail.session.effort].filter(Boolean).join(" · "));
      fact(facts, "Messages", detail.session.messages);
    }
    if (detail.command) {
      fact(facts, "Command", detail.command);
      fact(facts, "Folder", detail.folder);
      fact(facts, "PID", detail.pid);
    }
    if (detail.createdAt) fact(facts, "Created", `${new Date(detail.createdAt).toLocaleString()} by ${detail.createdBy}`);

    if (detail.script) fact(facts, "Script", detail.script);
    if (detail.costs) fact(facts, "Costs", "Calls a paid API while it runs");
    const parts = [head];
    if (controlNote?.id === agent.id) {
      const note = node("div", "", "agents-stack-note");
      note.append(pre(controlNote.lines));
      if (controlNote.keptFor && !controlBusy) note.append(actionButton("Stop anyway", () => void controlAgent(agent, "stop", true)));
      parts.push(note);
    }
    parts.push(facts, section("Connections", connections(agent)));
    if (detail.question) {
      const questions = (detail.question.questions || []).map((question) => `• ${question.question}`);
      parts.push(section("Waiting for your answer", pre(questions), actionButton("Answer in the conversation", () => ctx.openProject(agent.project, "ai"))));
    }
    if (detail.queue?.length) parts.push(section(`Queue · ${detail.queue.length}`, pre(detail.queue.map((turn, index) => `${index + 1}. ${turn.message}`))));
    if (detail.recent) parts.push(section("Recent conversation", transcript(detail.recent)));
    if (detail.lines) {
      parts.push(section("Task", node("div", detail.text || "", "agents-turn-text")));
      if (detail.lines.length) parts.push(section("What the agent did", pre(detail.lines.map((line) => `${time(line.at)} ${line.type}${line.ok === false ? " ✗" : ""}  ${line.text}`))));
      if (detail.timeline?.length) parts.push(section("Timeline", pre(detail.timeline.map((event) => `${time(event.at)}  ${event.label}`))));
      if (detail.error) parts.push(section("Error", pre([detail.error])));
    }
    if (detail.items) parts.push(section("Working on", pre(detail.items.map((item) => `${item.project}: ${item.text}`))));
    if (detail.log) parts.push(section("Last log lines", detail.log.length ? pre(detail.log.map((line) => `${time(line.t)} ${line.line}`)) : node("div", "No output yet.", "procs-empty")));
    if (detail.calls) parts.push(section("Recent calls", detail.calls.length ? pre(detail.calls.map((call) => `${time(call.at)}  ${call.tool}${call.projectId ? ` · ${call.projectId}` : ""}  ${call.outcome}`)) : node("div", "No calls yet.", "procs-empty")));
    ctx.detail.replaceChildren(...parts);
  }

  async function loadDetail() {
    if (selected === "executor") return;
    if (selected.startsWith("stack:")) {
      if (!stackDraft) renderStack(); // an open editor is left alone between polls
      return;
    }
    const token = ++detailToken;
    try {
      const body = await get(`/api/agents/${encodeURIComponent(selected)}`);
      if (token !== detailToken) return;
      renderDetail(body.agent, body.detail || {});
    } catch (error) {
      if (token !== detailToken) return;
      const agent = byId(selected);
      if (agent) renderDetail(agent, {});
      else ctx.detail.replaceChildren(node("div", error.message, "procs-empty"));
    }
  }

  function show() {
    const executor = selected === "executor";
    ctx.executorPane.hidden = !executor;
    ctx.detail.hidden = executor;
    for (const button of ctx.rail.querySelectorAll(".agents-row")) button.classList.toggle("on", button.dataset.agent === selected);
  }

  function select(id, fromUser = false) {
    if (!id) id = "executor";
    const changed = id !== selected;
    selected = id;
    show();
    if (changed) controlNote = null;
    if (changed && id !== "executor") ctx.detail.replaceChildren(node("div", "Loading…", "procs-empty"));
    if (fromUser && ctx.onSelect) ctx.onSelect(id);
    void loadDetail();
  }

  async function poll() {
    try {
      const [body, stackBody] = await Promise.all([get("/api/agents"), get("/api/stacks").catch(() => ({ stacks }))]);
      agents = body.agents || [];
      stacks = stackBody.stacks || [];
      renderSummary(body.machine || "this machine");
      renderRail();
      show();
    } catch (error) {
      ctx.summary.textContent = error.message;
    }
  }

  window.PsmAgents = {
    open(options) {
      ctx = options;
      selected = options.selected || "executor";
      show();
      clearInterval(timer);
      timer = setInterval(() => {
        if (!watching()) return;
        void poll();
        void loadDetail();
      }, 3000);
      void loadDetail();
      return poll();
    },
    select(id) {
      if (ctx) select(id);
    },
    /** True when the executor's own page is showing, so executor.js polls only then. */
    executorShown() {
      return !!ctx && selected === "executor";
    },
    close() {
      clearInterval(timer);
      timer = null;
      detailToken++;
    },
  };
})();
