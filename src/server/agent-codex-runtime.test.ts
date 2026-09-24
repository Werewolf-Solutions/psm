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

test("Codex policy disables inherited servers including dotted names and denies native filesystem access", () => {
  const config = codexManagedConfig({ mcp_servers: { "server.with.dots": { command: "evil" } } }, "/tmp/empty");
  assert.deepEqual(config.mcp_servers, { "server.with.dots": { command: "evil", enabled: false } });
  assert.equal(config["features.shell_tool"], false); assert.equal(config.web_search, "disabled");
  assert.deepEqual(config["permissions.psm.filesystem"], { "/": "deny", "/tmp/empty": "read" });
  assert.equal(config.default_permissions, "psm", "app-server 0.156 refuses profiles without a named default");
});
test("A Codex app-server that exits during startup reports its own error line", async () => {
  const abort = new AbortController();
  const database = openDatabase(":memory:"); const store = new AgentPermissionStore(() => database);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-codex-test-"));
  const server = createManagedRepositoryServer({ store, snapshots: [store.snapshot({ id: "prj_test", name: "test", path: root })], protectedRoots: [] }, abort);
  const script = "process.stderr.write('\\u001b[2mnoise\\u001b[0m\\nError: error loading default config after config error: config defines profiles\\nmore\\n'); setTimeout(() => process.exit(1), 50);";
  await assert.rejects(
    runCodexManaged({ server, model: null, message: "hi", context: "", signal: abort, event: () => {}, launch: (_args, cwd) => spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] }) }),
    /stopped before the managed turn completed\. Error: error loading default config after config error: config defines profiles$/,
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
        assert.equal(m.params.permissions,'psm'); assert.equal(m.params.ephemeral,true); assert.equal(m.params.approvalPolicy,'never');
        assert.equal(m.params.config.mcp_servers.untrusted.enabled,false);
        assert.ok(m.params.dynamicTools.some(t=>t.name==='psm_write'));
        assert.deepEqual(m.params.environments,[]); reply(m.id,{thread:{id:'thread'}});
      }else if(m.method==='turn/start'){
        reply(m.id,{}); send({id:100,method:'item/commandExecution/requestApproval',params:{command:'git push'}});
      }else if(m.id===100){
        assert.ok(m.error);send({id:101,method:'item/tool/call',params:{tool:'psm_write',namespace:null,callId:'write',arguments:{project:'prj_test',file:'app.txt',content:'after'}}});
      }else if(m.id===101){
        assert.equal(m.result.success,true);send({id:102,method:'item/tool/call',params:{tool:'psm_write',namespace:null,callId:'grant',arguments:{project:'prj_test',file:'.claude/settings.local.json',content:'grant all'}}});
      }else if(m.id===102){
        assert.equal(m.result.success,false);send({id:103,method:'item/tool/call',params:{tool:'execute_anything',namespace:null,arguments:{}}});
      }else if(m.id===103){
        assert.ok(m.error);send({method:'item/completed',params:{item:{type:'agentMessage',text:'Done'}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});
      }
    });`;
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await runCodexManaged({ server, model: null, context: "test", message: "fix", signal: abort, event: (event) => events.push(event), launch: (_args, cwd) => spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] }) });
  assert.equal(fs.readFileSync(path.join(root, "app.txt"), "utf8"), "after");
  assert.ok(!fs.existsSync(path.join(root, ".claude")));
  assert.match(JSON.stringify(events), /Done/);
});
