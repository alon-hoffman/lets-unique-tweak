/**
 * End to end, with the real pieces: an in-process lets host (the actual engine),
 * the real lets-tweak CLI spawning the real agent, and a fake window that speaks
 * LIP exactly as the browser does (SSE down, POST /lip/event up).
 *
 * Needs a checkout of the lets repo next to this one (../lets) or LETS_REPO.
 * The proof of "no AI on adjustments": every MCP tool is wrapped with a counter, and the `claude` and
 * `hook` cursors, the only doors through which events reach a model, must stay untouched while
 * hundreds of adjustments are applied.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, tmpProject, read, write, lineOf } from './helpers.mjs';
import { sleep, until, fakeWindow, cli } from './harness.mjs';

const LETS = path.resolve(process.env.LETS_REPO || path.join(ROOT, '..', 'lets'));
const HAVE_LETS = fs.existsSync(path.join(LETS, 'engine', 'src', 'engine.mjs'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tweak-home-'));
process.env.LETS_HOME = HOME;
process.env.LETS_NO_DEFAULTS = '1';
const UNIQUES = path.join(HOME, 'uniques-dev');
process.env.LETS_UNIQUES_DIRS = UNIQUES;

const CFG = 'src/config.ts';
let engine; let toolCalls = 0; let win; let project; let agentPid;

function writeDef(name, params, extra = {}) {
  const file = path.join(HOME, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ scope: name, title: name, summary: 'test scope', params, ...extra }));
  return file;
}
const P = (id, needle, literal, more = {}) => ({ id, label: id, group: 'G', file: CFG, line: lineOf(project, CFG, needle), literal, ...more });

before(async () => {
  if (!HAVE_LETS) return;
  fs.mkdirSync(path.join(UNIQUES, 'tweak'), { recursive: true });
  for (const f of ['unique.json', 'GUIDE.md', 'icon.svg']) fs.copyFileSync(path.join(ROOT, f), path.join(UNIQUES, 'tweak', f));
  fs.cpSync(path.join(ROOT, 'ui'), path.join(UNIQUES, 'tweak', 'ui'), { recursive: true });
  const { createEngine } = await import(pathToFileURL(path.join(LETS, 'engine', 'src', 'engine.mjs')).href);
  engine = await createEngine({ projectDir: ROOT, port: 0, log: () => {} });
  for (const t of engine.tools) { const h = t.handler; t.handler = (...a) => { toolCalls++; return h.apply(t, a); }; }
  project = tmpProject();
});

after(async () => {
  win?.close();
  try { process.kill(agentPid); } catch { /* not running */ }
  engine?.stop();
  await sleep(200);
});

test('the lets host accepts the unique: manifest valid, web mode, page and sdk served', { skip: !HAVE_LETS && 'lets checkout not found' }, async () => {
  const u = engine.host.registry.get('tweak');
  assert.equal(u.ok, true, (u.problems || []).join('; '));
  assert.deepEqual(u.modes, ['web']);
  const h = engine.host;
  const page = await fetch(`${h.origin}/u/tweak/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  for (const f of ['app.js', 'model.js', 'style.css']) assert.equal((await fetch(`${h.origin}/u/tweak/${f}`)).status, 200, f);
});

test('check resolves discovery without a window and reports bad hints with exit code 2', { skip: !HAVE_LETS && 'lets checkout not found' }, async () => {
  const ok = await cli('check', writeDef('chk', [P('g', 'gravity:', '1800', { min: 0, max: 4000 })]), '--project', project);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.json.params[0].source, /src\/config\.ts:\d+/);
  const bad = await cli('check', writeDef('chk2', [P('g', 'gravity:', '999')]), '--project', project);
  assert.equal(bad.status, 2);
  assert.match(bad.json.error, /not found/);
});

test('open → inspector in the window, many adjustments, no model involved, undo, revert', { skip: !HAVE_LETS && 'lets checkout not found' }, async () => {
  const original = read(project, CFG);
  const { windowId } = engine.host.windowUrl('tweak');
  win = await fakeWindow(engine.host, windowId);
  const def = writeDef('movement', [
    P('gravity', 'gravity:', '1800', { label: 'Gravity', group: 'World', min: 0, max: 4000, step: 10 }),
    P('trails', 'trails:', 'true', { label: 'Trails' }),
    P('accent', 'accent:', "'#A66BFF'", { label: 'Accent' }),
    P('mode', 'mode:', "'normal'", { options: ['normal', 'hard'] }),
    P('jump', 'speed: 5', '5', { nth: 2, min: 0, max: 20 }),
  ]);
  const o = await cli('open', def, '--project', project, '--window', windowId);
  assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.equal(o.json.params, 5);
  agentPid = o.json.agent.pid;

  // the inspector arrives as a plain LIP command; it carries values and controls, no paths beyond the display label
  const insp = await until(() => win.last('tweak.inspector'), 5000, 'tweak.inspector');
  assert.equal(insp.data.params.length, 5);
  assert.deepEqual(insp.data.params.map((p) => p.control), ['slider', 'toggle', 'color', 'segmented', 'slider']);
  assert.ok(!JSON.stringify(insp.data).includes(project.replace(/\\/g, '\\\\')));
  await until(() => win.last('tweak.agent'), 8000, 'agent heartbeat');

  const callsBefore = toolCalls;
  const cursorsBefore = new Map(engine.host.bus.cursors);

  // a drag: 200 changes of one slider, as fast as the loop allows, then a toggle and a color
  for (let n = 1; n <= 200; n++) await win.emit('tweak.set', { id: 'gravity', value: 1000 + n * 5, n });
  await win.emit('tweak.set', { id: 'trails', value: false, n: 201 });
  await win.emit('tweak.set', { id: 'accent', value: '#00ff88', n: 202 });
  await win.emit('tweak.set', { id: 'mode', value: 'hard', n: 203 });
  await win.emit('tweak.set', { id: 'jump', value: 9, n: 204 });
  await until(() => win.results().some((r) => r.data.id === 'jump' && r.data.n === 204), 8000, 'last result');

  const after1 = read(project, CFG);
  assert.equal(after1, original
    .replace('gravity: 1800,', 'gravity: 2000,').replace('trails: true,', 'trails: false,')
    .replace("'#A66BFF'", "'#00FF88'").replace("'normal'", "'hard'").replace('jumpSpeed: 5,', 'jumpSpeed: 9,'));

  // 204 adjustments, and not one went through a model
  assert.equal(toolCalls, callsBefore, 'no MCP tool (the only way Claude acts) was called');
  assert.equal(engine.host.bus.cursors.get('claude'), cursorsBefore.get('claude'), 'the claude cursor never moved');
  assert.equal(engine.host.bus.cursors.get('hook'), cursorsBefore.get('hook'), 'the hook cursor never moved');
  const state = JSON.parse(fs.readFileSync(path.join(HOME, 'tweak', windowId, 'state.json'), 'utf8'));
  assert.ok(state.stats.writes < 120, `drag was coalesced: ${state.stats.writes} writes for 204 changes`);
  assert.equal(win.last('tweak.result').data.changed, 5);
  // with a host that knows `quiet`, the prompt hook has nothing to say about the drag either
  if (engine.host.bus.quiet) {
    const bus = engine.host.bus;
    const seen = bus.ring.filter((e) => e.msg.type.startsWith('tweak.') && !bus._hidden('hook', e.msg) && !bus._hidden('claude', e.msg));
    assert.deepEqual(seen.map((e) => e.msg.type), [], 'neither the prompt hook nor listen would show tweak.set');
  }

  // undo: the whole drag is one step; the rest follow
  await win.emit('tweak.undo', { n: 300 });
  await until(() => win.results().some((r) => r.data.op === 'undo'), 5000, 'undo result');
  assert.ok(read(project, CFG).includes('jumpSpeed: 5,') && read(project, CFG).includes('gravity: 2000,'));

  // revert one parameter, then everything
  await win.emit('tweak.revert', { id: 'gravity', n: 301 });
  await until(() => win.results().some((r) => r.data.op === 'revert' && r.data.ok), 5000, 'revert result');
  assert.ok(read(project, CFG).includes('gravity: 1800,'));
  await win.emit('tweak.revertAll', { n: 302 });
  await until(() => win.results().some((r) => r.data.op === 'revertAll' && r.data.ok), 5000, 'revertAll result');
  assert.equal(read(project, CFG), original, 'every change reverted, byte for byte');
  assert.equal(win.last('tweak.result').data.changed, 0);
  assert.equal(toolCalls, callsBefore);
});

test('the window cannot name files, forge other uniques or reach unknown ids', { skip: !HAVE_LETS && 'lets checkout not found' }, async () => {
  const before = read(project, CFG);
  const injectedPath = path.resolve(project, '../../etc/passwd');
  const injectedBefore = fs.existsSync(injectedPath) ? fs.readFileSync(injectedPath) : null;
  /** send one event and wait for its own answer, so each case is judged on its own */
  let n = 1000;
  const ask = async (type, data, from) => {
    const mine = ++n;
    await (from || win).emit(type, { ...data, n: mine });
    return (await until(() => win.results().find((r) => r.data.n === mine), 5000, `answer to ${type} ${JSON.stringify(data)}`)).data;
  };
  const rejected = [
    await ask('tweak.set', { id: '../../x', value: 1 }),
    await ask('tweak.set', { id: 'nope', value: 1 }),
    await ask('tweak.set', { id: 'gravity', value: 'DROP TABLE' }),
    await ask('tweak.set', { id: 'gravity', value: 99999 }),                      // outside the slider's range
    await ask('tweak.set', { id: 'accent', value: "'; process.exit(1); //" }),
  ];
  assert.ok(rejected.every((r) => r.ok === false), JSON.stringify(rejected.map((r) => r.code)));
  assert.equal(read(project, CFG), before, 'nothing was written for any of them');
  // extra fields (a file, a path) are not part of the contract and are ignored: the id alone decides what is edited
  const ok = await ask('tweak.set', { id: 'gravity', value: 5, file: '../../etc/passwd', path: 'x' });
  assert.equal(ok.ok, true);
  assert.equal(read(project, CFG), before.replace('gravity: 1800,', 'gravity: 5,'));
  assert.deepEqual(fs.existsSync(injectedPath) ? fs.readFileSync(injectedPath) : null, injectedBefore, 'the injected path is untouched, even if it already exists');
  // a window of another unique cannot drive the agent
  const impostor = await fakeWindow(engine.host, 'wimpostor', 'graph');
  await impostor.emit('tweak.set', { id: 'gravity', value: 7 });
  await sleep(500);
  assert.equal(impostor.results().length, 0);
  assert.equal(read(project, CFG), before.replace('gravity: 1800,', 'gravity: 5,'));
  impostor.close();
  assert.equal((await ask('tweak.revert', { id: 'gravity' })).ok, true);
  assert.equal(read(project, CFG), before);
});

test('a new scope opens on the same window; old changes remain revertable', { skip: !HAVE_LETS && 'lets checkout not found' }, async () => {
  const original = read(project, CFG);
  await win.emit('tweak.set', { id: 'trails', value: false, n: 500 });
  await until(() => win.last('tweak.result').data.id === 'trails' && win.last('tweak.result').data.ok);
  const def2 = writeDef('scoring', [P('bonus', 'const bonus', '5', { label: 'Bonus', min: 0, max: 50 })]);
  const o = await cli('open', def2, '--project', project, '--window', win.id);
  assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.equal(o.json.agent.started, false, 'the running agent is reused');
  const insp = await until(() => win.got.filter((m) => m.type === 'tweak.inspector').find((m) => m.data.scope === 'scoring'), 5000, 'second inspector');
  assert.equal(insp.data.params.length, 1);
  assert.equal(insp.data.changed, 1, 'the earlier scope\'s change is counted');
  // old ids are no longer addressable by the new inspector
  await win.emit('tweak.set', { id: 'trails', value: true, n: 501 });
  await win.emit('tweak.set', { id: 'bonus', value: 12, n: 502 });
  await until(() => win.results().some((r) => r.data.n === 502 && r.data.ok));
  assert.ok(read(project, CFG).includes('const bonus = 12;') && read(project, CFG).includes('trails: false,'));
  await win.emit('tweak.revertAll', { n: 503 });
  await until(() => win.results().some((r) => r.data.n === 503 && r.data.ok), 5000, 'revertAll of both scopes');
  assert.equal(read(project, CFG), original);
});

test('stale code and outside edits are reported to the window, never overwritten', { skip: !HAVE_LETS && 'lets checkout not found' }, async () => {
  write(project, CFG, read(project, CFG).replace('const bonus = 5;', 'const bonus = 8;'));
  const edited = read(project, CFG);
  await win.emit('tweak.set', { id: 'bonus', value: 20, n: 600 });
  const r = await until(() => win.results().find((x) => x.data.n === 600), 5000, 'result');
  assert.equal(r.data.ok, false);
  assert.equal(r.data.code, 'changed');
  assert.equal(r.data.value, 8);
  assert.equal(read(project, CFG), edited);
  write(project, CFG, edited.replace('const bonus = 8;', 'const bonus = pick();'));
  await win.emit('tweak.set', { id: 'bonus', value: 20, n: 601 });
  const s = await until(() => win.results().find((x) => x.data.n === 601), 5000, 'stale result');
  assert.equal(s.data.code, 'stale');
  assert.match(s.data.message, /re-discover|rediscover|Ask Claude/i);
});

test('the agent follows the documented lifecycle: own cursor, reads only tweak events, exits cleanly', { skip: !HAVE_LETS && 'lets checkout not found' }, async () => {
  const names = [...engine.host.bus.cursors.keys()];
  assert.ok(names.some((n) => n.startsWith('tweak-')), `agent has its own named cursor (${names.join(', ')})`);
  assert.ok(!names.includes('claude') && !names.includes('hook'));
  process.kill(agentPid);
  await sleep(300);
  await win.emit('tweak.set', { id: 'bonus', value: 1, n: 700 });
  await sleep(600);
  assert.equal(win.results().find((x) => x.data.n === 700), undefined, 'with the agent gone nothing is applied (the window shows no answer)');
});
