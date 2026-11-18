'use strict';
const $ = id => document.getElementById(id);
const model=StudioModel, colors=['#008470','#507cc5','#b36a20','#9771b5'];
const cloneDefaults=()=>({...model.defaults,weights:[...model.defaults.weights]});
const cfg=cloneDefaults();
let reference=[],source=null, windows=[], result={points:[],clips:[]}, selected=0, sourceKind='demo';
let backend=false, busy=false, recalculating=false, stopped=false, activeTab='url';
let sourceSerial=0, worker=null, localData=null, wordTimer;
const presets={balanced:[40,30,25,5],burst:[65,20,12,3],reaction:[20,25,50,5]};
const fmt=n=>Number(n).toLocaleString('zh-TW');
const clock=t=>{let n=Math.max(0,Math.floor(t)); return (n>=3600?Math.floor(n/3600)+':':'')+String(Math.floor(n/60)%60).padStart(2,'0')+':'+String(n%60).padStart(2,'0');};
const el=(type,cls,text)=>{const n=document.createElement(type);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
function status(message,error=false){const node=$('sourceState');node.textContent=message;node.hidden=!message;node.classList.toggle('error',error);}
function locks(){
  const blocked=busy||recalculating||stopped;
  $('load').disabled=blocked||!backend;$('file').disabled=blocked;$('demoBtn').disabled=blocked;
  $('export').disabled=blocked||!source;
  $('quit').disabled=blocked;
  $('connectBtn').disabled=blocked||backend;
  document.querySelectorAll('.params input,.params textarea,.params select,.params button').forEach(n=>n.disabled=busy||stopped);
  document.querySelectorAll('[data-download]').forEach(n=>n.disabled=blocked||!backend);
}
function tab(name){
  activeTab=name;
  for(const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed',String(b.dataset.tab===name));
  for(const [key,pane] of Object.entries({url:'urlPane',file:'filePane',demo:'demoPane'})) $(pane).hidden=name!==key;
  if(!busy&&!recalculating){
    status(name==='url'&&!backend?'請先連接雲端後端，或選擇匯入本機聊天室。':'');
  }
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
function slider(parent,id,label,min,max,value,suffix,change,color) {
  const wrap=el('div','slider'),head=el('div','slider-head'),lab=el('label','',label);
  lab.htmlFor=id;
  if(color){const dot=el('i','dot');dot.style.background=color;lab.prepend(dot);}
  const output=el('output');output.setAttribute('for',id);output.id=id+'Out';output.textContent=value+suffix;
  const input=el('input');Object.assign(input,{type:'range',id,min,max,value});
  input.oninput=()=>{output.textContent=input.value+suffix;change(Number(input.value));};
  head.append(lab,output);wrap.append(head,input);$(parent).append(wrap);
}
model.labels.forEach((label,i)=>slider('weights','w'+i,label,0,100,cfg.weights[i],'',v=>{
  cfg.weights[i]=v;$('preset').value='custom';rerank();
},colors[i]));
slider('cutoff','threshold','入選門檻',0,100,cfg.threshold,' 分',v=>{cfg.threshold=v;rerank();});
for(const [key,label,min,max,unit] of [['top','最多片段',1,20,' 段'],['before','往前保留',0,90,' 秒'],['after','往後保留',0,90,' 秒']])
  slider('limits',key,label,min,max,cfg[key],unit,v=>{cfg[key]=v;rerank();});
function syncControls(){
  cfg.weights.forEach((v,i)=>{$('w'+i).value=v;$('w'+i+'Out').textContent=v;});
  for(const [key,unit] of [['threshold',' 分'],['top',' 段'],['before',' 秒'],['after',' 秒']]){
    $(key).value=cfg[key];$(key+'Out').textContent=cfg[key]+unit;
  }
  $('window').value=cfg.window;$('words').value=cfg.words;
}
$('preset').onchange=()=>{cfg.weights=[...presets[$('preset').value]];syncControls();rerank();};
$('reset').onclick=()=>{clearTimeout(wordTimer);Object.assign(cfg,cloneDefaults());$('preset').value='balanced';syncControls();compute({kind:'features'});};
$('window').onchange=()=>{cfg.window=Number($('window').value);compute({kind:'features'});};
$('words').oninput=()=>{cfg.words=$('words').value;clearTimeout(wordTimer);recalculating=true;locks();wordTimer=setTimeout(()=>compute({kind:'features'}),220);};
syncControls();
function accepted(payload){
  if(payload.serial!==sourceSerial)return;
  busy=false;recalculating=false;
  if(payload.error){status(payload.error,true);locks();return;}
  source=payload.meta;windows=payload.windows;
  reference=windows.map(x=>x.signals.reduce((sum,value,i)=>sum+value*model.defaults.weights[i],0));
  if(payload.kind!=='features'){sourceKind=payload.kind==='demo'?'demo':payload.sourceKind;selected=-1;}
  $('title').textContent=source.title;$('messages').textContent=fmt(source.count);
  $('sourceTag').textContent={demo:'示範資料',file:'匯入檔案',url:'YouTube 重播'}[sourceKind];
  if(payload.kind!=='features')status(source.skipped?'已略過 '+fmt(source.skipped)+' 筆無效紀錄。':'');
  rerank();locks();
}
const pending=new Map();
if(location.protocol!=='file:' && typeof Worker!=='undefined'){
  worker=new Worker('worker.js');
  worker.onmessage=e=>{const extra=pending.get(e.data.serial);pending.delete(e.data.serial);if(extra)accepted({...extra,...e.data});};
  worker.onerror=()=>{busy=false;recalculating=false;worker.terminate();worker=null;pending.clear();locks();status('分析程序未能啟動，請重新載入資料。',true);};
}
function compute(task){
  if(task.kind==='features'&&!source)return;
  const serial=++sourceSerial;recalculating=true;locks();
  const meta={kind:task.kind,sourceKind:task.sourceKind};
  if(worker){pending.set(serial,meta);worker.postMessage({...task,cfg,serial});return;}
  setTimeout(()=>{
    try{
      if(task.kind==='demo')localData=model.demo();
      if(task.kind==='source')localData=model.parseChat(task.raw,task.meta);
      const {rows,...info}=localData;
      accepted({...meta,serial,meta:{...info,count:rows.length},windows:model.features(localData,cfg)});
    }catch(e){accepted({...meta,serial,error:e.message});}
  },0);
}
function rerank(){
  if(!source)return;
  result=model.rank(windows,cfg,source.duration);
  if(selected<0||selected>=windows.length) selected=result.clips.length?windows.findIndex(x=>x.start===result.clips[0].point.start):result.points.reduce((best,x,i,a)=>x.score>a[best].score?i:best,0);
  $('clipCount').textContent=result.clips.length;
  $('peak').textContent=result.points.reduce((best,x)=>Math.max(best,x.score),0).toFixed(1);
  $('weightHint').textContent=cfg.weights.some(Boolean)?'權重會按比例換算，總和可超過 100。':'權重皆為 0。調高任一項即可開始評分。';
  drawList();details();draw();locks();
}
function select(i){
  selected=Math.max(0,Math.min(result.points.length-1,i));
  details();draw();highlightSelection();
}
function highlightSelection(){document.querySelectorAll('.clip').forEach(row=>row.classList.toggle('selected',Number(row.dataset.at)===result.points[selected]?.start));}
function details(){
  const p=result.points[selected];if(!p)return;
  $('detailTitle').textContent=clock(p.start)+'–'+clock(p.end)+' · '+p.score.toFixed(1)+' 分';
  $('detailFacts').textContent=fmt(p.count)+' 則訊息 · '+fmt(p.users)+' 位可辨識觀眾';
  $('parts').replaceChildren();
  model.labels.forEach((label,i)=>{
    const line=el('div','part'),head=el('div','part-head'),track=el('div','track'),bar=el('i');
    head.append(el('span','',label),el('b','',p.parts[i].toFixed(1)+' 分'));
    bar.style.width=p.parts[i]+'%';bar.style.background=colors[i];track.append(bar);line.append(head,track);$('parts').append(line);
  });
  $('explain').textContent='有效發言 '+p.effective+' 則，參考基準 '+p.baseline.toFixed(1)+' 則。'+p.reactions+' 位觀眾有情緒反應，'+p.paid+' 位付費支持。';
  if($('compare').checked){
    const delta=p.score-reference[selected];
    $('explain').textContent+=' 同時段均衡權重為 '+reference[selected].toFixed(1)+' 分，目前差異 '+(delta>=0?'+':'')+delta.toFixed(1)+' 分。';
  }
  $('chart').setAttribute('aria-valuemax',result.points.length-1);$('chart').setAttribute('aria-valuenow',selected);
  $('chart').setAttribute('aria-valuetext',clock(p.start)+'，'+p.score.toFixed(1)+' 分');
}
function drawList(){
  const list=$('list');list.replaceChildren();
  if(!result.clips.length){list.append(el('p','empty','目前沒有片段入選。可降低門檻，或調整評分權重。'));return;}
  for(const c of result.clips){
    const p=c.point,div=el('div','clip'),row=el('div','clip-line'),btn=el('button','clip-select');
    div.dataset.at=p.start;
    btn.append(el('span','clip-rank',String(c.rank).padStart(2,'0')),el('strong','',clock(c.start)+' – '+clock(c.end)));
    btn.title='查看評分組成';btn.onclick=()=>select(result.points.findIndex(x=>x.start===p.start));
    row.append(btn,el('span','score',p.score.toFixed(1)+' 分'));
    const strongest=p.parts.indexOf(Math.max(...p.parts));
    div.append(row,el('div','clip-sub',Math.round(c.end-c.start)+' 秒 · '+p.users+' 位觀眾 · 主要訊號為'+model.labels[strongest]));
    if(source.id){
      const actions=el('div','clip-actions'),link=el('a','','回看此段 ↗');
      link.target='_blank';link.rel='noopener noreferrer';link.href='https://www.youtube.com/watch?v='+source.id+'&t='+Math.floor(c.start)+'s';actions.append(link);
      if(backend){
        for(const [kind,text] of [['clip','產生 MP4'],['subtitles','產生 MP4＋SRT']]){
          const button=el('button','',text);button.dataset.download='true';
          button.onclick=()=>clip(c,kind);actions.append(button);
        }
      }
      div.append(actions);
    }
    list.append(div);
  }
  highlightSelection();
}
const canvas=$('chart'),ctx=canvas.getContext('2d');
const geom=()=>({l:32,r:canvas.clientWidth-12,t:15,b:canvas.clientHeight-24});
function draw(){
  if(!source||!canvas.clientWidth)return;
  const d=devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;
  canvas.width=Math.round(w*d);canvas.height=Math.round(h*d);ctx.setTransform(d,0,0,d,0,0);
  const {l,r,t,b}=geom(),X=s=>l+(r-l)*s/source.duration,Y=v=>b-(b-t)*v/100;
  ctx.font='11px system-ui';ctx.lineWidth=1;
  for(const v of [0,25,50,75,100]){
    ctx.fillStyle='#596c65';ctx.textAlign='right';ctx.fillText(v,l-6,Y(v)+4);
    ctx.beginPath();ctx.strokeStyle='#e1e8e1';ctx.moveTo(l,Y(v));ctx.lineTo(r,Y(v));ctx.stroke();
  }
  for(let i=0;i<=4;i++){ctx.textAlign=i===0?'left':i===4?'right':'center';ctx.fillText(clock(source.duration*i/4),X(source.duration*i/4),h-3);}
  const xOf=p=>X((p.start+p.end)/2);
  const grad=ctx.createLinearGradient(0,t,0,b);grad.addColorStop(0,'#67c9a794');grad.addColorStop(1,'#c3e6d32b');
  const path=new Path2D();result.points.forEach((p,i)=>i?path.lineTo(xOf(p),Y(p.score)):path.moveTo(xOf(p),Y(p.score)));
  const fill=new Path2D(path);fill.lineTo(xOf(result.points.at(-1)),b);fill.lineTo(xOf(result.points[0]),b);fill.closePath();
  ctx.fillStyle=grad;ctx.fill(fill);ctx.strokeStyle='#087d68';ctx.lineWidth=2;ctx.stroke(path);
  ctx.beginPath();ctx.setLineDash([5,4]);ctx.lineWidth=1.25;ctx.strokeStyle='#a4672e';ctx.moveTo(l,Y(cfg.threshold));ctx.lineTo(r,Y(cfg.threshold));ctx.stroke();ctx.setLineDash([]);
  if($('compare').checked){
    ctx.beginPath();ctx.strokeStyle='#737a98';ctx.setLineDash([2,4]);ctx.lineWidth=1.6;
    result.points.forEach((p,i)=>i?ctx.lineTo(xOf(p),Y(reference[i])):ctx.moveTo(xOf(p),Y(reference[i])));
    ctx.stroke();ctx.setLineDash([]);
  }
  for(const c of result.clips){ctx.beginPath();ctx.fillStyle='#f7fff4';ctx.strokeStyle='#087d68';ctx.arc(xOf(c.point),Y(c.point.score),3.2,0,Math.PI*2);ctx.fill();ctx.stroke();}
  const p=result.points[selected];if(p){const x=xOf(p),y=Y(p.score);ctx.beginPath();ctx.strokeStyle='#548c80';ctx.moveTo(x,t);ctx.lineTo(x,b);ctx.stroke();ctx.fillStyle='#173e35';ctx.beginPath();ctx.arc(x,y,4,0,2*Math.PI);ctx.fill();}
}
function indexAt(e){
  const {l,r}=geom(),s=(e.clientX-canvas.getBoundingClientRect().left-l)/(r-l)*source.duration;
  const mid=p=>(p.start+p.end)/2;
  let lo=0,hi=result.points.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(mid(result.points[m])<s)lo=m+1;else hi=m;}
  return lo>0&&Math.abs(mid(result.points[lo-1])-s)<Math.abs(mid(result.points[lo])-s)?lo-1:lo;
}
canvas.onclick=e=>{if(source)select(indexAt(e));};
canvas.onmousemove=e=>{if(!source)return;const p=result.points[indexAt(e)],tip=$('tooltip');tip.hidden=false;tip.textContent=clock(p.start)+' · '+p.score.toFixed(1)+' 分';tip.style.left=Math.max(0,Math.min(canvas.clientWidth-110,e.clientX-canvas.getBoundingClientRect().left-32))+'px';};
canvas.onmouseleave=()=>$('tooltip').hidden=true;
canvas.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();select(selected+(e.key==='ArrowRight'?1:-1));}};
$('compare').onchange=()=>{details();draw();};
new ResizeObserver(draw).observe(canvas);
function save(blob,name){const a=el('a'),link=URL.createObjectURL(blob);a.href=link;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(link),30000);}
$('export').onclick=()=>{
  const summary={version:2,mode:sourceKind,video:{title:source.title,duration:source.duration,url:source.id?'https://www.youtube.com/watch?v='+source.id:''},
    config:{...cfg,signal_labels:model.labels},total_messages:source.count,highlights:result.clips.map(c=>({
      rank:c.rank,start:c.start,end:c.end,score:+c.point.score.toFixed(3),window_start:c.point.start,window_end:c.point.end,
      message_count:c.point.count,unique_users:c.point.users,contributions:Object.fromEntries(model.labels.map((k,i)=>[k,+c.point.parts[i].toFixed(3)]))}))};
  save(new Blob([JSON.stringify(summary,null,2)],{type:'application/json'}),(sourceKind==='demo'?'demo':source.id||'chat')+'-highlights.json');
};
async function clip(c,kind){
  busy=true;locks();
  const id=source.id, label=clock(c.start)+'–'+clock(c.end);
  status('送出片段 '+label+'…');
  try{
    const job=await Cloud.job({kind,id,start:c.start,end:c.end},step=>status(label+' · '+step));
    const row=el('div','download-row');
    row.append(el('span','',source.title+' · '+label));
    for(const ext of job.files){
      const button=el('button','secondary','下載 '+ext.toUpperCase());
      button.onclick=async()=>{
        button.disabled=true;
        try {save(await (await Cloud.file(job.id,ext)).blob(),'highlight-'+id+'-'+Math.floor(c.start)+'-'+Math.ceil(c.end)+'.'+ext);}
        catch(e){status(e.message,true);}finally{button.disabled=false;}
      };
      row.append(button);
    }
    if(job.notice)row.append(el('p','caption',job.notice));
    $('files').prepend(row);$('outputs').hidden=false;
    status(job.notice||'處理完成，請在「完成的檔案」下載。');
    $('outputs').scrollIntoView({block:'nearest'});
  }catch(e){status(e.message,true);}finally{busy=false;locks();}
}
$('load').onclick=async()=>{
  const id=model.videoId($('url').value.trim());
  if(!id){status('請貼上有效的 YouTube 影片、直播或 youtu.be 網址。',true);return;}
  busy=true;locks();status('正在讀取 YouTube 聊天室重播。長直播可能需要幾分鐘。');
  try{
    const job=await Cloud.job({kind:'chat',id},step=>status(step+'…'));
    const r=await Cloud.file(job.id,'chat');
    const meta={id,title:job.title||id,duration:job.duration};
    const raw=await r.text();status('正在分析聊天室…');compute({kind:'source',sourceKind:'url',raw,meta});
  }catch(e){busy=false;locks();status(e.message,true);}
};
$('url').onkeydown=e=>{if(e.key==='Enter'&&!$('load').disabled)$('load').click();};
$('file').onchange=async()=>{
  const file=$('file').files[0];$('file').value='';if(!file)return;
  if(file.size>128*1024*1024){status('檔案超過 128 MiB，請分段後匯入。',true);return;}
  busy=true;locks();status('正在分析聊天室…');
  try{const raw=await file.text();compute({kind:'source',sourceKind:'file',raw,meta:{title:file.name}});}
  catch(e){busy=false;locks();status(e.message,true);}
};
$('demoBtn').onclick=()=>{busy=true;compute({kind:'demo'});};
function updateConnection(connected){
  backend=connected;
  $('connection').textContent=connected?'雲端已連線':'雲端未連線';
  $('quit').hidden=!connected;$('cloudForm').hidden=connected;
  if(source)rerank();locks();
}
$('cloudForm').onsubmit=async event=>{
  event.preventDefault();busy=true;locks();
  const note=$('connectionState');note.classList.remove('connection-error');note.textContent='正在連線，首次啟動可能需要約一分鐘…';
  try{
    await Cloud.connect($('apiHost').value,$('apiKey').value);
    $('apiKey').value='';updateConnection(true);tab('url');status('');
    note.textContent='已連接 '+new URL($('apiHost').value).host;
  }catch(e){updateConnection(false);note.textContent=e.message;note.classList.add('connection-error');}
  finally{busy=false;locks();}
};
$('quit').onclick=()=>{
  Cloud.disconnect();updateConnection(false);$('files').replaceChildren();$('outputs').hidden=true;
  $('connectionState').textContent='已中斷連線。';tab('file');
};
$('apiHost').value=window.STUDIO_API_URL||'';
updateConnection(false);tab('file');busy=true;compute({kind:'demo'});
