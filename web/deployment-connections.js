/* Local deployment authority is changed only by explicit connection form actions. */
(() => {
  const renders = new WeakMap();
  const drafts = new WeakMap();
  const riskLevels = { development: 0, staging: 1, production: 2 };
  let helpId = 0;

  const fieldNotes = {
    label: ["A friendly name shown in the connection picker. It helps you recognize this connection; it does not change the server or repository.", "Production web server"],
    host: ["The hostname or IP address PSM connects to over SSH to reach the host helper. It must match the server named in the verified SSH host key entry.", "web.example.com or 192.0.2.10"],
    user: ["The SSH account PSM logs in as. Its permissions come from the target enrolled with the host helper.", "psm-deploy"],
    port: ["The port where the server accepts SSH connections. Use your server's configured port; the usual default is 22.", "22, or 2222 for a custom SSH port"],
    address: ["The server's public IPv4 address. PSM uses it as the destination of DNS A records that refer to this host connection.", "192.0.2.10 (illustrative address)"],
    knownHost: ["The server's public SSH identity, copied from a verified known_hosts entry. PSM checks it to ensure it connects to the expected server. A custom port uses [hostname]:port.", "web.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… (abbreviated)"],
    hostKeyFingerprint: ["The SHA256 fingerprint of that same public SSH host key. It must match the verified key above. Obtain it from your server administrator or inspect your verified key with ssh-keygen -lf <known-hosts-file>.", "SHA256:AbCd… (abbreviated; SHA256: followed by 43 base64 characters)"],
    target: ["The ID of the deployment destination enrolled with the host helper. PSM uses it to select the target contract; it must match the deployment manifest and the host enrollment.", "example:site-production-web"],
    root: ["The absolute directory this connection may manage for releases. PSM restricts host operations to this directory and its children.", "/var/www/site.example.com"],
    fingerprint: ["The SHA256 fingerprint of the enrolled target contract. PSM includes it in release requests so the controller can check the expected target configuration.", "sha256:abcd… (abbreviated; sha256: followed by 64 lowercase hexadecimal characters)"],
    revision: ["The revision recorded in the enrolled target contract. PSM includes it with the target fingerprint when requesting a release.", "1 (use the actual enrolled revision)"],
    sourceRef: ["The source branch or tag allowed for this environment. It limits which source ref this connection may build; use the exact value declared by the deployment.", "main or v1.2.3"],
    repository: ["The GitHub repository containing the application source. PSM uses its build workflow to prepare a deployment artifact. Enter owner/repository, without the GitHub URL.", "example/site"],
    workflow: ["The filename of the GitHub Actions workflow that builds a PSM deployment artifact. It must exist under .github/workflows and implement PSM artifact preparation.", "build-static.yml"],
    controllerRepository: ["The GitHub repository holding the trusted release workflow that deploys prepared artifacts. It can differ from your application's repository. PSM reads that workflow, the branch it runs from, and the hashes that pin it out of this repository itself.", "example/deployment-controller"],
    githubEnvironment: ["The GitHub Environment in the release repository that holds this target's deploy credentials and protection rules. PSM fills this in from the repository's configured environments when it can reach it.", "production"],
    zones: ["DNS domains this connection may manage in DigitalOcean. Enter zone names, not individual record names; separate multiple zones with commas.", "example.com, example.org"],
    monitors: ["The Better Stack monitor IDs this connection may read. PSM uses them to check external monitoring status after deployment. Enter IDs rather than monitor names or URLs.", "123456, 789012"],
    apiToken: ["The provider-issued secret used to authenticate API requests for this connection. Paste the token itself; PSM stores it separately from the public profile in the agent's secure store.", "your-provider-issued-token (illustrative; use your real token)"],
    privateKey: ["The private SSH login key for the deployment account. This is separate from the server's public host key. Select the complete key file below to preserve its formatting.", "-----BEGIN OPENSSH PRIVATE KEY----- … -----END OPENSSH PRIVATE KEY----- (abbreviated)"],
    keyFile: ["Choose the private SSH key file for the deployment account. PSM reads it and stores it with the agent when you choose Save credential. Select the private file, not the .pub file; maximum size is 64 KB.", "id_ed25519"],
    connection: ["An existing local connection profile with its saved settings and credentials. Choose one, then select Use connection to attach it to this deployment slot. Entries outside the project's environment or risk scope cannot be selected.", "Production web server — needs credentials"],
    profile: ["A complete public connection profile for advanced configuration. Import creates the profile; select Use connection afterward to bind it. Include connectionId, label, kind, publicMetadata, requiredSecretSlots, and constraints. Enter secrets separately.", '{ "connectionId": "host:production", "label": "Production host", … } (excerpt; import requires the complete profile)'],
  };

  function addFieldHelp(wrapper, control, key) {
    const name = key.replace(/\d+$/, "");
    const [note, example] = Object.hasOwn(fieldNotes, name) ? fieldNotes[name] : ["A secret required by this connection's provider. Save it in the agent's secure store so PSM can authenticate the connection.", "the value supplied by your provider"];
    const tooltip = element("span", "dep-field-tooltip");
    tooltip.id = `dep-field-help-${++helpId}`;
    tooltip.setAttribute("role", "tooltip");
    tooltip.append(element("span", "", note), element("span", "dep-field-example", `Example: ${example}`));
    control.setAttribute("aria-describedby", tooltip.id);
    wrapper.className += " dep-field-has-help";
    wrapper.onkeydown = (event) => {
      if (event.key === "Escape") wrapper.dataset.helpDismissed = "true";
    };
    wrapper.onmouseleave = () => { wrapper.dataset.helpDismissed = "false"; };
    wrapper.onfocusout = () => { wrapper.dataset.helpDismissed = "false"; };
    wrapper.append(tooltip);
  }

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

  // The form owns the JSON shape; people supply the connection's actual settings.
  function setupForm(connection, environment) {
    const fields = [];
    let controller = null;
    const defaults = connection.setup?.defaults;
    const field = (key, label, value = "", help = "", pattern = "", optional = false) => {
      const detected = defaults?.values?.[key];
      fields.push({ key, label, value: typeof detected === "string" ? detected : value, help, pattern, optional, source: defaults?.sources?.[key] || (value ? "Deployment settings or standard default" : "") });
      return key;
    };
    const unique = (values) => [...new Set(values)];
    const list = (value) => unique(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean));
    const setup = connection.setup || {};
    const kind = connection.kind;
    const names = { "ssh-host-helper@1": "Host", "github-actions@1": "GitHub", "digitalocean-api@1": "DigitalOcean DNS", "external-monitor@1": "Better Stack" };
    if (!names[kind]) return null;
    field("label", "Connection name", `${names[kind]} · ${environment.id}`);
    let configure;
    if (kind === "ssh-host-helper@1") {
      field("host", "SSH hostname or IP address", "", "The server running the PSM host helper.");
      field("user", "SSH username", "", "The deployment account enrolled with the host helper.");
      field("port", "SSH port", "22", "", "[0-9]{1,5}");
      field("address", "Public IPv4 address", "", "Used when DNS points to this server.", "(?:[0-9]{1,3}\\.){3}[0-9]{1,3}");
      field("knownHost", "Verified SSH host key", "", "Paste the server's verified known_hosts entry: hostname key-type public-key.");
      field("hostKeyFingerprint", "SSH host key fingerprint", "", "The SHA256 fingerprint verified with your server administrator.", "SHA256:[A-Za-z0-9+/]{43}");
      const targets = [...new Map((setup.targets || []).map((target) => [target.id, target])).values()];
      if (!targets.length) targets.push({ id: "", root: "" });
      targets.forEach((target, i) => {
        field(`target${i}`, "Deployment target", target.id, "The target ID enrolled with the host helper.");
        field(`root${i}`, "Release directory", target.root, "The directory this connection may manage.");
        field(`fingerprint${i}`, "Target contract fingerprint", "", "The sha256 fingerprint of the enrolled target contract.", "sha256:[0-9a-f]{64}");
        field(`revision${i}`, "Target contract revision", "", "The revision recorded in the enrolled target contract.");
      });
      configure = (values, profile) => {
        const port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH port must be between 1 and 65535.");
        if (values.address.split(".").some((part) => Number(part) > 255)) throw new Error("Enter a valid public IPv4 address.");
        const expectedHost = port === 22 ? values.host : `[${values.host}]:${port}`;
        if (!values.knownHost.split(/\s+/)[0].split(",").includes(expectedHost)) throw new Error("The verified SSH host key must name this hostname and port.");
        profile.requiredSecretSlots = ["privateKey"];
        profile.constraints.ssh = { host: values.host, user: values.user, port, hostKeyFingerprint: values.hostKeyFingerprint };
        profile.constraints.allowedTargetIds = unique(targets.map((_, i) => values[`target${i}`]));
        profile.constraints.allowedTargetRootPrefixes = unique(targets.map((_, i) => values[`root${i}`]));
        profile.publicMetadata = { address: values.address, knownHost: values.knownHost, targetContracts: Object.fromEntries(targets.map((_, i) => [values[`target${i}`], { fingerprint: values[`fingerprint${i}`], revision: values[`revision${i}`] }])) };
      };
    } else if (kind === "github-actions@1") {
      const workflows = setup.workflows?.length ? setup.workflows : [{ repository: "", workflow: "", targetId: "" }];
      field("sourceRef", "Source branch or tag", environment.releasePolicy?.allowedBranch || "", "Use the exact source ref allowed for this environment.");
      workflows.forEach((workflow, i) => {
        field(`repository${i}`, "Source repository", workflow.repository, "owner/repository", "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+");
        field(`workflow${i}`, "Build workflow filename", workflow.workflow, "The workflow in .github/workflows that implements PSM artifact preparation.", "[A-Za-z0-9][A-Za-z0-9._-]*\\.ya?ml");
      });
      field("controllerRepository", "Release repository", "", "owner/repository holding the trusted PSM release workflow. PSM reads its workflow, ref and hashes itself.", "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+");
      // The release workflow, its ref and its two hashes are discovered, never typed: they are a
      // fingerprint of reviewed code, and a person copying hashes by hand is how a wrong one gets in.
      const pins = defaults?.values || {};
      controller = { repository: pins.controllerRepository || "", workflow: pins.controllerWorkflow || "", ref: pins.controllerRef || "", commit: pins.controllerSha || "", blob: pins.workflowSha || "", source: defaults?.sources?.controllerSha || "" };
      controller.pinned = Boolean(controller.workflow && controller.ref && controller.commit && controller.blob);
      const targets = unique(workflows.map((workflow) => workflow.targetId));
      targets.forEach((target, i) => {
        field(`target${i}`, "Deployment target", target);
        field(`githubEnvironment${i}`, "GitHub release environment", "", "Read from the release repository when PSM can reach it.", "", !controller.pinned);
      });
      configure = (values, profile) => {
        const sources = unique(workflows.map((_, i) => values[`repository${i}`]));
        profile.constraints.allowedRepositories = sources;
        profile.constraints.allowedSourceRefs = [values.sourceRef];
        profile.constraints.allowedTargetIds = targets.map((_, i) => values[`target${i}`]);
        const builds = workflows.map((_, i) => ({ repository: values[`repository${i}`], workflow: values[`workflow${i}`], workflowPath: `.github/workflows/${values[`workflow${i}`]}`, refs: [{ ref: values.sourceRef }] }));
        // Pins are only ever carried with the repository they were read from.
        const usable = controller.pinned && values.controllerRepository === controller.repository;
        profile.publicMetadata = {
          revision: 1,
          prepareWorkflows: [...new Map(builds.map((build) => [`${build.repository}/${build.workflow}`, build])).values()],
          releaseControllers: usable ? targets.map((_, i) => ({ controller: "werewolf-static@1", targetId: values[`target${i}`], repository: controller.repository, workflow: controller.workflow, workflowPath: `.github/workflows/${controller.workflow}`, ref: controller.ref, expectedHeadSha: controller.commit, expectedWorkflowBlobSha: controller.blob, githubEnvironment: values[`githubEnvironment${i}`], allowedSourceRepositories: sources })) : [],
        };
      };
    } else if (kind === "digitalocean-api@1") {
      field("zones", "DNS zones", (setup.zones || []).join(", "), "Domain names separated by commas, for example example.com.");
      configure = (values, profile) => { profile.constraints.allowedZones = list(values.zones); };
    } else {
      field("monitors", "Better Stack monitor IDs", (setup.monitorIds || []).join(", "), "Monitor IDs separated by commas.");
      configure = (values, profile) => {
        profile.constraints.allowedMonitorIds = list(values.monitors);
        profile.publicMetadata = { provider: "better-stack@1" };
      };
    }
    return { fields, controller, build(values, connectionId) {
      if (!environment.projectId || riskLevels[environment.risk] == null) throw new Error("Reload the deployment to load its project and environment scope.");
      for (const field of fields) {
        values[field.key] = String(values[field.key] || "").trim();
        if (!values[field.key]) {
          if (field.optional) continue;
          throw new Error(`${field.label} is required.`);
        }
        if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(values[field.key])) throw new Error(`Check ${field.label.toLowerCase()}.`);
      }
      const profile = { connectionId, label: values.label, kind, publicMetadata: {}, requiredSecretSlots: ["apiToken"], constraints: { allowedProjectIds: [environment.projectId], allowedEnvironmentIds: [environment.id], maximumAuthorizedRisk: environment.risk } };
      configure(values, profile);
      return profile;
    } };
  }

  async function render(container, options) {
    const { projectKey, environment, api, onChanged, isCurrent = () => true, canManage = true } = options;
    const token = {};
    renders.set(container, token);
    if (!drafts.has(container)) drafts.set(container, new Map());
    const savedDrafts = drafts.get(container);
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
        const requiredSlots = profile.requiredSecretSlots?.length
          ? profile.requiredSecretSlots
          : profile.kind === "ssh-host-helper@1" ? ["privateKey"] : ["apiToken"];
        const missingSlots = new Set(profile.missingSecretSlots || []);
        credentials.append(element("div", "dep-row-detail", missingSlots.size
          ? "Credentials are missing. Save them to this agent's secure store. If its OS keyring is unavailable, they last only until the agent restarts."
          : "Credentials are present. You can replace them here; replacement updates this profile everywhere it is used."));
        for (const slot of requiredSlots) {
          const form = element("form", "dep-connection-secret");
          const label = element("label", "dep-row-detail", { apiToken: "API token", privateKey: "SSH private key" }[slot] || slot);
          const input = element("input", "dep-connection-input");
          input.type = "password";
          input.autocomplete = "new-password";
          input.required = true;
          input.setAttribute("aria-label", `${slot} for ${profile.label || profile.connectionId}`);
          label.append(input);
          addFieldHelp(label, input, slot);
          const save = element("button", "dep-mini-btn", missingSlots.has(slot) ? "Save credential" : "Replace credential");
          save.type = "submit";
          let fileValue = "";
          let fileVersion = 0;
          const keyFile = slot === "privateKey" ? element("input", "dep-connection-keyfile") : null;
          const fileStatus = element("span", "dep-row-detail");
          const updateSecret = () => {
            input.disabled = busy || !canManage;
            input.required = !fileValue;
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
                fileStatus.textContent = `Private key selected. ${save.textContent} to store it with this agent.`;
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
          if (keyFile) {
            const fileHelp = element("span", "dep-keyfile-help");
            fileHelp.append(keyFile);
            addFieldHelp(fileHelp, keyFile, "keyFile");
            form.append(fileHelp, fileStatus);
          }
          credentials.append(form);
        }
      }
      select.onchange = () => { if (current() && !busy) { updateControls(); showCredentials(); } };
      async function useProfile(profile) {
        const result = await request(api, `/api/projects/${encodeURIComponent(projectKey)}/deployments/${encodeURIComponent(environment.id)}/connection-bindings/${encodeURIComponent(connection.slot)}`, jsonRequest("PUT", { connectionId: profile.connectionId, expectedRevision: connection.bindingRevision ?? null }));
        connection.connectionId = profile.connectionId;
        connection.bindingRevision = result.binding?.bindingRevision ?? connection.bindingRevision;
      }
      bind.onclick = () => {
        const profile = selectedProfile();
        if (!profile || scopeIssue(profile, environment) || bind.disabled) return;
        return mutate(status, () => useProfile(profile));
      };
      updateControls();
      showCredentials();
      const selectHelp = element("span", "dep-select-help");
      selectHelp.append(select);
      addFieldHelp(selectHelp, select, "connection");
      controls.append(selectHelp, bind);
      copy.append(controls, credentials);

      const add = element("details", "dep-connection-import");
      add.append(element("summary", "dep-row-detail", "Add a connection"));
      add.open = !matching.length;
      const setup = setupForm(connection, environment);
      if (setup) {
        const draftKey = JSON.stringify([projectKey, environment.id, connection.slot, connection.kind]);
        const draft = savedDrafts.get(draftKey) || {};
        add.append(element("p", "dep-row-detail", `Create a connection for this project in ${environment.id}. Add its ${connection.kind === "ssh-host-helper@1" ? "private key" : "API token"} after saving.`));
        add.append(element("p", "dep-connection-help", "Known settings are filled in below. Review or change them, and complete any remaining fields."));
        for (const note of connection.setup?.defaults?.notes || []) add.append(element("p", "dep-connection-help", note));
        add.append(element("p", "dep-connection-help", "Hover over a field or focus it with Tab for details and an example. Press Escape to dismiss the notes."));
        const guided = element("form", "dep-connection-guided");
        const inputs = new Map();
        for (const field of setup.fields) {
          const label = element("label", "dep-connection-field");
          label.append(element("span", "dep-row-detail", field.label));
          const input = element("input", "dep-connection-input");
          input.type = "text";
          input.value = Object.hasOwn(draft, field.key) ? draft[field.key] : field.value;
          input.required = !field.optional;
          input.autocomplete = "off";
          input.spellcheck = false;
          input.setAttribute("aria-label", `${field.label} for ${connection.slot}`);
          label.append(input);
          if (field.help) label.append(element("span", "dep-connection-help", field.help));
          const origin = element("span", "dep-connection-help");
          const describeOrigin = () => { origin.textContent = input.value !== field.value ? "Your value" : field.source ? `Filled from: ${field.source}` : ""; };
          describeOrigin();
          label.append(origin);
          input.oninput = () => {
            // Only public form fields are retained; credentials never enter this draft map.
            draft[field.key] = input.value;
            savedDrafts.set(draftKey, draft);
            describeOrigin();
          };
          addFieldHelp(label, input, field.key);
          inputs.set(field.key, input);
          guided.append(label);
        }
        if (setup.controller) {
          const pin = element("div", "dep-connection-pin");
          pin.append(element("span", "dep-row-detail", "Release controller"));
          if (setup.controller.pinned) {
            pin.append(element("p", "dep-connection-help", `PSM runs ${setup.controller.workflow} from ${setup.controller.repository} at ${setup.controller.ref}, pinned to commit ${setup.controller.commit.slice(0, 12)} and workflow file ${setup.controller.blob.slice(0, 12)}. It rechecks both before every release, so a rewritten workflow cannot deploy.`));
            if (setup.controller.source) pin.append(element("p", "dep-connection-help", `Filled from: ${setup.controller.source}`));
          } else {
            pin.append(element("p", "dep-connection-help", "PSM pins the release workflow and its hashes itself; you never enter them. It has not been able to read them yet, so this connection can prepare artifacts but cannot release until it can."));
          }
          guided.append(pin);
        }
        const submit = element("button", "dep-mini-btn", "Create and use connection");
        submit.type = "submit";
        let savedProfile = null;
        const updateGuided = () => {
          for (const input of inputs.values()) input.disabled = busy || !canManage || !!savedProfile;
          submit.disabled = busy || !canManage;
          submit.textContent = savedProfile ? "Use saved connection" : "Create and use connection";
        };
        refreshControls.push(updateGuided);
        updateGuided();
        guided.onsubmit = (event) => {
          event.preventDefault();
          if (!current() || busy || !canManage) return;
          let profile;
          try {
            profile = savedProfile || setup.build(Object.fromEntries([...inputs].map(([key, input]) => [key, input.value])), `con_${crypto.randomUUID()}`);
          } catch (error) {
            status.textContent = error.message;
            return;
          }
          return mutate(status, async () => {
            if (!savedProfile) {
              await request(api, "/api/connections", jsonRequest("POST", profile));
              savedProfile = profile;
              savedDrafts.delete(draftKey);
              // Keep a successfully created profile usable even if binding fails.
              matching.push({ ...profile, missingSecretSlots: profile.requiredSecretSlots });
              const option = element("option", "", `${profile.label} — needs credentials`);
              option.value = profile.connectionId;
              select.append(option);
              select.value = profile.connectionId;
              showCredentials();
            }
            try { await useProfile(profile); }
            catch (error) { throw new Error(`Connection saved, but could not be selected: ${error.message}`); }
          });
        };
        guided.append(submit);
        add.append(guided);
      }
      const advanced = element("details", "dep-connection-advanced");
      advanced.append(element("summary", "dep-row-detail", "Advanced: import JSON"));
      advanced.open = !setup;
      advanced.append(element("p", "dep-row-detail", profileHelp(connection.kind)));
      advanced.append(element("p", "dep-row-detail", "For custom scopes, multiple release controllers, or other advanced settings. Paste only public settings; add credentials separately after import."));
      if (environment.projectId) advanced.append(element("p", "dep-row-detail", `Project: ${environment.projectId} · Environment: ${environment.id} · Risk: ${environment.risk}`));
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
      const profileHelpWrapper = element("div", "dep-profile-help");
      profileHelpWrapper.append(profileInput);
      addFieldHelp(profileHelpWrapper, profileInput, "profile");
      importForm.append(profileHelpWrapper, create);
      advanced.append(importForm);
      add.append(advanced);
      copy.append(add, status);
      row.append(copy, element("span", "dep-row-kind", connection.kind));
      container.append(row);
    }
    if (!canManage) container.append(element("div", "dep-empty", "Open this project in the local cockpit to manage deployment connections."));
  }

  window.PsmDeploymentConnections = { render, setupForm };
})();
