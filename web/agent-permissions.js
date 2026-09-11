/* Project policy is server-owned. This view never writes repository settings. */
(() => {
  const generations = new WeakMap();
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
  async function render(container, connections, { api, project, onDeploy }) {
    const generation = (generations.get(container) || 0) + 1;
    generations.set(container, generation);
    const current = () => generations.get(container) === generation;
    container.replaceChildren(node("h2", "Agent permissions"), node("p", "Project and workroom sessions use these grants. Missing grants deny access. Workspace chat and operator terminals retain their own permissions.", "cap-section-description"));
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
      list.append(node("p", "Managed execution: Claude and Codex. Tests and installs use a disposable offline Docker sandbox. Attached MCP calls require individual review below.", "cap-section-description"));
      for (const permission of data.permissions) {
        const grant = data.grants[permission.id];
        const row = node("article", "", "permission-row");
        const description = node("div", "");
        description.append(node("h3", permission.title), node("p", permission.description));
        if (grant) description.append(node("small", `${grant.granted ? "Granted" : "Revoked"} by ${grant.actor} · ${new Date(grant.at).toLocaleString()}`));
        else description.append(node("small", permission.id === "git.push" ? "Outside standing agent permissions" : "No grant recorded"));
        const state = node("span", permission.supported ? grant?.granted ? "Granted" : "Not granted" : permission.id === "git.push" ? "Approval required" : "Unavailable", "cap-badge");
        row.append(description, state);
        if (permission.supported) {
          const button = node("button", grant?.granted ? "Revoke" : "Grant", "btn");
          button.type = "button";
          button.onclick = async () => {
            if (pending || !current()) return;
            const granted = !grant?.granted;
            if (granted && !window.confirm(`Allow ${project.name} agents to ${permission.title.toLowerCase()}?\n\n${permission.description}\n\nCurrent turns will stop so new permissions take effect.`)) return;
            pending = true;
            list.querySelectorAll("button").forEach((item) => { item.disabled = true; });
            try {
              const updated = await request(api, `${base}/agent-permissions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permission: permission.id, granted, revision: data.revision }) });
              if (current()) { status.textContent = granted ? "Grant saved. Start a new turn or resume preparation." : "Revoked. Affected turns and queued messages were stopped."; show(updated); }
            } catch (error) { if (current()) status.textContent = error.message; }
            finally { pending = false; if (current()) list.querySelectorAll("button").forEach((item) => { item.disabled = false; }); }
          };
          row.append(button);
        }
        list.append(row);
      }
      const audit = node("details", "", "permission-audit");
      audit.append(node("summary", "Permission history"));
      for (const event of data.history) audit.append(node("p", `${new Date(event.at).toLocaleString()} · ${event.actor} · ${event.granted ? "granted" : "revoked"} ${event.permission} · revision ${event.revision}`));
      if (!data.history.length) audit.append(node("p", "No permission changes recorded."));
      list.append(audit);
      container.append(list);
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
            for (const approve of [true, false]) {
              const button = node("button", approve ? "Approve call" : "Reject", "btn");
              button.onclick = async () => {
                if (approve && !window.confirm(`Run ${call.tool} through ${call.capability} with the displayed arguments? This may change an external service.`)) return;
                row.querySelectorAll("button").forEach((button) => { button.disabled = true; });
                try { await request(api, `${base}/agent-tool-requests/${encodeURIComponent(call.id)}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest: call.digest, approve }) }); }
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
    await Promise.all([permissions, connectionTask, loadReviews()]);
  }
  window.PsmAgentPermissions = { render };
})();
