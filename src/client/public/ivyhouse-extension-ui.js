(() => {
  const CUSTOM_INPUT_TIMEOUT_MS = 10000;
  const STATE = { currentId: null, busy: false, inlineCustomSubmitting: false };
  const css = `
    .ivy-extui-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:24px;color:#e6edf3;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .ivy-extui-card{width:min(920px,96vw);max-height:88vh;overflow:auto;background:#0d1117;border:1px solid #30363d;border-radius:14px;box-shadow:0 20px 70px rgba(0,0,0,.6)}
    .ivy-extui-head{position:sticky;top:0;background:#161b22;border-bottom:1px solid #30363d;padding:14px 18px;font-weight:700;color:#f0f6fc}
    .ivy-extui-body{padding:18px;white-space:pre-wrap;line-height:1.5;font-size:14px;color:#e6edf3}
    .ivy-extui-actions{display:flex;flex-direction:column;gap:10px;padding:0 18px 18px}
    .ivy-extui-row{display:flex;gap:10px;justify-content:flex-end;padding:0 18px 18px;flex-wrap:wrap}
    .ivy-extui-btn{appearance:none;border:1px solid #30363d;border-radius:10px;background:#21262d;color:#e6edf3;padding:10px 12px;cursor:pointer;text-align:left;font-size:14px;touch-action:manipulation}
    .ivy-extui-btn:hover:not(:disabled){background:#30363d}.ivy-extui-btn:disabled{opacity:.55;cursor:not-allowed}.ivy-extui-primary{border-color:#2f81f7;background:#0d2847}.ivy-extui-danger{border-color:#da3633;background:#2d1111}
    .ivy-extui-textarea{width:100%;min-height:160px;box-sizing:border-box;border-radius:10px;border:1px solid #30363d;background:#05070a;color:#e6edf3;padding:12px;font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
    .ivy-extui-muted{color:#8b949e;font-size:12px;margin-top:8px}.ivy-extui-error{color:#ffb4ab;font-size:12px;margin-top:8px}.ivy-extui-status{color:#79c0ff;font-size:12px;margin-top:8px}
    .ivy-extui-inline-custom{display:none;margin:0 18px 18px;padding:14px;border:1px solid #30363d;border-radius:12px;background:#080c12}.ivy-extui-inline-custom.open{display:block}.ivy-extui-inline-custom .ivy-extui-row{padding:12px 0 0}.ivy-extui-inline-title{font-weight:700;margin-bottom:8px;color:#f0f6fc}
    @media(max-width:640px){.ivy-extui-overlay{padding:10px;align-items:stretch}.ivy-extui-card{width:100%;max-height:96vh}.ivy-extui-body{font-size:13px}.ivy-extui-row{justify-content:stretch}.ivy-extui-row .ivy-extui-btn{flex:1}.ivy-extui-btn{font-size:15px;padding:12px}.ivy-extui-textarea{min-height:120px}.ivy-extui-inline-custom{margin:0 18px 14px}}
  `;
  function ensureStyle(){ if(document.getElementById('ivy-extui-style')) return; const s=document.createElement('style'); s.id='ivy-extui-style'; s.textContent=css; document.head.appendChild(s); }
  function selectedSessionId(){
    const u=new URL(location.href);
    for (const key of ['sessionId','session','selectedSessionId']) { const v=u.searchParams.get(key); if(v) return v; }
    const m=location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : null;
  }
  function isCustomInstructionOption(label){
    const normalized=String(label||'').toLowerCase();
    return normalized.includes('custom instruction') || normalized.includes('custom instructions') || String(label||'').includes('補充其他指示') || String(label||'').includes('其他指示') || String(label||'').includes('自訂指示');
  }
  async function api(path, options){ const r=await fetch(path,{headers:{'content-type':'application/json'},...options}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
  async function respondOnly(sessionId, requestId, body){ await api(`/api/sessions/${encodeURIComponent(sessionId)}/extension-ui/respond`, {method:'POST', body:JSON.stringify({requestId,...body})}); }
  async function respond(sessionId, requestId, body){ await respondOnly(sessionId,requestId,body); closeModal(); }
  function closeModal(){ document.getElementById('ivy-extui-overlay')?.remove(); STATE.currentId=null; STATE.busy=false; STATE.inlineCustomSubmitting=false; }
  function setDisabled(elements, disabled){ for(const element of elements){ if(element) element.disabled=disabled; } }
  async function waitForInputRequest(sessionId, previousRequestId){
    const start=Date.now();
    while(Date.now()-start<CUSTOM_INPUT_TIMEOUT_MS){
      const data=await api(`/api/sessions/${encodeURIComponent(sessionId)}/extension-ui/pending`);
      const req=(data.requests||[]).find((item)=>item && item.method==='input' && item.requestId!==previousRequestId);
      if(req) return req;
      await new Promise((resolve)=>setTimeout(resolve,250));
    }
    return null;
  }
  async function submitInlineCustomInstruction(sessionId, selectReq, optionValue, textarea, status, error, controls){
    const value=textarea.value.trim();
    error.textContent=''; status.textContent='';
    if(!value){ error.textContent='請先輸入補充指示；空白不會送出，以避免誤觸 fail-closed。'; textarea.focus(); return; }
    setDisabled(controls,true); STATE.busy=true; STATE.inlineCustomSubmitting=true; status.textContent='Submitting custom instruction…';
    try{
      await respondOnly(sessionId,selectReq.requestId,{value:optionValue});
      status.textContent='Waiting for Pi input request…';
      const inputReq=await waitForInputRequest(sessionId,selectReq.requestId);
      if(!inputReq) throw new Error('Timed out waiting for Pi input request. Please cancel and retry.');
      status.textContent='Sending custom instruction…';
      await respondOnly(sessionId,inputReq.requestId,{value});
      closeModal();
    }catch(e){
      STATE.inlineCustomSubmitting=false; STATE.busy=false; STATE.currentId=selectReq.requestId;
      setDisabled(controls,false);
      status.textContent='';
      error.textContent=e instanceof Error ? e.message : String(e);
    }
  }
  function renderInlineCustomPanel(sessionId, req, optionValue, triggerButton){
    let panel=document.getElementById('ivy-extui-inline-custom');
    if(panel){ panel.classList.add('open'); panel.querySelector('textarea')?.focus(); return; }
    const actions=document.querySelector('.ivy-extui-actions');
    if(!actions) return;
    panel=document.createElement('div'); panel.id='ivy-extui-inline-custom'; panel.className='ivy-extui-inline-custom open';
    const title=document.createElement('div'); title.className='ivy-extui-inline-title'; title.textContent='Provide custom instruction / 我要補充其他指示'; panel.appendChild(title);
    const textarea=document.createElement('textarea'); textarea.className='ivy-extui-textarea'; textarea.placeholder='請在此輸入要補充給 Coordinator 的限制、偏好或修正方向…'; panel.appendChild(textarea);
    const hint=document.createElement('div'); hint.className='ivy-extui-muted'; hint.textContent='送出後，PI WEB 會在背景完成 Question Gate 的兩段式回覆；畫面不會切到另一張 Input Gate。'; panel.appendChild(hint);
    const error=document.createElement('div'); error.className='ivy-extui-error'; panel.appendChild(error);
    const status=document.createElement('div'); status.className='ivy-extui-status'; panel.appendChild(status);
    const row=document.createElement('div'); row.className='ivy-extui-row';
    const cancel=document.createElement('button'); cancel.className='ivy-extui-btn ivy-extui-danger'; cancel.textContent='Cancel / Fail closed'; cancel.onclick=()=>respond(sessionId,req.requestId,{cancelled:true});
    const submit=document.createElement('button'); submit.className='ivy-extui-btn ivy-extui-primary'; submit.textContent='Submit custom instruction';
    submit.onclick=()=>submitInlineCustomInstruction(sessionId,req,optionValue,textarea,status,error,[textarea,cancel,submit,triggerButton]);
    textarea.addEventListener('input',()=>{ error.textContent=''; });
    row.append(cancel,submit); panel.appendChild(row);
    actions.after(panel);
    setTimeout(()=>textarea.focus(),50);
  }
  function render(sessionId, req){
    ensureStyle(); STATE.currentId=req.requestId;
    document.getElementById('ivy-extui-overlay')?.remove();
    const overlay=document.createElement('div'); overlay.id='ivy-extui-overlay'; overlay.className='ivy-extui-overlay';
    const card=document.createElement('div'); card.className='ivy-extui-card'; overlay.appendChild(card);
    const head=document.createElement('div'); head.className='ivy-extui-head'; head.textContent=req.method==='select'?'Ivyhouse Question Gate':req.method==='confirm'?'Ivyhouse Confirm Gate':'Ivyhouse Input Gate'; card.appendChild(head);
    const body=document.createElement('div'); body.className='ivy-extui-body'; body.textContent=req.title || req.message || ''; card.appendChild(body);
    if(req.method==='select'){
      const actions=document.createElement('div'); actions.className='ivy-extui-actions'; card.appendChild(actions);
      for(const opt of (req.options||[])){
        const b=document.createElement('button'); b.className='ivy-extui-btn'; b.textContent=opt;
        b.onclick=()=>{ if(isCustomInstructionOption(opt)) renderInlineCustomPanel(sessionId,req,opt,b); else respond(sessionId,req.requestId,{value:opt}); };
        actions.appendChild(b);
      }
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
    if(STATE.busy || STATE.inlineCustomSubmitting) return; const sid=selectedSessionId(); if(!sid) return; STATE.busy=true;
    try{ const data=await api(`/api/sessions/${encodeURIComponent(sid)}/extension-ui/pending`); const req=(data.requests||[])[0]; if(req && req.requestId!==STATE.currentId) render(sid,req); if(!req && STATE.currentId) closeModal(); }catch(_e){} finally{ STATE.busy=false; }
  }
  setInterval(poll, 1000); window.addEventListener('focus', poll); setTimeout(poll, 1200);
})();
