import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModel, loadInspector, localChange, applyResult } from '../ui/model.js';
import { capture, inspectorKey, planRestore, previewURL, handoff } from '../ui/workspace-model.js';
import { TweakSession } from '../agent/lib/session.mjs';
import { resolveDefinition } from '../agent/lib/definition.mjs';
import { tmpProject, read, def, lineOf } from './helpers.mjs';
const fixture=()=>{const m=createModel();loadInspector(m,{projectKey:'project-a',scope:'movement',params:[{id:'gravity',label:'Gravity',source:'src/config.ts:2',kind:'number',control:'slider',min:0,max:4000,step:10,integer:true,value:1800,original:1800}]});return m;};

test('presets and handoffs refuse optimistic or rejected values',()=>{
  const m=fixture();localChange(m,'gravity',1200);
  assert.throws(()=>capture(m,'bad'),/acknowledged/);
  assert.throws(()=>handoff(m,'','',''),/acknowledged/);
  applyResult(m,{id:'gravity',ok:false,message:'stale'});
  assert.throws(()=>capture(m,'bad'),/acknowledged/);
  applyResult(m,{id:'gravity',ok:true,value:1200});
  assert.equal(capture(m,'good').params[0].value,1200);
  assert.match(handoff(m,'jump feel','more control','refresh required'),/already written/);
  assert.match(handoff(m,'jump feel','more control','refresh required'),/src\/config.ts:2/);
});
test('preset restore rejects a different project, moved mapping, duplicate ids or invalid ranges before sending any change',()=>{
  const m=fixture(),p=capture(m,'A');
  m.view.projectKey='project-b';assert.throws(()=>planRestore(m,p),/different project/);
  m.view.projectKey='project-a';m.params.get('gravity').source='src/config.ts:3';assert.throws(()=>planRestore(m,p),/source mapping/);
  m.params.get('gravity').source='src/config.ts:2';p.params[0].value=9000;assert.throws(()=>planRestore(m,p),/no longer fits/);
  p.params[0].value=1200;assert.deepEqual(planRestore(m,p),[{id:'gravity',value:1200}]);
  p.params.push(p.params[0]);assert.throws(()=>planRestore(m,p),/incomplete/);
});
test('app launch links accept dev servers but refuse executable, credential-bearing and nonlocal HTTP URLs',()=>{
  assert.equal(previewURL('http://localhost:5173/'),'http://localhost:5173/');
  assert.equal(previewURL('https://example.org/demo'),'https://example.org/demo');
  for(const url of ['javascript:alert(1)','file:///etc/passwd','http://example.org','https://u:p@example.org','https://example.org/?token=secret'])assert.throws(()=>previewURL(url));
});
test('an acknowledged preset round-trips through the actual source resolver/session',async()=>{
  const root=tmpProject(),file='src/config.ts',s=new TweakSession({root});
  s.load(resolveDefinition(def([{id:'gravity',file,line:lineOf(root,file,'gravity:'),literal:'1800',min:0,max:4000}]),root));
  const m=createModel();loadInspector(m,s.view());const preset=capture(m,'Original');
  assert.equal(m.view.projectKey.length,24);assert.ok(!m.view.projectKey.includes(root));
  const evt=localChange(m,'gravity',1200),r=await s.set(evt.id,evt.value);applyResult(m,{...r,n:evt.n});
  assert.match(read(root,file),/gravity: 1200/);
  const hand=handoff(m,'control','slower fall','new Simulation');assert.match(hand,/1800 → 1200/);
  for(const item of planRestore(m,preset)){const result=await s.set(item.id,item.value);assert.equal(result.ok,true);}
  assert.match(read(root,file),/gravity: 1800/);
  assert.equal(inspectorKey(m),preset.key);
});
