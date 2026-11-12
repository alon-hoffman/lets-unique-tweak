/** The window's logic (ui/model.js), tested without a browser. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModel, loadInspector, localChange, applyResult, expirePending, createSender, snap, setAgent, agentOnline, isChanged } from '../ui/model.js';

const view = () => ({
  scope: 's', title: 'S', groups: ['A'], seq: 1, changed: 0, canUndo: false,
  params: [
    { id: 'g', label: 'G', group: 'A', control: 'slider', kind: 'number', value: 10, original: 10, min: 0, max: 100, step: 1 },
    { id: 't', label: 'T', group: 'A', control: 'toggle', kind: 'boolean', value: true, original: true },
  ],
});
const loaded = () => loadInspector(createModel(), view());

test('a local change marks the parameter pending and returns the event to send', () => {
  const m = loaded();
  const e = localChange(m, 'g', 20);
  assert.deepEqual(e, { id: 'g', value: 20, n: 1 });
  assert.equal(m.params.get('g').status, 'pending');
  assert.equal(isChanged(m.params.get('g')), true);
  assert.equal(localChange(m, 'g', 20), null, 'same value: nothing to send');
  assert.equal(localChange(m, 'nope', 1), null);
});

test('an answer to an older change does not move the control being dragged', () => {
  const m = loaded();
  const first = localChange(m, 'g', 20);
  localChange(m, 'g', 30);
  applyResult(m, { op: 'set', id: 'g', n: first.n, ok: true, value: 20, changes: [{ id: 'g', value: 20 }] });
  assert.equal(m.params.get('g').value, 30);
  assert.equal(m.params.get('g').status, 'pending');
  applyResult(m, { op: 'set', id: 'g', n: 2, ok: true, value: 30, changes: [{ id: 'g', value: 30 }], changed: 1, canUndo: true });
  assert.equal(m.params.get('g').status, 'applied');
  assert.equal(m.changed, 1);
  assert.equal(m.canUndo, true);
});

test('failures keep the message and adopt the value the file holds', () => {
  const m = loaded();
  const e = localChange(m, 'g', 50);
  applyResult(m, { op: 'set', id: 'g', n: e.n, ok: false, code: 'changed', message: 'G was changed in the file to 33.', value: 33, changes: [{ id: 'g', value: 33 }] });
  const p = m.params.get('g');
  assert.equal(p.status, 'error');
  assert.equal(p.value, 33);
  assert.match(p.message, /changed in the file/);
});

test('revert all and undo settle every control', () => {
  const m = loaded();
  localChange(m, 'g', 50); localChange(m, 't', false);
  applyResult(m, { op: 'revertAll', ok: true, changes: [{ id: 'g', value: 10 }, { id: 't', value: true }], changed: 0, canUndo: false });
  assert.equal(m.params.get('g').value, 10);
  assert.equal(m.params.get('t').value, true);
  assert.ok([...m.params.values()].every((p) => p.status === 'idle'));
  assert.equal(m.changed, 0);
});

test('an unanswered change turns into a visible error, not a silent success', () => {
  const m = loaded();
  const e = localChange(m, 'g', 50);
  const sent = new Map([['g', 1000]]);
  assert.deepEqual(expirePending(m, 2000, sent), []);
  assert.deepEqual(expirePending(m, 6000, sent), ['g']);
  assert.match(m.params.get('g').message, /No answer/);
  assert.ok(e);
});

test('the agent heartbeat decides the online indicator', () => {
  const m = loaded();
  assert.equal(agentOnline(m, 0), false);
  setAgent(m, { online: true }, 1000);
  assert.equal(agentOnline(m, 5000), true);
  assert.equal(agentOnline(m, 20_000), false);
});

test('the sender sends the first value at once, at most one per interval, and always the last', () => {
  const sent = [];
  const timers = [];
  const s = createSender({ send: (e) => sent.push(e.value), delay: 100, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  for (let v = 1; v <= 100; v++) s.push('g', { id: 'g', value: v });
  assert.deepEqual(sent, [1], 'only the leading edge so far');
  timers.shift()();                                // the interval elapses
  assert.deepEqual(sent, [1, 100], 'then the latest, not 98 in-between values');
  timers.shift()();
  assert.deepEqual(sent, [1, 100]);
});

test('releasing a drag flushes the final value immediately, and a queued value is not lost', () => {
  const sent = [];
  const s = createSender({ send: (e) => sent.push(e.value), delay: 100, setTimer: () => 1, clearTimer: () => {} });
  s.push('g', { id: 'g', value: 1 }); s.push('g', { id: 'g', value: 2 });
  s.flushPending('g');
  assert.deepEqual(sent, [1, 2]);
  s.push('g', { id: 'g', value: 3 });
  s.flush('g', { id: 'g', value: 4 });
  assert.deepEqual(sent, [1, 2, 3, 4]);
});

test('snap respects range, step and integers', () => {
  assert.equal(snap('0.30000000000000004', { step: 0.1 }), 0.3);
  assert.equal(snap(500, { min: 0, max: 100 }), 100);
  assert.equal(snap(-5, { min: 0, max: 100 }), 0);
  assert.equal(snap(7.6, { integer: true, step: 1 }), 8);
  assert.equal(snap('abc', {}), null);
});
