import assert from "node:assert/strict";
import test from "node:test";

import { agentId, buildRoster, type RosterInputs } from "./agents.ts";

const NOW = 1_800_000_000_000;

function inputs(change: Partial<RosterInputs> = {}): RosterInputs {
  return {
    machine: "desk",
    executor: { enabled: true, executorId: "exec_mine_1234567890", state: "connected", lastClaimAt: NOW - 60_000, lastError: null, running: ["job_1"], paused: false },
    hub: { target: "local (http://localhost:3001)", reachable: true },
    signedIn: true,
    jobs: [
      { kind: "implement", jobId: "job_1", projectId: "prj_todo", projectName: "todo-app", text: "Embed the feedback widget", state: "implementing", claimedAt: NOW - 30_000, finishedAt: null, error: null },
      { kind: "triage", jobId: "job_0", projectId: "prj_todo", projectName: "todo-app", text: "Old one", state: "triaged", claimedAt: NOW - 90_000, finishedAt: NOW - 80_000, error: null },
    ],
    queue: [
      { intakeId: "i1", projectId: "prj_fh", status: "new", text: "waiting", claim: null },
      { intakeId: "i2", projectId: "prj_fh", status: "claimed", text: "on the VPS", claim: { executorId: "exec_vps_abcdef123456" } },
      { intakeId: "i3", projectId: "prj_todo", status: "claimed", text: "mine", claim: { executorId: "exec_mine_1234567890" } },
    ],
    sessions: [
      { name: "todo-app", role: "agent", project: "todo-app", roomId: null, workspace: false, engine: "claude", model: "opus", actualModel: null, sessionShort: "abcd1234", busy: true, open: true, waiting: false, queueDepth: 2, lastActive: NOW - 5_000, activity: "Working: Edit", folder: "todo-app", extraFolders: ["werewolf-dapp"] },
      { name: "__psm_planning__:planner:feedback-hub", role: "planner", project: "feedback-hub", roomId: null, workspace: false, engine: "codex", model: null, actualModel: null, sessionShort: "—", busy: false, open: false, waiting: true, queueDepth: 0, lastActive: NOW - 10_000, activity: "Waiting for your answer", folder: "feedback-hub", extraFolders: [] },
      { name: "__psm_work__:room1", role: "agent", project: null, roomId: "room1", workspace: false, engine: "claude", model: null, actualModel: null, sessionShort: "—", busy: false, open: false, waiting: false, queueDepth: 0, lastActive: NOW - 20_000, activity: "Idle", folder: "werewolf-dapp", extraFolders: ["todo-app"] },
    ],
    rooms: [{ id: "room1", title: "Hub work", projects: ["werewolf-dapp", "todo-app"] }],
    processes: [
      { name: "werewolf-dapp", kind: "custom:c420af45-7a71-41d7-9448-56611acd3eea", command: "npm run website-agent", folder: "werewolf-dapp", status: "running", exitCode: null, startedAt: NOW - 100_000, port: null },
      { name: "feedback-hub", kind: "run", command: "npm start", folder: "feedback-hub", status: "running", exitCode: null, startedAt: NOW - 200_000, port: 4400 },
      { name: "todo-app", kind: "run", command: "npm run dev", folder: "todo-app", status: "exited", exitCode: 1, startedAt: NOW - 300_000, port: 5200 },
    ],
    mcpClients: [
      { id: "mcpc_1", name: "Claude Code", projects: ["prj_todo"], revokedAt: null, lastUsedAt: NOW - 60_000, recent: [{ tool: "list_projects", at: NOW - 60_000 }] },
      { id: "mcpc_2", name: "Old", projects: "all", revokedAt: NOW - 1, lastUsedAt: null, recent: [] },
    ],
    projects: [
      { name: "todo-app", id: "prj_todo", attachments: [{ capabilityRef: "workspace:werewolf", kind: "mcp" }] },
      { name: "feedback-hub", id: "prj_fh" },
      { name: "werewolf-dapp", id: "prj_dapp", customCommands: [{ id: "c420af45-7a71-41d7-9448-56611acd3eea", name: "Website agent", directory: "werewolf-dapp" }] },
    ],
    now: NOW,
    ...change,
  };
}

test("lists the executor first, with its waiting queue and the jobs it runs as project agents", () => {
  const roster = buildRoster(inputs());
  assert.equal(roster[0].id, "executor");
  assert.equal(roster[0].state, "working");
  assert.equal(roster[0].queue, 2, "one unclaimed item plus one running job");
  assert.match(roster[0].where, /This machine \(desk\)/);

  const todo = roster.find((agent) => agent.id === agentId.project("todo-app"))!;
  assert.equal(todo.name, "todo-app-agent");
  assert.equal(todo.kind, "project-agent");
  assert.equal(todo.state, "working");
  assert.equal(todo.parent, "executor");
  assert.equal(todo.jobId, "job_1", "the running job, not the finished one");
  const sub = roster.find((agent) => agent.id === agentId.sub("job_1"))!;
  assert.equal(sub.parent, todo.id, "the job runs as the project agent's sub-agent");
  assert.match(sub.where, /Docker clone/);
  assert.ok(roster[0].connections.some((link) => link.agentId === agentId.sub("job_1")), "the executor links to the sub-agent it runs");

});

test("shows other executors from the hub's claims, never this one", () => {
  const roster = buildRoster(inputs());
  const remote = roster.filter((agent) => agent.kind === "remote-executor");
  assert.equal(remote.length, 1);
  assert.equal(remote[0].id, "remote:exec_vps_abcdef123456");
  assert.match(remote[0].activity, /feedback-hub/);
  assert.deepEqual(buildRoster(inputs({ queue: null })).filter((agent) => agent.kind === "remote-executor"), [], "no hub answer, no guesses");
});

test("names AI sessions by project and role, with model, folders, room members and attached MCP servers", () => {
  const roster = buildRoster(inputs());
  const todo = roster.find((agent) => agent.id === agentId.session("todo-app"))!;
  assert.equal(todo.name, "todo-app-chat", "-agent is the project agent's name");
  assert.equal(todo.state, "working");
  assert.equal(todo.queue, 2);
  assert.ok(todo.connections.some((link) => link.kind === "model" && /Claude · opus/.test(link.label)));
  assert.ok(todo.connections.some((link) => link.kind === "repo" && link.label === "werewolf-dapp"));
  assert.ok(todo.connections.some((link) => link.kind === "mcp" && link.label === "workspace:werewolf"));
  assert.ok(todo.related.includes(agentId.project("todo-app")), "linked to the project agent on the same project");

  const planner = roster.find((agent) => agent.name === "feedback-hub-planner")!;
  assert.equal(planner.state, "waiting");
  assert.equal(roster.findIndex((agent) => agent.state === "waiting"), 1, "what needs you comes right after the executor");

  const room = roster.find((agent) => agent.name === "Hub work-room-agent")!;
  assert.deepEqual(room.connections.filter((link) => link.kind === "project").map((link) => link.label), ["werewolf-dapp", "todo-app"]);
});

test("processes use their custom command's name, and script agents are told apart", () => {
  const roster = buildRoster(inputs());
  const website = roster.find((agent) => agent.name === "Website agent")!;
  assert.equal(website.agentLike, true);
  assert.equal(website.type, "Script agent");
  assert.equal(website.projectId, "prj_dapp");
  const hub = roster.find((agent) => agent.name === "feedback-hub run")!;
  assert.equal(hub.agentLike, false);
  assert.ok(hub.connections.some((link) => link.kind === "port" && link.label === "localhost:4400"));
  const todo = roster.find((agent) => agent.name === "todo-app run")!;
  assert.equal(todo.state, "error");
});

test("MCP clients: revoked ones are left out, scope shows project names", () => {
  const clients = buildRoster(inputs()).filter((agent) => agent.kind === "mcp-client");
  assert.equal(clients.length, 1);
  assert.equal(clients[0].state, "working", "used in the last five minutes");
  assert.ok(clients[0].connections.some((link) => link.kind === "project" && link.label === "todo-app"));
});

test("an executor that is off or cannot reach the hub says so", () => {
  const off = buildRoster(inputs({ executor: { ...inputs().executor, enabled: false } }))[0];
  assert.equal(off.state, "off");
  const broken = buildRoster(inputs({ executor: { ...inputs().executor, state: "hub-error", lastError: "Sign in with Werewolf" }, jobs: [] }))[0];
  assert.equal(broken.state, "error");
  assert.match(broken.activity, /sign in/);
});

test("lists runbook agents nothing runs yet, off and startable as their unit", () => {
  const roster = buildRoster(inputs({
    scriptAgents: [
      { project: "todo-app", unit: "server/worker", title: "server · worker", command: "npm run worker", folder: "server", summary: "Drains the email queue.", port: null, costs: true },
    ],
  }));
  const worker = roster.find((agent) => agent.id === agentId.process("todo-app", "unit:server/worker"))!;
  assert.equal(worker.state, "off");
  assert.equal(worker.agentLike, true);
  assert.equal(worker.type, "Script agent");
  assert.match(worker.activity, /Not running\. Drains the email queue\./);
  assert.deepEqual(worker.control, { project: "todo-app", unit: "server/worker", running: false, costs: true });
  assert.equal(worker.projectId, "prj_todo");
});

test("a runbook agent that runs shows once, as its process, with a stop control", () => {
  const roster = buildRoster(inputs({
    processes: [
      ...inputs().processes,
      { name: "todo-app", kind: "unit:server/worker", command: "npm run worker", folder: "server", status: "running", exitCode: null, startedAt: NOW - 1_000, port: null },
    ],
    scriptAgents: [
      { project: "todo-app", unit: "server/worker", title: "server · worker", command: "npm run worker", folder: "server", summary: null, port: null, costs: false },
      // Started as a custom command with the same command and folder: no second row.
      // Its script lives in server/; the root script only delegates there.
      { project: "werewolf-dapp", unit: "server/website-agent", title: "server · website-agent", command: "npm run website-agent", folder: "server", summary: null, port: null, costs: false, aliases: [{ command: "npm run website-agent", folder: "werewolf-dapp" }] },
    ],
  }));
  const workers = roster.filter((agent) => agent.project === "todo-app" && agent.name.includes("worker"));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].state, "working");
  assert.deepEqual(workers[0].control, { project: "todo-app", unit: "server/worker", running: true });

  const website = roster.filter((agent) => agent.project === "werewolf-dapp" && agent.group === "process");
  assert.equal(website.length, 1, "the custom command stands for the runbook agent");
  assert.equal(website[0].agentLike, true);
  assert.deepEqual(website[0].control, { project: "werewolf-dapp", kind: "custom:c420af45-7a71-41d7-9448-56611acd3eea", running: true });

  const feedback = roster.find((agent) => agent.id === agentId.process("feedback-hub", "run"))!;
  assert.deepEqual(feedback.control, { project: "feedback-hub", kind: "run", running: true });
});

test("every project gets a project agent that idles until the executor calls it", () => {
  const roster = buildRoster(inputs({
    projects: [...inputs().projects, { name: "no-id-yet" }],
    jobs: [{ kind: "triage", jobId: "job_9", projectId: "prj_fh", projectName: "feedback-hub", text: "Add  dark\nmode", state: "triaged", claimedAt: NOW - 90_000, finishedAt: NOW - 80_000, error: null }],
  }));
  const agents = roster.filter((agent) => agent.kind === "project-agent");
  assert.deepEqual(agents.map((agent) => agent.name).sort(), ["feedback-hub-agent", "no-id-yet-agent", "todo-app-agent", "werewolf-dapp-agent"]);
  const fh = agents.find((agent) => agent.project === "feedback-hub")!;
  assert.equal(fh.state, "idle");
  assert.match(fh.activity, /^Idle\. Last task \(triage, triaged\): Add dark mode/);
  assert.equal(fh.since, NOW - 80_000);
  assert.equal(fh.jobId, "job_9");
  assert.equal(agents.find((agent) => agent.project === "todo-app")!.activity, "Idle. The executor calls it when a task for this project arrives.");
  assert.equal(agents.find((agent) => agent.project === "no-id-yet")!.state, "off");

  const off = buildRoster(inputs({ jobs: [], executor: { ...inputs().executor, enabled: false } }));
  assert.ok(off.filter((agent) => agent.kind === "project-agent").every((agent) => agent.state === "off"), "nothing calls them while the executor is off");
});

test("a project agent spawns a sub-agent per job: running side by side, queued behind an overlap, in review", () => {
  const roster = buildRoster(inputs({
    jobs: [
      { kind: "implement", jobId: "job_aaaaaa111111111111111111", projectId: "prj_todo", projectName: "todo-app", text: "Search the registry", state: "implementing", claimedAt: NOW - 20_000, finishedAt: null, error: null },
      { kind: "implement", jobId: "job_bbbbbb222222222222222222", projectId: "prj_todo", projectName: "todo-app", text: "Filter strategies", state: "preparing", claimedAt: NOW - 10_000, finishedAt: null, error: null },
    ],
    queue: [
      { intakeId: "int_c", projectId: "prj_todo", status: "triaged", text: "Also search by type", claim: null },
      { intakeId: "int_d", projectId: "prj_todo", status: "triaged", text: "Health check", claim: null },
    ],
    hubJobs: [
      { jobId: "job_aaaaaa111111111111111111", intakeId: "int_a", projectId: "prj_todo", status: "claimed", createdAt: new Date(NOW - 30_000).toISOString(), updatedAt: new Date(NOW).toISOString() },
      { jobId: "job_cccccc333333333333333333", intakeId: "int_c", projectId: "prj_todo", status: "queued", createdAt: new Date(NOW - 5_000).toISOString(), updatedAt: new Date(NOW).toISOString(), waitingFor: [{ jobId: "job_aaaaaa111111111111111111", status: "claimed", paths: ["routes/registry.js"] }] },
      { jobId: "job_dddddd444444444444444444", intakeId: "int_d", projectId: "prj_todo", status: "review", createdAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW - 1_000).toISOString() },
    ],
  }));
  const parent = roster.find((agent) => agent.id === agentId.project("todo-app"))!;
  assert.equal(parent.state, "working");
  assert.equal(parent.type, "Project agent · 2 in parallel");
  assert.equal(parent.queue, 1);
  const subs = roster.filter((agent) => agent.kind === "sub-agent" && agent.project === "todo-app");
  assert.deepEqual(subs.map((sub) => [sub.name, sub.state]).sort(), [
    ["sub-agent aaaaaa", "working"], ["sub-agent bbbbbb", "working"], ["sub-agent cccccc", "idle"], ["sub-agent dddddd", "waiting"],
  ]);
  assert.ok(subs.every((sub) => sub.parent === parent.id));
  const queued = subs.find((sub) => sub.name === "sub-agent cccccc")!;
  assert.match(queued.activity, /^Waits for sub-agent aaaaaa \(working; routes\/registry\.js\): Also search by type/);
  assert.ok(queued.connections.some((link) => link.agentId === agentId.sub("job_aaaaaa111111111111111111")));
  assert.ok(roster[0].connections.some((link) => link.agentId === agentId.sub("job_bbbbbb222222222222222222")), "the executor links to the sub-agents it runs");
});

test("a queued sub-agent whose ticket builds on an unmerged one waits on you and names it", () => {
  const roster = buildRoster(inputs({
    queue: [{ intakeId: "int_e", projectId: "prj_todo", status: "triaged", text: "Drag the grid edges", claim: null }],
    hubJobs: [
      { jobId: "job_dddddd444444444444444444", intakeId: "int_d", projectId: "prj_todo", status: "review", createdAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW - 1_000).toISOString() },
      { jobId: "job_eeeeee555555555555555555", intakeId: "int_e", projectId: "prj_todo", status: "queued", createdAt: new Date(NOW - 5_000).toISOString(), updatedAt: new Date(NOW).toISOString(), note: "Resumed: old note.",
        needs: [{ intakeId: "int_d", title: "grid lab 2: Live preview.", jobId: "job_dddddd444444444444444444", status: "review" }] },
    ],
  }));
  const queued = roster.find((agent) => agent.name === "sub-agent eeeeee")!;
  assert.equal(queued.state, "waiting");
  assert.match(queued.activity, /^Waiting for another ticket to be merged first: "grid lab 2: Live preview\." \(job_dddddd444444444444444444, ready for review: Accept it\)\. Drag the grid edges/);
  assert.ok(queued.connections.some((link) => link.agentId === agentId.sub("job_dddddd444444444444444444") && /must be merged first/.test(link.detail ?? "")));
});
