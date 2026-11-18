/* Shared by the analysis worker, the file-mode fallback and the regression tests. */
const StudioModel = (() => {
  const defaults = { weights: [40, 30, 25, 5], threshold: 48, window: 30, top: 6, before: 15, after: 10,
    words: '笑死, 哈哈, 太神, 扯, 逆轉, 777, 666, 草, www, gg, omg, clutch, 😂, 🤣, 🔥, 👏, 😱' };
  const labels = ['熱度突增', '參與廣度', '情緒反應', '付費支持'];
  const limit = 7 * 86400;
  function videoId(value) {
    try {
      const u = new URL(value);
      if (!['http:', 'https:'].includes(u.protocol)) return '';
      const host = u.hostname.toLowerCase();
      const path = u.pathname.split('/');
      let id = '';
      if (host === 'youtu.be') id = path[1];
      if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(host))
        id = path[1] === 'watch' ? u.searchParams.get('v') : ['live','shorts','embed'].includes(path[1]) ? path[2] : '';
      return /^[\w-]{11}$/.test(id || '') ? id : '';
    } catch { return ''; }
  }
  function parseChat(input, metadata = {}) {
    const rows = []; let skipped = 0;
    function put(t, a, text, paid, emoji) {
      if (t == null || typeof t === 'boolean' || String(t).trim() === '') { skipped++; return; }
      const time = Number(t);
      if (!Number.isFinite(time) || time < 0 || time >= limit) { skipped++; return; }
      const body = String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 800);
      if (!body && !paid && !emoji) { skipped++; return; }
      rows.push({t:time, a:String(a || '').trim(), text:body, paid:Boolean(paid), emoji:Boolean(emoji)});
    }
    function record(r) {
      if (!r || typeof r !== 'object') { skipped++; return; }
      if (r.replayChatItemAction) {
        const replay = r.replayChatItemAction;
        for (const act of replay.actions || []) {
          const item = act.addChatItemAction?.item;
          if (!item) continue;
          const key = Object.keys(item).find(k => ['liveChatTextMessageRenderer','liveChatPaidMessageRenderer','liveChatPaidStickerRenderer','liveChatMembershipItemRenderer'].includes(k));
          if (!key) continue;
          const m = item[key], runs = m.message?.runs || [];
          const body = runs.map(x => x.text || x.emoji?.shortcuts?.[0] || x.emoji?.emojiId || '').join('');
          put(replay.videoOffsetTimeMsec == null ? null : Number(replay.videoOffsetTimeMsec)/1000,
              m.authorExternalChannelId || m.authorName?.simpleText, body, key.includes('Paid'), runs.some(x => x.emoji));
        }
        return;
      }
      const author = r.author;
      const user = typeof author === 'object' && author ? (author.id || author.name) : author;
      const type = String(r.message_type || '').toLowerCase();
      put(r.time_in_seconds ?? r.timestamp, user ?? r.author_name, r.text ?? r.message,
          /^(donation|superchat|superchat_sticker|supersticker|paid_message|paid_sticker)$/.test(type),
          Boolean(r.emotes?.length || r.extra?.emoji_terms?.length));
    }
    const raw = input.replace(/^\uFEFF/, '').trim();
    if (!raw) throw Error('檔案沒有內容。');
    let obj;
    try { obj = JSON.parse(raw); } catch { /* yt-dlp writes one JSON object per line. */ }
    if (Array.isArray(obj)) obj.forEach(record);
    else if (obj && Array.isArray(obj.messages)) {
      const meta = obj.video || {};
      metadata = {...metadata, title: meta.title || metadata.title, id:videoId(meta.url) || metadata.id, duration:meta.duration ?? metadata.duration};
      obj.messages.forEach(record);
    } else if (obj) record(obj);
    else {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { record(JSON.parse(line)); } catch { skipped++; }
      }
    }
    if (!rows.length) throw Error('找不到有時間戳記的聊天訊息。可匯入 yt-dlp 的 live_chat.json、JSONL 或原版 ChatMessage 陣列。');
    rows.sort((a,b) => a.t-b.t);
    const last = Math.floor(rows.at(-1).t)+1;
    const duration = Number(metadata.duration);
    return {rows, skipped, title:String(metadata.title || '聊天室紀錄'), id:metadata.id || '',
      duration:Number.isFinite(duration) && duration <= limit ? Math.max(last, duration) : last};
  }
  function demo() {
    let seed=729;
    const random=() => ((seed=(1664525*seed+1013904223)>>>0)/4294967296);
    const rows=[], duration=1200;
    const normal=['有看到','這局很穩','等下一波','我也覺得','這邊可以','收到','來了'];
    const hype=['太神了','笑死 😂','777','逆轉！','哈哈哈哈','🔥🔥','OMG'];
    for(let t=0;t<duration;t++) {
      const peak=[[214,15,2.7],[562,21,3.8],[906,15,2.2],[1075,9,1.8]].reduce((n,[at,w,h])=>n+h*Math.exp(-(((t-at)/w)**2)),0);
      const amount=0.30+0.13*Math.sin(t/39)+peak;
      const count=Math.floor(amount)+(random()<amount%1?1:0);
      for(let i=0;i<count;i++){
        const hot=random()<Math.min(.91,peak*.32);
        const pool=hot?hype:normal;
        rows.push({t:t+random(),a:'觀眾'+Math.floor(random()*(peak>.6?70:13)),text:pool[Math.floor(random()*pool.length)].toLowerCase(),paid:t>550&&t<578&&random()<.11,emoji:false});
      }
    }
    rows.sort((a,b)=>a.t-b.t);
    return {rows,duration,skipped:0,title:'示範直播・團隊逆轉戰',id:''};
  }
  const clamp = x => Math.max(0,Math.min(1,x));
  function quantile(values, frac) {
    if (!values.length) return 1;
    values.sort((a,b)=>a-b);
    return values[Math.floor((values.length-1)*frac)] || 1;
  }
  function features(data, cfg) {
    const terms=[...new Set(cfg.words.toLowerCase().normalize('NFKC').split(/[,，、\n]+/).map(x=>x.trim()).filter(Boolean))];
    const rows=data.rows.map(m=>({...m,react:m.emoji || terms.some(term => m.text.includes(term))}));
    const w=cfg.window,step=w/3;
    const windows=[]; let left=0,right=0;
    for(let start=0;start<data.duration;start+=step) {
      const end=Math.min(start+w,data.duration);
      while(left<rows.length && rows[left].t<start) left++;
      while(right<rows.length && rows[right].t<end) right++;
      const authors=new Map(), reacts=new Set(), paid=new Set();
      let effective=0,known=0;
      for(let i=left;i<right;i++) {
        const m=rows[i], key=m.a;
        if(!authors.has(key)) {authors.set(key,new Set()); if(key) known++;}
        const seen=authors.get(key);
        if(seen.size<2 && !seen.has(m.text)) {seen.add(m.text); effective++;}
        if(m.react && key) reacts.add(key);
        if(m.paid && key) paid.add(key);
      }
      windows.push({start,end,count:right-left,users:known,effective,reactions:reacts.size,paid:paid.size});
      if(end===data.duration) break;
    }
    return scoreSignals(windows,w);
  }
  function scoreSignals(windows,w) {
    const active=windows.filter(x=>x.effective);
    const typical=quantile(active.map(x=>x.effective),.5);
    const broad=Math.max(5,quantile(active.map(x=>x.users),.90));
    const refCount=Math.max(1,Math.round(120/w));
    for(let i=0;i<windows.length;i++) {
      const x=windows[i];
      // Compare against disjoint preceding windows, excluding the candidate itself.
      const history=[];
      for(let j=i-3;j>=0 && history.length<refCount;j-=3) history.push(windows[j].effective);
      const base=history.length ? history.reduce((s,n)=>s+n,0)/history.length : typical;
      const support=clamp(x.users/4);
      x.signals=[clamp((x.effective-base)/(base+3)/2)*support,
        clamp(x.users/broad), x.reactions/(x.users+2)*support, 1-Math.exp(-x.paid/1.5)];
      x.baseline=base;
    }
    return windows;
  }
  function rank(windows,cfg,duration) {
    const total=cfg.weights.reduce((a,b)=>a+b,0);
    const points=windows.map(x=>{
      const parts=x.signals.map((s,i)=> total ? 100*s*cfg.weights[i]/total : 0);
      return {...x,parts,score:parts.reduce((a,b)=>a+b,0)};
    });
    const clips=[];
    for(const p of points.filter(p=>p.count && p.score>0 && p.score>=cfg.threshold).sort((a,b)=>b.score-a.score||a.start-b.start)) {
      const start=Math.max(0,p.start-cfg.before), end=Math.min(duration,p.end+cfg.after);
      if(clips.some(c=>start<c.end && end>c.start)) continue;
      clips.push({start,end,point:p,rank:clips.length+1});
      if(clips.length>=cfg.top) break;
    }
    return {points,clips};
  }
  return {defaults,labels,videoId,parseChat,demo,features,scoreSignals,rank};
})();
if(typeof module!=='undefined') module.exports=StudioModel;
