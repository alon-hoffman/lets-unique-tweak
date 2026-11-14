import { capture, inspectorKey, planRestore, previewURL, handoff, ideas } from './workspace-model.js';

/** Adds a workspace to the real inspector. All writes use its existing change() → LIP → TweakSession path. */
export function mountWorkspace({ model, change, lets, shell }) {
  const host = document.getElementById('workspace'), toggle = document.getElementById('workspaceToggle');
  let db = { demos: [], presets: [], notes: [] }, project = '', active = '', visible = false, applying = false;
  const make = (tag, text, props = {}) => {
    const e = document.createElement(tag); if (text) e.textContent = text;
    for (const [k,v] of Object.entries(props)) { if (k.startsWith('on')) e.addEventListener(k.slice(2),v); else e.setAttribute(k,v); }
    return e;
  };
  const button = (name, fn) => make('button', name, { type:'button', class:'lets-btn lets-btn-sm', onclick:fn });
  const say = text => { status.hidden = !text; status.textContent = text; };
  const save = () => { try { localStorage.setItem('tweak-workspace:'+project, JSON.stringify(db)); } catch { say('Browser storage failed. Export a backup before closing.'); } };
  const safe = fn => { try { fn(); } catch(e) { say(e.message); } };
  const status = make('p','', { class:'tw-away', role:'status', hidden:'' });
  let lastKey = ''; 
  function load() {
    const key = model.view?.projectKey;
    if (!key || key === project) return;
    project = key;
    try { const data = JSON.parse(localStorage.getItem('tweak-workspace:'+key)||'null'); db = data && Array.isArray(data.demos) && Array.isArray(data.presets) && Array.isArray(data.notes) ? data : {demos:[],presets:[],notes:[]}; } catch { db = {demos:[],presets:[],notes:[]}; }
    active = '';
  }
  function current() { return db.demos.find(d=>d.id===active); }
  function bound() { return current()?.scope === model.view?.scope; }
  function fields(form, entries) {
    const map = {};
    for (const [key,label,value,area] of entries) {
      const id = 'ws-'+key, input = make(area?'textarea':'input','',{ id, ...(area?{rows:3}:{type:'text'}), maxlength: key==='url'?1000:2000 });
      input.value = value || ''; form.append(make('label',label,{for:id}),input); map[key]=input;
    } return map;
  }
  function dialog(title, populate) {
    const d=make('dialog','',{class:'tw-dialog'}); d.append(make('h2',title)); populate(d); d.append(button('Close',()=>d.close())); d.addEventListener('close',()=>d.remove()); document.body.append(d);d.showModal();return d;
  }
  function editDemo(isNew=false, idea=null) {
    if (!project) return say('Open an inspector with the local Tweak agent before creating a workspace.');
    const old=isNew?null:current();
    dialog(isNew?'Add a real demo':'Demo brief', d=>{
      const f=make('form'), inputs=fields(f,[['name','Demo name',old?.name||idea?.[0]],['scope','What should the agent expose?',old?.scope||idea?.[1]||model.view?.scope],['url','Running app URL (optional)',old?.url],['evaluation','What are you evaluating?',old?.evaluation||idea?.[2],true],['limits','Reload / initialization / other limitations',old?.limits||'Unknown — verify in the running app.',true]]);
      const label=make('label','Evidence status'), select=make('select','',{'aria-label':'Evidence status'}); for(const s of ['Connected project','Exploratory idea']) select.append(make('option',s)); select.value=old?.status||'Exploratory idea';f.append(label,select);
      const error=make('p','',{role:'alert'});f.append(error,make('button','Save brief',{type:'submit',class:'lets-btn lets-btn-primary'}));
      f.onsubmit=e=>{e.preventDefault();try{if(!inputs.name.value.trim()||!inputs.scope.value.trim())throw new Error('Name and scope are required.');const item={id:old?.id||crypto.randomUUID(),name:inputs.name.value.trim().slice(0,80),scope:inputs.scope.value.trim().slice(0,80),url:previewURL(inputs.url.value),evaluation:inputs.evaluation.value.trim(),limits:inputs.limits.value.trim(),status:select.value};if(old)Object.assign(old,item);else db.demos.push(item);active=item.id;save();d.close();render();}catch(e){error.textContent=e.message;}};d.append(f);
    });
  }
  function requestScope() {
    if(!current())return;
    lets.emit('tweak.scope',{text:`${current().scope}. Human evaluation: ${current().evaluation}. Runtime limitations to verify: ${current().limits}`.slice(0,2000)});
    say(shell.listening?'Asked Claude to discover the real controls.':'Request queued. Send a message in Claude Code or run /lets tweak '+current().scope+' to pick it up.');
  }
  function render() {
    if(!visible)return;
    load();
    host.replaceChildren();
    const top=make('div','',{class:'ws-heading'});top.append(make('h2','Project workspace'),make('span','Same inspector. Same source files.',{class:'tw-dim'}));host.append(top);
    if(!project){host.append(make('p','Open a scope through the local Tweak agent to start. No project is connected yet.'));return;}
    if(!active)active=db.demos.find(d=>d.scope===model.view?.scope)?.id||db.demos[0]?.id||'';
    const bar=make('div','',{class:'ws-actions'}),select=make('select','',{'aria-label':'Demo catalog'});
    if(!db.demos.length) select.append(make('option','No demo briefs yet'));
    for(const demo of db.demos){const o=make('option',demo.name,{value:demo.id});select.append(o);}select.value=active;select.onchange=()=>{active=select.value;render();};bar.append(select,button('Add demo',()=>editDemo(true)),button('Re-read source',()=>{lets.emitNow('tweak.resync',{n:++model.n});say('Asked the local agent to re-read the mapped source values.');}),button('Export workspace',exportData));host.append(bar);
    const demo=current();
    if(demo){
      const card=make('div','',{class:'ws-card'});card.append(make('h3',demo.name),make('span',demo.status+' · '+(bound()?'scope open':'scope not open'),{class:'tw-agent'}));
      const links=make('div','',{class:'ws-actions'});links.append(button('Edit brief',()=>editDemo()),button('Ask Claude to expose controls',requestScope));
      if(demo.url){const a=make('a','Open real app ↗',{href:demo.url,target:'_blank',rel:'noopener noreferrer',class:'lets-btn lets-btn-primary lets-btn-sm'});links.append(a);}
      card.append(links,make('p',demo.evaluation||'Evaluation not recorded.'),make('p','Runtime: '+demo.limits,{class:'tw-dim'}),make('p','The real app opens in a companion tab. Keep it beside Tweak. Source edits use your existing watcher; reload the app when needed. No runtime injection or embedded recreation.',{class:'tw-fine tw-dim'}));host.append(card);
      const actions=make('div','',{class:'ws-actions'});actions.append(button('Save acknowledged preset',()=>safe(()=>{
        if(!bound())throw new Error('Open this demo’s scope before saving its values.');
        const snapshot=capture(model,'');
        dialog('Name this iteration',d=>{const form=make('form'),f=fields(form,[['preset','Preset name','']]);form.append(make('button','Save',{type:'submit',class:'lets-btn lets-btn-primary'}));form.onsubmit=e=>{e.preventDefault();snapshot.name=f.preset.value.trim().slice(0,80)||'Untitled';db.presets.push({...snapshot,demo:demo.id});save();d.close();render();};d.append(form);});
      })),button('Agent handoff',()=>safe(()=>{if(!bound())throw new Error('Open this demo’s scope first.');dialog('Return the decision to your agent',d=>{const form=make('div'),f=fields(form,[['reason','What did you decide, and why?','',true]]),out=make('textarea','',{rows:12,readonly:'','aria-label':'Agent handoff text'});const update=()=>{out.value=handoff(model,demo.evaluation,f.reason.value,demo.limits);};f.reason.oninput=()=>safe(update);update();d.append(form,out,button('Copy handoff',async()=>{try{await navigator.clipboard.writeText(out.value);say('Handoff copied. Paste it into your coding agent.');}catch{out.focus();out.select();say('Select and copy the handoff text.');}}));});})));host.append(actions);
      const presets=make('div','',{class:'ws-card'});presets.append(make('h3','Iterations'));
      const matching=db.presets.filter(p=>p.demo===demo.id);
      if(!matching.length)presets.append(make('p','No saved iterations yet.',{class:'tw-dim'}));
      for(const p of matching){const row=make('div','',{class:'ws-preset'});row.append(make('span',p.name+' · '+new Date(p.at).toLocaleDateString()),button('Compare',()=>compare(p)),button('Apply to source',()=>safe(()=>restore(p))),button('Remove',()=>{db.presets=db.presets.filter(x=>x.id!==p.id);save();render();}));presets.append(row);}host.append(presets);
      const notebook=make('div','',{class:'ws-card'});notebook.append(make('h3','Lessons & limitations'));const form=make('form'),f=fields(form,[['lesson','Record an observation, limitation, or question','',true]]);const types=make('select','',{'aria-label':'Lesson type'});for(const t of ['Observation','Limitation','Question','Future idea'])types.append(make('option',t));form.append(types,make('button','Record lesson',{type:'submit',class:'lets-btn lets-btn-sm'}));form.onsubmit=e=>{e.preventDefault();if(!f.lesson.value.trim())return;db.notes.push({id:crypto.randomUUID(),demo:demo.id,type:types.value,text:f.lesson.value.trim(),at:new Date().toISOString()});save();render();};notebook.append(form);for(const n of db.notes.filter(n=>n.demo===demo.id).slice().reverse()){notebook.append(make('p',n.type+': '+n.text));}host.append(notebook);
    }
    const catalog=make('details','',{class:'ws-card'});catalog.append(make('summary','Beyond games · unvalidated starting points'));for(const idea of ideas){const row=make('div','',{class:'ws-preset'});row.append(make('span',idea[0]+' · idea only'),button('Start a brief',()=>editDemo(true,idea)));catalog.append(row);}host.append(catalog,status);
  }
  function restore(p) {
    if(applying)throw new Error('A preset is already being applied.');
    if(!bound())throw new Error('Open this demo’s scope first.');
    capture(model,'check'); // refuses pending/error states
    const plan=planRestore(model,p);
    dialog('Apply preset to source?',d=>{
      d.append(make('p','This writes '+plan.length+' values through the existing local Tweak agent. Each value is independently validated. Watch the inspector for errors; a multi-value preset is not an atomic transaction. Undo and Revert all remain available. Reload the real app if needed.'));
      d.append(button('Apply selected values',()=>{applying=true;for(const item of plan)change(item.id,item.value,{final:true});d.close();say('Preset sent to the local agent. Check each control’s acknowledgement; runtime refresh is separate.');setTimeout(()=>{applying=false;},500);}));
    });
  }
  function compare(p){safe(()=>{
    if(!bound())throw new Error('Open this demo’s scope first.');const now=capture(model,'Current');if(p.key!==inspectorKey(model))throw new Error('This snapshot’s project or source mapping differs. Rediscover before comparing.');
    dialog('Saved iteration / current source',d=>{const table=make('table');const tr=make('tr');['Parameter','Saved','Current','Delta'].forEach(t=>tr.append(make('th',t)));table.append(tr);for(const old of p.params){const n=now.params.find(x=>x.id===old.id);const row=make('tr');[old.label,String(old.value),String(n.value),typeof n.value==='number'?String(Number((n.value-old.value).toFixed(6))):(n.value===old.value?'same':'changed')].forEach(t=>row.append(make('td',t)));table.append(row);}d.append(table,make('p','Values only. Apply either direction and evaluate in the real running app. No screenshot or runtime-state comparison is implied.',{class:'tw-dim'}));});
  });}
  function exportData(){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify({version:1,project,...db},null,2)],{type:'application/json'}));a.href=url;a.download='lets-tweak-workspace.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);say('Exported briefs, presets, and notes. Source files remain in your project.');}
  toggle.onclick=()=>{visible=!visible;toggle.setAttribute('aria-expanded',String(visible));host.hidden=!visible;document.querySelector('.tw').classList.toggle('tw-wide',visible);render();};
  return {sync(){
    load();
    const seed=model.view?.workspace;
    if(seed && project && !db.demos.some(d=>d.scope===model.view.scope)) {
      try { db.demos.push({id:crypto.randomUUID(),name:String(seed.name).slice(0,80),scope:model.view.scope,url:previewURL(seed.url),evaluation:String(seed.evaluation||''),limits:String(seed.limits||''),status:'Connected project'});save(); }catch(e){say(e.message);}
    }
    const key=inspectorKey(model);
    if(key!==lastKey){lastKey=key;active=db.demos.find(d=>d.scope===model.view?.scope)?.id||'';if(seed&&!visible)toggle.click();else render();}
  }};
}
