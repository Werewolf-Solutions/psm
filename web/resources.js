/* Resources: databases, containers, node servers and folders on this machine,
 * each with an access level (None · Read · Full), and the database-script
 * buttons those levels allow. Every rule is enforced by the server; this view
 * only shows what it answers and asks it to act. */
(() => {
  const node = (tag, text = "", className = "") => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text, onclick, className = "btn") => {
    const element = node("button", text, className);
    element.type = "button";
    element.onclick = onclick;
    return element;
  };

  const LEVELS = [
    { id: "none", label: "None", hint: "Listed only. Nothing reads or changes it." },
    { id: "read", label: "Read", hint: "Inspect and preview. No writes." },
    { id: "full", label: "Full", hint: "Development: Preview and Apply." },
  ];
  const LEVEL_NAME = { none: "None", read: "Read", full: "Full" };
  const SECTIONS = [
    { kind: "database", one: "database", title: "Databases", empty: "No databases found on this machine or in your projects' .env files." },
    { kind: "container", one: "container", title: "Containers", empty: null },
    { kind: "server", one: "node server", title: "Node servers", empty: "No servers holding a port." },
    { kind: "folder", one: "folder", title: "Folders", empty: "Add folders you want psm and agents to know about — or to keep out of." },
  ];

  let ctx = null; // { api, stream, root, summary, toast, focus }
  let data = { resources: [], docker: null, scripts: [] };

  async function call(path, init = {}) {
    const response = await ctx.api(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { code: body.code });
    return body;
  }

  const fmtBytes = (bytes) => {
    if (bytes == null) return null;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  };

  /* ------------------------------------------------------------ level switch */

  function levelSwitch(resource, onChange) {
    const wrap = node("div", "", "res-levels");
    wrap.setAttribute("role", "radiogroup");
    wrap.setAttribute("aria-label", `Access for ${resource.name}`);
    for (const level of LEVELS) {
      const on = resource.level === level.id;
      const choice = button(level.label, async () => {
        if (on) return;
        wrap.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        choice.classList.add("res-level-saving");
        try {
          await call("/api/resources/level", { method: "PUT", body: JSON.stringify({ key: resource.key, level: level.id, revision: resource.revision }) });
          await onChange();
        } catch (error) {
          ctx.toast?.(error.message);
          await onChange();
        }
      }, `res-level res-level-${level.id}${on ? " on" : ""}`);
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-checked", on ? "true" : "false");
      choice.title = level.hint;
      wrap.append(choice);
    }
    return wrap;
  }

  /* ------------------------------------------------------------ script card */

  /**
   * Preview / Apply for one database script. Apply always runs a fresh preview
   * first and asks once, showing that preview's output; the server refuses an
   * Apply that did not follow a clean preview of the same database anyway.
   */
  function scriptCard(script, { api, stream, onLevel }) {
    const card = node("div", "", "res-script");
    const head = node("div", "", "res-script-head");
    const title = node("div", "", "res-script-title");
    title.append(node("strong", script.path.split("/").pop().replace(/\.(c|m)?js$/, "")), node("span", script.title, "res-script-desc"));
    head.append(title);
    card.append(head);

    const target = node("div", "", "res-script-target");
    if (script.target) {
      const chip = node("button", "", `res-target res-target-${script.levelSet ? script.level : "unset"}`);
      chip.type = "button";
      chip.append(node("span", script.target.label), node("span", script.level === "none" && !script.levelSet ? "not set" : LEVEL_NAME[script.level], "res-target-level"));
      chip.title = script.target.variables.length ? `From ${script.target.variables.join(", ")} in ${script.directory || "."}/.env` : "The fallback written in the script's code; its .env sets nothing.";
      chip.onclick = () => onLevel?.(script.target.key);
      target.append(node("span", "Database", "res-script-label"), chip);
    }
    card.append(target);

    const actions = node("div", "", "res-script-actions");
    const preview = button("Preview", () => run("preview"));
    const apply = button("Apply", () => run("apply-flow"), "btn btn-primary");
    preview.disabled = !script.allowed.preview;
    apply.disabled = !script.allowed.apply;
    actions.append(preview, apply);
    if (script.allowed.why) actions.append(node("span", script.allowed.why, "res-script-why"));
    card.append(actions);

    const log = node("pre", "", "res-log");
    log.hidden = true;
    log.dataset.streamPrivate = "";
    const confirm = node("div", "", "res-confirm");
    confirm.hidden = true;
    card.append(log, confirm);

    let source = null;
    const listen = () => new Promise((resolve) => {
      source?.close();
      log.hidden = false;
      log.textContent = "";
      source = stream(`/api/projects/${encodeURIComponent(script.project)}/logs/stream?kind=${encodeURIComponent(script.kind)}`);
      let started = false;
      source.onmessage = (event) => {
        try {
          const line = JSON.parse(event.data);
          if (line.stream === "sys" && line.line.startsWith("$ ")) { started = true; log.textContent = ""; }
          if (!started) return; // replayed lines from an earlier run
          log.textContent += `${line.line}\n`;
          log.scrollTop = log.scrollHeight;
        } catch { /* not a log line */ }
      };
      source.addEventListener("status", (event) => {
        try {
          const state = JSON.parse(event.data);
          if (state.status === "running") return;
          source.close();
          resolve(state);
        } catch { /* ignore */ }
      });
      source.onerror = () => {};
    });

    const post = (mode) => call("/api/resources/scripts/run", { method: "POST", body: JSON.stringify({ project: script.project, id: script.id, mode }) }).catch((error) => {
      ctx?.toast?.(error.message);
      log.hidden = false;
      log.textContent = error.message;
      throw error;
    });

    async function run(mode) {
      preview.disabled = apply.disabled = true;
      confirm.hidden = true;
      try {
        const done = listen();
        await post("preview");
        const state = await done;
        if (mode !== "apply-flow") return;
        if (state.exitCode !== 0) {
          log.textContent += "\nThe preview did not finish cleanly, so there is nothing to apply.\n";
          return;
        }
        confirm.replaceChildren(
          node("span", `Apply these changes to ${script.target.label}?`),
          button("Apply now", async () => {
            confirm.hidden = true;
            const applied = listen();
            try {
              await post("apply");
              const result = await applied;
              ctx?.toast?.(result.exitCode === 0 ? "Applied." : "Apply finished with an error — see the log.");
            } catch { /* shown in the log */ }
            preview.disabled = !script.allowed.preview;
            apply.disabled = !script.allowed.apply;
          }, "btn btn-primary"),
          button("Cancel", () => { confirm.hidden = true; }),
        );
        confirm.hidden = false;
      } catch {
        /* shown in the log */
      } finally {
        preview.disabled = !script.allowed.preview;
        apply.disabled = !script.allowed.apply;
      }
    }
    return card;
  }

  /* ------------------------------------------------------------ panel */

  function row(resource) {
    const item = node("div", "", `res-row${resource.running ? "" : " res-off"}`);
    item.id = `res-${CSS.escape(resource.key)}`;
    item.dataset.streamPrivate = "";
    const main = node("div", "", "res-main");
    const title = node("div", "", "res-title");
    title.append(node("span", resource.name, "res-name"));
    for (const port of resource.kind === "database" ? [] : resource.ports || []) title.append(node("span", `:${port}`, "proc-port"));
    if (!resource.running && resource.kind !== "folder") title.append(node("span", "not running", "proc-tag"));
    if (resource.kind === "folder" && !resource.running) title.append(node("span", "missing", "proc-tag stale"));
    main.append(title);

    const meta = node("div", "", "res-meta");
    meta.append(node("span", resource.where));
    if (resource.image) meta.append(node("span", resource.image));
    if (resource.summary) {
      const parts = [resource.summary.items != null ? `${resource.summary.items.toLocaleString()} items` : null, fmtBytes(resource.summary.bytes)].filter(Boolean);
      if (parts.length) meta.append(node("span", parts.join(" · ")));
    }
    main.append(meta);

    for (const use of resource.usedBy || []) {
      const where = use.directory ? `${use.project}/${use.directory}` : use.project;
      main.append(node("div", `${where} · ${use.variable}${use.database ? ` · ${use.database}` : ""}`, "res-use"));
    }

    if (!resource.level && resource.suggestion) {
      const suggestion = node("div", "", "res-suggest");
      suggestion.append(
        button(`Set to ${LEVEL_NAME[resource.suggestion.level]}`, async (event) => {
          event.currentTarget.disabled = true;
          event.currentTarget.textContent = "Saving…";
          try {
            await call("/api/resources/level", { method: "PUT", body: JSON.stringify({ key: resource.key, level: resource.suggestion.level, revision: resource.revision }) });
          } catch (error) { ctx.toast?.(error.message); }
          await load();
        }, "btn res-suggest-btn"),
        node("span", resource.suggestion.reason),
      );
      main.append(suggestion);
    }

    const scripts = data.scripts.filter((script) => script.target?.key === resource.key);
    if (scripts.length) {
      const list = node("div", "", "res-scripts");
      for (const script of scripts) list.append(scriptCard(script, { api: ctx.api, stream: ctx.stream, onLevel: focus }));
      main.append(list);
    }
    item.append(main);

    const side = node("div", "", "res-side");
    if (resource.settable) {
      side.append(levelSwitch(resource, load));
      if (!resource.level) side.append(node("span", "not set · treated as None", "res-unset"));
    } else {
      side.append(node("span", "stop it from Running", "res-unset"));
    }
    if (resource.kind === "folder") {
      side.append(button("Remove", async () => {
        try {
          await call("/api/resources", { method: "DELETE", body: JSON.stringify({ key: resource.key, revision: resource.revision }) });
        } catch (error) { ctx.toast?.(error.message); }
        await load();
      }, "btn res-remove"));
    }
    item.append(side);
    return item;
  }

  function addFolderForm() {
    const form = node("form", "", "res-add-folder");
    const input = node("input");
    input.placeholder = "~/Videos or /mnt/photos";
    input.setAttribute("aria-label", "Folder path");
    const add = node("button", "Add folder", "btn");
    add.type = "submit";
    form.append(input, add);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      add.disabled = true;
      try {
        await call("/api/resources/folders", { method: "POST", body: JSON.stringify({ path: input.value.trim() }) });
        input.value = "";
        await load();
      } catch (error) {
        ctx.toast?.(error.message);
      } finally {
        add.disabled = false;
      }
    };
    return form;
  }

  function render() {
    const root = ctx.root;
    root.replaceChildren();
    const counts = SECTIONS.map((section) => [section, data.resources.filter((resource) => resource.kind === section.kind)]);
    const unset = data.resources.filter((resource) => resource.settable && !resource.level).length;
    if (ctx.summary) {
      ctx.summary.textContent = counts.filter(([, list]) => list.length).map(([section, list]) => `${list.length} ${list.length === 1 ? section.one : section.title.toLowerCase()}`).join(" · ")
        + (unset ? ` · ${unset} not set` : "") || "Nothing found yet.";
    }

    const note = node("p", "", "res-note");
    note.textContent = "None, Read and Full decide which buttons psm offers and what its sandboxed agents may do. Agents psm does not run (a terminal Claude Code) are told the levels in ~/.claude/CLAUDE.md — guidance they should follow, not a lock.";
    root.append(note);

    for (const [section, list] of counts) {
      if (section.kind === "container" && !list.length && data.docker?.available) continue;
      const group = node("section", "", "res-section");
      group.append(node("h3", section.title, "procs-group"));
      if (section.kind === "container" && data.docker && !data.docker.available) group.append(node("div", data.docker.reason || "Docker not reachable.", "procs-empty"));
      for (const resource of list) group.append(row(resource));
      if (!list.length && section.empty && !(section.kind === "container")) group.append(node("div", section.empty, "procs-empty"));
      if (section.kind === "folder") group.append(addFolderForm());
      root.append(group);
    }
    if (ctx.focus) {
      const target = document.getElementById(`res-${CSS.escape(ctx.focus)}`);
      target?.classList.add("res-focus");
      target?.scrollIntoView({ block: "center" });
      ctx.focus = null;
    }
  }

  function focus(key) {
    ctx.focus = key;
    render();
  }

  async function load() {
    try {
      const [list, scripts] = await Promise.all([call("/api/resources"), call("/api/resources/scripts")]);
      data = { resources: list.resources || [], docker: list.docker || null, scripts: scripts.scripts || [] };
      render();
    } catch (error) {
      ctx.root.replaceChildren(node("div", error.message || "Could not read resources.", "procs-empty"));
      if (ctx.summary) ctx.summary.textContent = "Unavailable";
    }
  }

  /** The project's Data card: its database scripts, or nothing at all. */
  async function renderData(root, options) {
    root.replaceChildren();
    root.hidden = true;
    if (!options.project) return;
    let scripts = [];
    try {
      const response = await options.api(`/api/resources/scripts?project=${encodeURIComponent(options.project)}`);
      if (!response.ok) return;
      scripts = (await response.json()).scripts || [];
    } catch {
      return;
    }
    if (!scripts.length) return;
    const head = node("div", "", "res-data-head");
    const text = node("div");
    text.append(node("h2", "Data"), node("p", "Database scripts in this project. Preview reports; Apply writes, and only on a database you set to Full."));
    head.append(text, button("Resources…", () => options.openResources?.()));
    root.append(head);
    for (const script of scripts) {
      root.append(scriptCard(script, { api: options.api, stream: options.stream, onLevel: (key) => options.openResources?.(key) }));
    }
    root.hidden = false;
  }

  /** Compact chips for the Running dialog. */
  async function strip(root, options) {
    root.replaceChildren();
    root.hidden = true;
    let list;
    try {
      const response = await options.api("/api/resources");
      if (!response.ok) return;
      list = (await response.json()).resources || [];
    } catch {
      return;
    }
    const chips = [];
    for (const resource of list.filter((entry) => entry.kind === "database" && entry.local)) {
      const chip = button("", () => options.openResources?.(resource.key), `res-chip res-target-${resource.level || "unset"}`);
      chip.append(node("span", resource.name), node("span", resource.level ? LEVEL_NAME[resource.level] : "not set", "res-target-level"));
      chips.push(chip);
    }
    const containers = list.filter((entry) => entry.kind === "container").length;
    const folders = list.filter((entry) => entry.kind === "folder").length;
    if (containers) chips.push(button(`${containers} container${containers === 1 ? "" : "s"}`, () => options.openResources?.(), "res-chip"));
    if (folders) chips.push(button(`${folders} folder${folders === 1 ? "" : "s"}`, () => options.openResources?.(), "res-chip"));
    if (!chips.length) return;
    root.append(node("span", "Resources", "res-strip-label"), ...chips);
    root.hidden = false;
  }

  window.PsmResources = {
    open(options) {
      ctx = options;
      ctx.root.replaceChildren(node("div", "Looking at this machine…", "procs-empty"));
      return load();
    },
    refresh: () => (ctx ? load() : Promise.resolve()),
    renderData,
    strip,
  };
})();
