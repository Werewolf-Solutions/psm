import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { createManagedRepositoryServer } from "./agent-permission-runtime.ts";
import { codexManagedConfig, runCodexManaged } from "./agent-codex-runtime.ts";
import { openDatabase } from "./db.ts";
import { ManagedResumeUnavailableError } from "./agent-session-errors.ts";

test("Codex policy disables inherited servers including dotted names and denies native filesystem access", () => {
  const config = codexManagedConfig({ mcp_servers: { "server.with.dots": { command: "evil" } } }, "/tmp/empty");
  assert.deepEqual(config.mcp_servers, { "server.with.dots": { command: "evil", enabled: false } });
  assert.equal(config["features.shell_tool"], false); assert.equal(config.web_search, "disabled");
  assert.equal(config["features.code_mode"], false);
  assert.equal(config["features.code_mode_host"], true);
  assert.deepEqual(config["permissions.psm.filesystem"], { "/": "deny", "/tmp/empty": "read" });
  assert.equal(config.default_permissions, "psm", "app-server 0.156 refuses profiles without a named default");
});
test("A Codex app-server that exits during startup reports its own error line", async (t) => {
  const abort = new AbortController();
  const database = openDatabase(":memory:"); const store = new AgentPermissionStore(() => database);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-codex-test-"));
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const server = createManagedRepositoryServer({ store, snapshots: [store.snapshot({ id: "prj_test", name: "test", path: root })], protectedRoots: [] }, abort);
  const script = "process.stderr.write('\\u001b[2mnoise\\u001b[0m\\nError: error loading default config after config error: config defines profiles\\nmore\\n'); setTimeout(() => process.exit(1), 50);";
  await assert.rejects(
    runCodexManaged({ server, model: null, message: "hi", context: "", signal: abort, event: () => {}, launch: (_args, cwd) => spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] }) }),
    /stopped before the managed turn completed\. Error: error loading default config after config error: config defines profiles$/,
  );
});

function continuityFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-codex-continuity-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_continuity", name: "continuity", path: root };
  store.change(project, "repo.read", true, 0, "operator");
  fs.writeFileSync(path.join(root, "app.txt"), "the retained fact");
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const directories: string[] = [];
  const starts: any[] = [];
  const threadFile = path.join(root, "thread-fixture.json");
  const run = async (resume?: { id: string; digest: string }, options: { failure?: string; status?: string; revoke?: boolean } = {}) => {
    const signal = new AbortController();
    const server = createManagedRepositoryServer({ store, snapshots: [store.snapshot(project)], protectedRoots: [] }, signal);
    if (options.revoke) store.change(project, "repo.read", false, store.snapshot(project).revision, "operator");
    const events: any[] = [];
    const script = `
      const fs=require('fs'),assert=require('assert/strict'),readline=require('readline');
      const saved=${JSON.stringify(threadFile)},resuming=${Boolean(resume)},failure=${JSON.stringify(options.failure ?? null)},status=${JSON.stringify(options.status ?? "completed")};
      const send=m=>process.stdout.write(JSON.stringify(m)+'\\n'),reply=(id,result)=>send({id,result});
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='initialize') reply(m.id,{});
        if(m.method==='config/read') reply(m.id,{config:{mcp_servers:{untrusted:{command:'no'}}}});
        if(m.method==='thread/start'||m.method==='thread/resume'){
          assert.equal(m.method,resuming?'thread/resume':'thread/start');
          assert.equal(m.params.approvalPolicy,'never');assert.equal(m.params.permissions,'psm');
          assert.equal(m.params.config.mcp_servers.untrusted.enabled,false);
          assert.equal(m.params.config.web_search,'disabled');
          assert.deepEqual(m.params.runtimeWorkspaceRoots,[process.cwd()]);
          assert.deepEqual(m.params.config['permissions.psm.filesystem'],{'/':'deny',[process.cwd()]:'read'});
          if(resuming){
            assert.equal(m.params.threadId,'managed-thread');
            assert.equal(m.params.dynamicTools,undefined);assert.equal(m.params.environments,undefined);assert.equal(m.params.selectedCapabilityRoots,undefined);
            assert.notEqual(JSON.parse(fs.readFileSync(saved)).cwd,process.cwd());
            assert.equal(m.params.model,'chosen-model');assert.equal(m.params.developerInstructions,'current instructions');
          }else{
            assert.equal(m.params.ephemeral,false);assert.deepEqual(m.params.environments,[]);
            assert.ok(m.params.dynamicTools.some(t=>t.name==='psm_read'));fs.writeFileSync(saved,JSON.stringify({cwd:process.cwd()}));
          }
          if(failure)send({id:m.id,error:{code:-32600,message:failure}});
          else reply(m.id,{thread:{id:'managed-thread'},model:'chosen-model'});
        }
        if(m.method==='turn/start'){
          assert.equal(m.params.effort,'high');assert.deepEqual(m.params.environments,[]);
          reply(m.id,{turn:{id:'current-turn'}});
          send({method:'item/completed',params:{threadId:'foreign-thread',turnId:'current-turn',item:{type:'agentMessage',text:'FOREIGN'}}});
          send({method:'turn/completed',params:{threadId:'managed-thread',turn:{id:'old-turn',status:'completed'}}});
          send({id:100,method:'item/tool/call',params:{threadId:'foreign-thread',turnId:'current-turn',namespace:null,tool:'psm_read',callId:'foreign',arguments:{project:'prj_continuity',file:'app.txt'}}});
        }
        if(m.id===100){assert.ok(m.error);send({id:101,method:'item/tool/call',params:{threadId:'managed-thread',turnId:'old-turn',namespace:null,tool:'psm_read',callId:'old',arguments:{project:'prj_continuity',file:'app.txt'}}});}
        if(m.id===101){assert.ok(m.error);send({id:102,method:'item/tool/call',params:{threadId:'managed-thread',turnId:'current-turn',namespace:null,tool:'psm_read',callId:'current',arguments:{project:'prj_continuity',file:'app.txt'}}});}
        if(m.id===102){
          assert.equal(m.result.success,${!options.revoke});
          assert.ok(JSON.stringify(m.result.contentItems).includes(${JSON.stringify(options.revoke ? "permissions changed" : "the retained fact")}));
          send({method:'item/completed',params:{threadId:'managed-thread',turnId:'current-turn',item:{type:'agentMessage',text:'CURRENT'}}});
          send({method:'turn/completed',params:{threadId:'managed-thread',turn:{id:'current-turn',status}}});
        }
      });`;
    await runCodexManaged({ server, model: "chosen-model", effort: "high", message: "continue", context: "current instructions", signal,
      resume: resume?.id, resumeToolsDigest: resume?.digest, event: (event) => events.push(event),
      launch: (args, cwd) => { directories.push(cwd); starts.push(args); return spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] }); },
    });
    const init = events.find((event) => event.type === "system" && event.subtype === "init");
    assert.match(init.psm_tools_digest, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(events).includes("FOREIGN"));
    assert.ok(JSON.stringify(events).includes("CURRENT"));
    return { id: init.session_id as string, digest: init.psm_tools_digest as string };
  };
  return { run, directories, starts };
}

test("Codex resumes the same managed thread in a new process and routes only its current turn to the new broker", async (t) => {
  const fixture = continuityFixture(t);
  const first = await fixture.run();
  assert.deepEqual(await fixture.run(first), first);
  assert.equal(fixture.starts.length, 2);
  assert.notEqual(fixture.directories[0], fixture.directories[1]);
  assert.ok(fixture.directories.every((directory) => !fs.existsSync(directory)), "remove each native workspace after the turn");
  await fixture.run(first, { revoke: true });
});

test("missing stored Codex threads and changed tool catalogs allow fallback only before a new turn", async (t) => {
  const fixture = continuityFixture(t);
  const first = await fixture.run();
  await assert.rejects(fixture.run(first, { failure: "no rollout found for thread id managed-thread" }), ManagedResumeUnavailableError);
  await assert.rejects(fixture.run({ ...first, digest: "old-catalog" }), ManagedResumeUnavailableError);
  await assert.rejects(fixture.run(first, { failure: "authentication failed" }), (error: unknown) => error instanceof Error && !(error instanceof ManagedResumeUnavailableError) && /authentication failed/.test(error.message));
});

test("failed and interrupted Codex turns do not report success or become resume fallback errors", async (t) => {
  const fixture = continuityFixture(t);
  const first = await fixture.run();
  for (const status of ["failed", "interrupted"]) {
    await assert.rejects(fixture.run(first, { status }), (error: unknown) => error instanceof Error && !(error instanceof ManagedResumeUnavailableError) && error.message === `Codex turn ${status}.`);
  }
});
test("A missing Codex executable reports the PATH problem", async (t) => {
  const abort = new AbortController();
  const database = openDatabase(":memory:"); const store = new AgentPermissionStore(() => database);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-codex-test-"));
  const server = createManagedRepositoryServer({ store, snapshots: [store.snapshot({ id: "prj_test", name: "test", path: root })], protectedRoots: [] }, abort);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(
    runCodexManaged({ server, model: null, message: "hi", context: "", signal: abort, event: () => {}, launch: (_args, cwd) => spawn("/does-not-exist-psm-codex", [], { cwd, stdio: ["pipe", "pipe", "pipe"] }) }),
    /Could not start Codex \(ENOENT\)\. Check the PSM process PATH\./,
  );
});
test("Codex dynamic tools use the shared broker and deny approval requests and self-grants", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-codex-test-"));
  const database = openDatabase(":memory:"); const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_test", name: "test", path: root };
  store.change(project, "repo.read", true, 0, "operator"); store.change(project, "repo.edit", true, 1, "operator");
  fs.writeFileSync(path.join(root, "app.txt"), "before");
  const abort = new AbortController();
  const server = createManagedRepositoryServer({ store, snapshots: [store.snapshot(project)], protectedRoots: [] }, abort);
  const events: unknown[] = [];
  const script = `
    const readline=require('readline'),assert=require('assert/strict');
    const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
    const reply=(id,result)=>send({id,result});
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize') reply(m.id,{});
      else if(m.method==='config/read') reply(m.id,{config:{mcp_servers:{untrusted:{command:'must-not-run'}}}});
      else if(m.method==='thread/start'){
        assert.equal(m.params.permissions,'psm'); assert.equal(m.params.ephemeral,false); assert.equal(m.params.approvalPolicy,'never');
        assert.equal(m.params.config.mcp_servers.untrusted.enabled,false);
        assert.ok(m.params.dynamicTools.some(t=>t.name==='psm_write'));
        assert.deepEqual(m.params.environments,[]); reply(m.id,{thread:{id:'thread'}});
      }else if(m.method==='turn/start'){
        reply(m.id,{turn:{id:'turn'}}); send({id:100,method:'item/commandExecution/requestApproval',params:{command:'git push'}});
      }else if(m.id===100){
        assert.ok(m.error);send({id:101,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',tool:'psm_write',namespace:null,callId:'write',arguments:{project:'prj_test',file:'app.txt',content:'after'}}});
      }else if(m.id===101){
        assert.equal(m.result.success,true);send({id:102,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',tool:'psm_write',namespace:null,callId:'grant',arguments:{project:'prj_test',file:'.claude/settings.local.json',content:'grant all'}}});
      }else if(m.id===102){
        assert.equal(m.result.success,false);send({id:103,method:'item/tool/call',params:{tool:'execute_anything',namespace:null,arguments:{}}});
      }else if(m.id===103){
        assert.ok(m.error);send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',text:'Done'}}});send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
      }
    });`;
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await runCodexManaged({ server, model: null, context: "test", message: "fix", signal: abort, event: (event) => events.push(event), launch: (_args, cwd) => spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] }) });
  assert.equal(fs.readFileSync(path.join(root, "app.txt"), "utf8"), "after");
  assert.ok(!fs.existsSync(path.join(root, ".claude")));
  assert.match(JSON.stringify(events), /Done/);
});
