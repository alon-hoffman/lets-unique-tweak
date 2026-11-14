#!/usr/bin/env node
/** Launch the existing Lets engine + existing Tweak agent + the actual Ink Skater dev server. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { inkSkaterDefinition } from './ink-skater.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
if(args.includes('--help')){console.log('node workspace/run.mjs --project /path/to/ink-skater --lets /path/to/lets [--port 4173] [--app-port 5173]\nUses the current checkouts without copying or rewriting the game. Install Ink Skater dependencies first.');process.exit(0);}
const project=fs.realpathSync(option('project',path.join(root,'..','ink-skater'))), letsRepo=path.resolve(option('lets',path.join(root,'..','lets')));
const vite=path.join(project,'node_modules','vite','bin','vite.js'), engineFile=path.join(letsRepo,'engine','src','engine.mjs');
for(const file of [vite,engineFile])if(!fs.existsSync(file))throw new Error(`Missing ${file}. Clone Lets and install Ink Skater dependencies before launching.`);
const definition=inkSkaterDefinition(project); // fail before starting processes if the current source cannot be mapped
const registry=fs.mkdtempSync(path.join(os.tmpdir(),'tweak-workspace-'));
fs.symlinkSync(root,path.join(registry,'tweak'),process.platform==='win32'?'junction':'dir');
process.env.LETS_UNIQUES_DIRS=[process.env.LETS_UNIQUES_DIRS,registry].filter(Boolean).join(path.delimiter);
process.env.LETS_NO_DEFAULTS='1';
const {createEngine}=await import(pathToFileURL(engineFile));
const {Agent,stateFileFor}=await import('../agent/lib/daemon.mjs');
const {TweakSession}=await import('../agent/lib/session.mjs');
const {resolveDefinition}=await import('../agent/lib/definition.mjs');
const {Lip}=await import('../agent/lib/lip.mjs');
const appPort=Number(option('app-port','5173'));
if(!Number.isInteger(appPort)||appPort<1024||appPort>65535)throw new Error('Invalid app port');
const child=spawn(process.execPath,[vite,'--host','127.0.0.1','--port',String(appPort),'--strictPort'],{cwd:project,stdio:['ignore','pipe','pipe']});
let appOutput='';child.stdout.on('data',b=>{appOutput+=b;});child.stderr.on('data',b=>process.stderr.write(b));
let engine,agent,exiting=false;
function cleanup(){if(exiting)return;exiting=true;agent?.stop();child.kill();engine?.stop();fs.rmSync(registry,{recursive:true,force:true});}
process.on('exit',cleanup);process.on('SIGINT',()=>{cleanup();process.exit(0);});process.on('SIGTERM',()=>{cleanup();process.exit(0);});
child.on('error',e=>{console.error(e.message);cleanup();process.exitCode=1;});
child.on('exit',code=>{if(!exiting){console.error(`Ink Skater dev server stopped (${code}).`);cleanup();process.exitCode=1;}});
try {
  let ready=false;
  for(let i=0;i<100;i++){if(exiting)throw new Error('App server failed to start');if(/Local:.*http/.test(appOutput)){ready=true;break;}await new Promise(r=>setTimeout(r,100));}
  if(!ready)throw new Error('Timed out starting Ink Skater.');
  engine=await createEngine({projectDir:project,port:Number(option('port','4173')),log:()=>{}});
  const {url,windowId}=engine.host.windowUrl('tweak');
  const resolved=resolveDefinition(definition,project);
  resolved.workspace={name:'Ink Skater',url:`http://127.0.0.1:${appPort}/`,evaluation:'Does movement feel controllable? Compare jumps, acceleration, and recovery on the same level.',limits:'Actual unmodified Ink Skater checkout. Vite handles source edits. physicsConfig imports can trigger a reload and reset the run; gravity is read when Simulation is constructed. Source acknowledgement is not proof that an existing physics body changed.'};
  const session=new TweakSession({root:project,stateFile:stateFileFor(windowId)});session.load(resolved);
  agent=new Agent({lip:new Lip({port:engine.host.port,token:engine.host.token}),log:m=>console.error(m)});
  console.log(`Tweak workspace: ${url}\nInk Skater: http://127.0.0.1:${appPort}/\nKeep both windows beside each other. Ctrl+C stops this launcher; source edits remain uncommitted.`);
  await agent.run();
  cleanup();
} catch(e){cleanup();throw e;}
