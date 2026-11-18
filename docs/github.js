'use strict';

// Compact rows use the same five counts as the local-file analysis.
function reportWindows(report, size) {
  const duration = report.meta.duration;
  const rows = report.windows[size];
  const step = size / 3;
  const expected = Math.max(1, 1 + Math.ceil((duration - size) / step));
  if (!Array.isArray(rows) || rows.length !== expected) throw Error('時段統計不完整。');
  const windows = rows.map((row, i) => {
    if (!Array.isArray(row) || row.length !== 5 || row.some(v => !Number.isSafeInteger(v) || v < 0))
      throw Error('時段資料格式錯誤。');
    const [count, users, effective, reactions, paid] = row;
    return {start:i*step, end:Math.min(i*step+size,duration), count, users, effective, reactions, paid};
  });
  return model.scoreSignals(windows, size);
}

(() => {
  const host = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  const project = location.pathname.split('/')[1];
  const repo = host && /^[\w.-]+$/.test(project) ? host[1]+'/'+project : 'lting025/HighlightStudio';
  const base = 'https://github.com/'+repo;
  const api = 'https://api.github.com/repos/'+repo;
  let generation = 0;
  let timer;

  function message(value) {
    $('requestState').textContent=value;
    $('requestState').hidden=!value;
  }
  function link(url, label) {
    $('requestLink').href=url;
    $('requestLink').textContent=label;
    $('requestLink').hidden=false;
  }
  function stop() {
    clearTimeout(timer);
    generation++;
  }
  async function read(path) {
    const r=await fetch(api+path,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(!r.ok) throw Error(r.status===403 || r.status===429
      ? 'GitHub 限制了目前的查詢次數。'
      : '無法取得 GitHub 工作狀態（HTTP '+r.status+'）。');
    return r.json();
  }
  async function applyReport(data, videoId, token) {
    const finish=data.findLast(c=>c.user?.login==='github-actions[bot]' &&
      /^<!-- HS-DONE\/1 [\d-]+ \d+ -->/.test(c.body));
    if (!finish) {
      if (data.some(c=>c.user?.login==='github-actions[bot]' && c.body.startsWith('HS-ERROR/1'))) {
        throw Error('無法取得可分析的聊天室。請在 GitHub 工作頁查看原因。');
      }
      return false;
    }
    const [,run,n]=finish.body.match(/^<!-- HS-DONE\/1 ([\d-]+) (\d+) -->/);
    if (+n<1 || +n>30) throw Error('統計資料超出支援範圍。');
    const chunks=Array(+n).fill(null);
    for (const c of data) {
      if (c.user?.login!=='github-actions[bot]') continue;
      const match=c.body.match(/^<!-- HS-DATA\/1 ([\d-]+) (\d+)\n([A-Za-z0-9+/=]+)\n-->/);
      if (match && match[1]===run && +match[2]<chunks.length) chunks[+match[2]]=match[3];
    }
    if(chunks.includes(null)) throw Error('結果資料不完整。');
    const bytes=Uint8Array.from(atob(chunks.join('')),c=>c.charCodeAt(0));
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const report=await new Response(stream).json();
    if (report.version!==1 || report.meta?.id!==videoId || !Number.isFinite(report.meta.duration) ||
        report.meta.duration<=0 || report.meta.duration>604800) throw Error('結果格式或影片 ID 不符。');
    const windows=reportWindows(report,cfg.window);
    if(token!==generation) return true;
    clearTimeout(wordTimer);
    cfg.words=model.defaults.words;
    $('words').value=cfg.words;
    githubReport=report;
    accepted({serial:++sourceSerial,kind:'source',sourceKind:'github',meta:report.meta,windows});
    message('分析完成。可直接調整權重、比較曲線或點選精華回看影片。');
    return true;
  }
  function monitor(title, issueNumber) {
    stop();
    const token=generation;
    const start=Date.now();
    let number=issueNumber;
    async function poll() {
      if(token!==generation) return;
      try {
        let entry;
        if (!number) {
          const issues=await read('/issues?state=all&sort=created&direction=desc&per_page=100');
          entry=issues.find(x=>x.title===title && !x.pull_request);
          number=entry?.number;
        } else entry=await read('/issues/'+number);
        if(token!==generation) return;
        if(entry) {
          const parsed=entry.title.match(/^Highlight Studio · ([\w-]{11}) · [0-9a-f]{16}$/);
          if (!parsed || entry.pull_request) throw Error('這筆工作不屬於聊天室分析。');
          link(base+'/issues/'+number,'查看 GitHub 工作');
          if(!['OWNER','MEMBER','COLLABORATOR'].includes(entry.author_association)) throw Error('此工作需由儲存庫擁有者或協作者提交。');
          if(location.protocol==='https:') history.replaceState(null,'','?issue='+number);
          if(entry.comments>0) {
            const comments=await read('/issues/'+number+'/comments?per_page=100');
            if(token!==generation) return;
            if(await applyReport(comments,parsed[1],token)) return;
          }
          if(entry.state==='closed') throw Error('工作已關閉，沒有完整統計可讀取。');
          message('GitHub 已收到網址，正在等待聊天室統計。你也可以稍後從這筆 Issue 開啟結果。');
        }
        if(Date.now()-start>32*60*1000) throw Error('已停止等待。請在 GitHub 查看工作與結果連結。');
        if(token===generation) timer=setTimeout(poll,number?45000:20000);
      } catch(e) {
        if(token===generation) message(e.message+' 可稍後從 Issue 的結果連結重新開啟。');
      }
    }
    poll();
  }
  $('requestForm').onsubmit=e=>{
    e.preventDefault();
    const id=model.videoId($('videoUrl').value.trim());
    if(!id) {message('請輸入有效的 YouTube 影片或直播存檔網址。');return;}
    const nonce=Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>v.toString(16).padStart(2,'0')).join('');
    const title='Highlight Studio · '+id+' · '+nonce;
    const url=new URL(base+'/issues/new');
    url.searchParams.set('title',title);
    url.searchParams.set('body','分析這場公開直播的聊天室重播。\n\nhttps://www.youtube.com/watch?v='+id+
      '\n\n請保留標題並按 Create。工作完成後，可回到原本的分析頁，或點下方自動回覆的結果連結。');
    link(url.href,'開啟 GitHub 提交頁');
    window.open(url.href,'_blank','noopener,noreferrer');
    message('在新分頁按 Create 建立工作後，回到這裡等待。若沒有開啟新分頁，請點下方連結。');
    monitor(title,null);
  };
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{
    if(b.dataset.tab!=='url') {
      stop();
      if (!$('requestLink').hidden) message('已停止自動查詢。可從 GitHub 工作頁開啟結果。');
    }
  }));
  const number=new URLSearchParams(location.search).get('issue');
  if (/^[1-9]\d{0,9}$/.test(number||'')) {
    message('正在讀取 GitHub 的分析結果…');
    monitor(null,Number(number));
  }
})();
