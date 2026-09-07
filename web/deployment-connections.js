/* Local deployment authority is changed only by explicit connection form actions. */
(() => {
  const renders = new WeakMap();
  const riskLevels = { development: 0, staging: 1, production: 2 };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className || "";
    if (text != null) node.textContent = text;
    return node;
  }

  function scopeIssue(profile, environment) {
    const constraints = profile.constraints || {};
    if (environment.projectId && !constraints.allowedProjectIds?.includes(environment.projectId)) return "Not allowed for this project";
    if (!constraints.allowedEnvironmentIds?.includes(environment.id)) return "Not allowed for this environment";
    const risk = riskLevels[environment.risk];
    if (risk == null || riskLevels[constraints.maximumAuthorizedRisk] == null) return "Risk scope is missing";
    if (risk > riskLevels[constraints.maximumAuthorizedRisk]) return "Not allowed for this risk level";
    if (constraints.minimumRequiredRisk && risk < riskLevels[constraints.minimumRequiredRisk]) return "Requires a higher risk level";
    return "";
  }

  async function request(api, url, init) {
    const response = await api(url, init);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Connection request failed");
    return result;
  }

  function jsonRequest(method, body) {
    return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  function profileHelp(kind) {
    if (kind === "ssh-host-helper@1") return "Use the operator's verified SSH host key, SSH account, allowed targets and release directories, known-host entry, and trusted target contracts. The private key is added separately after importing.";
    if (kind === "github-actions@1") return "Use the operator's approved repositories, source refs, and trusted build and release workflow contracts. The API token is added separately after importing.";
    if (kind === "digitalocean-api@1") return "Use the operator's approved DNS zones and provider account scope. The API token is added separately after importing.";
    if (kind === "external-monitor@1") return "Use the operator's monitoring provider metadata and allowed monitor IDs. Any API token is added separately after importing.";
    return "Use the operator's connection metadata and explicit scope for this environment. Credentials are added separately after importing.";
  }

  async function render(container, options) {
    const { projectKey, environment, api, onChanged, isCurrent = () => true, canManage = true } = options;
    const token = {};
    renders.set(container, token);
    const current = () => renders.get(container) === token && isCurrent();
    container.replaceChildren();
    if (!environment?.connections?.length) {
      container.append(element("div", "dep-empty", "This environment declares no connections."));
      return;
    }

    container.append(element("div", "dep-empty", "Loading local connections…"));
    let profiles;
    try {
      profiles = (await request(api, "/api/connections")).connections || [];
    } catch (error) {
      if (!current()) return;
      container.replaceChildren(element("div", "dep-empty", error.message || "Could not load local connections."));
      const retry = element("button", "dep-mini-btn", "Retry connections");
      retry.type = "button";
      retry.onclick = () => { if (current()) return render(container, options); };
      container.append(retry);
      return;
    }
    if (!current()) return;
    container.replaceChildren();
    let busy = false;

    async function mutate(status, action) {
      if (!current() || busy || !canManage) return;
      busy = true;
      for (const control of container.querySelectorAll("button, input, select, textarea")) control.disabled = true;
      status.textContent = "Saving connection…";
      try {
        await action();
      } catch (error) {
        if (!current()) return;
        status.textContent = error.message || "Could not save this connection.";
        // Recompute each control's eligibility; do not enable forbidden scope choices.
        busy = false;
        for (const refresh of refreshControls) refresh();
        return;
      }
      if (!current()) return;
      status.textContent = "Saved. Checking deployment readiness…";
      try {
        await onChanged?.();
        if (current()) await render(container, options);
      } catch (error) {
        if (!current()) return;
        status.textContent = `Saved, but readiness could not be refreshed: ${error.message || "try again"}`;
        busy = false;
        for (const refresh of refreshControls) refresh();
      }
    }

    const refreshControls = [];
    for (const connection of environment.connections) {
      const row = element("div", "dep-row dep-connection-row");
      row.dataset.state = connection.ready ? "ready" : "blocked";
      row.append(element("span", "dep-row-icon", connection.ready ? "✓" : "×"));
      const copy = element("div");
      copy.append(element("div", "dep-row-title", connection.slot));
      copy.append(element("div", "dep-row-detail", connection.detail || (connection.ready ? "Bound" : "Choose a local connection")));
      const status = element("div", "dep-row-detail dep-connection-status");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const matching = profiles.filter((profile) => profile.kind === connection.kind);
      const controls = element("div", "dep-connection-controls");
      const select = element("select", "dep-connection-select");
      select.setAttribute("aria-label", `Connection for ${connection.slot} in ${environment.id}`);
      const placeholder = element("option", "", matching.length ? "Choose a local connection…" : "No connections of this kind");
      placeholder.value = "";
      select.append(placeholder);
      for (const profile of matching) {
        const issue = scopeIssue(profile, environment);
        const option = element("option", "", `${profile.label || profile.connectionId}${issue ? ` — ${issue}` : profile.ready ? "" : " — needs credentials"}`);
        option.value = profile.connectionId;
        option.disabled = !!issue;
        select.append(option);
      }
      select.value = matching.some((profile) => profile.connectionId === connection.connectionId) ? connection.connectionId : "";
      const bind = element("button", "dep-mini-btn", "Use connection");
      bind.type = "button";
      const credentials = element("div", "dep-connection-credentials");
      let secretControls = [];
      refreshControls.push(() => { for (const refresh of secretControls) refresh(); });
      const selectedProfile = () => matching.find((profile) => profile.connectionId === select.value);
      const updateControls = () => {
        select.disabled = busy || !canManage || !matching.length;
        const selected = selectedProfile();
        bind.disabled = busy || !canManage || !selected || !!scopeIssue(selected, environment) || selected.connectionId === connection.connectionId;
      };
      refreshControls.push(updateControls);

      function showCredentials() {
        credentials.replaceChildren();
        secretControls = [];
        const profile = selectedProfile();
        if (!profile || scopeIssue(profile, environment)) return;
        if (!profile.missingSecretSlots?.length) {
          credentials.append(element("div", "dep-row-detail", "Credentials are present. Check deployment readiness to verify the actual connection and target."));
          return;
        }
        credentials.append(element("div", "dep-row-detail", "Credentials go to this agent's secure store. If its OS keyring is unavailable, they last only until the agent restarts. Saving updates this profile wherever it is used."));
        for (const slot of profile.missingSecretSlots) {
          const form = element("form", "dep-connection-secret");
          const label = element("label", "dep-row-detail", slot);
          const input = element("input", "dep-connection-input");
          input.type = "password";
          input.autocomplete = "new-password";
          input.required = true;
          input.setAttribute("aria-label", `${slot} for ${profile.label || profile.connectionId}`);
          label.append(input);
          const save = element("button", "dep-mini-btn", "Save credential");
          save.type = "submit";
          let fileValue = "";
          let fileVersion = 0;
          const keyFile = slot === "privateKey" ? element("input", "dep-connection-keyfile") : null;
          const fileStatus = element("span", "dep-row-detail");
          const updateSecret = () => {
            input.disabled = busy || !canManage;
            if (keyFile) keyFile.disabled = busy || !canManage;
            save.disabled = busy || !canManage || !(input.value || fileValue);
          };
          input.oninput = () => {
            fileVersion++;
            fileValue = "";
            if (keyFile) keyFile.value = "";
            fileStatus.textContent = "";
            updateSecret();
          };
          secretControls.push(updateSecret);
          if (keyFile) {
            keyFile.type = "file";
            keyFile.setAttribute("aria-label", `Choose a private key file for ${profile.label || profile.connectionId}`);
            keyFile.onchange = async () => {
              const version = ++fileVersion;
              fileValue = "";
              input.value = "";
              fileStatus.textContent = "";
              updateSecret();
              const file = keyFile.files?.[0];
              if (!file) return;
              if (file.size > 65_536) {
                fileStatus.textContent = "Choose a private key file smaller than 64 KB.";
                return;
              }
              try {
                const value = await file.text();
                if (!current() || busy || version !== fileVersion || selectedProfile() !== profile) return;
                fileValue = value;
                fileStatus.textContent = "Private key selected. Save credential to store it with this agent.";
                updateSecret();
              } catch {
                if (current() && version === fileVersion) fileStatus.textContent = "Could not read this private key file.";
              }
            };
          }
          updateSecret();
          form.onsubmit = (event) => {
            event.preventDefault();
            if (!current() || busy || !canManage || !(input.value || fileValue) || selectedProfile() !== profile) return;
            let value = fileValue || input.value;
            fileValue = "";
            fileVersion++;
            input.value = "";
            if (keyFile) keyFile.value = "";
            fileStatus.textContent = "";
            return mutate(status, async () => {
              try {
                await request(api, `/api/connections/${encodeURIComponent(profile.connectionId)}/secrets`, jsonRequest("POST", { slot, value }));
              } finally {
                value = "";
              }
            });
          };
          form.append(label, save);
          if (keyFile) form.append(keyFile, fileStatus);
          credentials.append(form);
        }
      }
      select.onchange = () => { if (current() && !busy) { updateControls(); showCredentials(); } };
      bind.onclick = () => {
        const profile = selectedProfile();
        if (!profile || scopeIssue(profile, environment) || bind.disabled) return;
        return mutate(status, async () => {
          const result = await request(api, `/api/projects/${encodeURIComponent(projectKey)}/deployments/${encodeURIComponent(environment.id)}/connection-bindings/${encodeURIComponent(connection.slot)}`, jsonRequest("PUT", { connectionId: profile.connectionId, expectedRevision: connection.bindingRevision ?? null }));
          connection.connectionId = profile.connectionId;
          connection.bindingRevision = result.binding?.bindingRevision ?? connection.bindingRevision;
        });
      };
      updateControls();
      showCredentials();
      controls.append(select, bind);
      copy.append(controls, credentials);

      const add = element("details", "dep-connection-import");
      add.append(element("summary", "dep-row-detail", "Add a connection"));
      add.append(element("p", "dep-row-detail", `Import a ${connection.kind} profile supplied by your operator. ${profileHelp(connection.kind)}`));
      add.append(element("p", "dep-row-detail", "Profile JSON needs connectionId, label, kind, publicMetadata, requiredSecretSlots, and constraints. Include this project's ID and environment in allowedProjectIds and allowedEnvironmentIds. Paste only public settings; enter secret values in the credential fields after import."));
      if (environment.projectId) add.append(element("p", "dep-row-detail", `Project: ${environment.projectId} · Environment: ${environment.id} · Risk: ${environment.risk}`));
      const importForm = element("form");
      const profileInput = element("textarea", "dep-connection-profile");
      profileInput.rows = 8;
      profileInput.spellcheck = false;
      profileInput.setAttribute("aria-label", `Public connection profile JSON for ${connection.slot}`);
      profileInput.placeholder = "Paste the operator-supplied connection profile JSON";
      const create = element("button", "dep-mini-btn", "Import connection");
      create.type = "submit";
      const updateImport = () => {
        profileInput.disabled = busy || !canManage;
        create.disabled = busy || !canManage || !profileInput.value.trim();
      };
      refreshControls.push(updateImport);
      profileInput.oninput = updateImport;
      updateImport();
      importForm.onsubmit = (event) => {
        event.preventDefault();
        if (!current() || busy || !canManage || !profileInput.value.trim()) return;
        let profile;
        try {
          profile = JSON.parse(profileInput.value);
          if (!profile || Array.isArray(profile) || typeof profile !== "object") throw new Error("Paste a connection profile JSON object.");
          if (profile.kind !== connection.kind) throw new Error(`This slot requires a ${connection.kind} profile.`);
          if (!profile.connectionId || !profile.label || !Array.isArray(profile.requiredSecretSlots)) throw new Error("The profile needs connectionId, label, and requiredSecretSlots.");
          const issue = scopeIssue(profile, environment);
          if (issue) throw new Error(issue);
          const fields = new Set(["connectionId", "label", "kind", "publicMetadata", "credentialIdentity", "requiredSecretSlots", "constraints"]);
          if (Object.keys(profile).some((key) => !fields.has(key))) throw new Error("Use only public profile settings. Add credentials separately after import.");
        } catch (error) {
          status.textContent = error.message || "The connection profile is not valid JSON.";
          return;
        }
        return mutate(status, async () => {
          await request(api, "/api/connections", jsonRequest("POST", profile));
        });
      };
      importForm.append(profileInput, create);
      add.append(importForm);
      copy.append(add, status);
      row.append(copy, element("span", "dep-row-kind", connection.kind));
      container.append(row);
    }
    if (!canManage) container.append(element("div", "dep-empty", "Open this project in the local cockpit to manage deployment connections."));
  }

  window.PsmDeploymentConnections = { render };
})();
