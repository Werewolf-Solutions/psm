const CLOUD = {
  signedIn: false,
  account: null,
  settings: { backupProjects: [], lastBackupAt: {} },
  devices: [],
  snapshots: [],
  remote: null,
  project: "",
  busy: false,
  runtime: null,
  authError: "",
};

function cloudBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

async function cloudApi(path, init) {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "PSM Cloud request failed");
    error.code = body.code;
    error.data = body.data;
    throw error;
  }
  return body;
}

async function loadCloud(force) {
  if (CLOUD.busy && !force) return;
  CLOUD.busy = true;
  $("#cloud-body").innerHTML = '<div class="cloud-empty">Loading PSM Cloud…</div>';
  try {
    const status = await cloudApi("/api/cloud/status");
    CLOUD.signedIn = !!status.signedIn;
    CLOUD.account = status.account || null;
    CLOUD.runtime = status.runtime || STATE.runtimeServices.werewolf || null;
    CLOUD.authError = status.authError || "";
    CLOUD.settings = status.settings || { backupProjects: [], lastBackupAt: {} };
    if (CLOUD.signedIn && CLOUD.account?.cloudReady !== false) {
      const results = await Promise.all([
        cloudApi("/api/cloud/devices"),
        cloudApi("/api/cloud/backups"),
      ]);
      CLOUD.devices = results[0].devices || [];
      CLOUD.snapshots = results[1].snapshots || [];
      CLOUD.settings = results[1].settings || CLOUD.settings;
      if (!CLOUD.project || !STATE.projects.some((project) => project.name === CLOUD.project)) {
        CLOUD.project = STATE.projects[0]?.name || "";
      }
    }
    renderCloud();
  } catch (error) {
    $("#cloud-body").innerHTML = '<div class="cloud-empty cloud-warning">' + esc(error.message) + "</div>";
  } finally {
    CLOUD.busy = false;
  }
}

function renderCloudLogin() {
  const runtime = CLOUD.runtime || STATE.runtimeServices.werewolf || {};
  const target = runtime.source === "local"
    ? "Local Werewolf"
    : runtime.source === "override"
      ? "Configured Werewolf"
      : "Werewolf production";
  $("#cloud-body").innerHTML = [
    '<div class="cloud-login">',
      '<div class="cloud-section">',
        "<h3>Sign in to PSM Cloud</h3>",
        "<p>Your existing local workspace stays available without an account.</p>",
        '<label>Name <input id="cloud-name" type="text" autocomplete="name" placeholder="Only needed for a new account" /></label>',
        '<label>Email <input id="cloud-email" type="email" autocomplete="email" /></label>',
        '<label>Password <input id="cloud-password" type="password" autocomplete="current-password" minlength="8" /></label>',
        '<div class="cloud-actions">',
          '<button class="btn btn-primary" id="cloud-login">Sign in</button>',
          '<button class="btn" id="cloud-register">Create account</button>',
        "</div>",
      "</div>",
      CLOUD.authError ? '<div class="cloud-warning">Previous session unavailable: ' + esc(CLOUD.authError) + "</div>" : "",
      '<p class="hint">Target: ' + esc(target) + " · " + esc(runtime.activeUrl || "discovering…") + '. Sign-in uses /auth/login and /auth/me. Refresh credentials use the OS keyring when available and otherwise remain in memory only.</p>',
    "</div>",
  ].join("");

  async function submit(action) {
    const email = $("#cloud-email").value.trim();
    const password = $("#cloud-password").value;
    const name = $("#cloud-name").value.trim();
    if (!email || password.length < 8) return toast("Enter an email and a password of at least 8 characters");
    CLOUD.busy = true;
    try {
      const result = await cloudApi("/api/cloud/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      CLOUD.signedIn = true;
      CLOUD.account = result.account;
      CLOUD.settings = result.settings;
      toast(action === "register" ? "PSM Cloud account created" : "Signed in to PSM Cloud");
      await loadCloud(true);
    } catch (error) {
      toast(error.message);
      CLOUD.busy = false;
    }
  }
  $("#cloud-login").onclick = () => submit("login");
  $("#cloud-register").onclick = () => submit("register");
}

function cloudSnapshotRow(snapshot) {
  const id = encodeURIComponent(snapshot._id || snapshot.id);
  const when = new Date(snapshot.createdAt).toLocaleString();
  return [
    '<div class="cloud-item">',
      '<div class="cloud-item-main">',
        "<strong>" + esc(snapshot.projectName) + "</strong>",
        "<span>" + esc(when) + " · " + Number(snapshot.fileCount || 0) + " files · " + cloudBytes(snapshot.totalBytes) + "</span>",
      "</div>",
      '<div class="cloud-row-actions">',
        '<button class="btn cloud-restore" data-id="' + id + '">Restore</button>',
        '<button class="btn danger cloud-delete" data-id="' + id + '">Delete</button>',
      "</div>",
    "</div>",
  ].join("");
}

function renderCloudAccount() {
  const account = CLOUD.account || {};
  if (account.cloudReady === false) {
    const user = account.user || {};
    $("#cloud-body").innerHTML = [
      '<section class="cloud-section">',
        '<div class="cloud-account-line"><div><h3>' + esc(user.name || user.email) + "</h3><p>" + esc(user.email || "") + "</p></div>",
        '<div class="cloud-actions"><button class="btn" id="cloud-logout">Sign out</button></div></div>',
        '<div class="cloud-warning">Your Werewolf Solutions account is signed in (verified by /auth/me), but this device does not have an active PSM Cloud session. Sign out and sign in again to reconnect it.</div>',
        account.serviceError ? '<p class="hint">' + esc(account.serviceError) + "</p>" : "",
      "</section>",
    ].join("");
    $("#cloud-logout").onclick = async () => {
      await cloudApi("/api/cloud/logout", { method: "POST" }).catch(() => {});
      CLOUD.signedIn = false;
      CLOUD.account = null;
      renderCloud();
    };
    return;
  }
  const entitlement = account.entitlement || {};
  const subscription = account.subscription || {};
  const limits = account.limits || {};
  const usage = account.usage || {};
  const user = account.user || {};
  const isPro = entitlement.plan === "pro";
  const projectOptions = STATE.projects
    .filter((project) => !project.archived)
    .map((project) => '<option value="' + esc(project.name) + '"' + (project.name === CLOUD.project ? " selected" : "") + ">" + esc(project.name) + "</option>")
    .join("");
  const backupEnabled = CLOUD.settings.backupProjects?.includes(CLOUD.project);
  const lastBackup = CLOUD.settings.lastBackupAt?.[CLOUD.project];
  const relevantSnapshots = CLOUD.snapshots.filter((snapshot) => !CLOUD.project || snapshot.projectId === CLOUD.project);
  const deviceRows = CLOUD.devices.map((device) => [
    '<div class="cloud-item">',
      '<div class="cloud-item-main"><strong>' + esc(device.name || device.deviceId) + (device.current ? " · this device" : "") + "</strong>",
      "<span>" + esc(device.platform || "") + " · seen " + esc(new Date(device.lastSeenAt).toLocaleString()) + "</span></div>",
      device.current ? "" : '<button class="btn danger cloud-revoke" data-id="' + encodeURIComponent(device.id) + '">Revoke</button>',
    "</div>",
  ].join("")).join("");

  $("#cloud-body").innerHTML = [
    '<section class="cloud-section">',
      '<div class="cloud-account-line"><div><h3>' + esc(user.name || user.email) + "</h3><p>" + esc(user.email || "") + "</p></div>",
      '<div class="cloud-actions"><button class="btn" id="cloud-logout">Sign out</button></div></div>',
      '<div class="cloud-summary">',
        '<div class="cloud-metric"><span>Plan</span><strong>' + esc((entitlement.plan || "free").toUpperCase()) + "</strong></div>",
        '<div class="cloud-metric"><span>Storage</span><strong>' + cloudBytes(usage.storageBytes) + " / " + cloudBytes(limits.storageBytes) + "</strong></div>",
        '<div class="cloud-metric"><span>Devices</span><strong>' + Number(usage.devices || 0) + " / " + Number(limits.devices || 1) + "</strong></div>",
        '<div class="cloud-metric"><span>Retention</span><strong>' + Number(limits.retentionDays || 30) + " days</strong></div>",
      "</div>",
      '<div class="cloud-actions" style="margin-top:12px">',
        isPro ? "" : '<button class="btn btn-primary" id="cloud-monthly">Pro £12/month</button><button class="btn" id="cloud-annual">Pro £120/year</button>',
        subscription.status && subscription.status !== "free" ? '<button class="btn" id="cloud-portal">Manage billing</button>' : "",
      "</div>",
      entitlement.restoreOnly ? '<div class="cloud-warning">Payment is past due. Restore remains available during the three-day grace period; new uploads and sync are paused.</div>' : "",
      '<p class="hint">Session persistence: ' + esc(account.credentialPersistence || "memory") + " · API: " + esc((account.apiSource || "session") + " · " + (account.apiUrl || "")) + "</p>",
    "</section>",
    '<section class="cloud-section">',
      "<h3>Metadata sync</h3>",
      "<p>Sync project labels, safe settings, attachment references, and structured plans. Commands, absolute paths, secrets, logs, and raw AI sessions are excluded.</p>",
      '<div class="cloud-actions">',
        '<button class="btn btn-primary" id="cloud-sync-push"' + (!entitlement.canSync ? " disabled" : "") + ">Push this workspace</button>",
        '<button class="btn" id="cloud-sync-pull"' + (!entitlement.canSync ? " disabled" : "") + ">Preview cloud state</button>",
        CLOUD.remote ? '<button class="btn" id="cloud-sync-apply">Apply preview</button>' : "",
      "</div>",
      CLOUD.remote ? '<div class="cloud-warning">Cloud revision ' + Number(CLOUD.remote.revision || 0) + " loaded. Applying changes only safe override fields for projects present on this machine.</div>" : "",
    "</section>",
    '<section class="cloud-section">',
      "<h3>Encrypted project backups</h3>",
      "<p>Daily and manual snapshots use local AES-256-GCM encryption. Hard exclusions always remove credentials, environments, dependencies, build output, logs, AI sessions, and symlinks.</p>",
      '<div class="cloud-grid"><label>Project<select id="cloud-project">' + projectOptions + "</select></label>",
      '<div class="cloud-actions"><label class="check"><input id="cloud-auto" type="checkbox"' + (backupEnabled ? " checked" : "") + (!isPro ? " disabled" : "") + " /> Daily</label>",
      '<button class="btn btn-primary" id="cloud-backup-now"' + (!entitlement.canUpload ? " disabled" : "") + ">Back up now</button></div></div>",
      lastBackup ? '<div class="cloud-success">Last successful local run: ' + esc(new Date(lastBackup).toLocaleString()) + "</div>" : "",
      '<div class="cloud-list">' + (relevantSnapshots.length ? relevantSnapshots.map(cloudSnapshotRow).join("") : '<div class="cloud-empty">No snapshots for this project.</div>') + "</div>",
    "</section>",
    '<section class="cloud-section"><h3>Devices</h3><p>Pro supports three active devices. Revocation takes effect when the device next calls the API.</p><div class="cloud-list">' + (deviceRows || '<div class="cloud-empty">No active devices.</div>') + "</div></section>",
  ].join("");

  $("#cloud-logout").onclick = async () => {
    await cloudApi("/api/cloud/logout", { method: "POST" }).catch(() => {});
    CLOUD.signedIn = false;
    CLOUD.account = null;
    CLOUD.snapshots = [];
    CLOUD.devices = [];
    renderCloud();
  };
  async function billing(action, interval) {
    try {
      const result = await cloudApi("/api/cloud/billing/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(interval ? { interval } : {}),
      });
      window.open(result.url, "_blank", "noopener");
      toast("Billing opened in a new tab");
    } catch (error) { toast(error.message); }
  }
  if ($("#cloud-monthly")) $("#cloud-monthly").onclick = () => billing("checkout", "month");
  if ($("#cloud-annual")) $("#cloud-annual").onclick = () => billing("checkout", "year");
  if ($("#cloud-portal")) $("#cloud-portal").onclick = () => billing("portal");

  $("#cloud-sync-push").onclick = async () => {
    try {
      const result = await cloudApi("/api/cloud/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      toast("Workspace metadata synced at revision " + result.revision);
    } catch (error) {
      toast(error.code === "sync_conflict" ? "Cloud state changed. Preview it before overwriting." : error.message);
    }
  };
  $("#cloud-sync-pull").onclick = async () => {
    try {
      CLOUD.remote = await cloudApi("/api/cloud/sync");
      renderCloudAccount();
    } catch (error) { toast(error.message); }
  };
  if ($("#cloud-sync-apply")) $("#cloud-sync-apply").onclick = async () => {
    try {
      const applied = await cloudApi("/api/cloud/sync/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: CLOUD.remote.state }),
      });
      CLOUD.remote = null;
      await load();
      renderCloudAccount();
      const conflicts = applied.planConflicts || [];
      toast(conflicts.length
        ? "Metadata applied; " + conflicts.length + " confirmed plan conflict(s) kept local"
        : "Cloud metadata applied");
    } catch (error) { toast(error.message); }
  };

  $("#cloud-project").onchange = (event) => {
    CLOUD.project = event.target.value;
    renderCloudAccount();
  };
  $("#cloud-auto").onchange = async (event) => {
    try {
      const result = await cloudApi("/api/cloud/backups/" + encodeURIComponent(CLOUD.project), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: event.target.checked }),
      });
      CLOUD.settings = result.settings;
      toast(event.target.checked ? "Daily backup enabled" : "Daily backup disabled");
    } catch (error) {
      event.target.checked = !event.target.checked;
      toast(error.message);
    }
  };
  $("#cloud-backup-now").onclick = async (event) => {
    event.target.disabled = true;
    event.target.textContent = "Encrypting & uploading…";
    try {
      const result = await cloudApi("/api/cloud/backups/" + encodeURIComponent(CLOUD.project) + "/now", { method: "POST" });
      CLOUD.settings = result.settings;
      toast("Encrypted backup completed");
      await loadCloud(true);
    } catch (error) {
      toast(error.message);
      event.target.disabled = false;
      event.target.textContent = "Back up now";
    }
  };
  document.querySelectorAll(".cloud-restore").forEach((button) => {
    button.onclick = async () => {
      const destination = prompt("Restore into a new or empty absolute directory:");
      if (!destination) return;
      button.disabled = true;
      try {
        const result = await cloudApi("/api/cloud/backups/" + button.dataset.id + "/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destination }),
        });
        toast("Restored " + result.files + " files to " + result.destination);
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    };
  });
  document.querySelectorAll(".cloud-delete").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("Delete this encrypted snapshot?")) return;
      try {
        await cloudApi("/api/cloud/backups/" + button.dataset.id, { method: "DELETE" });
        toast("Snapshot deleted");
        await loadCloud(true);
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll(".cloud-revoke").forEach((button) => {
    button.onclick = async () => {
      try {
        await cloudApi("/api/cloud/devices/" + button.dataset.id, { method: "DELETE" });
        toast("Device revoked");
        await loadCloud(true);
      } catch (error) { toast(error.message); }
    };
  });
}

function renderCloud() {
  if (CLOUD.signedIn) renderCloudAccount();
  else renderCloudLogin();
  const button = $("#cloud-open");
  if (button) {
    button.textContent = !CLOUD.signedIn
      ? "☁ Sign in / up"
      : CLOUD.account?.entitlement?.plan === "pro"
        ? "☁ Cloud Pro"
        : "☁ Cloud";
  }
}

function openCloud() {
  openModal("#cloud-modal");
  loadCloud(true);
}

$("#cloud-open").onclick = openCloud;
$("#cloud-close").onclick = closeModals;
$("#cloud-refresh").onclick = () => loadCloud(true);
