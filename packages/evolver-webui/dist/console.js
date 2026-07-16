/** 3 栏主控台 HTML(自包含, 无构建步; 轮询 /api/* 渲染). 军杰 §9.5: Triggers｜Timeline｜Inspector. */
export const CONSOLE_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Evolver 控台</title>
<style>
*{box-sizing:border-box}html{height:100%}body{min-height:100%;margin:0;font:13px/1.5 ui-monospace,Menlo,monospace;background:#0d1117;color:#c9d1d9;display:grid;grid-template-rows:auto auto auto auto minmax(320px,1fr);overflow:auto}
header{padding:8px 12px;background:#161b22;border-bottom:1px solid #30363d;display:flex;gap:16px;align-items:center}
header b{color:#58a6ff}.muted{color:#8b949e}
.cols{display:grid;grid-template-columns:1fr 1fr 1.2fr;min-height:320px}
.col{overflow:auto;border-right:1px solid #30363d;padding:8px}
h2{font-size:12px;text-transform:uppercase;color:#8b949e;margin:4px 0 8px;letter-spacing:.05em}
.row{padding:6px 8px;border:1px solid #30363d;border-radius:6px;margin-bottom:6px;cursor:pointer}
.row:hover{border-color:#58a6ff}.tag{display:inline-block;padding:0 6px;border-radius:10px;font-size:11px}
.ok{background:#1a3d1a;color:#6fdd6f}.fail{background:#3d1a1a;color:#ff7b72}.warn{background:#3d3a1a;color:#e3b341}
.act{display:flex;gap:6px;margin-top:8px}button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 8px;cursor:pointer}
button:hover{border-color:#58a6ff}pre{white-space:pre-wrap;word-break:break-all;background:#161b22;padding:8px;border-radius:6px}
.valuecard{padding:10px 14px;background:#11161d;border-bottom:1px solid #30363d;display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.valuecard .big{font-size:18px;color:#6fdd6f;font-weight:600}.valuecard .est{color:#e3b341}.valuecard .lbl{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
#reviewqueue{max-height:156px;overflow:auto;align-items:flex-start}
@media(max-width:760px){body{display:block;overflow:auto}.cols{display:block}.col{border-right:0;border-bottom:1px solid #30363d;min-height:240px}#reviewqueue{max-height:none}}
</style></head><body>
<header><b>EVOLVER</b> <span id="stat" class="muted">…</span><span id="daily" class="muted"></span></header>
<div class="valuecard" id="valuecard"><span class="muted">价值 / value …</span></div>
<div class="valuecard" id="reviewqueue"><span class="muted">review queue …</span></div>
<div class="valuecard" id="retentionbar"><span class="muted">retention health …</span></div>
<div class="cols">
 <div class="col"><h2>Triggers</h2><div id="triggers"></div></div>
 <div class="col"><h2>Now &amp; Timeline</h2><div id="cycles"></div></div>
 <div class="col"><h2>Inspector</h2><div id="inspector" class="muted">选一个 cycle 或事件</div>
   <div class="act"><button onclick="act('observe')">Observe</button><button onclick="act('nudge')">Nudge</button><button onclick="act('intervene')">Intervene</button><button onclick="act('teach')">Teach</button></div>
 </div>
</div>
<script>
let sel=null;
const FRAG=new URLSearchParams(location.hash.slice(1));
const QUERY=new URLSearchParams(location.search);
let STORED='';try{STORED=sessionStorage.getItem('evolver.dashboard.token')||''}catch{}
const TOK=FRAG.get('token')||QUERY.get('token')||STORED;
if(TOK)try{sessionStorage.setItem('evolver.dashboard.token',TOK)}catch{}
if(FRAG.has('token')||QUERY.has('token')){QUERY.delete('token');const q=QUERY.toString();history.replaceState(null,'',location.pathname+(q?'?'+q:''))}
async function j(u,o){o=o||{};o.headers=Object.assign({},o.headers||{});if(TOK)o.headers.authorization='Bearer '+TOK;o.credentials='same-origin';const r=await fetch(u,o);return r.json()}
// XSS guards (#200): server data (gene summaries / event titles / payloads) is built from untrusted material —
// never put it into innerHTML raw. esc() = HTML-text escape (numeric entities) for text positions; q() strips a
// value to the content-addressed id charset for inline-handler string args so a malicious id cannot break the
// attribute/JS string. Every dynamic value below goes through one of these before reaching innerHTML.
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
const q=s=>String(s==null?'':s).replace(/[^a-zA-Z0-9:_.-]/g,'');
const nf=n=>Math.round(Number(n)||0).toLocaleString('en-US');
async function refresh(){
 const s=await j('/api/status');document.getElementById('stat').textContent='events='+s.totalEvents+' cycles='+s.cycles;
 const d=await j('/api/daily-summary');document.getElementById('daily').textContent='今日 '+d.solidified+'✓/'+d.failed+'✗ 触发'+d.triggered;
 const v=await j('/api/value?window=7d');
 const top=(v.topGenes||[]).slice(0,3).map(g=>esc(g.assetId)+' ×'+esc(g.reuses)).join(' · ')||'—';
 document.getElementById('valuecard').innerHTML=
   '<div><div class="lbl">measured saved (7d)</div><span class="big">'+nf(v.totalTokensSaved)+' tokens</span> <span class="muted">$'+(v.totalCostUsd||0).toFixed(4)+'</span></div>'
   +'<div><div class="lbl">estimated</div><span class="est">'+nf(v.estimated&&v.estimated.totalTokensSaved)+' tokens</span> <span class="muted">(tracked separately)</span></div>'
   +'<div><div class="lbl">top reused</div><span class="muted">'+top+'</span></div>';
 const rv=await j('/api/review');const stag=s=>s==='quarantined'?'warn':s==='approved'?'ok':s==='rejected'?'fail':'muted';
 const pend=rv.filter(g=>g.state==='quarantined').length;
 const btns=g=>g.state==='quarantined'?' <button onclick="reviewAct(\\''+q(g.assetId)+'\\',\\'approve\\')">Approve</button><button onclick="reviewAct(\\''+q(g.assetId)+'\\',\\'reject\\')">Reject</button>':'';
 document.getElementById('reviewqueue').innerHTML='<div><div class="lbl">review queue</div><span class="big">'+pend+'</span> <span class="muted">待审 pending</span></div>'
   +rv.slice(0,8).map(g=>'<div><span class="tag '+stag(g.state)+'">'+esc(g.state)+'</span> '+esc(g.geneId)+(g.autoDrafted?' <span class="muted">auto</span>':'')+btns(g)+'</div>').join('');
 const tr=await j('/api/triggers');document.getElementById('triggers').innerHTML=tr.map(t=>'<div class="row"><span class="tag '+(t.triggered?'ok':'warn')+'">'+(t.triggered?'触发':'抑制')+'</span> '+esc(t.patternId)+' <span class="muted">v='+((t.value||0).toFixed?t.value.toFixed(2):esc(t.value))+'</span></div>').join('')||'<div class="muted">无</div>';
 const cs=await j('/api/cycles');document.getElementById('cycles').innerHTML=cs.slice(-30).reverse().map(c=>'<div class="row" onclick="showCycle(\\''+q(c.cycleId)+'\\')"><span class="tag '+(c.finalStage==='solidified'?'ok':c.finalStage==='failed'?'fail':'warn')+'">'+esc(c.finalStage)+'</span> '+esc(c.cycleId)+' <span class="muted">('+esc(c.events)+')</span></div>').join('')||'<div class="muted">无 cycle</div>';
}
async function refreshRetention(){const el=document.getElementById('retentionbar');
 try{const r=await j('/api/retention');if(!r||r.available!==true){el.innerHTML='<span class="muted">retention unavailable</span>';return;}
  const safe=!!(r.rootEvents&&r.rootEvents.archiveRotationSafe&&r.material&&r.material.archiveRotationSafe);
  const gate=safe?'ok':'warn';const warnings=Array.isArray(r.warnings)?r.warnings.length:0;
  el.innerHTML='<div><div class="lbl">retention health</div><span class="tag '+gate+'">'+(safe?'safe':'attention')+'</span> <span class="muted">warnings '+esc(warnings)+'</span></div>'
   +'<div><div class="lbl">root events · '+esc(r.rootEvents.state)+'</div><span class="big">'+esc(nf(r.rootEvents.records))+'</span> <span class="muted">active · '+esc(nf(r.rootEvents.archiveRecords))+' archive · '+esc(nf(r.rootEvents.historyRecords))+' history</span></div>'
   +'<div><div class="lbl">material · '+esc(r.material.state)+'</div><span class="big">'+esc(nf(r.material.records))+'</span> <span class="muted">active · '+esc(nf(r.material.archiveRecords))+' archive · '+esc(nf(r.material.historyRecords))+' history · '+esc(nf(r.material.pending))+' pending · cursor '+esc(r.material.cursor)+'</span></div>';
 }catch{el.innerHTML='<span class="tag warn">retention unavailable</span>'}}
async function showCycle(id){sel=id;const t=await j('/api/cycle?id='+encodeURIComponent(id));
 document.getElementById('inspector').innerHTML='<b>'+esc(id)+'</b>'+t.timeline.map(e=>'<div class="row">#'+esc(e.seq)+' <b>'+esc(e.type)+'</b><br>'+esc(e.title)+(e.why?'<br><span class="muted">why: '+esc(e.why)+'</span>':'')+(e.payload?'<pre>'+esc(JSON.stringify(e.payload,null,1))+'</pre>':'')+'</div>').join('');
}
async function reviewAct(gene,action){const reason=prompt(action+' 理由 reason:');if(reason===null)return;
 try{const r=await j('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({gene,action,reason})});
  if(!r||r.ok!==true){alert('review 失败 failed: '+((r&&r.error)||'unknown'));return;}}
 catch(e){alert('review 失败 failed: '+e);return;}
 refresh();}
async function act(kind){const note=prompt(kind+' 备注:');if(note===null)return;
 await j('/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:kind,title:kind+(sel?(' @'+sel):''),note,cycleId:sel})});refresh();}
refresh();refreshRetention();setInterval(refresh,4000);setInterval(refreshRetention,60000);
</script></body></html>`;