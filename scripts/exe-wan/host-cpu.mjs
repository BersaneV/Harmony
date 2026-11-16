// Diagnostic only: counters for the disposable VM, never a media acceptance gate.
export function summarizeHostCpu(samples){
 const rows=samples.map(s=>s?.host_cpu),bad=reason=>({status:'NOT_VERIFIED',reason});
 if(rows.length<2||rows.some(r=>!r))return bad('At least two host counter samples required');
 const first=rows[0],last=rows.at(-1),count=first.cores?.length;
 if(!Array.isArray(first.cores)||!count||rows.some((r,i)=>r.platform!=='win32'||!Array.isArray(r.cores)||r.cores.length!==count||!Number.isFinite(r.at_ms)||r.at_ms<0||(i&&r.at_ms<=rows[i-1].at_ms)))return bad('Stable cores and monotonic wall clock required');
 const keys=['user','nice','sys','idle','irq'];
 for(let i=0;i<rows.length;i++)for(let core=0;core<count;core++)for(const k of keys){const v=rows[i].cores[core]?.[k];if(!Number.isFinite(v)||v<0||(i&&v<rows[i-1].cores[core][k]))return bad('Missing or nonmonotonic CPU counters');}
 // libuv Windows sys=(KernelTime-IdleTime), which already includes IRQ.
 // Validate irq above but never add it to sys a second time.
 const accounting=['user','nice','sys','idle'];
 const cores=first.cores.map((a,i)=>{const b=last.cores[i],total=accounting.reduce((n,k)=>n+b[k]-a[k],0),idle=b.idle-a.idle;return{total_ms:total,busy_ms:total-idle,busy_fraction:total>0?(total-idle)/total:null}});
 if(cores.some(c=>c.total_ms<=0))return bad('Every core needs positive elapsed counter time');
 const total=cores.reduce((n,c)=>n+c.total_ms,0),busy=cores.reduce((n,c)=>n+c.busy_ms,0);
 return{status:'OBSERVED',scope:'Entire owned disposable Windows VM including fixture, app, observer and encoding; IRQ already included in sys, not process or encoder CPU attribution',duration_seconds:(last.at_ms-first.at_ms)/1000,samples:rows.length,logical_cores:count,busy_fraction:busy/total,busy_core_equivalent:count*busy/total,per_core:cores};
}
