/* A project's Scripts pane (P18): every script it has, what it does and when
 * to use it, and its units started and stopped one process each.
 *
 * Detection, README lines and script header comments fill the rundown; the
 * operator's own words are saved to the project's committed .psm/runbook.json
 * and win field by field. Data, deploy, install and MCP scripts are listed but
 * never started from here. Uses app.js globals: agentApi, toast, connectLogs,
 * switchPane. */
(() => {
  const node = (tag, text = "", className = "") => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  const KINDS = [
    ["service", "Servers", "Long-running: dev servers, APIs, clients."],
    ["agent", "Agents and workers", "Long-running processes that do work on their own. Some spend model credit."],
    ["task", "Tasks", "Run to completion: tests, builds, checks."],
    ["data", "Data scripts", "Change data or state. Run them through the Data card (Preview, then Apply) or by hand."],
    ["mcp", "MCP servers", "Launched by an MCP client, not run here."],
    ["install", "Install", "Dependency installs."],
    ["deploy", "Production", "Production builds and starts. Use the Deploy tab."],
  ];
  const STARTABLE = new Set(["service", "agent", "task"]);
  const SOURCE = { curated: "yours", readme: "README", script: "script comment", detected: "detected" };
  const OUTCOME = {
    started: "started", reused: "already running", external: "already served", blocked: "port taken",
    "not-startable": "not startable here", unknown: "unknown", skipped: "skipped", failed: "failed",
  };

  let project = null;
  let data = null;
  let editing = null;
  let busy = false;
  let draft = null; // { units, meta } from the AI, until accepted or discarded
  let drafting = false;
  let timer = null;
  const root = () => document.getElementById("ws-scripts");

  async function call(path, method = "GET", body) {
    const response = await agentApi(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `Request failed (${response.status})`);
    return json;
  }

  const unitStatus = (id) => data?.status?.[id]?.status || "idle";
  const refText = (ref) => (ref.project ? `${ref.project}: ${ref.unit}` : ref.unit);

  function summarize(results) {
    const lines = results.map((result) => `${result.project} ${result.unit}: ${OUTCOME[result.outcome] || result.outcome}${result.message ? ` (${result.message})` : ""}`);
    toast(lines.slice(0, 4).join(" · ") + (lines.length > 4 ? ` · +${lines.length - 4} more` : ""));
  }

  async function startUnits(ids) {
    if (busy) return;
    busy = true;
    render();
    try {
      const { results } = await call("/api/units/start", "POST", { targets: ids.map((unit) => ({ project, unit })) });
      summarize(results);
    } catch (error) {
      toast(error.message);
    } finally {
      busy = false;
      void load();
    }
  }

  async function stopUnits(ids) {
    try {
      const { results } = await call("/api/units/stop", "POST", { targets: ids.map((unit) => ({ project, unit })) });
      const kept = results.filter((result) => result.keptFor?.length);
      if (kept.length) toast(kept.map((result) => `${result.unit} kept: ${result.keptFor.join(", ")} still needs it`).join(" · "));
    } catch (error) {
      toast(error.message);
    }
    void load();
  }

  function button(label, onclick, disabled = false, primary = false) {
    const element = node("button", label, primary ? "btn btn-primary" : "btn");
    element.type = "button";
    element.disabled = disabled;
    element.onclick = onclick;
    return element;
  }

  function badge(text, tone = "") {
    return node("span", text, `exec-badge${tone ? ` exec-${tone}` : ""}`);
  }

  function statusBadge(status) {
    if (status === "running") return badge("running", "busy");
    if (status === "error") return badge("error", "bad");
    if (status === "exited") return badge("exited");
    return null;
  }

  function header() {
    const { runbook } = data;
    const wrap = node("div", "", "scripts-head");
    const text = node("div");
    text.append(node("h3", "Scripts"));
    const counts = KINDS.map(([kind, title]) => [title, runbook.units.filter((unit) => unit.kind === kind).length]).filter(([, count]) => count);
    text.append(node("p", `${runbook.units.length} scripts · ${counts.map(([title, count]) => `${count} ${title.toLowerCase()}`).join(" · ")}${runbook.curated ? " · descriptions saved in .psm/runbook.json" : ""}`, "hint"));
    const actions = node("div", "", "scripts-actions");
    const ai = button(drafting ? "Drafting…" : "✨ Draft descriptions with AI", () => void requestDraft(), drafting);
    ai.title = "One Claude call with no tools reads the scripts, their files and the README and proposes descriptions. Nothing is saved until you accept it.";
    actions.append(ai);
    if (runbook.defaultUnits.length) {
      const running = runbook.defaultUnits.filter((id) => unitStatus(id) === "running");
      actions.append(
        button(busy ? "Starting…" : `▶ Start ${runbook.defaultUnits.join(" + ")}`, () => startUnits(runbook.defaultUnits), busy || running.length === runbook.defaultUnits.length, true),
        button("■ Stop", () => stopUnits(running), !running.length),
      );
    }
    wrap.append(text, actions);
    const parts = [wrap];
    for (const warning of runbook.warnings) parts.push(node("div", warning, "scripts-warning"));
    const mcp = mcpAllRow();
    if (mcp) parts.push(mcp);
    if (draft) parts.push(draftPanel());
    return parts;
  }

  /** One switch for every startable script: allow them all for MCP, or take it back. */
  function mcpAllRow() {
    const units = data.runbook.units.filter((unit) => STARTABLE.has(unit.kind));
    const state = (unit) => data.status?.[unit.id]?.mcp;
    if (!units.length || units.some((unit) => state(unit) === "no-project-id")) return null;
    const allowed = units.filter((unit) => state(unit) === "allowed");
    const pending = units.filter((unit) => state(unit) !== "allowed");
    const costly = pending.filter((unit) => unit.costs);
    const row = node("div", "", "scripts-mcp scripts-mcp-all");
    row.append(node("span", `MCP clients may start ${allowed.length} of ${units.length} scripts`, `scripts-meta${allowed.length ? " scripts-mcp-on" : ""}`));
    if (pending.length) {
      // Same rule as a single script: anything that spends credit takes a second click.
      const confirming = confirmCost === ALL;
      const allow = button(confirming ? `Click again: ${costly.length} spend${costly.length === 1 ? "s" : ""} credit` : allowed.length ? `Allow the other ${pending.length}` : "Allow all for MCP", () => {
        if (costly.length && !confirming) {
          confirmCost = ALL;
          return render();
        }
        confirmCost = null;
        void setMcpMany(pending, true);
      }, mcpBusy, true);
      allow.title = "Lets Claude Code, Codex and other MCP clients start and stop every server, agent and task here through psm.";
      row.append(allow);
    }
    if (allowed.length) row.append(button("Disallow all", () => { confirmCost = null; void setMcpMany(units.filter((unit) => state(unit) !== "not-allowed"), false); }, mcpBusy));
    return row;
  }

  async function requestDraft() {
    drafting = true;
    render();
    try {
      const result = await call(`/api/projects/${encodeURIComponent(project)}/runbook/draft`, "POST", {});
      draft = { units: result.units, meta: result.meta };
      if (!Object.keys(result.units).length) toast("The AI had nothing to add.");
    } catch (error) {
      toast(error.message);
    } finally {
      drafting = false;
      render();
    }
  }

  /**
   * Accepted draft text fills only fields you have not written yourself. The AI
   * may add a credit warning but never remove one: "free to run" is not taken
   * from it, so a detected "spends credit" cannot be switched off by a draft.
   */
  async function acceptDraft(ids) {
    const next = { version: 1, units: { ...data.curated.units }, ...(data.curated.defaultUnits ? { defaultUnits: data.curated.defaultUnits } : {}) };
    for (const id of ids) {
      const proposed = draft.units[id];
      if (!proposed) continue;
      const own = { ...(next.units[id] || {}) };
      if (own.summary == null && proposed.summary) own.summary = proposed.summary;
      if (own.whenToUse == null && proposed.whenToUse) own.whenToUse = proposed.whenToUse;
      if (own.costs == null && proposed.costs === true) own.costs = true;
      if (Object.keys(own).length) next.units[id] = own;
    }
    try {
      await call(`/api/projects/${encodeURIComponent(project)}/runbook`, "PUT", next);
      for (const id of ids) delete draft.units[id];
      if (!Object.keys(draft.units).length) draft = null;
      toast(`Saved ${ids.length} description${ids.length === 1 ? "" : "s"} to .psm/runbook.json`);
      await load();
    } catch (error) {
      toast(error.message);
    }
  }

  function draftPanel() {
    const panel = node("section", "", "scripts-draft");
    const head = node("div", "", "scripts-unit-head");
    const cost = draft.meta?.costUsd != null ? ` · cost $${draft.meta.costUsd.toFixed(4)}` : "";
    head.append(node("strong", `AI draft · ${Object.keys(draft.units).length} scripts${cost}`));
    const actions = node("div", "", "scripts-actions");
    actions.append(button("Accept all", () => void acceptDraft(Object.keys(draft.units)), false, true), button("Discard", () => { draft = null; render(); }));
    head.append(actions);
    panel.append(head, node("p", "Proposed from repository text. Accepting fills only fields you have not written yourself, and can add a credit warning but not remove one. Kind and dependencies stay yours to set.", "hint"));
    for (const [id, proposed] of Object.entries(draft.units)) {
      const row = node("div", "", "scripts-draft-row");
      const text = node("div");
      text.append(node("code", id));
      if (proposed.summary) text.append(node("div", proposed.summary, "scripts-summary"));
      if (proposed.whenToUse) text.append(node("div", `When to use: ${proposed.whenToUse}`, "scripts-when"));
      if (proposed.costs) text.append(node("div", "Spends model or API credit", "scripts-meta"));
      row.append(text, button("Accept", () => void acceptDraft([id])));
      panel.append(row);
    }
    return panel;
  }

  function composites() {
    const list = data.runbook.composites;
    if (!list.length) return [];
    const section = node("section", "", "scripts-group");
    section.append(node("h4", "Combined scripts"), node("p", "Scripts that start several others at once. psm runs the parts as separate processes, so each one has its own log and can stop on its own.", "hint"));
    for (const composite of list) {
      const row = node("div", "", "scripts-composite");
      const label = node("div");
      label.append(node("code", `${composite.folder ? `${composite.folder}: ` : ""}npm run ${composite.script}`), node("span", ` = ${composite.units.join(" + ") || "—"}${composite.unresolved.length ? ` (plus ${composite.unresolved.join(", ")})` : ""}`, "scripts-muted"));
      if (composite.summary) label.append(node("div", composite.summary, "scripts-summary"));
      row.append(label);
      if (composite.units.length && !composite.unresolved.length && composite.units.every((id) => STARTABLE.has(data.runbook.units.find((unit) => unit.id === id)?.kind))) {
        row.append(button("▶ Start parts", () => startUnits(composite.units), busy));
      }
      section.append(row);
    }
    return [section];
  }

  function card(unit) {
    const status = unitStatus(unit.id);
    const wrap = node("article", "", `scripts-unit${status === "running" ? " running" : ""}`);
    const head = node("div", "", "scripts-unit-head");
    const title = node("div", "", "scripts-unit-title");
    title.append(node("strong", unit.sources.title === "curated" ? unit.title : unit.id));
    const state = statusBadge(status);
    if (state) title.append(state);
    if (unit.costs) title.append(badge("spends credit", "warn"));
    if (unit.port) title.append(badge(`:${unit.port}`));
    const actions = node("div", "", "scripts-actions");
    if (STARTABLE.has(unit.kind)) {
      if (status === "running") actions.append(button("■ Stop", () => stopUnits([unit.id])));
      else actions.append(button("▶ Start", () => startUnits([unit.id]), busy));
      actions.append(button("Logs", () => { connectLogs(project, `unit:${unit.id}`); switchPane("logs"); }, status === "idle"));
    }
    actions.append(button(editing === unit.id ? "Cancel" : "Edit", () => { editing = editing === unit.id ? null : unit.id; render(); }));
    head.append(title, actions);
    wrap.append(head);

    const command = node("div", "", "scripts-command");
    command.append(node("code", unit.command), node("span", unit.folder ? ` in ${unit.folder}/` : " at the root", "scripts-muted"));
    if (unit.aliases.length) command.append(node("span", ` · also ${unit.aliases.join(", ")}`, "scripts-muted"));
    wrap.append(command);
    if (unit.scriptText && unit.scriptText !== unit.command) wrap.append(node("div", unit.scriptText, "scripts-raw"));
    if (unit.summary) {
      const summary = node("div", unit.summary, "scripts-summary");
      if (unit.sources.summary) summary.append(node("span", ` · ${SOURCE[unit.sources.summary]}`, "scripts-source"));
      wrap.append(summary);
    }
    if (unit.whenToUse) wrap.append(node("div", `When to use: ${unit.whenToUse}`, "scripts-when"));
    const meta = [];
    if (unit.dependsOn.length) meta.push(`Needs ${unit.dependsOn.map(refText).join(", ")}`);
    if (data.runbook.proxies.some((proxy) => proxy.unit === unit.id)) meta.push(`Proxies to ${data.runbook.proxies.filter((proxy) => proxy.unit === unit.id).map((proxy) => `:${proxy.port}`).join(", ")}`);
    if (unit.env.length) meta.push(`Reads ${unit.env.length} variable${unit.env.length === 1 ? "" : "s"}: ${unit.env.slice(0, 8).join(", ")}${unit.env.length > 8 ? "…" : ""}`);
    if (meta.length) wrap.append(node("div", meta.join(" · "), "scripts-meta"));
    if (STARTABLE.has(unit.kind)) wrap.append(mcpRow(unit));
    if (editing === unit.id) wrap.append(editor(unit));
    return wrap;
  }

  const LEVEL = { full: "Full", read: "Read", none: "None" };

  /** Whether MCP clients may start this unit, and what would stop them. */
  function mcpRow(unit) {
    const info = data.status?.[unit.id] || {};
    const row = node("div", "", "scripts-mcp");
    const resources = info.resources || [];
    const blocked = resources.filter((resource) => resource.level !== "full");
    if (info.mcp === "no-project-id") {
      row.append(node("span", "MCP: give the project a stable id first (assign id on its card).", "scripts-meta"));
      return row;
    }
    const allowed = info.mcp === "allowed";
    const label = info.mcp === "changed" ? "MCP: script changed since you allowed it" : allowed ? "MCP clients may start this" : "MCP clients may not start this";
    row.append(node("span", label, `scripts-meta${allowed ? " scripts-mcp-on" : ""}`));
    // A unit that spends credit takes a second click, so it is never allowed by accident.
    const confirming = confirmCost === unit.id;
    const toggle = button(allowed ? "Disallow" : confirming ? "Click again: it spends credit" : info.mcp === "changed" ? "Allow again" : "Allow for MCP", () => {
      if (!allowed && unit.costs && !confirming) {
        confirmCost = unit.id;
        return render();
      }
      confirmCost = null;
      void setMcp(unit, !allowed);
    });
    toggle.title = unit.costs ? "This unit spends model or API credit when it runs." : "Lets Claude Code, Codex and other MCP clients start and stop it through psm.";
    row.append(toggle);
    if (resources.length) row.append(node("span", `Uses ${resources.map((resource) => `${resource.label} (${LEVEL[resource.level] || "not set"})`).join(", ")}`, "scripts-meta"));
    if (blocked.length) row.append(node("span", `MCP will refuse it until ${blocked.map((resource) => resource.label).join(", ")} ${blocked.length === 1 ? "is" : "are"} at Full in Resources.`, "scripts-warning"));
    return row;
  }

  const ALL = "*"; // confirmCost for the "allow all" switch; no unit id is "*"
  let confirmCost = null;
  let mcpBusy = false;
  async function setMcpMany(units, allow) {
    if (mcpBusy) return;
    mcpBusy = true;
    render();
    let done = 0;
    try {
      for (const unit of units) {
        await call(`/api/projects/${encodeURIComponent(project)}/unit-grants`, "POST", { unit: unit.id, allow });
        done++;
      }
      toast(`${allow ? "Allowed" : "Disallowed"} ${done} script${done === 1 ? "" : "s"} for MCP`);
    } catch (error) {
      toast(`${error.message}${done ? ` (${done} of ${units.length} changed)` : ""}`);
    } finally {
      mcpBusy = false;
      await load();
    }
  }

  async function setMcp(unit, allow) {
    try {
      await call(`/api/projects/${encodeURIComponent(project)}/unit-grants`, "POST", { unit: unit.id, allow });
      await load();
    } catch (error) {
      toast(error.message);
    }
  }

  function field(label, input) {
    const wrap = node("label", "", "scripts-field");
    wrap.append(node("span", label), input);
    return wrap;
  }

  function editor(unit) {
    const own = data.curated.units[unit.id] || {};
    const form = node("form", "", "scripts-editor");
    const summary = node("textarea");
    summary.rows = 2;
    summary.maxLength = 1000;
    summary.value = own.summary ?? "";
    summary.placeholder = unit.summary || "What it does";
    const when = node("textarea");
    when.rows = 2;
    when.maxLength = 1000;
    when.value = own.whenToUse ?? "";
    when.placeholder = "When to use it";
    const kind = node("select");
    for (const [value, title] of [["", `Detected (${unit.kind})`], ...KINDS.map(([value, title]) => [value, title])]) {
      const option = node("option", title);
      option.value = value;
      kind.append(option);
    }
    kind.value = own.kind ?? "";
    const port = node("input");
    port.type = "number";
    port.min = "1";
    port.max = "65535";
    port.value = own.port ?? "";
    port.placeholder = unit.port ? String(unit.port) : "none";
    const needs = node("input");
    needs.value = (own.dependsOn ?? []).map(refText).join(", ");
    needs.placeholder = unit.dependsOn.length ? unit.dependsOn.map(refText).join(", ") : "server/dev, werewolf-dapp: server/dev";
    const costs = node("select");
    for (const [value, title] of [["", `Detected (${unit.costs ? "yes" : "no"})`], ["true", "Spends model or API credit"], ["false", "Free to run"]]) {
      const option = node("option", title);
      option.value = value;
      costs.append(option);
    }
    costs.value = own.costs == null ? "" : String(own.costs);
    form.append(
      field("What it does", summary),
      field("When to use it", when),
      field("Kind", kind),
      field("Port", port),
      field("Needs (comma separated; project: unit for another project)", needs),
      field("Credit", costs),
    );
    const actions = node("div", "", "scripts-actions");
    const save = button("Save to .psm/runbook.json", () => {}, false, true);
    save.type = "submit";
    actions.append(save, button("Clear my text", () => saveUnit(unit.id, null)));
    form.append(actions, node("p", "Saved in the project's .psm/runbook.json, so it travels with the repository. Leave a field empty to keep what psm detected.", "hint"));
    form.onsubmit = (event) => {
      event.preventDefault();
      const entry = {};
      if (summary.value.trim()) entry.summary = summary.value.trim();
      if (when.value.trim()) entry.whenToUse = when.value.trim();
      if (kind.value) entry.kind = kind.value;
      if (port.value) entry.port = Number(port.value);
      if (costs.value) entry.costs = costs.value === "true";
      const refs = needs.value.split(",").map((text) => text.trim()).filter(Boolean).map((text) => {
        const at = text.indexOf(": ");
        return at > 0 ? { project: text.slice(0, at).trim(), unit: text.slice(at + 2).trim() } : { unit: text };
      });
      if (refs.length) entry.dependsOn = refs;
      void saveUnit(unit.id, entry);
    };
    return form;
  }

  async function saveUnit(id, entry) {
    const next = { version: 1, units: { ...data.curated.units }, ...(data.curated.defaultUnits ? { defaultUnits: data.curated.defaultUnits } : {}) };
    if (entry && Object.keys(entry).length) next.units[id] = entry;
    else delete next.units[id];
    try {
      await call(`/api/projects/${encodeURIComponent(project)}/runbook`, "PUT", next);
      editing = null;
      toast("Saved to .psm/runbook.json");
      await load();
    } catch (error) {
      toast(error.message);
    }
  }

  function render() {
    const container = root();
    if (!container || !data) return;
    if (container.contains(document.activeElement) && editing) return; // keep an open form steady while typing
    const parts = [...header(), ...composites()];
    for (const [kind, title, hint] of KINDS) {
      const units = data.runbook.units.filter((unit) => unit.kind === kind);
      if (!units.length) continue;
      const section = node("section", "", "scripts-group");
      section.append(node("h4", `${title} · ${units.length}`), node("p", hint, "hint"));
      for (const unit of units) section.append(card(unit));
      parts.push(section);
    }
    if (!data.runbook.units.length) parts.push(node("div", "No package scripts found in this project or its nested packages.", "procs-empty"));
    container.replaceChildren(...parts);
  }

  async function load() {
    const name = project;
    if (!name) return;
    try {
      const next = await call(`/api/projects/${encodeURIComponent(name)}/runbook`);
      if (name !== project) return;
      data = next;
      render();
    } catch (error) {
      if (name === project) root()?.replaceChildren(node("div", error.message, "procs-empty"));
    }
  }

  window.PsmScripts = {
    open(name) {
      if (name !== project) {
        data = null;
        editing = null;
        draft = null;
        root()?.replaceChildren(node("div", "Reading the project's scripts…", "procs-empty"));
      }
      project = name;
      clearInterval(timer);
      timer = setInterval(() => {
        if (!document.hidden && !root()?.hidden) void load();
      }, 3000);
      return load();
    },
    close() {
      clearInterval(timer);
      timer = null;
    },
  };
})();
