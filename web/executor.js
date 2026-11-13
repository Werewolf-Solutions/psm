/* The Executor page (P17): write a task for a project, watch it get triaged,
 * press Go, and review the change — the same flow a Todo note tagged @project
 * takes, started here or there.
 *
 * Queue is the hub's whole intake for this user plus its implement jobs.
 * Activity is what this machine's executor did with each job it claimed: a
 * triage job is one prompt to a tool-less Claude call and one answer, so it
 * reads as a short exchange. Both are live while the page is visible. */
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
    preparing: ["Preparing its clone", "busy"],
    implementing: ["Implementing", "busy"],
    review: ["Ready for review", "ok"],
    merged: ["Merged", "ok"],
    rejected: ["Rejected", "warn"],
    revising: ["Sent back", "busy"],
    stalled: ["Stalled", "warn"],
    failed: ["Failed", "bad"],
    abandoned: ["Stopped", "warn"],
  };
  const VERDICT = { fits: "Fits", doesnt_fit: "Doesn't fit", needs_decision: "Needs a decision" };

  let ctx = null; // the page's elements and callbacks, from app.js
  /** Nothing is polled while the tab is in the background or the page is closed. */
  const watching = () => !!ctx && !document.hidden && (!ctx.isOpen || ctx.isOpen());
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
    if (ctx.statusText) return ctx.statusText(status || {});
    if (!status?.enabled) return "Executor is off — switch it on to pick up tasks.";
    if (status.state === "hub-error") return /sign in/i.test(status.lastError || "") ? "Waiting for you to sign in with Werewolf." : `Hub not answering: ${status.lastError}`;
    if (status.running?.length) return `Working on ${status.running.length} task${status.running.length === 1 ? "" : "s"} now.`;
    return "Connected — waiting for tasks.";
  }

  function renderList() {
    ctx.list.replaceChildren();
    if (!jobs.length) {
      ctx.list.append(node("div", "No jobs yet. Add a task in Queue, or tag a Todo note with @project: it appears here as soon as this machine's executor claims it.", "procs-empty"));
      return;
    }
    const shown = projectFilter ? jobs.filter((job) => job.projectId === projectFilter) : jobs;
    if (!shown.length) {
      ctx.list.append(node("div", "No jobs for this project yet. Pick All projects to see the rest.", "procs-empty"));
      return;
    }
    for (const job of shown) {
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
    const actions = node("div", "", "exec-detail-actions");
    actions.append(copyLogButton(entry.jobId, "Copy log", false), copyLogButton(entry.jobId, "+ prompts", true), badge(entry.state));
    head.append(title, actions);
    root.append(head);
    if (entry.kind === "implement") return renderImplement(root, entry);

    if (entry.meta) {
      const facts = [entry.meta.model, entry.meta.durationMs != null ? `${(entry.meta.durationMs / 1000).toFixed(1)} s` : null,
        entry.meta.inputTokens != null ? `${entry.meta.inputTokens.toLocaleString()} in / ${(entry.meta.outputTokens ?? 0).toLocaleString()} out tokens` : null,
        entry.meta.costUsd != null ? `$${entry.meta.costUsd.toFixed(4)}` : null].filter(Boolean);
      if (facts.length) root.append(node("div", facts.join(" · "), "exec-facts"));
    }

    root.append(bubble("Task", "exec-from-todo", node("p", entry.text)));

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

  /** An implement job: the task, what the agent said and did, the result. */
  function renderImplement(root, entry) {
    root.append(bubble("Task", "exec-from-todo", node("p", entry.text)));
    if (entry.prompt) {
      const sent = bubble("psm → agent", "exec-from-psm", node("p", "One agent with a shell in the job's isolated container. Only its clone is writable; the container has no host files or network."));
      sent.append(collapsible(`Task as sent (${kb(entry.prompt)})`, entry.prompt));
      if (entry.systemPrompt) sent.append(collapsible("Instructions (system prompt)", entry.systemPrompt));
      root.append(sent);
    }
    const lines = entry.agent || [];
    if (lines.length) {
      root.append(node("div", `What the agent did (${lines.length})`, "exec-label"));
      const list = node("div", "", "exec-transcript");
      for (const line of lines) {
        if (line.type === "message") {
          list.append(bubble("Agent", "exec-from-claude", node("p", line.text)));
        } else if (line.type === "tool") {
          list.append(node("div", `→ ${line.text}`, "exec-tline exec-tcall"));
        } else if (line.type === "result") {
          const first = line.text.split("\n").find((text) => text.trim()) || (line.ok ? "ok" : "failed");
          if (line.text.length > 160 || line.text.includes("\n")) {
            const details = node("details", "", `exec-tline exec-tresult${line.ok ? "" : " exec-tfail"}`);
            details.append(node("summary", `${line.ok ? "✓" : "✗"} ${first.slice(0, 140)}`), node("pre", line.text, "exec-pre"));
            list.append(details);
          } else list.append(node("div", `${line.ok ? "✓" : "✗"} ${line.text}`, `exec-tline exec-tresult${line.ok ? "" : " exec-tfail"}`));
        } else if (line.type === "check") {
          list.append(node("div", `${line.ok ? "✓ passed" : "✗ failed"}: ${line.text}`, `exec-tline exec-tcheck${line.ok ? "" : " exec-tfail"}`));
        } else if (line.type === "stop") {
          list.append(node("div", line.text, "exec-error"));
        }
      }
      root.append(list);
    } else if (!["review", "merged", "rejected", "revising", "stalled", "failed", "abandoned"].includes(entry.state)) {
      root.append(bubble("Agent", "exec-from-claude exec-pending", node("p", entry.state === "preparing" ? "Preparing the job's own clone…" : "Starting…")));
    }
    if (entry.result) {
      const r = entry.result;
      const card = node("div", "", `exec-verdict exec-verdict-${entry.state === "rejected" ? "doesnt_fit" : "fits"}`);
      const headline = node("div", "", "exec-verdict-head");
      headline.append(node("strong", STATE[entry.state]?.[0] || "Ready for review"), node("span", `${r.commits.length} commit${r.commits.length === 1 ? "" : "s"} · ${r.diffStat.files} files · +${r.diffStat.insertions} −${r.diffStat.deletions}`, "exec-size"));
      card.append(headline, node("p", r.summary));
      if (entry.state === "review") {
        const review = node("button", "Review the change", "btn btn-primary exec-qopen");
        review.type = "button";
        review.onclick = () => openReview(entry.jobId);
        card.append(review);
      }
      root.append(card);
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

  /** The job as plain text, to paste into a conversation instead of screenshots. */
  function copyLogButton(jobId, label, full) {
    const button = node("button", label, "btn btn-small");
    button.type = "button";
    button.title = full ? "Copy the log including the prompts psm sent" : "Copy the job's whole log as text: transcript, tool output, result, timeline";
    button.onclick = async () => {
      button.disabled = true;
      try {
        const response = await ctx.api(`/api/executor/activity/${encodeURIComponent(jobId)}/log${full ? "?full=1" : ""}`);
        const text = await response.text();
        if (!response.ok) throw new Error(text.trim() || `Request failed (${response.status})`);
        if (!await copyText(text)) throw new Error("The browser refused clipboard access");
        toast(`Copied the job log (${kb(text)})`);
      } catch (error) {
        toast(error.message || "Could not copy the log");
      } finally {
        button.disabled = false;
      }
    };
    return button;
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

  /* ---------- Queue: the hub's whole intake for this user ---------- */

  let view = "activity";
  let queueTimer = null;

  // What waits on you comes first: ready to implement, then your decisions; then the triage line.
  const QUEUE_SECTIONS = [
    { id: "fits", title: "Fits — ready to implement", note: "Go queues an implement job: a local branch in its own clone, tested, never pushed, for you to review here.", empty: null },
    { id: "needs_decision", title: "Needs your decision", empty: null },
    { id: "running", title: "Being triaged now", empty: null },
    { id: "waiting", title: "Waiting", empty: "Nothing waiting. Add a task above, or tag a Todo task or note with @project." },
    { id: "doesnt_fit", title: "Doesn't fit", empty: null },
    { id: "failed", title: "Failed", empty: null },
  ];

  function sectionOf(item) {
    if (item.status === "claimed") return "running";
    if (item.status === "new") return "waiting";
    if (item.status === "failed") return "failed";
    if (item.status === "triaged") return item.verdict?.verdict || "failed";
    return null;
  }

  function leaseLeft(iso) {
    const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    return s > 0 ? `lease ${s}s left` : "lease expired — goes back to waiting";
  }

  function queueRow(item, position) {
    const row = node("div", "", "exec-qrow");
    const head = node("div", "", "exec-qhead");
    const name = node("strong", item.projectName || item.projectId);
    head.append(name);
    if (position) head.append(node("span", `#${position}`, "exec-qpos"));
    const fromPsm = item.source === "psm";
    const asked = item.requestedBy;
    head.append(node("span", asked ? `${asked.kind === "bug" ? "bug" : asked.kind === "feature" ? "feature" : "request"} from ${asked.name}` : fromPsm ? "from PSM" : item.sourceRef?.kind === "note" ? "Todo note" : "Todo task", `exec-qkind${fromPsm ? " exec-qsource-psm" : ""}`));
    const text = node("div", item.text, "exec-qtext");
    row.append(head, text);
    const meta = [ago(new Date(item.createdAt).getTime())];
    if (item.status === "claimed" && item.claim) meta.push(item.mine ? "this machine" : `executor ${item.claim.executorId}`, leaseLeft(item.claim.leaseUntil));
    if (item.attempts > 1 || (item.status === "new" && item.attempts > 0)) meta.push(`attempt ${item.attempts}${item.status === "new" ? " failed, retrying" : ""}`);
    if (item.verdict) meta.push(`size ${item.verdict.size}`);
    row.append(node("div", meta.join(" · "), "exec-qmeta"));
    if (item.status === "triaged" && item.verdict?.verdict === "needs_decision" && item.verdict.questions?.length) {
      const ul = node("ul", "", "exec-qquestions");
      for (const question of item.verdict.questions) ul.append(node("li", question));
      row.append(ul);
    } else if (item.verdict?.queue?.note) {
      row.append(node("div", item.verdict.queue.note, "exec-qnote"));
    }
    if (item.error && item.status !== "triaged") row.append(node("div", item.error, "exec-qerror"));
    if (item.status === "triaged" && ["fits", "needs_decision"].includes(item.verdict?.verdict)) {
      const job = jobByIntake.get(item.intakeId);
      if (job && ["queued", "claimed", "review"].includes(job.status)) {
        row.append(node("div", `Implement job: ${JOB_LABEL[job.status] || job.status}`, "exec-qnote"));
      } else {
        const choice = node("select", "", "exec-qchoice");
        choice.setAttribute("aria-label", "Implementation provider");
        for (const [value, label] of [["auto", "Auto (project provider and task size)"], ["claude", "Claude"], ["codex", "Codex"]]) {
          const option = node("option", label); option.value = value; choice.append(option);
        }
        const model = node("select", "", "exec-qchoice");
        model.setAttribute("aria-label", "Implementation model");
        model.hidden = true;
        const effort = node("select", "", "exec-qchoice");
        effort.setAttribute("aria-label", "Reasoning effort");
        effort.hidden = true;
        let catalogReady = false;
        const loadModels = async () => {
          const engine = choice.value;
          model.hidden = effort.hidden = engine === "auto";
          if (engine === "auto") { catalogReady = true; go.disabled = false; return; }
          catalogReady = false; go.disabled = true;
          model.replaceChildren(node("option", "Loading models…"));
          try {
            const catalog = await get(`/api/executor/job-models?engine=${encodeURIComponent(engine)}&projectId=${encodeURIComponent(item.projectId)}`);
            if (choice.value !== engine) return;
            if (catalog.source !== "live" || !catalog.models?.length) throw new Error(catalog.message || "Models are unavailable.");
            model.replaceChildren();
            for (const entry of catalog.models) {
              const option = node("option", entry.label); option.value = entry.isDefault ? "" : entry.id;
              option.dataset.efforts = JSON.stringify(entry.effortLevels || []);
              model.append(option);
            }
            const updateEffort = () => {
              const levels = JSON.parse(model.selectedOptions[0]?.dataset.efforts || "[]");
              effort.replaceChildren();
              const standard = node("option", "Provider default effort"); standard.value = ""; effort.append(standard);
              for (const level of levels) { const option = node("option", level); option.value = level; effort.append(option); }
              effort.hidden = !levels.length;
            };
            model.onchange = updateEffort;
            updateEffort();
            catalogReady = true; go.disabled = false;
          } catch (error) {
            model.replaceChildren(node("option", error.message));
          }
        };
        choice.onchange = () => { void loadModels(); };
        const go = node("button", job ? "Go again" : "Go — implement it", "btn btn-primary exec-qopen");
        go.type = "button";
        go.title = "Queue an implement job: a local branch psm/job/<id> in its own clone, with tests and checks, never pushed. You review it here.";
        go.onclick = async () => {
          go.disabled = true;
          go.textContent = "Queuing…";
          try {
            if (!catalogReady) throw new Error("Wait for the provider's models to load.");
            const selection = choice.value === "auto" ? { mode: "auto" } : { mode: "manual", engine: choice.value, model: model.value || null, effort: effort.value || null };
            await send("/api/executor/jobs", { intakeId: item.intakeId, selection });
            lastQueue = "";
            await pollQueue();
          } catch (error) {
            go.disabled = false;
            go.textContent = "Go — implement it";
            row.append(node("div", error.message, "exec-qerror"));
          }
        };
        catalogReady = true;
        row.append(choice, model, effort, go);
      }
    }
    const actions = node("div", "", "exec-qactions");
    if (jobs.some((job) => job.jobId === item.intakeId)) {
      const open = node("button", "See what the executor did", "btn exec-qopen");
      open.type = "button";
      open.onclick = () => {
        setView("activity");
        void select(item.intakeId);
      };
      actions.append(open);
    }
    // Only a task written here can be changed here; a Todo item is changed in Todo.
    if (fromPsm) actions.append(...ownTaskButtons(item, row, text));
    if (actions.childElementCount) row.append(actions);
    return row;
  }

  /** Edit and Withdraw for a task written in PSM. An edit sends it back to triage. */
  function ownTaskButtons(item, row, text) {
    const path = `/api/executor/intake/${encodeURIComponent(item.intakeId)}`;
    const fail = (error) => row.append(node("div", error.message, "exec-qerror"));
    const edit = node("button", "Edit", "btn exec-qopen");
    edit.type = "button";
    edit.title = "Change the wording. The task goes back to triage.";
    edit.onclick = () => {
      editing = item.intakeId; // the queue is not redrawn under an open editor
      const area = node("textarea", "", "exec-qedit");
      area.value = item.text;
      area.maxLength = 20000;
      area.setAttribute("aria-label", "Task text");
      const save = node("button", "Save — triage again", "btn btn-primary exec-qopen");
      const cancel = node("button", "Cancel", "btn exec-qopen");
      save.type = cancel.type = "button";
      const bar = node("div", "", "exec-qactions");
      bar.append(save, cancel);
      text.replaceWith(area, bar);
      edit.disabled = true;
      area.focus();
      const done = () => {
        editing = null;
        lastQueue = "";
        void pollQueue();
      };
      cancel.onclick = done;
      save.onclick = async () => {
        if (!area.value.trim()) return area.focus();
        save.disabled = cancel.disabled = true;
        try {
          await send(path, { text: area.value.trim() }, "PATCH");
          done();
        } catch (error) {
          save.disabled = cancel.disabled = false;
          fail(error);
        }
      };
    };
    const withdraw = node("button", "Withdraw", "btn exec-qopen");
    withdraw.type = "button";
    withdraw.title = "Take this task off the queue";
    let armed = false;
    withdraw.onclick = async () => {
      if (!armed) {
        armed = true;
        withdraw.textContent = "Withdraw — sure?";
        setTimeout(() => { armed = false; withdraw.textContent = "Withdraw"; }, 4000);
        return;
      }
      withdraw.disabled = true;
      try {
        await send(path, undefined, "DELETE");
        if (editing === item.intakeId) editing = null;
        lastQueue = "";
        await pollQueue();
      } catch (error) {
        withdraw.disabled = false;
        fail(error);
      }
    };
    return [edit, withdraw];
  }

  const JOB_LABEL = { queued: "queued", claimed: "implementing now", review: "ready for review", accepted: "merged", rejected: "rejected", stalled: "stalled", failed: "failed", cancelled: "cancelled" };
  let jobByIntake = new Map();
  let lastQueue = "";
  let editing = null; // the intake whose text is being edited in place
  let projectFilter = ""; // a prj_ id, or "" for every project

  async function send(path, body = {}, method = "POST") {
    const response = await ctx.api(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { data });
    return data;
  }

  function jobRow(job, textOf, extra = {}) {
    const row = node("div", "", "exec-qrow");
    const head = node("div", "", "exec-qhead");
    head.append(node("strong", job.projectName || job.projectId));
    if (extra.position) head.append(node("span", `#${extra.position}`, "exec-qpos"));
    head.append(node("span", JOB_LABEL[job.status] || job.status, "exec-qkind"));
    row.append(head, node("div", textOf(job.intakeId) || job.intakeId, "exec-qtext"));
    const meta = [ago(new Date(job.updatedAt || job.createdAt).getTime())];
    if (job.claim) meta.push(job.claim.executorId === extra.me ? "this machine" : `executor ${job.claim.executorId}`, leaseLeft(job.claim.leaseUntil));
    if (job.attempts > 1) meta.push(`attempt ${job.attempts}`);
    if (job.revisions?.length) meta.push(`${job.revisions.length} revision${job.revisions.length === 1 ? "" : "s"}`);
    if (job.result?.model) meta.push(`${job.result.model.engine} ${job.result.model.model || "default"}`);
    else if (job.selection?.mode === "manual") meta.push(`${job.selection.engine} ${job.selection.model || "default"}`);
    else meta.push("Auto model");
    if (job.result) meta.push(`${job.result.commits.length} commit${job.result.commits.length === 1 ? "" : "s"}, +${job.result.diffStat.insertions} −${job.result.diffStat.deletions}`);
    row.append(node("div", meta.join(" · "), "exec-qmeta"));
    if (extra.waiting) row.append(node("div", "Waits: another job is implementing this project (one at a time per repo).", "exec-qnote"));
    if (job.error && ["stalled", "failed", "queued"].includes(job.status)) row.append(node("div", job.error, "exec-qerror"));
    const actions = node("div", "", "exec-qactions");
    if (job.status === "review") {
      if (job.reviewHere) {
        const review = node("button", "Review the change", "btn btn-primary exec-qopen");
        review.type = "button";
        review.onclick = () => openReview(job.jobId);
        actions.append(review);
      } else actions.append(node("span", `The branch is on executor ${job.pinnedExecutor}: review it from that psm.`, "exec-qnote"));
    }
    if (jobs.some((entry) => entry.jobId === job.jobId)) {
      const open = node("button", "What the agent did", "btn exec-qopen");
      open.type = "button";
      open.onclick = () => {
        setView("activity");
        void select(job.jobId);
      };
      actions.append(open);
    }
    if (["queued", "stalled", "failed"].includes(job.status)) {
      const cancel = node("button", "Cancel", "btn exec-qopen");
      cancel.type = "button";
      cancel.onclick = async () => {
        cancel.disabled = true;
        try {
          await send(`/api/executor/jobs/${encodeURIComponent(job.jobId)}/cancel`);
          lastQueue = "";
          await pollQueue();
        } catch (error) {
          cancel.disabled = false;
          row.append(node("div", error.message, "exec-qerror"));
        }
      };
      actions.append(cancel);
    }
    if (actions.childElementCount) row.append(actions);
    return row;
  }

  const DONE_KEY = "psm.executor.doneOpen";
  let doneOpen = (() => { try { return localStorage.getItem(DONE_KEY) === "1"; } catch { return false; } })();

  function renderJobs(root, jobList, items, me) {
    const textOf = (intakeId) => items.find((item) => item.intakeId === intakeId)?.text;
    const sections = [
      { title: "Implementing now", list: jobList.filter((job) => job.status === "claimed") },
      { title: "Queued to implement", list: jobList.filter((job) => job.status === "queued").sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)), queued: true },
      { title: "Ready for review", list: jobList.filter((job) => job.status === "review") },
      { title: "Stalled or failed", list: jobList.filter((job) => job.status === "stalled" || job.status === "failed") },
      { title: "Done recently", list: jobList.filter((job) => ["accepted", "rejected", "cancelled"].includes(job.status)).slice(0, 8), collapsible: true },
    ];
    const busy = new Set(jobList.filter((job) => job.status === "claimed").map((job) => job.projectId));
    for (const section of sections) {
      if (!section.list.length) continue;
      const className = `exec-qsection exec-q-job-${section.title.split(" ")[0].toLowerCase()}`;
      if (section.collapsible) {
        // Finished work stays out of the way: closed unless you opened it.
        const block = node("details", "", `${className} exec-qfold`);
        block.open = doneOpen;
        const summary = node("summary", `${section.title} (${section.list.length})`, "procs-group exec-qfold-head");
        summary.onclick = () => { doneOpen = !block.open; try { localStorage.setItem(DONE_KEY, doneOpen ? "1" : "0"); } catch { /* private window */ } };
        block.append(summary);
        section.list.forEach((job) => block.append(jobRow(job, textOf, { me, position: 0, waiting: false })));
        root.append(block);
        continue;
      }
      const block = node("section", "", className);
      block.append(node("h3", `${section.title} (${section.list.length})`, "procs-group"));
      section.list.forEach((job, index) => block.append(jobRow(job, textOf, { me, position: section.queued ? index + 1 : 0, waiting: section.queued && busy.has(job.projectId) })));
      root.append(block);
    }
  }

  function renderQueue(allItems, executorId, allJobs = []) {
    const root = ctx.queue;
    root.replaceChildren();
    jobByIntake = new Map();
    for (const job of allJobs) if (!jobByIntake.has(job.intakeId)) jobByIntake.set(job.intakeId, job);
    fillProjectFilter(allItems);
    const items = projectFilter ? allItems.filter((item) => item.projectId === projectFilter) : allItems;
    const jobList = projectFilter ? allJobs.filter((job) => job.projectId === projectFilter) : allJobs;
    const groups = new Map(QUEUE_SECTIONS.map((section) => [section.id, []]));
    for (const item of items) {
      // An item with a job under way is shown with its job, not again under its verdict.
      const job = jobByIntake.get(item.intakeId);
      // A merged one is done and listed under "Done recently"; a rejected or cancelled one can Go again.
      if (job && ["queued", "claimed", "review", "accepted"].includes(job.status)) continue;
      groups.get(sectionOf(item))?.push(item);
    }
    // Claim order is oldest first, so that is the order they will be picked up in.
    groups.get("waiting").sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const counts = QUEUE_SECTIONS.map((section) => `${groups.get(section.id).length} ${section.title.split(" —")[0].toLowerCase()}`).filter((text) => !text.startsWith("0 "));
    root.append(node("p", `${counts.join(" · ") || "The queue is empty."}${executorId ? ` · this machine is ${executorId}` : ""}`, "exec-qsummary"));
    for (const section of QUEUE_SECTIONS) {
      const list = groups.get(section.id);
      if (!list.length && !section.empty) continue;
      const block = node("section", "", `exec-qsection exec-q-${section.id}`);
      block.append(node("h3", `${section.title} (${list.length})`, "procs-group"));
      if (section.note && list.length) block.append(node("p", section.note, "exec-qsection-note"));
      if (!list.length) block.append(node("div", section.empty, "procs-empty"));
      list.forEach((item, index) => block.append(queueRow(item, section.id === "waiting" ? index + 1 : 0)));
      root.append(block);
      // Implement jobs follow the triage line.
      if (section.id === "waiting") renderJobs(root, jobList, allItems, executorId);
    }
  }

  async function pollQueue() {
    if (!ctx || view !== "queue") return;
    try {
      const [data, jobData] = await Promise.all([get("/api/executor/queue"), get("/api/executor/jobs").catch(() => ({ jobs: [] }))]);
      ctx.onJobs?.(jobData.jobs || []); // the header's count
      if (view !== "queue" || editing) return; // a review opened meanwhile, or a task is being edited
      // Redraw only on a real change, so a button never moves under the pointer
      // and the scroll position holds. Lease countdowns refresh every 30 s.
      const fingerprint = JSON.stringify([data, jobData, projectFilter, Math.floor(Date.now() / 30000)]);
      if (fingerprint === lastQueue && ctx.queue.childElementCount) return;
      lastQueue = fingerprint;
      renderQueue(data.items || [], data.executorId, jobData.jobs || []);
    } catch (error) {
      ctx.queue.replaceChildren(node("div", error.message || "Could not read the queue.", "procs-empty"));
    }
  }

  /* ---------- Review: the job's change, Accept / Reject / Revise ---------- */

  function diffBlock(text) {
    const pre = node("pre", "", "exec-pre exec-diff");
    for (const line of text.split("\n")) {
      const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : line.startsWith("diff ") ? "file" : "";
      const span = node("span", `${line}\n`, cls ? `exec-d-${cls}` : "");
      pre.append(span);
    }
    return pre;
  }

  async function openReview(jobId) {
    setView("review");
    const root = ctx.queue;
    root.replaceChildren(node("div", "Reading the job's branch…", "procs-empty"));
    let data;
    try {
      data = await get(`/api/executor/jobs/${encodeURIComponent(jobId)}/diff`);
    } catch (error) {
      root.replaceChildren(node("div", error.message, "procs-empty"));
      return;
    }
    if (view !== "review") return;
    const { job, diff, projectCauses = [] } = data;
    root.replaceChildren();
    const back = node("button", "← Queue", "btn exec-qopen");
    back.type = "button";
    back.onclick = () => setView("queue");
    const head = node("div", "", "exec-detail-head");
    const title = node("div");
    title.append(node("h3", `Review ${diff.branch}`), node("div", `${diff.commits.length} commit${diff.commits.length === 1 ? "" : "s"} on top of ${diff.base.slice(0, 8)} · job ${job.jobId}`, "exec-sub"));
    head.append(title, badge("review"));
    root.append(back, head);
    if (job.result?.summary) root.append(bubble("Agent's summary", "exec-from-claude", node("p", job.result.summary)));
    if (job.result?.model) root.append(node("div", `Implemented with ${job.result.model.engine} ${job.result.model.model || "default"}${job.result.model.effort ? ` · ${job.result.model.effort} effort` : ""} · ${job.result.model.reason}`, "exec-facts"));
    if (job.result?.checks?.length) {
      const checks = node("div", "", "exec-checks");
      for (const check of job.result.checks) checks.append(node("span", `${check.ok ? "✓" : "✗"} ${check.name}`, `exec-check${check.ok ? "" : " exec-tfail"}`));
      root.append(node("div", "Checks", "exec-label"), checks);
    }
    root.append(node("div", "Commits", "exec-label"));
    const commits = node("ul", "", "exec-commits");
    for (const commit of diff.commits) commits.append(node("li", `${commit.sha.slice(0, 8)}  ${commit.subject}`));
    root.append(commits, node("div", diff.truncated ? "Changes (cut at 400 KB)" : "Changes", "exec-label"), diffBlock(diff.diff));

    const message = node("div", "", "exec-review-message");
    const actions = node("div", "", "exec-review-actions");
    const accept = node("button", "Accept — merge into your branch", "btn btn-primary");
    const reject = node("button", "Reject", "btn");
    const comment = node("textarea", "", "exec-revise");
    comment.placeholder = "What should change? The job goes back to the queue and continues on the same branch.";
    const revise = node("button", "Revise", "btn");
    for (const b of [accept, reject, revise]) b.type = "button";
    const act = async (button, path, body, done) => {
      for (const b of [accept, reject, revise]) b.disabled = true;
      message.className = "exec-review-message";
      message.textContent = "Working…";
      try {
        const result = await send(path, body);
        message.classList.add("exec-ok-text");
        message.textContent = done(result);
        setTimeout(() => setView("queue"), 1800);
      } catch (error) {
        message.classList.add("exec-qerror");
        message.textContent = error.message;
        for (const b of [accept, reject, revise]) b.disabled = false;
      }
    };
    accept.onclick = () => act(accept, `/api/executor/jobs/${encodeURIComponent(jobId)}/accept`, {}, (r) => `Merged into ${r.merged.into} (${r.merged.mergeCommit.slice(0, 8)}). The job's clone is removed.`);
    // The cause tag: is this a one-off, or will the next job make the same mistake?
    const causeBox = node("div", "", "exec-cause");
    const causeNote = node("input", "", "exec-cause-note");
    causeNote.type = "text";
    causeNote.maxLength = 500;
    causeNote.placeholder = "What in the project? A misleading example, a missing fixture, an unreliable setup…";
    causeNote.hidden = true;
    const causeChoices = node("div", "", "exec-cause-choices");
    for (const [value, label] of [["one-off", "One-off mistake"], ["project", "The project made this easy"]]) {
      const choice = node("label", "", "exec-cause-choice");
      const radio = node("input");
      radio.type = "radio";
      radio.name = "exec-cause";
      radio.value = value;
      radio.onchange = () => { causeNote.hidden = value !== "project"; };
      choice.append(radio, node("span", label));
      causeChoices.append(choice);
    }
    causeBox.append(causeChoices, causeNote);
    if (projectCauses.length) {
      const earlier = node("details", "", "exec-cause-earlier");
      earlier.open = true;
      earlier.append(node("summary", `Earlier project causes here (${projectCauses.length}) — a repeat means fix the project`));
      const list = node("ul");
      for (const cause of projectCauses) list.append(node("li", `${new Date(cause.at).toLocaleDateString()} · ${cause.note}${cause.task ? ` — task: ${cause.task}` : ""}`));
      earlier.append(list);
      causeBox.append(earlier);
    }
    /** The chosen cause, or null after telling the owner what is missing. */
    const chosenCause = (noteFallback = "") => {
      const cause = causeChoices.querySelector("input:checked")?.value;
      const fail = (text) => {
        message.className = "exec-review-message exec-qerror";
        message.textContent = text;
        return null;
      };
      if (!cause) return fail("Say first why it is going back: a one-off, or something in the project.");
      if (cause === "project" && !causeNote.value.trim() && !noteFallback) return fail("Say what in the project made this mistake easy.");
      return { cause, causeNote: causeNote.value.trim() };
    };
    reject.onclick = () => {
      const why = chosenCause();
      if (why) act(reject, `/api/executor/jobs/${encodeURIComponent(jobId)}/reject`, why, () => "Rejected. The job's clone is removed; nothing reached your repo.");
    };
    revise.onclick = () => {
      if (!comment.value.trim()) {
        message.className = "exec-review-message exec-qerror";
        message.textContent = "Say what should change first.";
        return;
      }
      const why = chosenCause(comment.value.trim());
      if (why) act(revise, `/api/executor/jobs/${encodeURIComponent(jobId)}/revise`, { comment: comment.value.trim(), ...why }, () => "Sent back with your comment. It continues on the same branch.");
    };
    actions.append(accept);
    const reviseRow = node("div", "", "exec-revise-row");
    reviseRow.append(comment, revise);
    const rejectRow = node("div", "", "exec-review-actions");
    rejectRow.append(reject);
    root.append(node("div", "Your decision", "exec-label"), actions, node("div", "Or send it back — why?", "exec-label"), causeBox, reviseRow, rejectRow, message);
  }

  /* ---------- Project filter and the new-task composer ---------- */

  /** The projects a task can be written for: scanned here, with a prj_ id. */
  const localProjects = () =>
    (ctx.projects?.() || []).filter((project) => project.id).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  /** Replace a select's options only when they changed, keeping what is chosen. */
  function fillSelect(select, options, value) {
    const signature = JSON.stringify(options);
    if (select.dataset.options !== signature) {
      select.dataset.options = signature;
      select.replaceChildren();
      for (const [id, label] of options) {
        const option = node("option", label);
        option.value = id;
        select.append(option);
      }
    }
    select.value = options.some(([id]) => id === value) ? value : "";
  }

  /** Every project that is local or has something in the queue; a name the hub knows and psm does not shows its id. */
  function fillProjectFilter(items = []) {
    const select = ctx.filter?.select;
    if (!select) return;
    const names = new Map(localProjects().map((project) => [project.id, project.name]));
    for (const item of items) if (!names.has(item.projectId)) names.set(item.projectId, item.projectName || item.projectId);
    if (projectFilter && !names.has(projectFilter)) names.set(projectFilter, projectFilter);
    const options = [...names].sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }));
    fillSelect(select, [["", "All projects"], ...options], projectFilter);
  }

  function fillComposerProjects() {
    const select = ctx.composer?.project;
    if (!select) return;
    fillSelect(select, [["", "Project…"], ...localProjects().map((project) => [project.id, project.name])], select.value || projectFilter);
  }

  function setProjectFilter(id, fromUser = false) {
    projectFilter = id || "";
    fillProjectFilter();
    if (projectFilter && ctx.composer?.project) {
      fillComposerProjects();
      ctx.composer.project.value = localProjects().some((project) => project.id === projectFilter) ? projectFilter : ctx.composer.project.value;
    }
    if (fromUser) ctx.filter?.onChange?.(projectFilter);
    if (view === "queue" && !editing) {
      lastQueue = "";
      void pollQueue();
    }
    if (view === "activity") renderList();
  }

  const MENTION = /(^|\s)@([^\s@]*)$/;
  let attempt = null; // { nonce, signature }: a retry of the same task reuses its nonce

  const newNonce = () => {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  function setupComposer() {
    const composer = ctx.composer;
    if (!composer) return;
    const { form, project, text, suggest, add, note } = composer;
    let matches = [];
    let active = 0;
    const say = (message, bad = false) => {
      note.textContent = message;
      note.classList.toggle("exec-qerror", bad);
    };
    const grow = () => {
      text.style.height = "auto";
      text.style.height = `${Math.min(text.scrollHeight + 2, window.innerHeight * 0.4)}px`;
    };
    const closeSuggest = () => {
      matches = [];
      suggest.hidden = true;
      suggest.replaceChildren();
    };
    /** The "@partial" being typed just before the caret, if any. */
    const mention = () => {
      const before = text.value.slice(0, text.selectionStart);
      const match = before.match(MENTION);
      return match ? { start: before.length - match[2].length - 1, end: before.length, query: match[2].toLowerCase() } : null;
    };
    const pick = (chosen) => {
      const at = mention();
      if (at) {
        // The @token names the project; it is not part of the task, as in Todo.
        const rest = text.value.slice(at.end).replace(/^ /, "");
        text.value = text.value.slice(0, at.start) + rest;
        text.setSelectionRange(at.start, at.start);
      }
      project.value = chosen.id;
      closeSuggest();
      say("");
      grow();
      text.focus();
    };
    const showSuggest = () => {
      const at = mention();
      if (!at) return closeSuggest();
      const all = localProjects();
      matches = [...all.filter((p) => p.name.toLowerCase().startsWith(at.query)), ...all.filter((p) => !p.name.toLowerCase().startsWith(at.query) && p.name.toLowerCase().includes(at.query))].slice(0, 8);
      if (!matches.length) return closeSuggest();
      active = Math.min(active, matches.length - 1);
      suggest.replaceChildren();
      matches.forEach((candidate, index) => {
        const option = node("button", candidate.name, index === active ? "on" : "");
        option.type = "button";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", index === active ? "true" : "false");
        option.onmousedown = (event) => { event.preventDefault(); pick(candidate); };
        suggest.append(option);
      });
      suggest.hidden = false;
    };
    /** "@name" tokens left in the text: the last one that names a project wins, and all such tokens go. */
    const takeTokens = (raw) => {
      const all = localProjects();
      let named = null;
      const cleaned = raw.replace(/(^|\s)@([^\s@]+)/g, (whole, lead, name) => {
        const found = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
        if (!found) return whole;
        named = found;
        return lead;
      });
      return { named, text: cleaned.replace(/[ \t]{2,}/g, " ").trim() };
    };

    text.oninput = () => { active = 0; showSuggest(); grow(); };
    text.onblur = () => setTimeout(closeSuggest, 100);
    text.onkeydown = (event) => {
      if (matches.length) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          active = (active + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
          return showSuggest();
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          return pick(matches[active]);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          return closeSuggest();
        }
      }
      // Enter adds the task; Shift+Enter is a new line.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (add.disabled) return;
      const taken = takeTokens(text.value);
      if (taken.named) project.value = taken.named.id;
      if (!taken.text) return say("Write the task first.", true);
      if (!project.value) return say("Choose a project from the list, or type @ and its name.", true);
      const signature = JSON.stringify([project.value, taken.text]);
      if (attempt?.signature !== signature) attempt = { nonce: newNonce(), signature };
      add.disabled = true;
      say("Adding…");
      try {
        await send("/api/executor/intake", { projectId: project.value, text: taken.text, nonce: attempt.nonce });
        attempt = null;
        text.value = "";
        grow();
        say("Added. It waits for triage, then shows its verdict below.");
        lastQueue = "";
        await pollQueue();
      } catch (error) {
        say(error.message, true);
      } finally {
        add.disabled = false;
      }
    };
    fillComposerProjects();
    say("");
  }

  function setView(next) {
    view = next;
    ctx.activityPane.hidden = next !== "activity";
    ctx.queue.hidden = next !== "queue" && next !== "review";
    if (ctx.composer) ctx.composer.form.hidden = next !== "queue";
    if (ctx.filter?.wrap) ctx.filter.wrap.hidden = next !== "queue" && next !== "activity";
    for (const [name, tab] of Object.entries(ctx.tabs)) {
      const on = name === next || (name === "queue" && next === "review");
      tab.classList.toggle("on", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    }
    clearInterval(queueTimer);
    if (next === "queue") {
      lastQueue = "";
      ctx.queue.replaceChildren(node("div", "Reading the queue from the hub…", "procs-empty"));
      void pollQueue();
      queueTimer = setInterval(() => {
        if (!watching()) return; // hidden tab or closed page: no polling
        fillComposerProjects(); // a rescan may have found a project
        void pollQueue();
      }, 3000);
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
      ctx.tabs.activity.onclick = () => setView("activity");
      ctx.tabs.queue.onclick = () => setView("queue");
      editing = null;
      projectFilter = options.project || "";
      if (ctx.filter?.select) ctx.filter.select.onchange = () => setProjectFilter(ctx.filter.select.value, true);
      setupComposer();
      fillProjectFilter();
      setView(options.view || "queue");
      clearInterval(timer);
      timer = setInterval(() => {
        if (watching()) void poll();
      }, 3000);
      return poll();
    },
    /** Open one job's exchange in Activity (from a job on the Agents page). */
    showJob(jobId) {
      if (!ctx || !jobId) return;
      setView("activity");
      void select(jobId);
    },
    /** Show one project's queue (the route's ?project=), or all of it. */
    setProject(id) {
      if (ctx && (id || "") !== projectFilter) setProjectFilter(id);
    },
    close() {
      clearInterval(timer);
      clearInterval(queueTimer);
      timer = null;
      queueTimer = null;
      editing = null;
    },
  };
})();
