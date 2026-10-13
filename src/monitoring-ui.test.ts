import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
class Element {
 children:Element[]=[];textContent='';className='';attrs:Record<string,string>={};
 constructor(readonly tag:string){}
 append(...nodes:Element[]){this.children.push(...nodes);}
 replaceChildren(...nodes:Element[]){this.children=nodes;}
 setAttribute(k:string,v:string){this.attrs[k]=v;}
}
function dashboard(){
 const context=vm.createContext({window:{},document:{createElement:(tag:string)=>new Element(tag),createElementNS:(_ns:string,tag:string)=>new Element(tag)}});
 vm.runInContext(fs.readFileSync(new URL('../web/monitoring.js',import.meta.url),'utf8'),context);return context.window.PsmMonitoring;
}
function nodes(e:Element):Element[]{return [e,...e.children.flatMap(nodes)];}
test('dashboard shows real measurements, gaps, failed checks and host identity; absent CPU is unavailable',()=>{
 const ui=dashboard();const root=new Element('div');const now=Date.now();const at=Math.floor(now/3600000)*3600000;
 ui.render(root,{watch:{effectiveState:'healthy',observedAt:now,evidence:{observer:'werewolf-alpha',failureDomain:'same-host',history:{checks:[{at,checks:10,healthy:8,degraded:1,down:1,latencyMs:30}],host:[{at,cpuPercent:null,memoryUsedBytes:100,memoryTotalBytes:200,diskUsedBytes:300,diskTotalBytes:400}],hostLatest:{observedAt:now,hostname:'werewolf-alpha',cpuPercent:null,memoryUsedBytes:1073741824,memoryTotalBytes:2147483648,diskUsedBytes:2147483648,diskTotalBytes:4294967296}}}}},24,now);
 const rendered=nodes(root);const text=rendered.map(n=>n.textContent).join(' ');
 assert.match(text,/90.00%/);assert.match(text,/10 recorded checks/);assert.match(text,/1.00 GiB \/ 2.00 GiB/);assert.match(text,/werewolf-alpha/);assert.match(text,/gaps have no observations/);
 assert.equal(rendered.filter(n=>n.tag==='svg').length,5);
 assert.ok(rendered.some(n=>n.tag==='rect'&&n.attrs.class==='mon-point bad'));
 const cpuCard=root.children[0].children[3];assert.equal(cpuCard.children[1].textContent,'Unavailable');
 ui.render(root,{watch:{effectiveState:'unknown'}},168,now);
 assert.match(nodes(root).map(n=>n.textContent).join(' '),/Collecting/);
 assert.equal(nodes(root).filter(n=>n.tag==='circle'||n.tag==='rect').length,0);
});
test('downtime clips incidents to the chosen period and no samples yield no uptime claim',()=>{
 const ui=dashboard();const now=100000,since=50000;
 const result=ui.summarize([],[{opened:0,resolved:60000},{opened:90000,resolved:null},{opened:120000,resolved:null}],since,now);
 assert.equal(result.uptimePercent,null);assert.equal(result.downtimeMs,20000);
});
