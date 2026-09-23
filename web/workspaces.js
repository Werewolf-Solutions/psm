/**
 * Personal / business workspaces in the cockpit.
 *
 * The header selector chooses which workspace's projects the board shows; the
 * project view has a selector that assigns *that project* to a workspace. Both
 * talk to the local agent (/api/cloud/workspaces…), which asks Werewolf who the
 * signed-in account belongs to — the page never decides membership. Personal
 * needs no sign-in. Choosing a workspace is a view, not a grant: it does not
 * touch files, agent pairing or deployments.
 */
(function () {
  const api = (path, init) => PsmAgent.api(path, init);
  const json = (body) => ({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const state = {
    signedIn: false,
    workspaces: [{ ref: "personal", kind: "personal", name: "Personal", role: "owner" }],
    current: { ref: "personal", name: "Personal" },
    pending: null,
    /** Set when the account API could not say which businesses this account is in. */
    businessError: null,
    /** Set when the local agent itself could not be reached. A different problem. */
    agentError: null,
    hidden: new Set(),
    projectWorkspace: new Map(),
    project: null,
  };

  const label = (w) => (w.kind === "business" ? `${w.name} (${w.role})` : w.name);

  function option(w) {
    const o = document.createElement("option");
    o.value = w.ref;
    o.textContent = label(w);
    return o;
  }

  function fill(select, value) {
    if (!select) return;
    select.replaceChildren(...state.workspaces.map(option));
    select.value = state.workspaces.some((w) => w.ref === value) ? value : "personal";
  }

  function renderTop() {
    const select = document.getElementById("workspace-select");
    if (!select) return;
    fill(select, state.current.ref);
    // These are three different problems and the user has to be able to tell
    // them apart: the agent is unreachable, the account cannot be asked who you
    // work for, or you are simply signed out. Only the last is normal.
    select.title = state.agentError
      ? `The psm agent is not reachable (${state.agentError}). Showing personal only; business workspaces are unknown, not empty.`
      : state.businessError
        ? `Signed in, but your business workspaces could not be listed (${state.businessError}). This is an error, not an empty list — retry before assuming you have none.`
        : state.pending
          ? "Your last business workspace returns when you sign in with an account that belongs to it"
          : state.current.kind === "business"
            ? "Business workspace — access comes from your membership"
            : "Personal workspace — private to you";
    select.classList.toggle("workspace-degraded", !!(state.agentError || state.businessError));
  }

  function renderProject() {
    const select = document.getElementById("ws-workspace");
    if (!select) return;
    select.hidden = !state.project;
    if (!state.project) return;
    const assigned = state.projectWorkspace.get(state.project) || "personal";
    // A project may sit in a business this session cannot currently list; keep it
    // visible and honest rather than silently showing "Personal".
    fill(select, assigned);
    if (!state.workspaces.some((w) => w.ref === assigned)) {
      const o = document.createElement("option");
      o.value = assigned;
      o.textContent = "Business (sign in to view)";
      select.appendChild(o);
      select.value = assigned;
    }
  }

  /** So a failing poll does not toast on every refresh. */
  let lastReported = null;

  async function refresh() {
    let failure = null;
    try {
      const [listed, projects] = await Promise.all([
        api("/api/cloud/workspaces").then((r) => r.json()),
        api("/api/cloud/workspaces/projects").then((r) => r.json()),
      ]);
      state.signedIn = !!listed.signedIn;
      state.workspaces = listed.workspaces || state.workspaces;
      state.current = listed.current || state.current;
      state.pending = listed.pending || null;
      state.businessError = listed.businessError || null;
      state.agentError = null;
      state.hidden = new Set((projects.projects || []).filter((p) => !p.visible).map((p) => p.name));
      state.projectWorkspace = new Map((projects.projects || []).map((p) => [p.name, p.workspace]));
    } catch (err) {
      // The board keeps working without the workspace service — but it says so.
      // Silently showing every project as if no workspace existed would read as
      // "nothing is filtered", when the truth is "the filter is unknown".
      state.agentError = (err && err.message) || "not reachable";
      failure = state.agentError;
      state.hidden = new Set();
    }
    renderTop();
    renderProject();
    if (failure && typeof toast === "function" && failure !== lastReported) {
      lastReported = failure;
      toast(`Workspaces unavailable: ${failure}. Showing every project, unfiltered.`);
    }
    if (!failure) lastReported = null;
    if (typeof render === "function") render();
  }

  async function select(ref) {
    const res = await api("/api/cloud/workspaces/selected", json({ ref }));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (typeof toast === "function") toast(body.error || "Could not switch workspace");
    }
    await refresh();
  }

  async function assign(ref) {
    if (!state.project) return;
    const res = await api(`/api/cloud/workspaces/projects/${encodeURIComponent(state.project)}`, json({ ref }));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (typeof toast === "function") toast(body.error || "Could not move the project");
    } else if (typeof toast === "function") {
      const body = await res.json().catch(() => ({}));
      const moved = body.from && body.from !== body.workspace;
      toast(
        `${moved ? "Project moved" : "Project workspace confirmed"}. This records where psm shows it — files, ` +
          "agent pairing and deployment access on this machine are unchanged, and no cloud data changed hands.",
      );
    }
    await refresh();
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("workspace-select")?.addEventListener("change", (e) => void select(e.target.value));
    document.getElementById("ws-workspace")?.addEventListener("change", (e) => void assign(e.target.value));
    renderTop();
  });

  window.PsmWorkspaces = {
    refresh,
    /** Is this project outside the selected workspace? (Used by the board filter.) */
    hides: (name) => state.hidden.has(name),
    showProject(name) {
      state.project = name || null;
      renderProject();
    },
    state,
  };
})();
