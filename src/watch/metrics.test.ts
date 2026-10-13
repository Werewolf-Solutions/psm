import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {cpuCounters,cpuUsage} from './metrics.ts';
import {WatchStore,monitorsFromConfig,type Sample} from './watch.ts';
import {normalizeHistory} from '../server/deploy/adapters/werewolf-watch.ts';
test('CPU uses counter deltas, excludes duplicate guest counters and handles first/reset samples',()=>{
 const a=cpuCounters('cpu 10 0 10 80 0 0 0 0 50 0\ncpu0 1');
 const b=cpuCounters('cpu 30 0 10 160 0 0 0 0 100 0\n');
 assert.equal(a.total,100);assert.equal(cpuUsage(null,a),null);assert.ok(Math.abs(cpuUsage(a,b)!-20)<0.0001);assert.equal(cpuUsage(b,a),null);
 assert.throws(()=>cpuCounters('cpu bad'));
});
test('hourly history aggregates recorded checks and resource samples without inventing missing periods',()=>{
 const db=new DatabaseSync(':memory:');const store=new WatchStore(db);const now=Date.now();const hour=Math.floor(now/3600000)*3600000;
 const m=monitorsFromConfig({monitors:[{id:'todo',url:'https://todo.example/'}]})[0];
 const base:Sample={id:m.id,url:m.url,hostname:'todo.example',observedAt:hour+1,state:'healthy',status:200,durationMs:10,tlsExpiresAt:now+86400000,detail:'ok'};
 try{
 store.record(m,base);store.record(m,{...base,observedAt:hour+2,state:'down',durationMs:30});
 store.recordHost({observedAt:hour+2,hostname:'host',cpuPercent:25,memoryUsedBytes:100,memoryTotalBytes:200,diskUsedBytes:300,diskTotalBytes:400,diskPath:'/srv',load1:1,uptimeSeconds:100});
 const h=store.history(m.id,now) as any;
 assert.equal(h.checks.length,1);assert.equal(h.checks[0].checks,2);assert.equal(h.checks[0].down,1);assert.equal(h.checks[0].latencyMs,20);assert.equal(h.host[0].cpuPercent,25);
 store.database.prepare('INSERT INTO incidents(monitor,opened,resolved,detail) VALUES(?,?,?,?)').run(m.id,now-10000,now-5000,'test incident');
 assert.equal(store.history(m.id,now).incidentTime24hMs,5000);
 const normalized=normalizeHistory({...h,checks:[null,{at:now+1,checks:1},...h.checks]},now) as any;assert.equal(normalized.checks.length,1);assert.equal(normalized.hostLatest.hostname,'host');
 }finally{db.close();}
});
