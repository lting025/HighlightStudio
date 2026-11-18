'use strict';
const Cloud = (() => {
  let host='', token='';
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function request(path, options={}) {
    let response;
    try {
      response=await fetch(host+path,{...options,redirect:'error',credentials:'omit',cache:'no-store',
        headers:{Authorization:'Bearer '+token,...options.headers}});
    } catch {
      throw Error('連不到後端。請確認 HTTPS 網址、Render 部署狀態及 PAGES_ORIGIN；休眠中的服務需要時間啟動。');
    }
    if(!response.ok){
      const detail=await response.json().catch(()=>({}));
      throw Error(detail.error||'後端回應 HTTP '+response.status+'。');
    }
    return response;
  }
  function disconnect(){host='';token='';}
  async function connect(input, key) {
    disconnect();
    let addr;
    try {addr=new URL(input.trim());} catch {throw Error('請輸入完整的 HTTPS 後端網址。');}
    if(addr.protocol!=='https:' || addr.username || addr.password || addr.search || addr.hash || addr.pathname!=='/')
      throw Error('請輸入後端的 HTTPS 網域，例如 https://你的服務名稱.onrender.com。');
    if(!key.trim())throw Error('請輸入部署時設定的 STUDIO_KEY。');
    host=addr.origin;token=key.trim();
    try {
      if((await (await request('/api/status')).json()).ok!==true)throw Error('後端回應格式有誤。');
    } catch(e) {disconnect();throw e;}
  }
  async function job(payload,progress) {
    const {job:id}=await (await request('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();
    if(!/^[a-f0-9]{32}$/.test(id))throw Error('後端未傳回有效的工作編號。');
    const deadline=Date.now()+55*60*1000;
    let failures=0;
    while(Date.now()<deadline){
      await pause(2000);
      let state;
      try {state=await (await request('/api/jobs/'+id)).json();failures=0;}
      catch(e){if(++failures<3)continue;throw e;}
      if(state.state==='error')throw Error(state.error);
      if(state.state==='done')return {...state,id};
      progress(state.stage||'處理中');
    }
    throw Error('已超過等待時間，請確認後端狀態。');
  }
  return {connect,disconnect,job,file:(id,kind)=>request('/api/jobs/'+id+'/'+kind)};
})();
