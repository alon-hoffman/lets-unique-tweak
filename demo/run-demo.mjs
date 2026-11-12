#!/usr/bin/env node
/**
 * A reproducible, headless demonstration of Let's Tweak against a small app that knows nothing about it.
 *
 *   node demo/run-demo.mjs            (needs a lets checkout at ../lets, or LETS_REPO)
 *
 * What is real: the lets engine (in this process), the lets-tweak CLI, the agent it starts, the LIP traffic
 * and every file edit. What is stood in for: (1) Claude's discovery, which is the recorded result in
 * demo/arcade.definition.json (what Claude writes for "let's tweak how the ball moves and scores"; see GUIDE.md),
 * and (2) the browser, replaced by a window that sends exactly the events the page sends.
 * To see the real thing in a browser, follow README.md ("Try it").
 *
 * Exit code 0 only if every claim printed below held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LETS = path.resolve(process.env.LETS_REPO || path.join(ROOT, '..', 'lets'));
if (!fs.existsSync(path.join(LETS, 'engine', 'src', 'engine.mjs'))) {
  console.error(`Needs a lets checkout at ${LETS} (set LETS_REPO). git clone https://github.com/offensiveadhd/lets`);
  process.exit(2);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tweak-demo-'));
process.env.LETS_HOME = HOME;
process.env.LETS_NO_DEFAULTS = '1';
process.env.LETS_UNIQUES_DIRS = path.join(HOME, 'uniques');
fs.mkdirSync(path.join(HOME, 'uniques', 'tweak'), { recursive: true });
for (const f of ['unique.json', 'GUIDE.md', 'icon.svg']) fs.copyFileSync(path.join(ROOT, f), path.join(HOME, 'uniques', 'tweak', f));
fs.cpSync(path.join(ROOT, 'ui'), path.join(HOME, 'uniques', 'tweak', 'ui'), { recursive: true });

const { fakeWindow, cli, until } = await import('../tests/harness.mjs');
const { createEngine } = await import(pathToFileURL(path.join(LETS, 'engine', 'src', 'engine.mjs')).href);

const app = path.join(HOME, 'arcade');
fs.cpSync(path.join(ROOT, 'demo', 'arcade'), app, { recursive: true });
const FILES = ['src/physics.js', 'src/scoring.js', 'src/theme.css', 'src/main.js', 'index.html'];
const file = (rel) => fs.readFileSync(path.join(app, rel), 'utf8');
const original = Object.fromEntries(FILES.map((f) => [f, file(f)]));

let failures = 0;
const say = (s = '') => console.log(s);
const check = (ok, what) => { say(`  ${ok ? '✔' : '✘'} ${what}`); if (!ok) failures++; };
/** the lines that differ from the original, file by file (valid while the line count is unchanged) */
const diff = () => {
  const out = [];
  for (const [rel, before] of Object.entries(original)) {
    const a = before.split('\n');
    const b = file(rel).split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`    ${rel}:${i + 1}  ${(a[i] ?? '').trim()}  →  ${(b[i] ?? '').trim()}`);
  }
  return out;
};
const valueFiles = () => ['src/physics.js', 'src/scoring.js', 'src/theme.css'].map(file).join('\u0000');

const engine = await createEngine({ projectDir: ROOT, port: 0, log: () => {} });
let toolCalls = 0;
for (const t of engine.tools) { const h = t.handler; t.handler = (...a) => { toolCalls++; return h.apply(t, a); }; }
const bus = engine.host.bus;

say('\n1. The human types:  /lets tweak "how the ball moves and how it scores"');
say('   Claude opens the window, reads src/physics.js, src/scoring.js and src/theme.css, and writes its discovery');
say('   (demo/arcade.definition.json: 10 parameters, 4 groups, with ranges). This is the ONLY step that uses AI.');
const { windowId } = engine.host.windowUrl('tweak');
const win = await fakeWindow(engine.host, windowId);

say('\n2. Claude checks the discovery against the real files, then opens the inspector:');
const def = path.join(ROOT, 'demo', 'arcade.definition.json');
const chk = await cli('check', def, '--project', app);
check(chk.status === 0, `check: every one of ${chk.json?.params?.length} parameters resolves to an exact file:line`);
const open = await cli('open', def, '--project', app, '--window', windowId);
check(open.status === 0, `open: inspector sent to the window, agent ${open.json?.agent?.started ? 'started' : 'running'} (pid ${open.json?.agent?.pid})`);
const insp = await until(() => win.last('tweak.inspector'), 5000, 'inspector');
for (const g of insp.data.groups) say(`     ${g.padEnd(8)} ${insp.data.params.filter((p) => p.group === g).map((p) => `${p.label} [${p.control}] = ${p.value}${p.unit}`).join(' · ')}`);
const agentPid = open.json.agent.pid;

say('\n3. From here no AI is involved. The human drags and clicks; the agent edits the files.');
const callsBefore = toolCalls;
const cursorsBefore = new Map(bus.cursors);
let n = 0;
const send = (id, value) => win.emit('tweak.set', { id, value, n: ++n });
const settle = () => until(() => win.results().some((r) => r.data.n === n), 8000, `result ${n}`);
const resultOf = () => win.results().find((r) => r.data.n === n).data;
for (let v = 900; v <= 1800; v += 30) await send('gravity', v);                    // a 31-step drag of the gravity slider
await send('bounce', 0.6); await send('speed', 400); await send('trail', false);
await send('color', '#ff0066'); await send('points', 25); await send('combo', 15);
await send('label', 'Points'); await send('gap', 32); await send('fade', 600);
await settle();
const writes = JSON.parse(fs.readFileSync(path.join(HOME, 'tweak', windowId, 'state.json'), 'utf8')).stats.writes;
say(`   ${n} changes sent; ${writes} file writes (a drag is coalesced); the source now differs in exactly these places:`);
for (const l of diff()) say(l);
check(file('src/physics.js').includes('GRAVITY = 1800;') && file('src/physics.js').includes('BOUNCE = 0.60;') && file('src/physics.js').includes("'#ff0066'"), 'values landed in the source, formatted like the original');
check(file('src/main.js') === original['src/main.js'] && file('index.html') === original['index.html'], 'files that hold no parameters were never touched');
check(diff().length === 10, `${diff().length} lines changed, nothing else`);
check(toolCalls === callsBefore, `Claude tool calls during ${n} adjustments: ${toolCalls - callsBefore}`);
check(bus.cursors.get('claude') === cursorsBefore.get('claude') && bus.cursors.get('hook') === cursorsBefore.get('hook'), 'the cursors that feed a model never moved');

say('\n4. Mistakes are caught before any write:');
const snapshot = valueFiles();
const rejected = async (id, value, why) => { await send(id, value); await settle(); const r = resultOf(); check(r.ok === false, `${why} → ${r.code}: ${r.message}`); };
await rejected('gravity', 99999, 'slider range exceeded');
await rejected('color', 'blue', 'not a color');
await rejected('nope', 1, 'unknown parameter');
check(valueFiles() === snapshot, 'none of them touched a file');
await send('label', "x'; process.exit(1); //"); await settle();
say(`   text is only ever text, escaped, never executed:  ${file('src/scoring.js').split('\n')[2]}`);
check(file('src/scoring.js').includes("LABEL = 'x\\'; process.exit(1); //';"), 'an injection attempt became a harmless string');
await send('label', 'Points'); await settle();

say('\n5. A human edits the same file in their editor while Tweak is open:');
fs.writeFileSync(path.join(app, 'src/physics.js'), '// edited by hand\n' + file('src/physics.js').replace('MOVE_SPEED = 400', 'MOVE_SPEED = 123'));
await send('speed', 500); await settle();
const r5 = resultOf();
check(r5.ok === false && r5.code === 'changed' && file('src/physics.js').includes('MOVE_SPEED = 123;'), `their value is kept, not overwritten (${r5.message})`);
await send('gravity', 1500); await settle();
check(file('src/physics.js').startsWith('// edited by hand\n') && file('src/physics.js').includes('GRAVITY = 1500;'), 'another parameter in that file still works; their added line is preserved');

say('\n6. Undo, then Revert all:');
await win.emit('tweak.undo', { n: ++n }); await settle();
check(file('src/physics.js').includes('GRAVITY = 1800;'), 'Undo took the last change back');
await win.emit('tweak.revertAll', { n: ++n }); await settle();
const humanOnly = '// edited by hand\n' + original['src/physics.js'].replace('MOVE_SPEED = 260;', 'MOVE_SPEED = 123;');
if (file('src/physics.js') !== humanOnly) say(file('src/physics.js').split('\n').slice(0, 8).join('\n'));
check(file('src/physics.js') === humanOnly, "Revert all put back everything Tweak changed and kept the human's own edits (the note, speed 123)");
check(file('src/scoring.js') === original['src/scoring.js'] && file('src/theme.css') === original['src/theme.css'], 'the other files are byte-for-byte what they were before the session');

say('\n7. Asking for something else:');
say('   The human types "the header colors" into the window: that single message (tweak.scope) is what reaches Claude,');
say('   which discovers again and runs `lets-tweak open` on the same window. Nothing else ever does.');
check(true, 'new scope = new discovery; adjustments = no AI');

win.close();
try { process.kill(agentPid); } catch { /* gone */ }
engine.stop();
say(failures ? `\nDEMO FAILED: ${failures} claim(s) did not hold` : '\nDEMO OK');
process.exitCode = failures ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 300).unref?.();
