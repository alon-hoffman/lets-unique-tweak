#!/usr/bin/env node
/**
 * lets-tweak: the command-line half Claude uses once per scope.
 *
 *   lets-tweak open <definition.json> --window <id> [--project <dir>]
 *       validate and resolve the discovery, activate it for the window, make sure
 *       the agent is running, and show the inspector in the window
 *   lets-tweak check <definition.json> [--project <dir>]
 *       the same validation and resolution, no window and no writes
 *   lets-tweak status --window <id>
 *   lets-tweak revert-all --window <id>
 *   lets-tweak serve --port <host port>
 *       run the agent in the foreground (`open` starts it for you)
 *
 * Output is one line of JSON; exit code 0 ok, 2 the definition did not resolve, 1 anything else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDefinition } from '../lib/definition.mjs';
import { TweakError } from '../lib/literal.mjs';
import { TweakSession } from '../lib/session.mjs';
import { Agent, stateFileFor, safeId } from '../lib/daemon.mjs';
import { findHost, runFiles, Lip, TWEAK_HOME } from '../lib/lip.mjs';

const SELF = fileURLToPath(import.meta.url);
const MAX_DEFINITION = 256 * 1024;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

// no process.exit(): on Windows it can race open sockets (a libuv assertion); the event loop drains and exits by itself
const out = (o, code = 0) => { process.exitCode = code; process.stdout.write(JSON.stringify(o) + '\n'); };

function readDefinition(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_DEFINITION) throw new TweakError('definition', 'the definition file is larger than 256 KB');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new TweakError('definition', `the definition is not valid JSON: ${e.message}`); }
}

function agentFile(port) { return path.join(TWEAK_HOME, `agent-${port}.json`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function ensureAgent(lip) {
  let info = null;
  try { info = JSON.parse(fs.readFileSync(agentFile(lip.port), 'utf8')); } catch { /* none */ }
  if (info && alive(info.pid)) return { running: true, started: false, pid: info.pid };
  fs.mkdirSync(TWEAK_HOME, { recursive: true });
  const log = fs.openSync(path.join(TWEAK_HOME, 'agent.log'), 'a');
  const child = spawn(process.execPath, [SELF, 'serve', '--port', String(lip.port)], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { const j = JSON.parse(fs.readFileSync(agentFile(lip.port), 'utf8')); if (alive(j.pid)) return { running: true, started: true, pid: j.pid }; } catch { /* wait */ }
  }
  throw new Error(`the agent did not start; see ${path.join(TWEAK_HOME, 'agent.log')}`);
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  const project = path.resolve(String(opt.project || process.cwd()));

  if (cmd === 'check') {
    const def = resolveDefinition(readDefinition(path.resolve(pos[1])), project);
    return out({ ok: true, scope: def.scope, params: def.params.map((p) => ({ id: p.id, source: `${p.file}:${p.line}`, literal: p.mapping.text, control: p.control, unique: p.mapping.before.length > 0 })) });
  }

  if (cmd === 'open') {
    const w = safeId(String(opt.window || ''));
    const lip = await findHost({ windowId: w, port: opt['host-port'] });
    const def = resolveDefinition(readDefinition(path.resolve(pos[1])), project);
    const file = stateFileFor(w);
    let session;
    try { session = TweakSession.restore(file); if (session.root !== fs.realpathSync(project)) throw new Error('other project'); } catch { session = new TweakSession({ root: project, stateFile: file }); }
    session.stateFile = file;
    const view = session.load(def);
    const agent = await ensureAgent(lip);
    await lip.command('tweak.inspector', { ...view, changed: session.changedCount(), canUndo: session.journal.length > 0 }, w);
    return out({ ok: true, scope: def.scope, params: def.params.length, window: w, project: session.root, agent });
  }

  if (cmd === 'status' || cmd === 'revert-all') {
    const w = safeId(String(opt.window || ''));
    const session = TweakSession.restore(stateFileFor(w));
    if (cmd === 'revert-all') { const r = await session.revertAll(); return out({ ...r, changed: session.changedCount() }, r.ok ? 0 : 1); }
    return out({ ok: true, scope: session.def?.scope, changed: session.changedCount(), changes: session.allParams().filter((p) => p.currentText !== p.originalText).map((p) => ({ id: p.id, file: p.file, from: p.originalText, to: p.currentText })), stats: session.stats });
  }

  if (cmd === 'serve') {
    const port = Number(opt.port);
    const run = runFiles().find((r) => r.port === port);
    if (!run) throw new Error(`no lets host on port ${port}`);
    fs.mkdirSync(TWEAK_HOME, { recursive: true });
    const agent = new Agent({ lip: new Lip(run), log: (m) => console.error(`[tweak ${new Date().toISOString()}] ${m}`) });
    const file = agentFile(port);
    const cleanup = () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch { /* gone */ } };
    process.on('SIGINT', () => { agent.stop(); cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { agent.stop(); cleanup(); process.exit(0); });
    await agent.run({ onReady: () => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, started: Date.now() })) });
    cleanup();
    return;
  }

  out({ ok: false, error: 'usage: lets-tweak open|check|status|revert-all|serve …' }, 1);
}

main().catch((err) => {
  if (err instanceof TweakError) return out({ ok: false, code: err.code, error: err.message, problems: err.problems }, 2);
  out({ ok: false, error: err.message }, 1);
});
