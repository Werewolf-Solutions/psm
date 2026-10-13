import fs from 'node:fs';
import os from 'node:os';
export interface HostMetrics { observedAt:number; hostname:string; cpuPercent:number|null; memoryUsedBytes:number; memoryTotalBytes:number; diskUsedBytes:number; diskTotalBytes:number; diskPath:string; load1:number; uptimeSeconds:number }
export function cpuCounters(text:string): {total:number;idle:number} {
 const values=text.split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);
 if(values.length!==8 || values.some(n=>!Number.isFinite(n)||n<0))throw Error('CPU counters unavailable');
 return {total:values.reduce((a,b)=>a+b,0),idle:values[3]+values[4]};
}
export function cpuUsage(previous:{total:number;idle:number}|null,current:{total:number;idle:number}):number|null {
 if(!previous || current.total<=previous.total || current.idle<previous.idle)return null;
 return Math.max(0,Math.min(100,100*(1-(current.idle-previous.idle)/(current.total-previous.total))));
}
export class HostCollector {
 private previous:{total:number;idle:number}|null=null;
 collect():HostMetrics {
  const counters=cpuCounters(fs.readFileSync('/proc/stat','utf8'));
  const cpuPercent=cpuUsage(this.previous,counters);this.previous=counters;
  const mem=Object.fromEntries([...fs.readFileSync('/proc/meminfo','utf8').matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB/gm)].map(m=>[m[1],Number(m[2])*1024]));
  if(!mem.MemTotal || !Number.isFinite(mem.MemAvailable))throw Error('Memory metrics unavailable');
  const diskPath='/srv';const disk=fs.statfsSync(diskPath);
  return {observedAt:Date.now(),hostname:os.hostname(),cpuPercent,memoryUsedBytes:mem.MemTotal-mem.MemAvailable,memoryTotalBytes:mem.MemTotal,diskUsedBytes:(disk.blocks-disk.bfree)*disk.bsize,diskTotalBytes:disk.blocks*disk.bsize,diskPath,load1:os.loadavg()[0],uptimeSeconds:os.uptime()};
 }
}
