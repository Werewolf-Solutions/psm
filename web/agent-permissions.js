/* Project policy is server-owned. This view never writes repository settings. */
(() => {
  const generations = new WeakMap();
  const fallbackCategories = [
    { id: "repository", title: "Repository", description: "Read, edit, and delete project files." },
    { id: "git-local", title: "Local Git", description: "Create commits and manage local branches and merges." },
    { id: "git-remote", title: "Remote Git", description: "Fetch from and push to configured remotes." },
    { id: "execution", title: "Execution", description: "Run tests and install project packages." },
    { id: "integrations", title: "Integrations", description: "Use explicitly attached tools and services." },
    { id: "machines", title: "Servers", description: "Run commands on connected servers as the project's own account." },
  ];
  const STATUS_TEXT = {
    ready: "Ready", "needs-review": "Asks you first", "needs-grant": "Needs a grant", "needs-connection": "Needs a connection",
    "needs-runner": "Needs a runner", "provider-restricted": "Provider restricted", unsupported: "Not available",
  };
  const DURATIONS = [["standing", "Always"], ["1", "For 1 hour"], ["8", "For 8 hours"], ["24", "For 24 hours"], ["once", "Once"]];
  const describeRule = (rule) => {
    const scope = Object.entries(rule.scope || {}).filter(([key]) => key !== "operation" && key !== "task").map(([key, value]) => `${key.replace("Id", "")} ${value}`).join(", ");
    const duration = rule.remainingUses !== null ? "once" : rule.expiresAt ? `until ${new Date(rule.expiresAt).toLocaleString()}` : rule.scope?.task ? "this task" : "always";
    return `${rule.effect.toUpperCase()} ${rule.permission}${scope ? ` · ${scope}` : ""}${rule.scope?.operation ? " · one exact operation" : ""} · ${duration} · ${rule.source}`;
  };
  const permissionCategory = (permission) => {
    if (permission.category) return permission.category;
    if (permission.id.startsWith("repo.")) return "repository";
    if (["git.fetch", "git.push"].includes(permission.id)) return "git-remote";
    if (permission.id.startsWith("git.")) return "git-local";
    if (["test.run", "pkg.install"].includes(permission.id)) return "execution";
    if (permission.id.startsWith("mcp.")) return "integrations";
    if (permission.id.startsWith("machine.")) return "machines";
    return "other";
  };
  const node = (tag, text, className = "") => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  };
  async function request(api, path, init) {
    const response = await api(path, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Request failed");
    return body;
  }
  async function renderWorkspacePolicy(section, { api, workspaceId, current, onChanged }) {
    const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-policy`;
    const active = () => current() && section.isConnected;
    let pending = false;
    const show = (data, message = "") => {
      if (!active()) return;
      const workspaceName = data.workspaceName || workspaceId;
      section.replaceChildren(node("h3", "Workspace restrictions"), node("p", `Applies to every project in ${workspaceName}. A workspace restriction overrides project grants and presets.`, "cap-section-description"));
      const status = node("p", message, "permission-status"); status.setAttribute("role", "status");
      section.append(status);
      const change = async (path, body, method = "POST") => {
        if (pending || !active()) return;
        pending = true;
        const controls = [...section.querySelectorAll("button, select, input")];
        controls.forEach((item) => { item.disabled = true; });
        try {
          const updated = await request(api, `${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, revision: data.revision }) });
          if (active()) {
            const message = method === "DELETE" ? "Restriction removed. Project grants still determine access." : "Restriction saved. Affected agent turns and queued messages were stopped.";
            show(updated, message); onChanged(message);
          }
        } catch (error) { if (active()) status.textContent = `${error.message} Use Refresh policy before retrying a stale change.`; }
        finally { pending = false; controls.forEach((item) => { item.disabled = false; }); }
      };
      const refresh = node("button", "Refresh policy", "btn"); refresh.type = "button";
      refresh.onclick = async () => {
        if (pending) return;
        refresh.disabled = true;
        try { show(await request(api, base)); }
        catch (error) { if (active()) status.textContent = error.message; }
        finally { refresh.disabled = false; }
      };
      section.append(refresh);
      for (const rule of data.rules || []) {
        const row = node("article", "", "permission-row");
        const expired = rule.expiresAt !== null && rule.expiresAt <= Date.now();
        row.append(node("p", `${describeRule(rule)}${expired ? " · expired" : ""}`));
        const remove = node("button", "Remove restriction", "btn"); remove.type = "button";
        remove.onclick = async () => {
          if (await window.psmConfirm(`Remove this workspace restriction for every project in ${workspaceName}?\n${describeRule(rule)}\nProject grants will determine access.`, "Remove workspace restriction")) void change(`/rules/${encodeURIComponent(rule.id)}`, {}, "DELETE");
        };
        row.append(remove); section.append(row);
      }
      if (!(data.rules || []).length) section.append(node("p", "No workspace restrictions."));
      const form = node("form", "", "permission-rule-form");
      section.append(node("p", "Leave scope fields empty to apply everywhere. Filled fields must all match the operation.", "cap-section-description"));
      const select = (choices, title) => {
        const element = document.createElement("select"); element.setAttribute("aria-label", title);
        for (const [value, text] of choices) { const option = node("option", text); option.value = value; element.append(option); }
        return element;
      };
      const permission = select([["", "Choose an operation"], ["*", "All supported operations"], ...data.permissions.filter((entry) => entry.supported).map((entry) => [entry.id, entry.title])], "Restricted operation");
      permission.required = true;
      const duration = select(DURATIONS.filter(([value]) => value !== "once"), "Restriction duration");
      const scopeInputs = [["environmentId", "Environment"], ["connectionId", "Connection"], ["capability", "Capability"], ["tool", "Tool"]].map(([key, title]) => {
        const input = document.createElement("input"); input.placeholder = `${title} (optional)`; input.setAttribute("aria-label", title);
        return { key, input };
      });
      const add = node("button", "Add restriction", "btn"); add.type = "submit";
      form.append(permission, ...scopeInputs.map(({ input }) => input), duration, add);
      form.onsubmit = async (event) => {
        event.preventDefault();
        const scope = Object.fromEntries(scopeInputs.filter(({ input }) => input.value.trim()).map(({ key, input }) => [key, input.value.trim()]));
        const details = Object.entries(scope).map(([key, value]) => `${key.replace("Id", "")}: ${value}`).join(", ") || "all environments and connections";
        if (!await window.psmConfirm(`Deny ${permission.value} for every project in ${workspaceName}?\nScope: ${details}\nDuration: ${duration.selectedOptions[0].textContent}\nAffected agent turns and queued messages will stop.`, "Add workspace restriction")) return;
        void change("/rules", { permission: permission.value, effect: "deny", scope, duration: duration.value === "standing" ? { kind: "standing" } : { kind: "until", expiresAt: Date.now() + Number(duration.value) * 3_600_000 } });
      };
      section.append(form);
      const audit = node("details", "", "permission-audit"); audit.append(node("summary", "Workspace policy history"));
      for (const event of data.history || []) audit.append(node("p", `${new Date(event.at).toLocaleString()} · ${event.actor} · ${event.permission} · revision ${event.revision}`));
      if (!(data.history || []).length) audit.append(node("p", "No workspace policy changes recorded."));
      section.append(audit);
    };
    section.append(node("h3", "Workspace restrictions"), node("p", "Loading workspace policy…"));
    try { show(await request(api, base)); }
    catch (error) { if (active()) section.replaceChildren(node("h3", "Workspace restrictions"), node("p", error.message, "permission-status")); }
  }
  async function render(container, connections, { api, project, onDeploy }) {
    const generation = (generations.get(container) || 0) + 1;
    generations.set(container, generation);
    const current = () => generations.get(container) === generation;
    container.replaceChildren(node("h2", "Agent permissions"), node("p", "Project and workroom agents can do only what is allowed here, through PSM's tools. Anything not allowed is denied. Workspace chat and your own terminals have their own, separate access.", "cap-section-description"));
    connections.replaceChildren(node("h2", "Deployment connections"));
    if (!project?.id) {
      container.append(node("p", "This project has no registered identity. Set up the project before granting permissions."));
      connections.append(node("p", "No registered deployment project."));
      return;
    }
    const base = `/api/projects/${encodeURIComponent(project.id)}`;
    const loading = node("p", "Loading permissions…");
    container.append(loading);
    let pending = false;
    const show = (data) => {
      container.querySelector(".permission-list")?.remove();
      const list = node("div", "", "permission-list");
      const supported = data.permissions.filter((permission) => permission.supported);
      const currentCatalog = Array.isArray(data.categories) && data.categories.length > 0;
      const categoryIds = new Set(data.permissions.map(permissionCategory));
      const categories = currentCatalog
        ? data.categories
        : fallbackCategories.filter((category) => categoryIds.has(category.id));
      const changePermissions = async (permissions, granted, label) => {
        if (pending || !current() || !permissions.length) return;
        if (granted && !await window.psmConfirm(`Allow ${project.name} agents to ${label}?\n\nThis changes ${permissions.length} standing permission${permissions.length === 1 ? "" : "s"}. Remote Git grants can publish source, and repository grants can delete files. Current turns will stop so the new permissions take effect.`, "Change agent permissions")) return;
        pending = true;
        list.querySelectorAll("button").forEach((item) => { item.disabled = true; });
        try {
          const updated = await request(api, `${base}/agent-permissions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ permissions, permission: permissions.length === 1 ? permissions[0] : undefined, granted, revision: data.revision }),
          });
          if (current()) {
            const resumed = Array.isArray(updated.resumedPreparations) ? updated.resumedPreparations : [];
            status.textContent = !granted ? "Permissions revoked. Affected turns and queued messages were stopped."
              : resumed.length ? `Grants saved. Deployment preparation resumed for ${resumed.join(", ")}.`
              : "Grants saved. A preparation waiting on grants continues once every required one is in place.";
            show(updated);
          }
        } catch (error) { if (current()) status.textContent = error.message; }
        finally { pending = false; if (current()) list.querySelectorAll("button").forEach((item) => { item.disabled = item.dataset.fixedDisabled === "true"; }); }
      };
      const action = (text, permissions, granted, label, primary = false, available = true) => {
        const button = node("button", text, primary ? "btn btn-primary" : "btn");
        button.type = "button";
        button.disabled = !permissions.length || !available;
        button.dataset.fixedDisabled = button.disabled ? "true" : "false";
        if (!available) button.title = "Restart PSM to load the categorized permission service.";
        button.onclick = () => changePermissions(permissions, granted, label);
        return button;
      };

      const post = async (path, body, method = "POST") => {
        if (pending || !current()) return;
        pending = true;
        list.querySelectorAll("button, select, input").forEach((item) => { item.disabled = true; });
        try {
          const updated = await request(api, `${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, revision: data.revision }) });
          if (current()) { status.textContent = "Saved."; show(updated.permissions || updated); loadAccess(); }
        } catch (error) { if (current()) status.textContent = error.message; }
        finally { pending = false; }
      };

      const summary = node("section", "", "permission-presets");
      summary.append(node("h3", "Access presets"), node("p", "One action sets everything below to the preset. You can still change individual grants and rules afterwards.", "cap-section-description"));
      const lastPreset = [...(data.history || [])].find((event) => String(event.permission).startsWith("preset:"));
      const presetGrid = node("div", "", "permission-preset-grid");
      for (const preset of data.presets || []) {
        const card = node("article", "", "permission-preset");
        const active = lastPreset?.permission === `preset:${preset.id}@${preset.version}`;
        card.append(node("h4", `${preset.title}${active ? " · applied" : ""}`), node("p", preset.summary));
        const limits = node("details", "");
        limits.append(node("summary", "What it cannot do"));
        const ul = node("ul", "");
        for (const limit of preset.limits) ul.append(node("li", limit));
        limits.append(ul);
        const apply = node("button", active ? "Apply again" : `Apply ${preset.title}`, preset.id === "full" ? "btn" : "btn btn-primary");
        apply.type = "button";
        apply.onclick = async () => {
          const lines = [`${preset.title} for ${project.name}:`, preset.summary, "", "Allows: " + preset.grants.join(", "), ...(preset.rules || []).map((rule) => `${rule.effect.toUpperCase()} ${rule.permission}${rule.scope?.environmentId ? ` in ${rule.scope.environmentId}` : ""}`), "", "Replaces this project's current grants and rules. Running agent turns stop."];
          if (await window.psmConfirm(lines.join("\n"), "Apply access preset")) post("/agent-permissions/preset", { preset: preset.id });
        };
        card.append(limits, apply);
        presetGrid.append(card);
      }
      const granted = supported.filter((permission) => data.grants[permission.id]?.granted).map((permission) => permission.id);
      const revokeAll = action("Revoke all grants", granted, false, "revoke every managed operation", false, currentCatalog);
      summary.append(presetGrid, revokeAll);
      list.append(summary);

      const workspaceSection = node("section", "", "permission-workspace-policy");
      list.append(workspaceSection);

      const rules = node("section", "", "permission-rules");
      rules.append(node("h3", "Rules"), node("p", "Rules narrow or widen single operations: Allow, Ask (you review each use) or Deny, for an environment, for a while, or once. The most specific rule wins; Deny beats Ask beats Allow.", "cap-section-description"));
      for (const rule of data.rules || []) {
        const row = node("article", "", "permission-row");
        row.append(node("p", describeRule(rule)));
        const remove = node("button", "Remove", "btn"); remove.type = "button";
        remove.onclick = () => post(`/agent-permissions/rules/${encodeURIComponent(rule.id)}`, {}, "DELETE");
        row.append(remove);
        rules.append(row);
      }
      if (!(data.rules || []).length) rules.append(node("p", "No rules. Only the grants below apply."));
      for (const rule of data.workspaceRules || []) if (rule.effect === "deny") rules.append(node("p", `Workspace: ${describeRule(rule)}`, "cap-badge"));
      const form = node("form", "", "permission-rule-form");
      const select = (options, label) => { const element = document.createElement("select"); element.setAttribute("aria-label", label); for (const [value, text] of options) { const option = document.createElement("option"); option.value = value; option.textContent = text; element.append(option); } return element; };
      const permissionSelect = select(supported.map((permission) => [permission.id, `${permission.title} (${permission.id})`]), "Operation");
      const effectSelect = select([["allow", "Allow"], ["ask", "Ask me"], ["deny", "Deny"]], "Effect");
      const environment = document.createElement("input"); environment.placeholder = "environment (optional)"; environment.setAttribute("aria-label", "Environment");
      const duration = select(DURATIONS, "Duration");
      const add = node("button", "Add rule", "btn"); add.type = "submit";
      form.append(permissionSelect, effectSelect, environment, duration, add);
      form.onsubmit = (event) => {
        event.preventDefault();
        const chosen = duration.value;
        post("/agent-permissions/rules", {
          permission: permissionSelect.value, effect: effectSelect.value,
          scope: environment.value.trim() ? { environmentId: environment.value.trim() } : {},
          duration: chosen === "standing" ? { kind: "standing" } : chosen === "once" ? { kind: "once" } : { kind: "until", expiresAt: Date.now() + Number(chosen) * 3_600_000 },
        });
      };
      rules.append(form);
      list.append(rules);
      if (!currentCatalog) list.append(node("p", "PSM is still running the previous permission service. Individual grants remain available; restart PSM to load the complete Git list and category-wide grants.", "permission-status"));

      for (const category of categories) {
        const permissions = data.permissions.filter((permission) => permissionCategory(permission) === category.id);
        if (!permissions.length) continue;
        const section = node("section", "", "permission-category");
        const heading = node("div", "", "permission-category-head");
        const copy = node("div", "");
        copy.append(node("h3", category.title), node("p", category.description, "cap-section-description"));
        const actions = node("div", "", "permission-actions");
        const categoryMissing = permissions.filter((permission) => permission.supported && !data.grants[permission.id]?.granted).map((permission) => permission.id);
        const categoryGranted = permissions.filter((permission) => permission.supported && data.grants[permission.id]?.granted).map((permission) => permission.id);
        actions.append(
          action("Grant all", categoryMissing, true, `use all ${category.title.toLowerCase()} operations`, false, currentCatalog),
          action("Revoke all", categoryGranted, false, `revoke all ${category.title.toLowerCase()} operations`, false, currentCatalog),
        );
        heading.append(copy, actions);
        section.append(heading);

        for (const permission of permissions) {
          const grant = data.grants[permission.id];
          const row = node("article", "", "permission-row");
          const description = node("div", "");
          description.append(node("h4", permission.title), node("p", permission.description));
          if (grant) description.append(node("small", `${grant.granted ? "Granted" : "Revoked"} by ${grant.actor} · ${new Date(grant.at).toLocaleString()}`));
          else description.append(node("small", "No grant recorded"));
          const state = node("span", permission.supported ? grant?.granted ? "Granted" : "Not granted" : "Unavailable", "cap-badge");
          row.append(description, state);
          if (permission.supported) {
            row.append(action(grant?.granted ? "Revoke" : "Grant", [permission.id], !grant?.granted, permission.title.toLowerCase()));
          }
          section.append(row);
        }
        list.append(section);
      }
      const audit = node("details", "", "permission-audit");
      audit.append(node("summary", "Permission history"));
      for (const event of data.history) {
        const what = String(event.permission).includes(":") ? event.permission : `${event.granted ? "granted" : "revoked"} ${event.permission}`;
        audit.append(node("p", `${new Date(event.at).toLocaleString()} · ${event.actor} · ${what} · revision ${event.revision}`));
      }
      if (!data.history.length) audit.append(node("p", "No permission changes recorded."));
      list.append(audit);
      container.append(list);
      void renderWorkspacePolicy(workspaceSection, {
        api, workspaceId: data.project?.workspaceId || "personal", current,
        onChanged: async (message) => {
          status.textContent = message;
          try {
            const updated = await request(api, `${base}/agent-permissions`);
            if (current()) { show(updated); await loadAccess(); }
          } catch (error) { if (current()) status.textContent = `${message} Could not refresh project access: ${error.message}`; }
        },
      });
    };
    const status = node("p", "", "permission-status");
    status.setAttribute("role", "status");
    container.append(status);
    const permissions = request(api, `${base}/agent-permissions`).then((data) => { if (current()) show(data); }).catch((error) => { if (current()) status.textContent = error.message; }).finally(() => { if (current()) loading.remove(); });
    const connectionTask = request(api, `${base}/deployments`).then((data) => {
      if (!current()) return;
      const grouped = new Map();
      for (const environment of data.environments || []) {
        for (const connection of environment.connections || []) {
          const key = connection.connectionId || `unbound:${environment.id}:${connection.slot}`;
          const group = grouped.get(key) || { id: connection.connectionId || connection.slot, kind: connection.kind, uses: [], causes: new Map(), ready: true, checkedAt: null, expired: false };
          group.uses.push(`${environment.id} (${connection.slot})`);
          group.ready = group.ready && connection.ready;
          if (connection.observedAt) group.checkedAt = Math.max(group.checkedAt || 0, connection.observedAt);
          if (!connection.observationsExpireAt || connection.observationsExpireAt <= Date.now()) group.expired = true;
          for (const diagnostic of connection.diagnostics || []) {
            const causeKey = `${diagnostic.code}:${diagnostic.detail}`;
            const cause = group.causes.get(causeKey) || { ...diagnostic, dependents: [] };
            cause.dependents.push(...diagnostic.dependents.map((id) => `${environment.id}/${id}`));
            group.causes.set(causeKey, cause);
          }
          grouped.set(key, group);
        }
      }
      if (!grouped.size) connections.append(node("p", "No deployment connections declared."));
      for (const group of grouped.values()) {
        const card = node("article", "", "permission-connection");
        card.append(node("h3", `${group.id} · ${group.kind}`), node("p", `Used by ${group.uses.join(", ")}`));
        card.append(node("p", group.causes.size ? "Needs attention" : group.ready ? "Credentials present; check deployment readiness to verify access." : "Connection is not ready", "cap-badge"));
        if (group.checkedAt) card.append(node("small", `Last observation: ${new Date(group.checkedAt).toLocaleString()}${group.expired ? " · refresh required" : ""}`));
        for (const cause of group.causes.values()) {
          const details = node("div", "", "permission-cause");
          details.append(node("strong", cause.title), node("pre", cause.detail));
          if (cause.dependents.length) details.append(node("p", `Affects ${[...new Set(cause.dependents)].join(", ")}`));
          card.append(details);
        }
        connections.append(card);
      }
      const manage = node("button", "Open deployment setup", "btn");
      manage.type = "button"; manage.onclick = onDeploy; connections.append(manage);
    }).catch((error) => { if (current()) connections.append(node("p", error.message)); });
    const accessSection = node("section", "", "permission-access");
    container.insertBefore(accessSection, loading);
    const loadAccess = async () => {
      try {
        const data = await request(api, `${base}/agent-access`);
        if (!current()) return;
        accessSection.replaceChildren(node("h3", "What agents can do now"), node("p", `As ${data.engine} sees it. Each gap names what would change it.`, "cap-section-description"));
        const table = node("div", "", "permission-access-list");
        for (const item of data.items) {
          const row = node("article", "", `permission-row access-${item.status}`);
          const copy = node("div", "");
          copy.append(node("h4", item.title), node("p", item.detail));
          if (item.action) copy.append(node("small", item.action));
          row.append(copy, node("span", STATUS_TEXT[item.status] || item.status, "cap-badge"));
          table.append(row);
        }
        accessSection.append(table);
      } catch (error) { if (current()) accessSection.replaceChildren(node("p", error.message)); }
    };
    const operationSection = node("section", "", "permission-operation-reviews");
    container.append(operationSection);
    const loadOperationReviews = async () => {
      try {
        const data = await request(api, `${base}/agent-reviews`);
        if (!current()) return;
        operationSection.replaceChildren(node("h3", "Operations waiting for you"));
        const pendingReviews = data.reviews.filter((review) => review.state === "pending");
        if (!pendingReviews.length) operationSection.append(node("p", "Nothing is waiting. When a rule says Ask, the agent's request appears here."));
        for (const review of data.reviews.slice(0, 20)) {
          const row = node("article", "", "permission-row");
          const detail = node("div", "");
          detail.append(node("h4", review.permission), node("pre", review.summary), node("small", `${review.state}${review.answer ? ` · ${review.answer}` : ""}${review.actor ? ` · ${review.actor}` : ""} · ${new Date(review.createdAt).toLocaleString()}`));
          row.append(detail);
          if (review.state === "pending") {
            for (const [answer, label] of [["once", "Allow once"], ["task", "Allow for this task"], ["standing", "Always allow"], ["reject", "Reject"]]) {
              if (answer === "task" && !review.task) continue;
              const button = node("button", label, answer === "once" ? "btn btn-primary" : "btn"); button.type = "button";
              button.onclick = async () => {
                if (answer === "standing" && !await window.psmConfirm(`Always allow ${review.permission}${review.context?.environmentId ? ` in ${review.context.environmentId}` : ""} for ${project.name}? Future requests of this kind will not ask.`, "Always allow permission")) return;
                row.querySelectorAll("button").forEach((item) => { item.disabled = true; });
                try { await request(api, `${base}/agent-reviews/${encodeURIComponent(review.id)}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }) }); status.textContent = answer === "reject" ? "Rejected." : "Approved. The agent can retry now."; }
                catch (error) { status.textContent = error.message; }
                await Promise.all([loadOperationReviews(), loadAccess()]);
              };
              row.append(button);
            }
          }
          operationSection.append(row);
        }
      } catch (error) { if (current()) operationSection.replaceChildren(node("p", error.message)); }
    };
    const toolSection = node("section", "", "permission-tool-reviews");
    container.append(toolSection);
    const loadReviews = async () => {
      try {
        const data = await request(api, `${base}/agent-tool-requests`);
        if (!current()) return;
        toolSection.replaceChildren(node("h3", "Attached tool requests"));
        const refresh = node("button", "Refresh requests", "btn"); refresh.onclick = loadReviews; toolSection.append(refresh);
        if (!data.requests.length) toolSection.append(node("p", "No attached tool calls awaiting review."));
        for (const call of data.requests) {
          const row = node("article", "", "permission-row");
          const detail = node("div", "");
          detail.append(node("h4", `${call.capability} · ${call.tool}`), node("pre", JSON.stringify(call.arguments, null, 2)), node("p", `${call.state}${call.actor ? ` · ${call.actor}` : ""}`));
          row.append(detail);
          if (call.state === "pending" && call.expiresAt > Date.now()) {
            for (const [approve, always, label] of [[true, false, "Approve call"], [true, true, "Always allow this tool"], [false, false, "Reject"]]) {
              const button = node("button", label, "btn");
              button.onclick = async () => {
                if (approve && !await window.psmConfirm(always ? `Run ${call.tool} now, and let future ${call.tool} calls through ${call.capability} run without review?` : `Run ${call.tool} through ${call.capability} with the displayed arguments? This may change an external service.`, "Approve attached tool")) return;
                row.querySelectorAll("button").forEach((button) => { button.disabled = true; });
                try { await request(api, `${base}/agent-tool-requests/${encodeURIComponent(call.id)}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest: call.digest, approve, always }) }); }
                catch (error) { status.textContent = error.message; }
                await loadReviews();
              };
              row.append(button);
            }
          }
          toolSection.append(row);
        }
      } catch (error) { if (current()) toolSection.replaceChildren(node("p", error.message)); }
    };
    await Promise.all([permissions, connectionTask, loadReviews(), loadOperationReviews(), loadAccess()]);
  }
  window.PsmAgentPermissions = { render };
})();
