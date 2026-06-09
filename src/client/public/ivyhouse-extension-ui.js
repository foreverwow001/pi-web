(() => {
  const STATE = { currentId: null, busy: false };
  const css = `
    .ivy-extui-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:24px;color:#e6edf3;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .ivy-extui-card{width:min(920px,96vw);max-height:88vh;overflow:auto;background:#0d1117;border:1px solid #30363d;border-radius:14px;box-shadow:0 20px 70px rgba(0,0,0,.6)}
    .ivy-extui-head{position:sticky;top:0;background:#161b22;border-bottom:1px solid #30363d;padding:14px 18px;font-weight:700;color:#f0f6fc}
    .ivy-extui-body{padding:18px;white-space:pre-wrap;line-height:1.5;font-size:14px;color:#e6edf3}
    .ivy-extui-actions{display:flex;flex-direction:column;gap:10px;padding:0 18px 18px}
    .ivy-extui-row{display:flex;gap:10px;justify-content:flex-end;padding:0 18px 18px;flex-wrap:wrap}
    .ivy-extui-btn{appearance:none;border:1px solid #30363d;border-radius:10px;background:#21262d;color:#e6edf3;padding:10px 12px;cursor:pointer;text-align:left;font-size:14px;touch-action:manipulation}
    .ivy-extui-btn:hover{background:#30363d}.ivy-extui-primary{border-color:#2f81f7;background:#0d2847}.ivy-extui-danger{border-color:#da3633;background:#2d1111}
    .ivy-extui-textarea{width:100%;min-height:160px;box-sizing:border-box;border-radius:10px;border:1px solid #30363d;background:#05070a;color:#e6edf3;padding:12px;font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
    .ivy-extui-muted{color:#8b949e;font-size:12px;margin-top:8px}
    @media(max-width:640px){.ivy-extui-overlay{padding:10px;align-items:stretch}.ivy-extui-card{width:100%;max-height:96vh}.ivy-extui-body{font-size:13px}.ivy-extui-row{justify-content:stretch}.ivy-extui-row .ivy-extui-btn{flex:1}.ivy-extui-btn{font-size:15px;padding:12px}}
  `;
  function ensureStyle(){ if(document.getElementById('ivy-extui-style')) return; const s=document.createElement('style'); s.id='ivy-extui-style'; s.textContent=css; document.head.appendChild(s); }
  function selectedSessionId(){
    const u=new URL(location.href);
    for (const key of ['sessionId','session','selectedSessionId']) { const v=u.searchParams.get(key); if(v) return v; }
    const m=location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : null;
  }
  async function api(path, options){ const r=await fetch(path,{headers:{'content-type':'application/json'},...options}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
  async function respond(sessionId, requestId, body){ await api(`/api/sessions/${encodeURIComponent(sessionId)}/extension-ui/respond`, {method:'POST', body:JSON.stringify({requestId,...body})}); closeModal(); }
  function closeModal(){ document.getElementById('ivy-extui-overlay')?.remove(); STATE.currentId=null; }
  function render(sessionId, req){
    ensureStyle(); STATE.currentId=req.requestId;
    document.getElementById('ivy-extui-overlay')?.remove();
    const overlay=document.createElement('div'); overlay.id='ivy-extui-overlay'; overlay.className='ivy-extui-overlay';
    const card=document.createElement('div'); card.className='ivy-extui-card'; overlay.appendChild(card);
    const head=document.createElement('div'); head.className='ivy-extui-head'; head.textContent=req.method==='select'?'Ivyhouse Question Gate':req.method==='confirm'?'Ivyhouse Confirm Gate':'Ivyhouse Input Gate'; card.appendChild(head);
    const body=document.createElement('div'); body.className='ivy-extui-body'; body.textContent=req.title || req.message || ''; card.appendChild(body);
    if(req.method==='select'){
      const actions=document.createElement('div'); actions.className='ivy-extui-actions'; card.appendChild(actions);
      for(const opt of (req.options||[])){ const b=document.createElement('button'); b.className='ivy-extui-btn'; b.textContent=opt; b.onclick=()=>respond(sessionId,req.requestId,{value:opt}); actions.appendChild(b); }
      const row=document.createElement('div'); row.className='ivy-extui-row'; const cancel=document.createElement('button'); cancel.className='ivy-extui-btn ivy-extui-danger'; cancel.textContent='Cancel / Fail closed'; cancel.onclick=()=>respond(sessionId,req.requestId,{cancelled:true}); row.appendChild(cancel); card.appendChild(row);
    } else if(req.method==='confirm'){
      const msg=document.createElement('div'); msg.className='ivy-extui-body'; msg.textContent=req.message||''; card.appendChild(msg);
      const row=document.createElement('div'); row.className='ivy-extui-row';
      for(const [label,confirmed,cls] of [['Cancel / No',false,'ivy-extui-danger'],['Confirm / Yes',true,'ivy-extui-primary']]){ const b=document.createElement('button'); b.className=`ivy-extui-btn ${cls}`; b.textContent=label; b.onclick=()=>respond(sessionId,req.requestId,{confirmed}); row.appendChild(b); }
      card.appendChild(row);
    } else {
      const wrap=document.createElement('div'); wrap.className='ivy-extui-body'; const ta=document.createElement('textarea'); ta.className='ivy-extui-textarea'; ta.placeholder=req.placeholder||''; wrap.appendChild(ta); const hint=document.createElement('div'); hint.className='ivy-extui-muted'; hint.textContent='Submit sends this value back to Pi extension UI.'; wrap.appendChild(hint); card.appendChild(wrap);
      const row=document.createElement('div'); row.className='ivy-extui-row';
      const cancel=document.createElement('button'); cancel.className='ivy-extui-btn ivy-extui-danger'; cancel.textContent='Cancel / Fail closed'; cancel.onclick=()=>respond(sessionId,req.requestId,{cancelled:true});
      const submit=document.createElement('button'); submit.className='ivy-extui-btn ivy-extui-primary'; submit.textContent='Submit'; submit.onclick=()=>respond(sessionId,req.requestId,{value:ta.value}); row.append(cancel,submit); card.appendChild(row); setTimeout(()=>ta.focus(),50);
    }
    document.body.appendChild(overlay);
  }
  async function poll(){
    if(STATE.busy) return; const sid=selectedSessionId(); if(!sid) return; STATE.busy=true;
    try{ const data=await api(`/api/sessions/${encodeURIComponent(sid)}/extension-ui/pending`); const req=(data.requests||[])[0]; if(req && req.requestId!==STATE.currentId) render(sid,req); if(!req && STATE.currentId) closeModal(); }catch(_e){} finally{ STATE.busy=false; }
  }
  setInterval(poll, 1000); window.addEventListener('focus', poll); setTimeout(poll, 1200);
})();
