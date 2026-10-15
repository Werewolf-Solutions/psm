/* Executor activity: what the executor did with each Todo note it claimed.
 * A triage job is one prompt to a tool-less Claude call and one answer, so a
 * job reads as a short exchange: the note, what psm asked Claude, what Claude
 * answered, the verdict, and what went back to the hub. Live while open. */
(() => {
  const node = (tag, text = "", className = "") => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  const STATE = {
    claimed: ["Claimed", "busy"],
    "building-context": ["Reading the project", "busy"],
    "asking-claude": ["Asking Claude", "busy"],
    "checking-answer": ["Checking the answer", "busy"],
    posting: ["Posting to the hub", "busy"],
    triaged: ["Triaged", "ok"],
    failed: ["Failed", "bad"],
    abandoned: ["Stopped", "warn"],
  };
  const VERDICT = { fits: "Fits", doesnt_fit: "Doesn't fit", needs_decision: "Needs a decision" };

  let ctx = null; // { api, list, detail, summary }
  let jobs = [];
  let selected = null;
  let selectedEntry = null;
  let revision = -1;
  let timer = null;

  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(ms).toLocaleDateString();
  };
  const kb = (text) => `${Math.max(1, Math.round(new Blob([text]).size / 1024))} KB`;

  async function get(path) {
    const response = await ctx.api(path);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function badge(state) {
    const [label, tone] = STATE[state] || [state, ""];
    return node("span", label, `exec-badge exec-${tone}`);
  }

  function statusLine(status) {
    if (!status?.enabled) return "Executor is off — switch it on in Running to pick up tagged notes.";
    if (status.state === "hub-error") return /sign in/i.test(status.lastError || "") ? "Waiting for you to sign in with Werewolf." : `Hub not answering: ${status.lastError}`;
    if (status.running?.length) return `Working on ${status.running.length} note${status.running.length === 1 ? "" : "s"} now.`;
    return "Connected — waiting for tagged notes.";
  }

  function renderList() {
    ctx.list.replaceChildren();
    if (!jobs.length) {
      ctx.list.append(node("div", "No jobs yet. Tag a Todo note with @project and it appears here as soon as the executor claims it.", "procs-empty"));
      return;
    }
    for (const job of jobs) {
      const row = node("button", "", `exec-job${job.jobId === selected ? " on" : ""}`);
      row.type = "button";
      const head = node("div", "", "exec-job-head");
      head.append(node("strong", job.projectName), badge(job.state));
      const text = node("div", job.text, "exec-job-text");
      const meta = node("div", "", "exec-job-meta");
      const parts = [ago(job.claimedAt)];
      if (job.verdict) parts.push(`${VERDICT[job.verdict.verdict] || job.verdict.verdict} · ${job.verdict.size}`);
      if (job.cached) parts.push("reused");
      if (job.meta?.costUsd != null) parts.push(`$${job.meta.costUsd.toFixed(4)}`);
      meta.textContent = parts.join(" · ");
      row.append(head, text, meta);
      row.onclick = () => select(job.jobId);
      ctx.list.append(row);
    }
  }

  function bubble(who, className, ...children) {
    const wrap = node("div", "", `exec-bubble ${className}`);
    wrap.append(node("div", who, "exec-who"), ...children);
    return wrap;
  }

  function collapsible(summary, text, open = false) {
    const details = node("details", "", "exec-details");
    details.open = open;
    details.append(node("summary", summary), node("pre", text, "exec-pre"));
    return details;
  }

  function pretty(text) {
    const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return text;
    }
  }

  function verdictCard(verdict) {
    const card = node("div", "", `exec-verdict exec-verdict-${verdict.verdict}`);
    const head = node("div", "", "exec-verdict-head");
    head.append(node("strong", VERDICT[verdict.verdict] || verdict.verdict), node("span", `size ${verdict.size}`, "exec-size"));
    card.append(head);
    if (verdict.rationale) card.append(node("p", verdict.rationale));
    const list = (title, items) => {
      if (!items?.length) return;
      card.append(node("div", title, "exec-label"));
      const ul = node("ul");
      for (const item of items) ul.append(node("li", item));
      card.append(ul);
    };
    list("Questions for you", verdict.questions);
    list("Depends on", verdict.dependsOn);
    list("Conflicts with", verdict.conflictsWith);
    list("Comes after", verdict.queue?.after);
    if (verdict.queue?.note) card.append(node("div", verdict.queue.note, "exec-note"));
    return card;
  }

  function renderDetail() {
    const root = ctx.detail;
    root.replaceChildren();
    const entry = selectedEntry;
    if (!entry) {
      root.append(node("div", jobs.length ? "Pick a job to see the exchange." : "", "procs-empty"));
      return;
    }
    const head = node("div", "", "exec-detail-head");
    const title = node("div");
    title.append(node("h3", entry.projectName), node("div", `claimed ${time(entry.claimedAt)}${entry.attempt > 1 ? ` · attempt ${entry.attempt}` : ""} · job ${entry.jobId}`, "exec-sub"));
    head.append(title, badge(entry.state));
    root.append(head);

    if (entry.meta) {
      const facts = [entry.meta.model, entry.meta.durationMs != null ? `${(entry.meta.durationMs / 1000).toFixed(1)} s` : null,
        entry.meta.inputTokens != null ? `${entry.meta.inputTokens.toLocaleString()} in / ${(entry.meta.outputTokens ?? 0).toLocaleString()} out tokens` : null,
        entry.meta.costUsd != null ? `$${entry.meta.costUsd.toFixed(4)}` : null].filter(Boolean);
      if (facts.length) root.append(node("div", facts.join(" · "), "exec-facts"));
    }

    root.append(bubble("Todo note", "exec-from-todo", node("p", entry.text)));

    if (entry.prompt) {
      const asked = bubble("psm → Claude", "exec-from-psm",
        node("p", `One call, no tools. psm gave Claude the project's context (${entry.context ? `${Math.round(entry.context.bytes / 1024)} KB${entry.context.truncated ? ", trimmed" : ""}, ${entry.context.openIntake} other open notes` : "built from the project"}) and the note.`),
        collapsible(`Prompt (${kb(entry.prompt)})`, entry.prompt));
      if (entry.systemPrompt) asked.append(collapsible("Instructions (system prompt)", entry.systemPrompt));
      root.append(asked);
    } else if (entry.cached) {
      root.append(bubble("psm", "exec-from-psm", node("p", "Same note and same project context as an earlier job, so psm reused that verdict without calling Claude.")));
    } else if (!["triaged", "failed", "abandoned"].includes(entry.state)) {
      root.append(bubble("psm", "exec-from-psm exec-pending", node("p", "Reading the project…")));
    }

    if (entry.answer) {
      // The verdict in words first; the JSON Claude actually sent stays one click away.
      const answer = bubble("Claude → psm", "exec-from-claude");
      if (entry.verdict) answer.append(verdictCard(entry.verdict));
      else answer.append(node("p", "This answer was not a valid verdict, so nothing was triaged."));
      answer.append(collapsible("Raw answer", pretty(entry.answer), !entry.verdict));
      root.append(answer);
    } else if (entry.state === "asking-claude") {
      root.append(bubble("Claude", "exec-from-claude exec-pending", node("p", "Thinking… (one call, up to five minutes)")));
    } else if (entry.verdict) {
      root.append(verdictCard(entry.verdict)); // reused from an earlier job
    }
    if (entry.error) root.append(node("div", entry.error, "exec-error"));

    root.append(node("div", "Timeline", "exec-label"));
    const timeline = node("ol", "", "exec-timeline");
    for (const event of entry.timeline) {
      const li = node("li");
      li.append(node("time", time(event.at)), node("span", event.label));
      timeline.append(li);
    }
    root.append(timeline);
  }

  async function select(jobId) {
    selected = jobId;
    renderList();
    try {
      selectedEntry = await get(`/api/executor/activity/${encodeURIComponent(jobId)}`);
    } catch (error) {
      selectedEntry = null;
      ctx.detail.replaceChildren(node("div", error.message, "procs-empty"));
      return;
    }
    renderDetail();
  }

  async function poll() {
    if (!ctx) return;
    try {
      const data = await get("/api/executor/activity");
      if (ctx.summary) ctx.summary.textContent = statusLine(data.status);
      if (data.revision === revision) return;
      revision = data.revision;
      jobs = data.jobs || [];
      if (!selected && jobs.length) selected = jobs[0].jobId;
      renderList();
      if (selected) {
        selectedEntry = await get(`/api/executor/activity/${encodeURIComponent(selected)}`).catch(() => null);
        renderDetail();
      } else renderDetail();
    } catch (error) {
      if (ctx.summary) ctx.summary.textContent = error.message || "Could not reach psm";
    }
  }

  window.PsmExecutor = {
    open(options) {
      ctx = options;
      revision = -1;
      selected = null;
      selectedEntry = null;
      ctx.list.replaceChildren(node("div", "Loading…", "procs-empty"));
      ctx.detail.replaceChildren();
      clearInterval(timer);
      timer = setInterval(() => {
        if (ctx?.isOpen && !ctx.isOpen()) return clearInterval(timer);
        void poll();
      }, 2000);
      return poll();
    },
    close() {
      clearInterval(timer);
      timer = null;
    },
  };
})();
