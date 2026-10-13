import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {monitorsFromConfig, probe, WatchStore, type Sample} from './watch.ts';
import {normalizeWerewolfWatch} from '../server/deploy/adapters/werewolf-watch.ts';
const monitor = monitorsFromConfig({monitors:[{id:'todo',url:'https://todo.example.com/'}]})[0];
const sample = (state:Sample['state'], observedAt:number): Sample => ({id:'todo',url:monitor.url,hostname:'todo.example.com',state,observedAt,status:state==='down'?503:200,durationMs:10,tlsExpiresAt:observedAt+86400000,detail:state});
test('configuration rejects duplicate IDs, non HTTPS, credentials and unsafe intervals',()=>{
  for(const m of [{id:'todo',url:'http://example.com/'},{id:'todo',url:'https://u:p@example.com/'},{id:'todo',url:'https://example.com/?token=a'},{...monitor,intervalSeconds:0}]) assert.throws(()=>monitorsFromConfig({monitors:[m]}));
  assert.throws(()=>monitorsFromConfig({monitors:[monitor,monitor]}));
});
test('incidents confirm failures, survive restart and require confirmed recovery',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watch-store-')); const file=path.join(dir,'watch.db');
 let store=new WatchStore(new DatabaseSync(file)); const now=Date.now();
 try {
 assert.equal(store.record(monitor,sample('healthy',now)).effectiveState,'healthy');
 assert.equal(store.record(monitor,sample('down',now+1000)).effectiveState,'degraded');
 const failed=store.record(monitor,sample('down',now+2000)); assert.equal(failed.effectiveState,'down'); assert.equal((failed.incidents as any[]).length,1);
 store.database.close();store=new WatchStore(new DatabaseSync(file));
 assert.equal(store.observation('todo')!.effectiveState,'down');
 assert.equal(store.record(monitor,sample('healthy',now+3000)).effectiveState,'down');
 const recovered=store.record(monitor,sample('healthy',now+4000)); assert.equal(recovered.effectiveState,'healthy');assert.equal((recovered.incidents as any[])[0].resolved,now+4000);
 }finally{store.database.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('receipts reject mismatched identity, future time and missing TLS; old evidence becomes stale',()=>{
 const now=Date.now(); const def:any={id:'public-web',monitorKey:'todo',hostname:'todo.example.com',maxObservationAgeSeconds:300};
 const receipt={schema:'werewolf.watch/v1',monitorId:'todo',effectiveState:'healthy',...sample('healthy',now),failureDomain:'same-host',incidents:[]};
 assert.equal(normalizeWerewolfWatch(JSON.stringify(receipt),def,now).effectiveState,'healthy');
 assert.equal(normalizeWerewolfWatch(JSON.stringify(receipt),def,now+301000).effectiveState,'stale');
 for(const values of [{monitorId:'other'},{hostname:'other.example.com'},{observedAt:now+6000},{tlsExpiresAt:null},{state:'down'}]) assert.throws(()=>normalizeWerewolfWatch(JSON.stringify({...receipt,...values}),def,now));
});
test('real HTTPS validates TLS, health JSON, status, timeout, response bound and certificate warning',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watch-tls-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key'),' -out'.trim(),path.join(dir,'cert'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const ca=fs.readFileSync(path.join(dir,'cert'),'utf8');
 const server=https.createServer({key:fs.readFileSync(path.join(dir,'key')),cert:ca},(req,res)=>{
  if(req.url==='/timeout')return;
  if(req.url==='/bad')res.statusCode=503;
  res.end(req.url==='/large'?'x'.repeat(66000):req.url==='/html'?'<html>SPA</html>':JSON.stringify({ok:true}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as any).port;
 // localhost resolves to the bound IPv4 listener on this test host.
 const base={...monitor,url:`https://localhost:${port}/`,tlsWarningDays:1,expectJson:{ok:true}};
 try {
 assert.equal((await probe(base)).state,'down'); // untrusted certificate
 assert.equal((await probe(base,{ca})).state,'healthy');
 assert.equal((await probe({...base,tlsWarningDays:14},{ca})).state,'degraded');
 for(const suffix of ['bad','html','large','timeout'])assert.equal((await probe({...base,url:base.url+suffix,timeoutSeconds:1},{ca})).state,'down');
 } finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});}
});
