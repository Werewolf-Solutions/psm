/* Machines: a reusable inventory and the Connect → Choose access → Set up → Ready wizard.
 * All authority stays server-side; this view only calls the machine API and shows what it answers. */
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
  const field = (label, input) => {
    const wrap = node("label", "", "machine-field");
    wrap.append(node("span", label), input);
    return wrap;
  };
  const input = (value = "", placeholder = "", type = "text") => {
    const element = document.createElement(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") element.type = type;
    element.value = value;
    element.placeholder = placeholder;
    return element;
  };
  const STEP_ICON = { pending: "○", running: "◐", done: "●", skipped: "–", failed: "✕", uncertain: "?" };
  const STEPS = ["Connect", "Choose access", "Set up", "Ready"];

  let ctx = null; // { api, root, workspace, projects, project, environment, onBound, toast }

  async function call(path, init = {}) {
    const response = await ctx.api(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { code: body.code, field: body.field });
    return body;
  }
  const ws = (path) => `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(ctx.workspace)}`;
  const post = (path, body = {}) => call(ws(path), { method: "POST", body: JSON.stringify({ ...body, workspace: ctx.workspace }) });

  function frame(title, stepIndex) {
    ctx.root.replaceChildren();
    const head = node("div", "", "machine-wizard-head");
    head.append(node("h3", title));
    if (stepIndex !== null) {
      const steps = node("ol", "", "machine-steps");
      STEPS.forEach((step, index) => steps.append(node("li", step, index === stepIndex ? "current" : index < stepIndex ? "done" : "")));
      head.append(steps);
    }
    const body = node("div", "", "machine-wizard-body");
    const error = node("p", "", "machine-error");
    error.setAttribute("role", "alert");
    ctx.root.append(head, error, body);
    return { body, error: (message) => { error.textContent = message || ""; } };
  }

  /* ---------- inventory ---------- */

  async function showList() {
    const view = frame("Machines", null);
    view.body.append(node("p", "Servers your projects deploy to. A machine is registered once per workspace; each project gets its own access to it.", "hint"));
    const add = button("＋ Add machine", () => showConnect(), "btn btn-primary");
    view.body.append(add);
    try {
      const { machines } = await call(ws("/api/machines"));
      if (!machines.length) view.body.append(node("p", "No machines yet."));
      for (const machine of machines) {
        const card = node("article", "", "machine-card");
        const head = node("div", "", "machine-card-head");
        head.append(node("h4", `${machine.name} · ${machine.host}${machine.port === 22 ? "" : `:${machine.port}`}`), node("span", machine.trusted ? "Identity confirmed" : "Identity not confirmed", "cap-badge"));
        card.append(head);
        card.append(node("p", `Host key ${machine.hostKeyFingerprint}${machine.helper ? ` · helper ${machine.helper.sha256.slice(0, 12)}…` : " · no deployment helper"}${machine.adminConnectionId ? " · PSM has administrator access" : ""}`, "hint"));
        for (const access of machine.access) {
          const row = node("div", "", "machine-access-row");
          const who = access.machineLevel ? (access.role === "admin" ? "PSM administrator" : "Host helper") : `${access.projectName} · ${access.environmentId}`;
          row.append(node("span", `${who} — ${access.role === "ci" ? "CI release key" : access.role} as ${access.account}`), node("span", access.state, "cap-badge"));
          // The release controller in GitHub Actions gets its own key, revocable on its own.
          if (access.role === "deploy" && access.state === "ready" && !machine.access.some((other) => other.role === "ci" && other.projectId === access.projectId && other.environmentId === access.environmentId && other.state !== "revoked")) {
            row.append(button("Add GitHub Actions release key", async () => {
              try {
                const { access: ci } = await post(`/api/machine-access/${encodeURIComponent(access.id)}/ci-key`);
                showReview(machine.id, [{ access: ci, method: machine.adminConnectionId ? "admin-ssh" : "manual-command" }]);
              } catch (error) { view.error(error.message); }
            }));
          }
          if (access.role === "admin" && access.state === "ready") row.append(button("Remove administrator access", async () => {
            if (!window.confirm(`Remove PSM's administrator access to ${machine.name}? Project accounts keep working; setting up new ones will need administrator access again.`)) return;
            try { await post(`/api/machine-access/${encodeURIComponent(access.id)}/release`); showList(); } catch (error) { view.error(error.message); }
          }));
          if (["planned", "setting-up", "failed"].includes(access.state)) row.append(button("Continue setup", async () => {
            try {
              const { access: full } = await call(ws(`/api/machine-access/${encodeURIComponent(access.id)}`));
              showSetup(machine.id, [{ access: full, method: access.role === "admin" || !machine.adminConnectionId ? "manual-command" : "admin-ssh" }], access.role === "admin" ? { next: () => showAccess(machine.id) } : {});
            } catch (error) { view.error(error.message); }
          }, "btn btn-primary"));
          if (!access.machineLevel && access.state !== "revoked") row.append(button("Disconnect", async () => {
            if (!window.confirm(`Disconnect ${access.projectName} ${access.environmentId} from ${machine.name}? PSM forgets its keys; the server account stays until you remove it.`)) return;
            try { await post(`/api/machine-access/${encodeURIComponent(access.id)}/revoke`, { revision: access.revision }); showList(); } catch (error) { view.error(error.message); }
          }));
          card.append(row);
        }
        card.append(button("Add a project", () => showAccess(machine.id)));
        view.body.append(card);
      }
    } catch (error) { view.error(error.message); }
  }

  /* ---------- 1. Connect ---------- */

  function showConnect() {
    const view = frame("Add machine", 0);
    const name = input("", "e.g. staging server");
    const host = input("", "hostname or IP address");
    const port = input("22", "22", "number");
    const lookup = button("Look up host key", async () => {
      view.error("");
      lookup.disabled = true;
      try {
        const found = await post("/api/machines/discover", { host: host.value.trim(), port: port.value });
        candidates.replaceChildren(node("p", "The network offered these keys. A key learned over the network proves nothing until you compare it with a trusted source — your provider's console, or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server itself.", "hint"));
        for (const candidate of found.candidates) {
          const row = node("div", "", "machine-candidate");
          row.append(node("code", `${candidate.keyType} ${candidate.fingerprint}`));
          row.append(button("It matches — register", async () => {
            if (!window.confirm(`Register ${host.value.trim()} with host key\n${candidate.fingerprint}?\n\nOnly confirm if you compared it with a trusted source.`)) return;
            try {
              const { machine } = await post("/api/machines", { name: name.value.trim() || host.value.trim(), host: host.value.trim(), port: port.value, knownHost: candidate.knownHost, confirmFingerprint: candidate.fingerprint });
              showAdmin(machine.id);
            } catch (error) { view.error(error.message); }
          }, "btn btn-primary"));
          candidates.append(row);
        }
      } catch (error) { view.error(error.message); }
      finally { lookup.disabled = false; }
    }, "btn btn-primary");
    const candidates = node("div", "", "machine-candidates");
    view.body.append(field("Name", name), field("Host", host), field("SSH port", port), lookup, candidates, button("Back to machines", showList));
  }

  /* how PSM gets administrator authority for setup */
  async function showAdmin(machineId) {
    const view = frame("Connect", 0);
    const machine = (await call(ws(`/api/machines/${encodeURIComponent(machineId)}`))).machine;
    view.body.append(node("p", `${machine.name} is registered with host key ${machine.hostKeyFingerprint}. How should PSM get administrator access to set it up?`));
    const options = node("div", "", "machine-options");
    const once = node("article", "", "machine-option");
    once.append(node("h4", "Run a setup command once (recommended)"), node("p", "PSM generates one command. Paste it into a terminal on the server; sudo may ask for your password there. It gives PSM its own administrator account and key, which you can remove after setup."));
    once.append(button("Use a setup command", async () => {
      try {
        const { access } = await post(`/api/machines/${encodeURIComponent(machineId)}/admin-access`);
        // Review first: the command is generated only for what was shown.
        showReview(machineId, [{ access, method: "manual-command" }], { next: () => showAccess(machineId) });
      } catch (error) { view.error(error.message); }
    }, "btn btn-primary"));
    const key = node("article", "", "machine-option");
    const user = input("root", "administrator user");
    const privateKey = input("", "-----BEGIN OPENSSH PRIVATE KEY-----", "textarea");
    key.append(node("h4", "Use an administrator key I already have"), node("p", "For a user that is root or has passwordless sudo. The key is stored in PSM's credential store, never in project files."), field("User", user), field("Private key", privateKey));
    key.append(button("Save and use this key", async () => {
      try {
        const connectionId = `machine-admin-${machineId.slice(4, 16)}-${Date.now().toString(36)}`;
        const ssh = { host: machine.host, user: user.value.trim(), port: machine.port, hostKeyFingerprint: machine.hostKeyFingerprint };
        await call("/api/connections", { method: "POST", body: JSON.stringify({ connectionId, label: `${ssh.user} on ${machine.name}`, kind: "ssh-machine-admin@1", publicMetadata: { knownHost: machine.knownHost }, requiredSecretSlots: ["privateKey"], constraints: { allowedProjectIds: ["*"], allowedEnvironmentIds: ["*"], maximumAuthorizedRisk: "production", ssh } }) });
        await call(`/api/connections/${encodeURIComponent(connectionId)}/secrets`, { method: "POST", body: JSON.stringify({ slot: "privateKey", value: privateKey.value.trim() + "\n" }) });
        privateKey.value = "";
        await call(ws(`/api/machines/${encodeURIComponent(machineId)}/admin-connection`), { method: "PUT", body: JSON.stringify({ connectionId, revision: machine.revision, workspace: ctx.workspace }) });
        await post(`/api/machines/${encodeURIComponent(machineId)}/inspect`);
        showAccess(machineId);
      } catch (error) { view.error(error.code === "sudo-password-required" ? `${error.message} Use the setup command instead.` : error.message); }
    }));
    options.append(once, key);
    view.body.append(options);
    if (machine.adminConnectionId) view.body.append(button("PSM already has administrator access — continue", () => showAccess(machineId), "btn btn-primary"));
  }

  /* ---------- 2. Choose access ---------- */

  async function showAccess(machineId) {
    const view = frame("Choose access", 1);
    const machine = (await call(ws(`/api/machines/${encodeURIComponent(machineId)}`))).machine;
    const projectSelect = document.createElement("select");
    for (const project of ctx.projects().filter((entry) => entry.id)) {
      const option = document.createElement("option");
      option.value = project.id; option.textContent = project.name;
      if (ctx.project && ctx.project.id === project.id) option.selected = true;
      projectSelect.append(option);
    }
    const environment = input(ctx.environment || "staging", "staging");
    const risk = document.createElement("select");
    for (const value of ["staging", "production", "development"]) { const option = document.createElement("option"); option.value = value; option.textContent = value; risk.append(option); }
    const choices = [
      ["deploy", "Deploy this application", "Its own release and infrastructure accounts on this server, and the deployment helper if it is missing."],
      ["command", "Run application commands", "A separate unprivileged account for builds, diagnostics and maintenance, in its own directory."],
    ];
    const checks = {};
    const list = node("div", "", "machine-options");
    for (const [id, title, description] of choices) {
      const box = document.createElement("input"); box.type = "checkbox"; box.checked = id === "deploy";
      checks[id] = box;
      const label = node("label", "", "machine-option");
      label.append(box, node("strong", ` ${title}`), node("p", description, "hint"));
      list.append(label);
    }
    const hostname = input("", "e.g. todo.example.com");
    const email = input("", "who receives certificate notices");
    const deployFields = node("div", "", "machine-subfields");
    deployFields.append(field("Site domain", hostname), field("Certificate contact email", email));
    checks.deploy.onchange = () => { deployFields.hidden = !checks.deploy.checked; };
    // The deployment manifest decides the domain; show it rather than asking again.
    const manifestNote = node("p", "", "hint");
    deployFields.append(manifestNote);
    const loadTarget = async () => {
      try {
        const { target } = await call(ws(`/api/machine-deploy-target?projectId=${encodeURIComponent(projectSelect.value)}&environmentId=${encodeURIComponent(environment.value.trim())}`));
        hostname.readOnly = !!target?.hostname;
        if (target?.hostname) hostname.value = target.hostname;
        manifestNote.textContent = target ? `From the deployment manifest: target ${target.targetId}, site root ${target.root}.` : "This environment has no deployment manifest target; PSM will create one for the domain you enter.";
      } catch { manifestNote.textContent = ""; }
    };
    projectSelect.onchange = loadTarget;
    environment.onchange = loadTarget;
    void loadTarget();
    view.body.append(field("Project", projectSelect), field("Environment", environment), field("Risk", risk), list, deployFields);
    view.body.append(node("p", machine.adminConnectionId ? "PSM will use its administrator access to prepare exactly what you review next." : "PSM has no administrator access to this machine yet; the next step will offer the one-time setup command.", "hint"));
    view.body.append(button("Review changes", async () => {
      view.error("");
      try {
        const projectId = projectSelect.value;
        const plans = [];
        if (!machine.adminConnectionId && (checks.deploy.checked || checks.command.checked)) {
          const { access } = await post(`/api/machines/${encodeURIComponent(machineId)}/admin-access`);
          plans.push({ access, method: "manual-command" });
        }
        if (checks.deploy.checked) {
          if (!machine.helper) plans.push({ access: (await post(`/api/machines/${encodeURIComponent(machineId)}/helper`)).access, method: "admin-ssh" });
          plans.push({ access: (await post(`/api/machines/${encodeURIComponent(machineId)}/deploy-access`, { projectId, environmentId: environment.value.trim(), risk: risk.value, hostname: hostname.value.trim(), certbotEmail: email.value.trim() })).access, method: "admin-ssh", bind: { projectId, environmentId: environment.value.trim() } });
        }
        if (checks.command.checked) plans.push({ access: (await post(`/api/machines/${encodeURIComponent(machineId)}/access`, { projectId, environmentId: environment.value.trim(), risk: risk.value })).access, method: "admin-ssh" });
        if (!plans.length) { view.error("Choose at least one kind of access."); return; }
        showReview(machineId, plans);
      } catch (error) { view.error(error.message); }
    }, "btn btn-primary"), button("Back to machines", showList));
  }

  function showReview(machineId, plans, options = {}) {
    const view = frame("Choose access", 1);
    view.body.append(node("p", "This is exactly what setup will do. Nothing has changed on the server yet."));
    for (const { access } of plans) {
      const card = node("article", "", "machine-card");
      const title = access.machineLevel ? (access.role === "admin" ? "PSM administrator access" : "Deployment helper") : `${access.projectName} · ${access.environmentId} · ${access.role === "ci" ? "CI release key" : access.role}`;
      card.append(node("h4", title));
      const ops = node("ul", "");
      for (const line of access.plan.operations) ops.append(node("li", line));
      const authority = node("ul", "", "machine-authority");
      for (const line of access.plan.authority) authority.append(node("li", line));
      const script = node("details", "");
      script.append(node("summary", "View setup changes (script)"));
      script.addEventListener("toggle", async () => {
        if (!script.open || script.dataset.loaded) return;
        script.dataset.loaded = "1";
        try { const data = await call(ws(`/api/machine-access/${encodeURIComponent(access.id)}/script`)); script.append(node("p", `sha256 ${data.digest.slice(7)}`, "hint"), node("pre", data.script, "machine-script")); }
        catch (error) { script.append(node("p", error.message)); }
      });
      card.append(node("strong", "Changes"), ops, node("strong", "What it can do afterwards"), authority, script);
      view.body.append(card);
    }
    view.body.append(button("Set up machine", () => showSetup(machineId, plans, options), "btn btn-primary"), button("Back", () => options.next ? showAdmin(machineId) : showAccess(machineId)));
  }

  /* ---------- 3. Set up ---------- */

  async function showSetup(machineId, plans, { next } = {}) {
    const view = frame("Set up", 2);
    const machine = (await call(ws(`/api/machines/${encodeURIComponent(machineId)}`))).machine;
    const results = [];
    for (const plan of plans) {
      const card = node("article", "", "machine-card");
      const title = plan.access.machineLevel ? (plan.access.role === "admin" ? "PSM administrator access" : "Deployment helper") : `${plan.access.projectName} · ${plan.access.environmentId} · ${plan.access.role === "ci" ? "CI release key" : plan.access.role}`;
      card.append(node("h4", title));
      const steps = node("ol", "", "machine-job-steps");
      const status = node("p", "Starting…", "hint");
      card.append(steps, status);
      view.body.append(card);
      let job;
      try {
        job = (await post(`/api/machine-access/${encodeURIComponent(plan.access.id)}/setup`, { planDigest: plan.access.plan.digest, method: plan.method })).job;
      } catch (error) {
        // Already in progress (another tab, or before a reload): follow that job instead.
        const active = error.code === "job-active" ? machine.jobs.find((entry) => entry.accessId === plan.access.id && ["running", "waiting"].includes(entry.state)) : null;
        if (!active) {
          status.textContent = error.message;
          if (error.code === "admin-connection-missing" || error.code === "sudo-password-required") card.append(button("Get administrator access first", () => showAdmin(machineId)));
          return;
        }
        job = (await call(ws(`/api/machine-setup-jobs/${encodeURIComponent(active.id)}`))).job;
      }
      const render = (current) => {
        steps.replaceChildren(...current.steps.map((step) => { const item = node("li", `${STEP_ICON[step.status] || "○"} ${step.title}${step.detail ? ` — ${step.detail}` : ""}`); item.className = `step-${step.status}`; return item; }));
        status.textContent = current.state === "succeeded" ? "Verified." : current.state === "failed" ? `Stopped: ${current.error?.message || "failed"}` : current.state === "waiting" ? "Waiting for the machine…" : "Working…";
      };
      let card2 = null;
      for (;;) {
        render(job);
        if (job.state === "waiting" && job.command && !card2) {
          card2 = node("div", "", "machine-command-card");
          const pre = node("pre", job.command, "machine-command");
          const copy = button("Copy command", async () => {
            try { await navigator.clipboard.writeText(job.command); copy.textContent = "Copied"; }
            catch { copy.textContent = "Select the command and copy it"; const range = document.createRange(); range.selectNodeContents(pre); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
          }, "btn btn-primary");
          const download = button("Download setup file", () => {
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([job.command + "\n"], { type: "text/x-shellscript" }));
            link.download = `psm-setup-${machine.name.replace(/[^A-Za-z0-9._-]+/g, "-")}.sh`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
          });
          card2.append(node("p", `Run on: ${machine.name} (${machine.host}), in a terminal on that server where you can use sudo.`, "hint"),
            node("p", "Why: PSM has no administrator access yet. This creates only what was listed above; sudo may ask for your password in that terminal — never here.", "hint"), pre, copy, download,
            node("p", "Status appears here by itself: Waiting for the machine → Verified. The command checks its own contents before running anything.", "hint"));
          card.append(card2);
        }
        if (["succeeded", "failed", "cancelled"].includes(job.state)) break;
        await new Promise((resolve) => setTimeout(resolve, job.state === "waiting" ? 5000 : 1500));
        try {
          job = job.state === "waiting"
            ? (await post(`/api/machine-setup-jobs/${encodeURIComponent(job.id)}/probe`)).job
            : (await call(ws(`/api/machine-setup-jobs/${encodeURIComponent(job.id)}`))).job;
        } catch (error) { status.textContent = error.message; }
        if (!ctx.root.isConnected) return; // closed: the job continues on the server
      }
      card2?.remove();
      if (job.state !== "succeeded") {
        if (job.error?.code === "replaceable") {
          card.append(button("Review replacing it", async () => {
            try {
              const access = (await post(`/api/machine-access/${encodeURIComponent(plan.access.id)}/replace`)).access;
              const rest = plans.slice(plans.indexOf(plan));
              rest[0] = { ...plan, access };
              showReview(machineId, rest, { next });
            } catch (error) { view.error(error.message); }
          }, "btn btn-primary"));
        }
        card.append(button("Retry this step", async () => { try { await post(`/api/machine-setup-jobs/${encodeURIComponent(job.id)}/retry`); showSetup(machineId, plans.slice(plans.indexOf(plan)), { next }); } catch (error) { view.error(error.message); } }));
        return;
      }
      results.push({ plan, job });
    }
    if (next) return next();
    showReady(machineId, results);
  }

  /* ---------- 4. Ready ---------- */

  async function showReady(machineId, results) {
    const view = frame("Ready", 3);
    for (const { plan } of results) {
      const access = (await call(ws(`/api/machine-access/${encodeURIComponent(plan.access.id)}`))).access;
      const card = node("article", "", "machine-card");
      card.append(node("h4", access.machineLevel ? (access.role === "admin" ? "PSM administrator access" : "Deployment helper") : `${access.projectName} · ${access.environmentId} · ${access.role}`));
      const verified = node("ul", "");
      for (const check of access.checks) verified.append(node("li", `${check.ok ? "✓" : "✕"} ${check.title} — ${check.detail}`));
      card.append(verified);
      if (plan.bind) {
        const bind = button(`Use for ${ctx.projects().find((entry) => entry.id === plan.bind.projectId)?.name || plan.bind.projectId} ${plan.bind.environmentId} deployments`, async () => {
          try {
            await call(`/api/projects/${encodeURIComponent(plan.bind.projectId)}/deployments/${encodeURIComponent(plan.bind.environmentId)}/connection-bindings/host`, { method: "PUT", body: JSON.stringify({ connectionId: access.connectionId }) });
            bind.textContent = "Connected to the deployment's host slot"; bind.disabled = true;
            ctx.onBound?.(plan.bind);
          } catch (error) { view.error(error.message); }
        }, "btn btn-primary");
        card.append(bind);
      }
      view.body.append(card);
    }
    view.body.append(button("Add another project", () => showAccess(machineId)), button("Done", showList));
  }

  window.PsmMachines = {
    open(options) {
      ctx = options;
      if (options.machineId) return showAccess(options.machineId);
      return showList();
    },
  };
})();
