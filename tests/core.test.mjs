/**
 * The deterministic core: mapping, precise edits, validation, stale and external changes, undo.
 * No LIP, no host, no network: these are the guarantees every adjustment depends on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpProject, read, write, def, lineOf } from './helpers.mjs';
import { parseLiteral, formatValue, TweakError } from '../agent/lib/literal.mjs';
import { resolveDefinition, publicView } from '../agent/lib/definition.mjs';
import { TweakSession } from '../agent/lib/session.mjs';

const CFG = 'src/config.ts';
function open(root, params) {
  const resolved = resolveDefinition(def(params), root);
  const s = new TweakSession({ root, stateFile: null });
  s.load(resolved);
  return s;
}
const p = (root, id, needle, literal, more = {}) => ({ id, label: id, file: CFG, line: lineOf(root, CFG, needle), literal, ...more });

// ---- literals ----------------------------------------------------------------------------

test('parseLiteral recognises only safe literals', () => {
  assert.deepEqual(parseLiteral('1800'), { kind: 'number', value: 1800, unit: '', decimals: 0 });
  assert.equal(parseLiteral('-0.001').value, -0.001);
  assert.equal(parseLiteral('16px').unit, 'px');
  assert.equal(parseLiteral('1_000').value, 1000);
  assert.equal(parseLiteral('true').kind, 'boolean');
  assert.equal(parseLiteral("'#A66BFF'").kind, 'color');
  assert.equal(parseLiteral('#abc').kind, 'color');
  assert.equal(parseLiteral("'Skater'").kind, 'string');
  for (const bad of ['foo', 'a + b', '1 + 2', '`x ${y}`', "'a' + 'b'", '"it"s"', '0x10', 'NaN', '1e', '']) assert.equal(parseLiteral(bad), null, bad);
});

test('formatValue validates type, range and escapes text', () => {
  const num = { kind: 'number', min: 0, max: 10, integer: true };
  const cur = parseLiteral('5');
  assert.equal(formatValue(num, cur, 7), '7');
  for (const bad of ['7', NaN, Infinity, null, {}, [], 7.5]) assert.throws(() => formatValue(num, cur, bad), (e) => e.code === 'value', String(bad));
  assert.throws(() => formatValue(num, cur, 11), (e) => e.code === 'range');
  assert.throws(() => formatValue(num, cur, -1), (e) => e.code === 'range');
  // decimals follow the source; units are kept
  assert.equal(formatValue({ kind: 'number' }, parseLiteral('0.25'), 0.5), '0.50');       // the source's precision is kept
  assert.equal(formatValue({ kind: 'number' }, parseLiteral('0.25'), 0.125), '0.125');
  assert.equal(formatValue({ kind: 'number', decimals: 1 }, parseLiteral('1.5'), 2), '2.0');
  assert.equal(formatValue({ kind: 'number' }, parseLiteral('16px'), 20), '20px');
  assert.equal(formatValue({ kind: 'number' }, parseLiteral('-0.001'), -0.002), '-0.002');
  // colors keep quote style and case
  assert.equal(formatValue({ kind: 'color' }, parseLiteral("'#A66BFF'"), '#00ff00'), "'#00FF00'");
  assert.equal(formatValue({ kind: 'color' }, parseLiteral('#abc'), '#112233'), '#112233');
  assert.throws(() => formatValue({ kind: 'color' }, parseLiteral('#abc'), 'red'), (e) => e.code === 'value');
  assert.throws(() => formatValue({ kind: 'color' }, parseLiteral('#abc'), '#12'), (e) => e.code === 'value');
  // strings: the quote is escaped, code cannot be injected
  const str = parseLiteral("'Skater'");
  assert.equal(formatValue({ kind: 'string' }, str, "it's"), "'it\\'s'");
  assert.equal(formatValue({ kind: 'string' }, str, "a'; process.exit(1); //"), "'a\\'; process.exit(1); //'");
  assert.throws(() => formatValue({ kind: 'string' }, str, 'a\u0000b'), (e) => e.code === 'value');
  assert.throws(() => formatValue({ kind: 'string' }, parseLiteral('`x`'), '${evil}'), (e) => e.code === 'value');
  assert.throws(() => formatValue({ kind: 'string', options: ['a', 'b'] }, str, 'c'), (e) => e.code === 'value');
  assert.throws(() => formatValue({ kind: 'boolean' }, parseLiteral('true'), 'false'), (e) => e.code === 'value');
});

// ---- mapping ----------------------------------------------------------------------------------

test('a hint resolves to the exact literal and its anchors, and the view hides the mapping', () => {
  const root = tmpProject();
  const r = resolveDefinition(def([p(root, 'gravity', 'gravity:', '1800', { min: 0, max: 4000, step: 10 })]), root);
  const m = r.params[0].mapping;
  assert.equal(read(root, CFG).slice(m.start, m.end), '1800');
  assert.equal(r.params[0].control, 'slider');
  const view = JSON.stringify(publicView(r));
  assert.ok(!view.includes('start') && !view.includes('before') && !view.includes(root.replace(/\\/g, '\\\\')), 'no offsets, anchors or absolute paths leave the agent');
});

test('identical literals: the line, col or nth picks one; ambiguity is refused, never guessed', () => {
  const root = tmpProject();
  // `speed: 5, jumpSpeed: 5,` has two 5s on one line
  const line = lineOf(root, CFG, 'speed: 5');
  assert.throws(() => resolveDefinition(def([{ id: 'speed', label: 's', file: CFG, line, literal: '5' }]), root), (e) => /appears 2 times/.test(e.message));
  const a = resolveDefinition(def([{ id: 'speed', label: 's', file: CFG, line, literal: '5', nth: 1, min: 0, max: 20 }]), root);
  const b = resolveDefinition(def([{ id: 'jump', label: 'j', file: CFG, line, literal: '5', nth: 2, min: 0, max: 20 }]), root);
  assert.notEqual(a.params[0].mapping.start, b.params[0].mapping.start);
  assert.ok(a.params[0].mapping.start < b.params[0].mapping.start);
  assert.throws(() => resolveDefinition(def([{ id: 'x', label: 'x', file: CFG, line, literal: '5', nth: 1 }, { id: 'y', label: 'y', file: CFG, line, literal: '5', nth: 1 }]), root), (e) => /same literal/.test(e.message));
});

test('editing one of several identical numbers changes only that one', async () => {
  const root = tmpProject();
  const before = read(root, CFG);
  const line = lineOf(root, CFG, 'speed: 5');
  const s = open(root, [{ id: 'jump', label: 'jump', file: CFG, line, literal: '5', nth: 2, min: 0, max: 20 }, p(root, 'bonus', 'const bonus', '5', { min: 0, max: 20 })]);
  const r = await s.set('jump', 9);
  assert.equal(r.ok, true);
  const after = read(root, CFG);
  assert.equal(after, before.replace('speed: 5, jumpSpeed: 5,', 'speed: 5, jumpSpeed: 9,'));
  // the `5` in `base * 5 + bonus - 5` and `bonus = 5` are untouched
  assert.ok(after.includes('const bonus = 5;') && after.includes('base * 5 + bonus - 5'));
});

test('a unary minus must travel with the literal', () => {
  const root = tmpProject();
  assert.throws(() => resolveDefinition(def([p(root, 'drag', 'drag:', '0.001')]), root), (e) => /unary/.test(e.message));
  const ok = resolveDefinition(def([p(root, 'drag', 'drag:', '-0.001', { min: -0.01, max: 0.01, step: 0.001 })]), root);
  assert.equal(ok.params[0].mapping.text, '-0.001');
  // a binary minus is fine: `bonus - 5`
  assert.doesNotThrow(() => resolveDefinition(def([p(root, 'tail', 'base * 5', '5', { nth: 2, min: 0, max: 9 })]), root));
});

test('a number is not matched inside a longer number or word', () => {
  const root = tmpProject();
  assert.throws(() => resolveDefinition(def([p(root, 'g', 'gravity:', '180')]), root), (e) => /not found/.test(e.message));
  assert.throws(() => resolveDefinition(def([p(root, 'g', 'gravity:', '800')]), root), (e) => /not found/.test(e.message));
});

test('a wrong line number within two lines is corrected only when unambiguous', () => {
  const root = tmpProject();
  const real = lineOf(root, CFG, "name: 'Skater'");
  const r = resolveDefinition(def([{ id: 'n', label: 'n', file: CFG, line: real + 1, literal: "'Skater'" }]), root);
  assert.equal(r.params[0].line, real);
  // 1800 sits on two lines near the one given: refuse rather than pick
  const g = lineOf(root, CFG, 'gravity:');
  assert.throws(() => resolveDefinition(def([{ id: 'g', label: 'g', file: CFG, line: g + 1, literal: '1800' }]), root), (e) => /several times/.test(e.message));
  assert.throws(() => resolveDefinition(def([{ id: 'g', label: 'g', file: CFG, line: g + 9, literal: '1800' }]), root), (e) => /not found/.test(e.message));
});

test('too many parameters is refused: focused, not every constant', () => {
  const root = tmpProject();
  const many = Array.from({ length: 61 }, (_, i) => ({ id: `p${i}`, label: 'x', file: CFG, line: 3, literal: '1800' }));
  assert.throws(() => resolveDefinition(def(many), root), (e) => /at most 60/.test(e.message));
});

test('definitions that do not resolve list every problem', () => {
  const root = tmpProject();
  try {
    resolveDefinition(def([p(root, 'a', 'gravity:', '999'), { id: 'b', label: 'b', file: 'src/nope.ts', line: 1, literal: '1' }, p(root, 'c', 'name:', "'Skater'", { control: 'slider' })]), root);
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, 'definition');
    assert.equal(e.problems.length, 3);
  }
});

// ---- precise edits ----------------------------------------------------------------------------------

test('a set replaces exactly the literal and nothing else, byte for byte', async () => {
  const root = tmpProject();
  const before = read(root, CFG);
  const s = open(root, [p(root, 'gravity', 'gravity:', '1800', { min: 0, max: 4000 })]);
  const r = await s.set('gravity', 2400);
  assert.equal(r.ok, true);
  assert.equal(read(root, CFG), before.replace('gravity: 1800,', 'gravity: 2400,'));
  assert.equal(s.view().params[0].value, 2400);
  assert.equal(s.stats.writes, 1);
});

test('every kind round-trips: number, boolean, color, text, option, CSS unit', async () => {
  const root = tmpProject();
  const s = open(root, [
    p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 }),
    p(root, 'trails', 'trails:', 'true'),
    p(root, 'accent', 'accent:', "'#A66BFF'"),
    p(root, 'name', 'name:', "'Skater'"),
    p(root, 'mode', 'mode:', "'normal'", { options: ['normal', 'hard'] }),
    { id: 'gap', label: 'gap', file: 'src/theme.css', line: 3, literal: '16px', min: 0, max: 64 },
  ]);
  assert.equal((await s.set('g', 100)).ok, true);
  assert.equal((await s.set('trails', false)).ok, true);
  assert.equal((await s.set('accent', '#112233')).ok, true);
  assert.equal((await s.set('name', "O'Neil")).ok, true);
  assert.equal((await s.set('mode', 'hard')).ok, true);
  assert.equal((await s.set('gap', 24)).ok, true);
  const t = read(root, CFG);
  for (const x of ['gravity: 100,', 'trails: false,', "accent: '#112233'", "name: 'O\\'Neil'", "mode: 'hard'"]) assert.ok(t.includes(x), x);
  assert.ok(read(root, 'src/theme.css').includes('--gap: 24px;'));
});

test('invalid values are rejected before any write', async () => {
  const root = tmpProject();
  const before = read(root, CFG);
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 }), p(root, 'name', 'name:', "'Skater'"), p(root, 'accent', 'accent:', "'#A66BFF'")]);
  for (const [id, v] of [['g', 'fast'], ['g', 99999], ['g', 12.5], ['g', NaN], ['name', 5], ['accent', 'blue'], ['nope', 1]]) {
    const r = await s.set(id, v);
    assert.equal(r.ok, false, `${id}=${v}`);
  }
  assert.equal(read(root, CFG), before);
  assert.equal(s.stats.writes, 0);
});

test('CRLF line endings and a BOM survive an edit', async () => {
  const root = tmpProject();
  const css = path.join(root, 'src/theme.css');
  fs.writeFileSync(css, '\uFEFF' + fs.readFileSync(css, 'utf8'));
  const before = fs.readFileSync(css, 'utf8');
  const s = open(root, [{ id: 'fade', label: 'fade', file: 'src/theme.css', line: 4, literal: '250ms', min: 0, max: 2000 }]);
  assert.equal((await s.set('fade', 400)).ok, true);
  assert.equal(fs.readFileSync(css, 'utf8'), before.replace('250ms', '400ms'));
  assert.ok(fs.readFileSync(css, 'utf8').startsWith('\uFEFF'));
  assert.ok(fs.readFileSync(css, 'utf8').includes('\r\n'));
});

test('two parameters in one file stay correct when the first edit changes the length', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'w', 'width:', '64', { min: 0, max: 99999 }), p(root, 't', 'thickness:', '6', { min: 0, max: 99 })]);
  assert.equal((await s.set('w', 12345)).ok, true);
  assert.equal((await s.set('t', 7)).ok, true);
  assert.equal((await s.set('w', 3)).ok, true);
  assert.ok(read(root, CFG).includes('width: 3, thickness: 7,'));
});

// ---- safety -----------------------------------------------------------------------------------------

test('vendored, generated, minified, secret and escaping paths are refused', () => {
  const root = tmpProject();
  const bad = [
    ['node_modules/dep/index.js', /node_modules/], ['dist/app.min.js', /dist|minified/], ['src/gen.ts', /generated/],
    ['../outside.ts', /leaves the project/], ['/etc/passwd', /relative/], ['C:\\Windows\\win.ini', /relative/], ['.env', /secret|source file/], ['package-lock.json', /lock/], ['src/config.ts\0', /required|exist/],
  ];
  for (const [file, re] of bad) assert.throws(() => resolveDefinition(def([{ id: 'x', label: 'x', file, line: 1, literal: '1' }]), root), (e) => re.test(e.message), file);
});

test('a symlink that leaves the project is refused', (t) => {
  const root = tmpProject();
  const outside = fs.mkdtempSync(path.join(path.dirname(root), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const k = 1;\n');
  try { fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src', 'link.ts')); } catch { return t.skip('symlinks need privileges on this machine'); }
  assert.throws(() => resolveDefinition(def([{ id: 'x', label: 'x', file: 'src/link.ts', line: 1, literal: '1' }]), root), (e) => /outside the project/.test(e.message));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.ts'), 'utf8'), 'export const k = 1;\n');
});

// ---- external changes and stale mappings ---------------------------------------------------------------

test('an edit elsewhere in the file is preserved and the mapping follows the move', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]);
  write(root, CFG, '// added by a human\n// and another line\n' + read(root, CFG).replace('name: ', 'title: '));
  const r = await s.set('g', 2000);
  assert.equal(r.ok, true);
  const t = read(root, CFG);
  assert.ok(t.startsWith('// added by a human\n// and another line\n') && t.includes("title: 'Skater'") && t.includes('gravity: 2000,'));
});

test('a literal edited outside Tweak is adopted, never overwritten', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]);
  write(root, CFG, read(root, CFG).replace('gravity: 1800', 'gravity: 1234'));
  const before = read(root, CFG);
  const r = await s.set('g', 3000);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'changed');
  assert.equal(r.value, 1234);
  assert.equal(read(root, CFG), before, 'the human\'s edit is untouched');
  // the next change now works against the adopted value
  assert.equal((await s.set('g', 3000)).ok, true);
  assert.ok(read(root, CFG).includes('gravity: 3000'));
});

test('a mapping that cannot be found safely is stale and nothing is written', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]);
  write(root, CFG, read(root, CFG).replace('gravity: 1800,', 'g: computeGravity(),'));
  const before = read(root, CFG);
  const r = await s.set('g', 100);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'stale');
  assert.equal(read(root, CFG), before);
  fs.rmSync(path.join(root, CFG));
  assert.equal((await s.set('g', 100)).ok, false);
});

test('identical surroundings in two places make the mapping ambiguous, not guessed', async () => {
  const root = tmpProject();
  const dup = 'const A = { x: 11 };\nconst B = { x: 11 };\n';
  write(root, 'src/dup.ts', dup);
  const s = open(root, [{ id: 'x', label: 'x', file: 'src/dup.ts', line: 1, literal: '11', min: 0, max: 99 }]);
  write(root, 'src/dup.ts', 'const NEW = 1;\n' + dup.replace('const A', 'const B'));   // original location is gone, two lookalikes remain
  const r = await s.set('x', 12);
  assert.equal(r.ok, false);
  assert.ok(['stale', 'changed'].includes(r.code));
  assert.ok(!read(root, 'src/dup.ts').includes('x: 12'));
});

// ---- undo / revert ---------------------------------------------------------------------------------------

test('revert puts one value back; revert all restores the whole file byte for byte', async () => {
  const root = tmpProject();
  const original = read(root, CFG);
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 }), p(root, 'trails', 'trails:', 'true'), p(root, 'accent', 'accent:', "'#A66BFF'")]);
  await s.set('g', 10); await s.set('trails', false); await s.set('accent', '#000000');
  assert.equal(s.changedCount(), 3);
  assert.equal((await s.revert('trails')).ok, true);
  assert.ok(read(root, CFG).includes('trails: true,') && read(root, CFG).includes('gravity: 10,'));
  const all = await s.revertAll();
  assert.equal(all.ok, true);
  assert.equal(read(root, CFG), original);
  assert.equal(s.changedCount(), 0);
});

test('undo steps back one change; a drag of one parameter is one undo step', async () => {
  const root = tmpProject();
  const original = read(root, CFG);
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 }), p(root, 'trails', 'trails:', 'true')]);
  await s.set('trails', false);
  for (const v of [1801, 1900, 2100, 2500, 2600]) await s.set('g', v);          // a drag
  assert.equal(s.journal.length, 2);
  assert.equal((await s.undo()).ok, true);                                      // the whole drag goes
  assert.ok(read(root, CFG).includes('gravity: 1800,') && read(root, CFG).includes('trails: false,'));
  assert.equal((await s.undo()).ok, true);
  assert.equal(read(root, CFG), original);
  assert.equal((await s.undo()).code, 'nothing');
});

test('undo and revert refuse to clobber a file edited since', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]);
  await s.set('g', 2000);
  write(root, CFG, read(root, CFG).replace('gravity: 2000', 'gravity: 7777'));
  const before = read(root, CFG);
  const r = await s.revert('g');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'changed');
  assert.equal(r.value, 7777, 'the window is told what the file holds now');
  assert.equal(read(root, CFG), before);
  const u = await s.undo();                       // the journal entry no longer describes the file
  assert.equal(u.ok, false);
  assert.equal(read(root, CFG), before);
});

test('revert all reaches changes made under an earlier scope', async () => {
  const root = tmpProject();
  const original = read(root, CFG);
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]);
  await s.set('g', 5);
  s.load(resolveDefinition(def([p(root, 'trails', 'trails:', 'true')], { scope: 'second' }), root));
  await s.set('trails', false);
  assert.equal(s.changedCount(), 2);
  assert.equal((await s.revertAll()).ok, true);
  assert.equal(read(root, CFG), original);
});

test('state survives an agent restart: undo still works', async () => {
  const root = tmpProject();
  const original = read(root, CFG);
  const stateFile = path.join(root, '..', `state-${path.basename(root)}.json`);
  const s = new TweakSession({ root, stateFile });
  s.load(resolveDefinition(def([p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]), root));
  await s.set('g', 42);
  const again = TweakSession.restore(stateFile);
  assert.equal((await again.undo()).ok, true);
  assert.equal(read(root, CFG), original);
  fs.rmSync(stateFile);
});

// ---- rapid interaction ----------------------------------------------------------------------------------------

test('hundreds of rapid sets end on the last value with a correct file', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 }), p(root, 'name', 'name:', "'Skater'")]);
  const jobs = [];
  for (let i = 0; i < 300; i++) jobs.push(s.set('g', (i * 13) % 4000));
  jobs.push(s.set('g', 1234));
  const rs = await Promise.all(jobs);
  assert.ok(rs.every((r) => r.ok));
  assert.ok(read(root, CFG).includes('gravity: 1234,'));
  assert.equal(parseLiteral(read(root, CFG).match(/name: ('Skater')/)[1]).value, 'Skater');
  assert.equal(fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left behind');
  assert.equal(s.journal.length, 1);
});

test('setting the value already in the file does not write', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]);
  const r = await s.set('g', 1800);
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(s.stats.writes, 0);
});

test('resync adopts values changed in the files without writing', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]);
  write(root, CFG, read(root, CFG).replace('gravity: 1800', 'gravity: 1900'));
  const r = await s.resync();
  assert.deepEqual(r.changes, [{ id: 'g', value: 1900, original: 1900 }]);
  assert.equal(s.stats.writes, 0);
});

test('a value edited outside Tweak becomes the baseline: revert all never overwrites it', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 }), p(root, 'trails', 'trails:', 'true')]);
  await s.set('trails', false);
  await s.set('g', 2000);
  write(root, CFG, '// my note\n' + read(root, CFG).replace('gravity: 2000', 'gravity: 777'));
  const r = await s.set('g', 3000);                                   // the first touch notices the edit
  assert.equal(r.code, 'changed');
  assert.equal(r.changes[0].original, 777, 'the window is told the new baseline');
  assert.equal(s.changedCount(), 1, 'only trails still counts as changed by Tweak');
  assert.equal((await s.revertAll()).ok, true);
  const t2 = read(root, CFG);
  assert.ok(t2.startsWith('// my note\n') && t2.includes('gravity: 777,') && t2.includes('trails: true,'), 'trails restored, the human edit and note kept');
  // resync does not move baselines of Tweak's own changes
  await s.set('g', 900);
  await s.resync();
  assert.equal((await s.revert('g')).ok, true);
  assert.ok(read(root, CFG).includes('gravity: 777,'));
});

test('editing the neighbouring literal outside Tweak does not strand a parameter (own-line anchor)', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'trails', 'trails:', 'true'), p(root, 'name', 'name:', "'Skater'")]);
  // the lines above and below both change, and a line is inserted: the long anchors cannot match any more
  write(root, CFG, read(root, CFG).replace("name: 'Skater',", "name: 'Skater',\n  extra: 1,").replace('accent:', 'tint:').replace('drag: -0.001', 'drag: -0.5'));
  assert.equal((await s.set('trails', false)).ok, true);
  assert.ok(read(root, CFG).includes('trails: false,'));
});

test('a distinctive line that now occurs twice is ambiguous, never guessed', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'trails', 'trails:', 'true')]);
  write(root, CFG, read(root, CFG).replace('accent:', 'tint:').replace('mode:', 'other:').replace('  trails: true,', '  trails: true,\n  trails: true,'));
  const before = read(root, CFG);
  const r = await s.set('trails', false);
  assert.equal(r.ok, false);
  assert.ok(['stale', 'changed'].includes(r.code));
  assert.equal(read(root, CFG), before);
});

// ---- regressions from the independent review ----------------------------------------------------------------

test('review: text is only editable where JS-style escaping is right (never HTML, CSS, YAML)', () => {
  const root = tmpProject();
  write(root, 'src/page.html', '<div class="foo">x</div>\n');
  assert.throws(() => resolveDefinition(def([{ id: 'c', label: 'c', file: 'src/page.html', line: 1, literal: '"foo"' }]), root), (e) => /only editable in JS, TS and JSON/.test(e.message));
});

test('review: a sign hidden behind a keyword or a space is refused; a hugging binary minus is fine', () => {
  const root = tmpProject();
  write(root, 'src/u.js', 'function f() {\n  return -5;\n}\nconst a = 1, b = a-5;\n');
  write(root, 'src/m.css', '.a { margin: 0 -5px; }\n');
  assert.throws(() => resolveDefinition(def([{ id: 'x', label: 'x', file: 'src/u.js', line: 2, literal: '5' }]), root), (e) => /unary/.test(e.message));
  assert.throws(() => resolveDefinition(def([{ id: 'x', label: 'x', file: 'src/m.css', line: 1, literal: '5px' }]), root), (e) => /unary/.test(e.message));
  assert.doesNotThrow(() => resolveDefinition(def([{ id: 'x', label: 'x', file: 'src/u.js', line: 4, literal: '5', min: -9, max: 9 }]), root));
});

test('review: a negative value is never glued to a binary minus (a--3)', async () => {
  const root = tmpProject();
  write(root, 'src/u.js', 'const a = 1, b = a-5;\n');
  const s = new TweakSession({ root });
  s.load(resolveDefinition(def([{ id: 'x', label: 'x', file: 'src/u.js', line: 1, literal: '5', min: -9, max: 9 }]), root));
  const r = await s.set('x', -3);
  assert.equal(r.ok, false);
  assert.equal(read(root, 'src/u.js'), 'const a = 1, b = a-5;\n');
  assert.equal((await s.set('x', 3)).ok, true);
});

test('review: files that are not UTF-8 are refused, not rewritten', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'src/latin.js'), Buffer.from([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a, 0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x61, 0x3d, 0x35, 0x3b, 0x0a]));
  assert.throws(() => resolveDefinition(def([{ id: 'x', label: 'x', file: 'src/latin.js', line: 2, literal: '5' }]), root), (e) => /UTF-8/.test(e.message));
});

test('review: the deny-list is case-insensitive and covers secret-looking names', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'Node_Modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Node_Modules', 'pkg', 'i.js'), 'export const a = 1;\n');
  write(root, 'src/secrets.json', '{ "n": 1 }\n');
  for (const f of ['Node_Modules/pkg/i.js', 'NODE_MODULES/pkg/i.js', 'src/secrets.json', 'SRC/Secrets.JSON']) {
    assert.throws(() => resolveDefinition(def([{ id: 'x', label: 'x', file: f, line: 1, literal: '1' }]), root), TweakError, f);
  }
});

test('review: identical rows: a deleted row above makes the mapping ambiguous instead of editing a neighbour', async () => {
  const root = tmpProject();
  const rows = Array.from({ length: 40 }, () => '  { w: 100, h: 20 },').join('\n');
  write(root, 'src/rows.js', `export const R = [\n${rows}\n];\n`);
  const s = new TweakSession({ root });
  s.load(resolveDefinition(def([{ id: 'w', label: 'w', file: 'src/rows.js', line: 20, literal: '100', min: 0, max: 999 }]), root));
  const lines = read(root, 'src/rows.js').split('\n');
  lines.splice(2, 1);                                         // a human deletes a row above
  write(root, 'src/rows.js', lines.join('\n'));
  const before = read(root, 'src/rows.js');
  const r = await s.set('w', 150);
  assert.equal(r.ok, false);
  assert.equal(read(root, 'src/rows.js'), before);
});

test('review: the same literal under two scopes keeps its true original for Revert all', async () => {
  const root = tmpProject();
  write(root, 'src/g.js', 'const g = 10;\n');
  const s = new TweakSession({ root });
  const mk = (scope) => resolveDefinition(def([{ id: 'g', label: 'g', file: 'src/g.js', line: 1, literal: scope === 1 ? '10' : '20', min: 0, max: 5000 }], { scope: `s${scope}` }), root);
  s.load(mk(1));
  await s.set('g', 20);
  s.load(mk(2));
  await s.set('g', 1000);
  const r = await s.revertAll();
  assert.equal(r.ok, true);
  assert.equal(read(root, 'src/g.js'), 'const g = 10;\n');
});

test('review: a number that cannot be written exactly is refused, not rounded to zero', async () => {
  const root = tmpProject();
  const s = open(root, [p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]);
  assert.equal((await s.set('g', 1e-7)).ok, false);
});

test('review: a saved state that points at a different file is not trusted', () => {
  const root = tmpProject();
  const stateFile = path.join(root, '..', `evil-${path.basename(root)}.json`);
  const s = new TweakSession({ root, stateFile });
  s.load(resolveDefinition(def([p(root, 'g', 'gravity:', '1800', { min: 0, max: 4000 })]), root));
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  st.def.params[0].abs = path.join(root, 'src', 'theme.css');
  fs.writeFileSync(stateFile, JSON.stringify(st));
  assert.throws(() => TweakSession.restore(stateFile), (e) => e.code === 'state');
  fs.rmSync(stateFile);
});

test('TweakError carries a code', () => {
  assert.equal(new TweakError('x', 'y').code, 'x');
});
