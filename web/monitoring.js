(() => {
  const element=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
  const svg=(tag,attrs={})=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
  const bytes=n=>Number.isFinite(n)?`${(n/1073741824).toFixed(2)} GiB`:'Unavailable';
  const percent=(n,total)=>Number.isFinite(n)&&total>0?100*n/total:null;
  function summarize(points,incidents,since,now) {
    const totals=points.reduce((a,p)=>({checks:a.checks+(p.checks||0),passed:a.passed+(p.healthy||0)+(p.degraded||0),failed:a.failed+(p.down||0)}),{checks:0,passed:0,failed:0});
    const downtimeMs=incidents.reduce((sum,i)=>Number.isFinite(i.opened)?sum+Math.max(0,Math.min(i.resolved??now,now)-Math.max(i.opened,since)):sum,0);
    return {...totals,uptimePercent:totals.checks?100*totals.passed/totals.checks:null,downtimeMs};
  }
  function graph(title,points,value,since,now,{max=100,unit='%',availability=false}={}) {
    const card=element('section','mon-chart');card.append(element('h3','',title));
    const chart=svg('svg',{viewBox:'0 0 720 180',role:'img','aria-label':`${title}; hourly observations. Hover a point for details.`});
    const left=45,right=705,top=12,bottom=142;
    const x=at=>left+(Math.max(since,Math.min(now,at))-since)/(now-since)*(right-left);
    const valid=points.filter(p=>Number.isFinite(value(p)));
    const ceiling=max??Math.max(1,...valid.map(p=>value(p)))*1.1;
    const y=n=>bottom-Math.max(0,Math.min(ceiling,n))/ceiling*(bottom-top);
    for(const level of [0,.5,1]){
      chart.append(svg('line',{x1:left,x2:right,y1:y(ceiling*level),y2:y(ceiling*level),class:'mon-grid'}));
      const label=svg('text',{x:left-5,y:y(ceiling*level)+4,'text-anchor':'end',class:'mon-axis'});label.textContent=`${Math.round(ceiling*level)}${unit}`;chart.append(label);
    }
    let segment=[];
    const flush=()=>{if(segment.length>1)chart.append(svg('polyline',{points:segment.map(p=>`${x(p.at)},${y(value(p))}`).join(' '),class:'mon-line'}));segment=[];};
    for(const p of valid){
      if(segment.length && p.at-segment[segment.length-1].at>3600000)flush();
      segment.push(p);
      const dot=availability?svg('rect',{x:x(p.at),y:y(value(p)),width:Math.max(2,Math.min(22,3600000/(now-since)*(right-left))),height:Math.max(2,bottom-y(value(p))),class:p.degraded?'mon-point warning':'mon-point'}):svg('circle',{cx:x(p.at),cy:y(value(p)),r:3.5,class:'mon-point'});
      const tip=svg('title');tip.textContent=`${new Date(p.at).toLocaleString()}: ${value(p).toFixed(1)}${unit}${availability?` · ${p.checks} checks, ${p.down} failed, ${p.degraded} TLS warnings`:''}`;dot.append(tip);chart.append(dot);
      if(availability && p.down) {
        const failed=svg('rect',{x:x(p.at),y:top,width:Math.max(2,Math.min(22,3600000/(now-since)*(right-left))),height:bottom-top-(bottom-y(value(p))),class:'mon-point bad'});
        const failureTip=svg('title');failureTip.textContent=`${new Date(p.at).toLocaleString()}: ${p.down}/${p.checks} failed checks`;failed.append(failureTip);chart.append(failed);
      }
    }flush();
    for(const [at,anchor] of [[since,'start'],[(since+now)/2,'middle'],[now,'end']]){const label=svg('text',{x:x(at),y:168,'text-anchor':anchor,class:'mon-axis'});label.textContent=new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});chart.append(label);}
    card.append(chart,element('p','mon-note',valid.length?'Hourly observations · hover points for values · gaps have no observations':'No history collected in this period yet.'));return card;
  }
  function render(root,environment,hours=24,now=Date.now()) {
    root.replaceChildren();const watch=environment.watch||{},evidence=watch.evidence||{},history=evidence.history||{};
    const since=now-hours*3600000;
    const checks=(history.checks||[]).filter(p=>p.at>=since&&p.at<=now);
    const host=(history.host||[]).filter(p=>p.at>=since&&p.at<=now);
    const latest=history.hostLatest||{};const incidents=evidence.incidents||[];const stats=summarize(checks,incidents,since,now);
    const incidentTime=hours===168?history.incidentTime7dMs:history.incidentTime24hMs;
    if(Number.isFinite(incidentTime))stats.downtimeMs=incidentTime;
    const metrics=element('div','mon-cards');
    const card=(name,value,detail)=>{const c=element('section','mon-card');const note=element('p','mon-note',detail);if(name==='CPU')note.setAttribute('data-private','');c.append(element('div','dep-card-label',name),element('strong','',value),note);metrics.append(c);};
    card('Public availability',watch.effectiveState||'not-monitored',watch.observedAt?`Last check ${new Date(watch.observedAt).toLocaleString()}`:'No monitoring connection is configured.');
    card('Observed uptime',stats.uptimePercent==null?'Collecting':`${stats.uptimePercent.toFixed(2)}%`,`${stats.checks} recorded checks · ${stats.failed} failed · missing periods excluded`);
    card('Confirmed downtime',`${Math.round(stats.downtimeMs/60000)} min`,'From confirmed incident intervals; short failures are excluded. Intervals can include gaps between checks.');
    const hostFresh=latest.observedAt && now-latest.observedAt<=300000;
    card('CPU',hostFresh&&Number.isFinite(latest.cpuPercent)?`${latest.cpuPercent.toFixed(1)}%`:'Unavailable',`Host ${latest.hostname||evidence.observer||'unknown'} · load ${hostFresh&&latest.load1!=null?latest.load1:'unavailable'}`);
    card('Memory',hostFresh?`${bytes(latest.memoryUsedBytes)} / ${bytes(latest.memoryTotalBytes)}`:'Unavailable','Used excludes available/cache-reclaimable memory.');
    card('Disk used',hostFresh?`${bytes(latest.diskUsedBytes)} / ${bytes(latest.diskTotalBytes)}`:'Unavailable','Filesystem containing /srv · includes all applications on this filesystem.');
    const hostNote=element('p','mon-note',`Resource metrics are for the observer host ${latest.hostname||evidence.observer||'unknown'}. ${evidence.failureDomain==='same-host'?'This is also the application server. Whole-server outage coverage needs an independent observer.':'An independent observer’s resources are not the application server’s resources.'} History begins when collection starts; retained for 7 days.`);hostNote.setAttribute('data-private','');root.append(metrics,hostNote);
    const charts=element('div','mon-charts');
    charts.append(graph('Availability and failed checks',checks,p=>p.checks?100*(p.healthy+p.degraded)/p.checks:null,since,now,{availability:true}),graph('Response time',checks,p=>p.latencyMs,since,now,{max:null,unit:' ms'}),graph('CPU usage',host,p=>p.cpuPercent,since,now),graph('Memory usage',host,p=>percent(p.memoryUsedBytes,p.memoryTotalBytes),since,now),graph('Disk usage',host,p=>percent(p.diskUsedBytes,p.diskTotalBytes),since,now));root.append(charts);
    const list=element('section','mon-incidents');list.append(element('h3','','Incidents'));
    for(const i of incidents){const row=element('div','dep-row');row.append(element('strong','',i.resolved?'Recovered':'Open'),element('span','',`${new Date(i.opened).toLocaleString()} · ${i.detail}${i.resolved?` · recovered ${new Date(i.resolved).toLocaleString()}`:''}`));list.append(row);}
    if(!incidents.length)list.append(element('p','mon-note','No recorded incidents.'));root.append(list);
  }
  window.PsmMonitoring={render,summarize};
})();
