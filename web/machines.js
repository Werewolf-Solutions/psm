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
  const confirmAction = (message, title) => ctx.confirm ? ctx.confirm(message, title) : window.psmConfirm(message, title);

  function deployCandidate(machine, { projectId, environmentId, targetId, hostname }) {
    if (!targetId) return { access: null, reason: "This environment has no manifest deployment target." };
    if (!machine.trusted) return { access: null, reason: "Confirm this machine's host key." };
    if (!machine.helper || machine.helperOutdated) return { access: null, reason: machine.helperOutdated ? "Update the host helper." : "Install the host helper." };
    const access = (machine.access || []).find((entry) => entry.role === "deploy" && entry.state === "ready"
      && entry.projectId === projectId && entry.environmentId === environmentId && entry.plan?.target?.targetId === targetId
      && (!hostname || entry.plan?.target?.hostname === hostname));
    const other = (machine.access || []).find((entry) => entry.role === "deploy" && entry.state === "ready"
      && entry.projectId === projectId && entry.environmentId !== environmentId);
    return access ? { access, reason: `Verified for target ${targetId}.` }
      : { access: null, reason: other ? `Used for ${other.environmentId}; ${environmentId} needs its own deploy access.` : `Set up deploy access for ${environmentId}.` };
  }

  let ctx = null; // { api, root, workspace, projects, project, environment, onBound, toast }
  let snapshotTimer = null;

  async function call(path, init = {}) {
    const response = await ctx.api(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { code: body.code, field: body.field });
    return body;
  }
  const ws = (path) => `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(ctx.workspace)}`;
  const post = (path, body = {}) => call(ws(path), { method: "POST", body: JSON.stringify({ ...body, workspace: ctx.workspace }) });
  const deployTarget = async (projectId, environmentId) => (await call(ws(`/api/machine-deploy-target?projectId=${encodeURIComponent(projectId)}&environmentId=${encodeURIComponent(environmentId)}`))).target;
  const matchesTarget = (access, target) => !!target && access?.plan?.target?.targetId === target.targetId
    && access.plan.target.canonicalRoot === target.root && (!target.hostname || access.plan.target.hostname === target.hostname);
  const setupDeployment = (projectId) => ctx.onDeploymentSetup?.(projectId);

  function frame(title, stepIndex) {
    if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
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
    const scoped = ctx.project?.id && ctx.environment;
    const view = frame(scoped ? `Machines for ${ctx.project.name} · ${ctx.environment}` : "Machines", null);
    view.body.append(node("p", "Servers your projects deploy to. A machine is registered once per workspace; each project gets its own access to it.", "hint"));
    const add = button("＋ Add machine", () => showConnect(), "btn btn-primary");
    view.body.append(add);
    try {
      const { machines } = await call(ws("/api/machines"));
      let expectedTarget = null;
      if (scoped) {
        try { expectedTarget = await deployTarget(ctx.project.id, ctx.environment); } catch { /* setup can still continue */ }
      }
      if (!machines.length) view.body.append(node("p", "No machines yet."));
      for (const machine of machines) {
        const card = node("article", "", "machine-card");
        const head = node("div", "", "machine-card-head");
        head.append(node("h4", `${machine.name} · ${machine.host}${machine.port === 22 ? "" : `:${machine.port}`}`), node("span", machine.trusted ? "Identity confirmed" : "Identity not confirmed", "cap-badge"));
        card.append(head);
        if (scoped) {
          const candidate = deployCandidate(machine, { projectId: ctx.project.id, environmentId: ctx.environment, targetId: expectedTarget?.targetId, hostname: expectedTarget?.hostname });
          card.append(node("p", candidate.reason, candidate.access ? "machine-ready" : "hint"));
          if (!expectedTarget && ctx.onDeploymentSetup) card.append(button("Open project Deploy page", () => setupDeployment(ctx.project.id)));
          if (candidate.access && matchesTarget(candidate.access, expectedTarget)) card.append(button("Use this machine for deploy", async () => {
            try {
              const current = await deployTarget(ctx.project.id, ctx.environment);
              if (!matchesTarget(candidate.access, current)) throw new Error("The deployment target changed. Recheck machine access before binding it.");
              await call(`/api/projects/${encodeURIComponent(ctx.project.id)}/deployments/${encodeURIComponent(ctx.environment)}/connection-bindings/host`, { method: "PUT", body: JSON.stringify({ connectionId: candidate.access.connectionId }) });
              ctx.onBound?.({ projectId: ctx.project.id, environmentId: ctx.environment });
              showList();
            } catch (error) { view.error(error.message); }
          }, "btn btn-primary"));
          else if (candidate.access) card.append(node("p", "This access was enrolled for a different site root or domain. It cannot be bound to this manifest target.", "machine-error"));
        }
        card.append(node("p", `Host key ${machine.hostKeyFingerprint}${machine.helper ? ` · helper ${machine.helper.sha256.slice(0, 12)}…` : " · no deployment helper"}${machine.adminConnectionId ? " · PSM has administrator access" : ""}`, "hint"));
        if (machine.helperOutdated) card.append(helperUpdate(machine, view));
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
          if (access.role === "deploy" && access.state === "ready") {
            try {
              const target = await deployTarget(access.projectId, access.environmentId);
              if (!target && ctx.onDeploymentSetup) row.append(button("Set up deployment environment", () => setupDeployment(access.projectId)));
              if (target && !matchesTarget(access, target) && access.plan?.target?.targetId !== target.targetId) row.append(button("Review target repair", async () => {
                try {
                  const { access: repaired } = await post(`/api/machine-access/${encodeURIComponent(access.id)}/repair-target`);
                  showReview(machine.id, [{ access: repaired, method: "admin-ssh", bind: { projectId: access.projectId, environmentId: access.environmentId } }]);
                } catch (error) { view.error(error.message); }
              }, "btn btn-primary"));
            } catch { /* A missing manifest is explained by the project Deploy setup. */ }
          }
          if (access.role === "deploy" && access.state === "failed" && access.plan?.retireTarget) row.append(button("Review target repair again", async () => {
            try {
              const { access: repaired } = await post(`/api/machine-access/${encodeURIComponent(access.id)}/repair-target`);
              showReview(machine.id, [{ access: repaired, method: "admin-ssh", bind: { projectId: access.projectId, environmentId: access.environmentId } }]);
            } catch (error) { view.error(error.message); }
          }, "btn btn-primary"));
          if (access.role === "admin" && access.state === "ready") row.append(button("Remove administrator access", async () => {
            if (!await confirmAction(`Remove PSM's administrator access to ${machine.name}? Project accounts keep working; setting up new ones will need administrator access again.`, "Remove administrator access")) return;
            try { await post(`/api/machine-access/${encodeURIComponent(access.id)}/release`); showList(); } catch (error) { view.error(error.message); }
          }));
          if (["planned", "setting-up", "failed"].includes(access.state)) row.append(button("Continue setup", async () => {
            try {
              const { access: full } = await call(ws(`/api/machine-access/${encodeURIComponent(access.id)}`));
              showSetup(machine.id, [{ access: full, method: access.role === "admin" || !machine.adminConnectionId ? "manual-command" : "admin-ssh" }], access.role === "admin" ? { next: () => showAccess(machine.id) } : {});
            } catch (error) { view.error(error.message); }
          }, "btn btn-primary"));
          if (!access.machineLevel && access.state !== "revoked") row.append(button("Disconnect", async () => {
            if (!await confirmAction(`Disconnect ${access.projectName} ${access.environmentId} from ${machine.name}? PSM forgets its keys; the server account stays until you remove it.`, "Disconnect machine access")) return;
            try { await post(`/api/machine-access/${encodeURIComponent(access.id)}/revoke`, { revision: access.revision }); showList(); } catch (error) { view.error(error.message); }
          }));
          card.append(row);
        }
        card.append(button("Monitor machine", () => showDashboard(machine), "btn btn-primary"), button("Security audit", () => showAudit(machine.id, showList)), button("Add a project", () => showAccess(machine.id)));
        view.body.append(card);
      }
    } catch (error) { view.error(error.message); }
  }

  function size(value) {
    if (!Number.isFinite(value)) return "Unavailable";
    const unit = value >= 1073741824 ? "GiB" : "MiB";
    return `${(value / (unit === "GiB" ? 1073741824 : 1048576)).toFixed(1)} ${unit}`;
  }

  function metricChart(title, samples, key, maximum, unit) {
    const card = node("section", "", "machine-metric");
    card.append(node("h4", title));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 320 120");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${title} over the last five minutes, zero to ${maximum} ${unit}`);
    const add = (tag, attrs, content) => {
      const part = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attrs)) part.setAttribute(name, String(value));
      if (content !== undefined) part.textContent = content;
      svg.append(part);
    };
    for (const [value, y] of [[maximum, 13], [maximum / 2, 59], [0, 105]]) {
      add("line", { x1: 43, x2: 316, y1: y, y2: y, class: "mon-grid" });
      add("text", { x: 39, y: y + 3, "text-anchor": "end", class: "mon-axis" }, `${Number(value.toFixed(1))}${unit}`);
    }
    const end = Date.now(), start = end - 300000;
    const points = samples.filter(sample => Number.isFinite(sample[key]) && sample.at >= start);
    if (points.length) add("polyline", { points: points.map(sample => `${43 + (sample.at - start) / 300000 * 273},${105 - Math.min(maximum, Math.max(0, sample[key])) / maximum * 92}`).join(" "), class: "mon-line" });
    card.append(svg, node("p", "Last five minutes · gaps mean no reading", "mon-note"));
    return card;
  }

  function showDashboard(machine) {
    const view = frame(`${machine.name} · live machine`, null);
    const heading = node("div", "", "machine-card-head");
    const status = node("p", "Connecting…", "mon-note");
    heading.append(button("Back to machines", showList), button("Security audit", () => showAudit(machine.id, () => showDashboard(machine))), status);
    const content = node("div", "", "machine-dashboard");
    view.body.append(heading, content);
    const history = [];
    const filters = new Map();
    let busy = false;
    const refresh = async () => {
      if (busy || ctx.root.closest(".modal")?.hidden) return;
      busy = true;
      try {
        const { snapshot: s } = await call(ws(`/api/machines/${encodeURIComponent(machine.id)}/snapshot`));
        const age = Date.now() - s.observedAt;
        status.textContent = `${age > 15000 ? "Stale" : "Live"} · ${new Date(s.observedAt).toLocaleTimeString()} · observed as ${s.observer}`;
        const rootDisk = s.disks?.find(disk => disk.mount === "/") || s.disks?.[0];
        history.push({ at: s.observedAt, cpu: s.cpuPercent, memory: s.memoryUsedBytes, swap: s.swapUsedBytes, disk: rootDisk?.usedBytes });
        while (history.length && history[0].at < Date.now() - 300000) history.shift();
        const focused = content.contains(document.activeElement) && document.activeElement?.getAttribute("aria-label")?.startsWith("Filter ")
          ? { label: document.activeElement.getAttribute("aria-label"), cursor: document.activeElement.selectionStart } : null;
        content.replaceChildren();
        const cards = node("div", "", "mon-cards");
        const card = (label, value, detail) => { const el = node("section", "", "mon-card"); el.append(node("div", label, "dep-card-label"), node("strong", value), node("p", detail, "mon-note")); cards.append(el); };
        card("CPU", Number.isFinite(s.cpuPercent) ? `${s.cpuPercent.toFixed(1)}%` : "Unavailable", `${s.cores || "?"} cores · load ${s.load?.map(v => v.toFixed(2)).join(" / ") || "unavailable"}`);
        card("Memory", `${size(s.memoryUsedBytes)} / ${size(s.memoryTotalBytes)}`, "Used = total − available; cache reclaimable memory is available.");
        card("Swap", `${size(s.swapUsedBytes)} / ${size(s.swapTotalBytes)}`, "Physical swap use");
        card("Uptime", Number.isFinite(s.uptimeSeconds) ? `${Math.floor(s.uptimeSeconds / 86400)}d ${Math.floor(s.uptimeSeconds % 86400 / 3600)}h` : "Unavailable", s.hostname);
        content.append(cards);
        const graphs = node("div", "", "mon-charts");
        graphs.append(metricChart("CPU use", history, "cpu", 100, "%"));
        if (s.memoryTotalBytes > 0) graphs.append(metricChart("Memory used", history.map(p => ({ ...p, memory: p.memory / 1073741824 })), "memory", s.memoryTotalBytes / 1073741824, " GiB"));
        if (s.swapTotalBytes > 0) graphs.append(metricChart("Swap used", history.map(p => ({ ...p, swap: p.swap / 1073741824 })), "swap", s.swapTotalBytes / 1073741824, " GiB"));
        if (rootDisk?.totalBytes > 0) graphs.append(metricChart(`Disk used · ${rootDisk.mount}`, history.map(p => ({ ...p, disk: p.disk / 1073741824 })), "disk", rootDisk.totalBytes / 1073741824, " GiB"));
        content.append(graphs);
        const section = (title, rows, render) => {
          const box = node("section", "", "machine-detail");
          box.append(node("h4", `${title} (${rows.length})`));
          if (!rows.length) box.append(node("p", "No entries observed.", "mon-note"));
          const entries = rows.map(render);
          if (rows.length > 20) {
            const filter = input("", `Filter ${title.toLowerCase()}`);
            filter.setAttribute("aria-label", `Filter ${title}`);
            filter.value = filters.get(title) || "";
            const applyFilter = () => entries.forEach(entry => { entry.hidden = !entry.textContent.toLowerCase().includes(filter.value.toLowerCase()); });
            filter.oninput = () => { filters.set(title, filter.value); applyFilter(); };
            box.append(filter);
            applyFilter();
          }
          box.append(...entries);
          content.append(box);
        };
        const row = (...values) => { const el = node("div", "", "machine-detail-row"); values.forEach(value => el.append(node("span", String(value)))); return el; };
        section("Filesystems", s.disks || [], disk => row(disk.mount, `${size(disk.usedBytes)} / ${size(disk.totalBytes)}`, disk.totalBytes ? `${(disk.usedBytes / disk.totalBytes * 100).toFixed(1)}%` : "Unavailable"));
        section("PSM deployment targets", machine.access.filter(access => access.role === "deploy" && access.state === "ready" && access.plan?.target), access => row(`${access.projectName} · ${access.environmentId}`, access.plan.target.unitId, access.plan.target.hostname || "No public hostname"));
        section("Systemd services (including workers)", s.services || [], service => row(service.unit, `${service.active} · ${service.sub}`, service.description));
        section("Busiest processes", s.processes || [], proc => row(`${proc.name} · PID ${proc.pid}`, proc.user, `${proc.cpuPercent}% CPU · ${size(proc.rssBytes)} RAM`));
        section("Listening TCP ports", s.ports || [], port => row(port.local));
        section("Connected login sessions", s.users || [], user => row(user.user, user.terminal, user.since));
        if (s.errors?.length) content.prepend(node("p", `Partial snapshot: ${s.errors.join(", ")}`, "machine-error"));
        content.append(node("p", "Connected users covers terminal logins; application users and worker queue health need app-specific probes. Services and processes are observation only. Start, Stop, Restart and new-app deployment require a reviewed unit grant and release configuration.", "mon-note"));
        if (focused) {
          const filter = [...content.querySelectorAll("input")].find(input => input.getAttribute("aria-label") === focused.label);
          if (filter) { filter.focus(); filter.setSelectionRange(focused.cursor, focused.cursor); }
        }
      } catch (error) { status.textContent = `Unavailable · ${error.message}`; view.error(error.message); }
      finally { busy = false; }
    };
    void refresh();
    snapshotTimer = setInterval(refresh, 5000);
  }

  function showAudit(machineId, back) {
    const view = frame("Machine security audit", null);
    const actions = node("div", "", "machine-card-head");
    const result = node("div", "", "machine-dashboard");
    const state = node("p", "Choose a check to run. These observations do not approve a deployment.", "hint");
    const run = async (scope) => {
      view.error("");
      result.replaceChildren();
      state.textContent = scope === "internal" ? "Checking settings on the machine…" : "Scanning from this PSM agent; this may take a few minutes…";
      for (const control of actions.querySelectorAll("button")) control.disabled = true;
      try {
        const { report } = await post(`/api/machines/${encodeURIComponent(machineId)}/security-audit`, { scope });
        state.textContent = `${new Date(report.observedAt).toLocaleString()} · ${report.vantage}`;
        for (const check of report.checks) {
          const item = node("section", "", "machine-detail");
          const head = node("div", "", "machine-card-head");
          head.append(node("h4", check.title), node("span", check.status, `cap-badge machine-audit-${check.status}`));
          item.append(head, node("p", check.detail, "mon-note"));
          result.append(item);
        }
        result.append(button("Download report JSON", () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = `psm-machine-audit-${report.machineId}-${report.scope}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }));
      } catch (error) { state.textContent = "Audit could not finish."; view.error(error.message); }
      finally { for (const control of actions.querySelectorAll("button")) control.disabled = false; }
    };
    actions.append(button("Back", back), button("Run host audit", () => run("internal"), "btn btn-primary"), button("Scan from this PSM agent", () => run("agent-external")));
    view.body.append(node("p", "Host audit checks SSH settings, UFW, listeners, unattended updates and Lynis if installed. Agent scan checks TCP, common UDP and SSH algorithms using Nmap and ssh-audit installed on this PSM agent.", "hint"),
      actions, state, result, node("p", "An agent scan does not prove what an independent internet location can reach. Unknown and unavailable results require review. Save the report with your deployment evidence.", "hint"));
  }

  /* ---------- 1. Connect ---------- */

  function showConnect() {
    const view = frame("Add machine", 0);
    const name = input("", "e.g. staging server");
    const host = input("", "public IPv4 or reachable hostname");
    const port = input("22", "22");
    port.inputMode = "numeric";
    const bootstrap = document.createElement("select");
    const adminUser = input("root", "root or ubuntu");
    const keyDetails = node("div", "", "machine-key-details");
    const showKey = (key) => {
      keyDetails.replaceChildren();
      if (!key) return;
      const publicKey = node("pre", key.publicKey, "machine-command");
      const copy = button("Copy public key", async () => {
        try { await navigator.clipboard.writeText(key.publicKey); copy.textContent = "Copied"; }
        catch { const range = document.createRange(); range.selectNodeContents(publicKey); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); copy.textContent = "Public key selected"; }
      }, "btn btn-primary");
      const remove = button("Remove unused key", async () => {
        if (!await confirmAction(`Remove the unused droplet key ${key.name} from PSM?`, "Remove key")) return;
        try { await call(ws(`/api/machine-bootstrap-keys/${encodeURIComponent(key.connectionId)}`), { method: "DELETE" }); await loadKeys(); }
        catch (error) { view.error(error.message); }
      });
      keyDetails.append(node("p", `Name in DigitalOcean: ${key.name}`, "hint"), publicKey, copy, remove,
        node("p", `Fingerprint ${key.fingerprint}. Paste this public key into DigitalOcean when creating the droplet. PSM stores the private half locally and uses it only after you confirm the droplet's host key.`, "hint"));
    };
    const loadKeys = async (selected = "") => {
      const { keys } = await call(ws("/api/machine-bootstrap-keys"));
      bootstrap.replaceChildren();
      const none = document.createElement("option"); none.value = ""; none.textContent = "Use existing SSH access or setup command"; bootstrap.append(none);
      for (const key of keys) { const option = document.createElement("option"); option.value = key.connectionId; option.textContent = `${key.name} · ${key.fingerprint}`; bootstrap.append(option); }
      bootstrap.value = selected || "";
      bootstrap.onchange = () => showKey(keys.find((key) => key.connectionId === bootstrap.value));
      bootstrap.onchange();
    };
    const createKey = button("Create droplet SSH key", async () => {
      try {
        const keyName = name.value.trim() || "PSM droplet";
        const { key } = await post("/api/machine-bootstrap-keys", { name: keyName });
        await loadKeys(key.connectionId);
      } catch (error) { view.error(error.message); }
    }, "btn btn-primary");
    void loadKeys().catch((error) => view.error(error.message));
    const connect = button("Connect machine", async () => {
      view.error("");
      candidates.replaceChildren();
      connect.disabled = true;
      const requestedHost = host.value.trim();
      const requestedPort = port.value.trim();
      const requestedName = name.value.trim() || requestedHost;
      const requestedKey = bootstrap.value;
      const requestedUser = adminUser.value.trim();
      try {
        const found = await post("/api/machines/discover", { host: requestedHost, port: requestedPort });
        const preferred = found.candidates.find((item) => item.keyType === "ssh-ed25519") || found.candidates[0];
        const hostKeyFile = preferred.keyType === "ssh-ed25519" ? "ssh_host_ed25519_key.pub"
          : preferred.keyType === "ssh-rsa" ? "ssh_host_rsa_key.pub" : "ssh_host_ecdsa_key.pub";
        const review = node("section", "", "machine-option");
        review.append(node("h4", `Verify ${found.host}:${found.port}`),
          node("p", "SSH answered. In DigitalOcean's Web Console, run the command below and compare its fingerprint with this one. This is the server's identity, separate from the droplet key you copied during creation.", "hint"),
          node("code", `ssh-keygen -lf /etc/ssh/${hostKeyFile}`),
          node("code", `${preferred.keyType} ${preferred.fingerprint}`));
        const alternatives = found.candidates.filter((item) => item !== preferred);
        if (alternatives.length) {
          const details = document.createElement("details");
          details.append(node("summary", "Other host key algorithms"));
          for (const item of alternatives) details.append(node("p", `${item.keyType} ${item.fingerprint}`, "machine-fingerprint"));
          review.append(details);
        }
        review.append(button("Fingerprint matches — connect and add", async () => {
          if ([host.value.trim(), port.value.trim(), name.value.trim() || host.value.trim(), bootstrap.value, adminUser.value.trim()].some((value, index) => value !== [requestedHost, requestedPort, requestedName, requestedKey, requestedUser][index])) {
            view.error("Machine details changed. Connect again to verify the current address and key.");
            candidates.replaceChildren();
            return;
          }
          if (!await confirmAction(`I compared the server's ${preferred.keyType} fingerprint with a trusted source:\n${preferred.fingerprint}\n\nConnect ${requestedName} at ${requestedHost}:${requestedPort}?`, "Confirm server identity")) return;
          const verify = review.querySelector("button");
          verify.disabled = true;
          try {
            const { machine } = await post("/api/machines", { name: requestedName, host: requestedHost, port: requestedPort, knownHost: preferred.knownHost, confirmFingerprint: preferred.fingerprint });
            if (requestedKey) {
              try {
                await post(`/api/machines/${encodeURIComponent(machine.id)}/bootstrap-access`, { connectionId: requestedKey, user: requestedUser });
                await post(`/api/machines/${encodeURIComponent(machine.id)}/inspect`);
                showSecurity(machine.id);
              } catch (error) {
                view.error(`Machine added, but SSH access needs attention: ${error.message}`);
                candidates.replaceChildren(button("Continue machine setup", () => showAdmin(machine.id), "btn btn-primary"), button("See connected machines", showList));
              }
            } else showAdmin(machine.id);
          } catch (error) { view.error(error.message); verify.disabled = false; }
        }, "btn btn-primary"));
        candidates.append(review);
      } catch (error) {
        view.error(error.code === "no-host-key" && /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(requestedHost)
          ? `${error.message} That looks like a private address. Use the droplet's Public IPv4 unless this PSM agent is on the same private network.` : error.message);
      } finally { connect.disabled = false; }
    }, "btn btn-primary");
    const candidates = node("div", "", "machine-candidates");
    view.body.append(field("Name", name), createKey, field("Droplet SSH key", bootstrap), keyDetails,
      field("Administrator SSH user", adminUser), field("Public IPv4 or reachable hostname", host),
      node("p", "For DigitalOcean, copy Public IPv4 from Connection Details. Private IP works only when the PSM agent can reach the same VPC.", "hint"),
      field("SSH port", port), connect, candidates, button("Back to machines", showList));
  }

  async function showSecurity(machineId) {
    const view = frame("Secure new machine", 1);
    view.body.append(node("p", "PSM verified SSH access using the droplet key. Review the host firewall before setting up deploy accounts.", "hint"));
    try {
      const { plan } = await post(`/api/machines/${encodeURIComponent(machineId)}/firewall-review`);
      const steps = node("ul", "");
      for (const operation of plan.operations) steps.append(node("li", operation));
      view.body.append(node("h4", "Host firewall"), steps, node("p", plan.preflight || "Preflight passed.", "hint"));
      view.body.append(button("Apply and verify firewall", async () => {
        try {
          view.body.append(node("p", "Applying firewall and testing a new SSH connection…", "hint"));
          await post(`/api/machines/${encodeURIComponent(machineId)}/firewall-apply`, { digest: plan.digest });
          showAccess(machineId);
        } catch (error) { view.error(error.message); }
      }, "btn btn-primary"));
    } catch (error) { view.error(error.message); }
    view.body.append(button("Run security audit", () => showAudit(machineId, () => showSecurity(machineId))));
    view.body.append(button("Review deployment access", () => showAccess(machineId)));
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

  // A helper built from older sources is replaced through the same reviewed install.
  function helperUpdate(machine, view) {
    const box = node("div", "", "machine-access-row");
    box.append(node("span", "The deployment helper on this server is older than this PSM's. Update it before deploying."));
    box.append(button("Update helper", async () => {
      try {
        const { access } = await post(`/api/machines/${encodeURIComponent(machine.id)}/helper`);
        showReview(machine.id, [{ access, method: machine.adminConnectionId ? "admin-ssh" : "manual-command" }]);
      } catch (error) { view.error(error.message); }
    }, "btn btn-primary"));
    return box;
  }

  async function showAccess(machineId) {
    const view = frame("Choose access", 1);
    const machine = (await call(ws(`/api/machines/${encodeURIComponent(machineId)}`))).machine;
    if (machine.helperOutdated) view.body.append(helperUpdate(machine, view));
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
    if (ctx.project?.id && ctx.environment) {
      projectSelect.disabled = true;
      environment.readOnly = true;
      risk.value = ctx.risk || (ctx.environment === "production" ? "production" : "staging");
      risk.disabled = true;
    }
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
    const openSetup = button("Open project Deploy page", () => setupDeployment(projectSelect.value));
    openSetup.hidden = true;
    deployFields.append(openSetup);
    const loadTarget = async () => {
      try {
        const target = await deployTarget(projectSelect.value, environment.value.trim());
        hostname.readOnly = !!target?.hostname;
        if (target?.hostname) hostname.value = target.hostname;
        manifestNote.textContent = target ? `From the deployment manifest: target ${target.targetId}, site root ${target.root}.` : "Create this environment on the project's Deploy page before setting up deploy access on the machine.";
        openSetup.hidden = !!target || !ctx.onDeploymentSetup;
      } catch (error) { manifestNote.textContent = error.message; openSetup.hidden = true; }
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
        if (checks.deploy.checked && !await deployTarget(projectId, environment.value.trim())) {
          view.error(`Create the ${environment.value.trim()} deployment environment on this project's Deploy page first. The machine is connected and can be reused after that.`);
          return;
        }
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
        if (plan.access.plan?.retireTarget && job.error?.code === "conflict") card.append(button("Review target repair again", async () => {
          try {
            const { access: repaired } = await post(`/api/machine-access/${encodeURIComponent(plan.access.id)}/repair-target`);
            const rest = plans.slice(plans.indexOf(plan));
            rest[0] = { ...plan, access: repaired };
            showReview(machineId, rest, { next });
          } catch (error) { view.error(error.message); }
        }, "btn btn-primary"));
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
    const completion = node("div", results.some(({ plan }) => plan.bind)
      ? "✓ Machine access verified. Connect it to the deployment below."
      : "✓ Machine setup complete", "machine-complete");
    completion.setAttribute("role", "status");
    view.body.append(completion);
    for (const { plan } of results) {
      const access = (await call(ws(`/api/machine-access/${encodeURIComponent(plan.access.id)}`))).access;
      const card = node("article", "", "machine-card");
      card.append(node("h4", access.machineLevel ? (access.role === "admin" ? "PSM administrator access" : "Deployment helper") : `${access.projectName} · ${access.environmentId} · ${access.role}`));
      const verified = node("ul", "");
      for (const check of access.checks) verified.append(node("li", `${check.ok ? "✓" : "✕"} ${check.title} — ${check.detail}`));
      card.append(verified);
      if (plan.bind) {
        const projectName = ctx.projects().find((entry) => entry.id === plan.bind.projectId)?.name || plan.bind.projectId;
        let target = null;
        try { target = await deployTarget(plan.bind.projectId, plan.bind.environmentId); } catch (error) { view.error(error.message); }
        if (!target) {
          card.append(node("p", `Machine access is verified, but ${projectName} has no ${plan.bind.environmentId} deployment environment. Create it on the Deploy page before binding a machine. This enrolled target may need a reviewed repair to match the new manifest.`, "machine-error"));
          if (ctx.onDeploymentSetup) card.append(button("Open project Deploy page", () => setupDeployment(plan.bind.projectId), "btn btn-primary"));
        } else if (!matchesTarget(access, target)) {
          card.append(node("p", "This access was enrolled for a different target, site root or domain. It cannot be bound to the deployment manifest. Review a target repair before using it for deploys.", "machine-error"));
          if (access.plan?.target?.targetId !== target.targetId) card.append(button("Review target repair", async () => {
            try {
              const { access: repaired } = await post(`/api/machine-access/${encodeURIComponent(access.id)}/repair-target`);
              showReview(machineId, [{ access: repaired, method: "admin-ssh", bind: plan.bind }]);
            } catch (error) { view.error(error.message); }
          }, "btn btn-primary"));
        } else {
          const bind = button(`Use for ${projectName} ${plan.bind.environmentId} deployments`, async () => {
          try {
            const current = await deployTarget(plan.bind.projectId, plan.bind.environmentId);
            if (!matchesTarget(access, current)) throw new Error("The deployment target changed. Review machine access again before binding it.");
            await call(`/api/projects/${encodeURIComponent(plan.bind.projectId)}/deployments/${encodeURIComponent(plan.bind.environmentId)}/connection-bindings/host`, { method: "PUT", body: JSON.stringify({ connectionId: access.connectionId }) });
            bind.replaceWith(node("span", "✓ Connected to deployment", "machine-bound-state"));
            completion.textContent = `✓ Connected to ${projectName} ${plan.bind.environmentId}. You can close this window.`;
            ctx.onBound?.(plan.bind);
          } catch (error) { view.error(error.message); }
        }, "btn btn-primary");
        card.append(bind);
        }
      }
      view.body.append(card);
    }
    const actions = node("div", "", "machine-ready-actions");
    actions.append(button("Done ✓", () => ctx.onDone ? ctx.onDone() : showList(), "btn btn-success machine-done"), button("Add another project", () => showAccess(machineId)));
    view.body.append(actions);
  }

  window.PsmMachines = {
    deployCandidate,
    open(options) {
      ctx = options;
      if (options.machineId) return showAccess(options.machineId);
      return showList();
    },
  };
})();
