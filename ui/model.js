/**
 * model.js — the inspector's state logic, with no DOM, so it can be tested in Node.
 *
 * The window never edits files and never names a path. It keeps the values
 * it shows, sends `{id, value, n}` for each settled change, and folds the
 * agent's answers back in. `n` is a counter: an answer older than the newest
 * change of a parameter must not move the control the human is still dragging.
 */

export function createModel() {
  return { view: null, params: new Map(), n: 0, changed: 0, canUndo: false, agent: { online: false, at: 0 }, notice: '' };
}

/** Load a `tweak.inspector` command. */
export function loadInspector(m, view) {
  m.view = { scope: view.scope, title: view.title, summary: view.summary || '', groups: view.groups || [], seq: view.seq };
  m.params = new Map();
  for (const p of view.params || []) m.params.set(p.id, { ...p, status: 'idle', message: '', n: 0 });
  m.changed = view.changed || 0;
  m.canUndo = !!view.canUndo;
  m.notice = '';
  return m;
}

/** The human moved a control. Returns the event to send, or null when nothing changed. */
export function localChange(m, id, value) {
  const p = m.params.get(id);
  if (!p) return null;
  if (p.value === value && p.status !== 'error') return null;
  p.value = value;
  p.n = ++m.n;
  p.status = 'pending';
  p.message = '';
  return { id, value, n: p.n };
}

export function isChanged(p) { return p.original !== undefined && p.value !== p.original; }

/** Fold a `tweak.result` in. Returns the ids whose controls should redraw. */
export function applyResult(m, r) {
  const touched = new Set();
  const own = r.id ? m.params.get(r.id) : null;
  const superseded = own && r.n !== undefined && r.n < own.n;          // the human has moved on since
  if (typeof r.changed === 'number') m.changed = r.changed;
  if (typeof r.canUndo === 'boolean') m.canUndo = r.canUndo;
  for (const c of r.changes || []) {
    const p = m.params.get(c.id);
    if (!p) continue;
    if (p === own && superseded) continue;
    if (r.op === 'set' && p.status === 'pending' && p !== own) continue;   // do not fight a drag in progress elsewhere
    p.value = c.value;
    if (c.original !== undefined) p.original = c.original;
    touched.add(c.id);
  }
  if (own && !superseded) {
    if (r.ok) { own.status = r.unchanged ? 'idle' : 'applied'; own.message = ''; if (r.value !== undefined) own.value = r.value; }
    else { own.status = 'error'; own.message = r.message || 'The change was not applied.'; if (r.value !== undefined) own.value = r.value; }
    touched.add(own.id);
  }
  if (!r.id && r.ok === false) m.notice = r.message || 'That did not work.';
  else if (!r.id && r.ok) m.notice = '';
  if (r.errors?.length) m.notice = r.message || 'Some values could not be restored.';
  // after revert-all, undo and resync the whole inspector may have moved: mark everything idle
  if (r.op === 'revertAll' || r.op === 'undo' || r.op === 'revert' || r.op === 'resync') for (const p of m.params.values()) if (p.status === 'applied' || p.status === 'pending') { p.status = 'idle'; touched.add(p.id); }
  return touched;
}

/** A change nobody answered: say so instead of leaving the control looking applied. */
export function expirePending(m, now, sentAt, ttl = 3500) {
  const out = [];
  for (const p of m.params.values()) {
    if (p.status === 'pending' && sentAt.get(p.id) !== undefined && now - sentAt.get(p.id) > ttl) {
      p.status = 'error';
      p.message = 'No answer from the tweak agent. The file was not changed. Is it running?';
      out.push(p.id);
    }
  }
  return out;
}

export function setAgent(m, info, now) { m.agent = { online: !!info.online, at: now, writes: info.writes, sets: info.sets }; }
export function agentOnline(m, now, ttl = 12_000) { return m.agent.online && now - m.agent.at < ttl; }

/**
 * Trailing-edge sender with a leading edge for the first change: a drag sends the first value at
 * once, then at most one message per `delay` ms with the latest value, and always the final value.
 */
export function createSender({ send, delay = 120, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const slots = new Map();                       // id -> {timer, last, sentAt}
  return {
    push(id, evt) {
      let s = slots.get(id);
      if (!s) { s = { timer: null, pending: null }; slots.set(id, s); }
      if (!s.timer) {
        send(evt);                                // leading edge
        s.timer = setTimer(() => this._tick(id), delay);
      } else s.pending = evt;
    },
    _tick(id) {
      const s = slots.get(id);
      if (!s) return;
      s.timer = null;
      if (s.pending) { const e = s.pending; s.pending = null; send(e); s.timer = setTimer(() => this._tick(id), delay); }
    },
    flushPending(id) {                            // the final value was already queued by an earlier push
      const s = slots.get(id);
      if (!s?.pending) return;
      if (s.timer) { clearTimer(s.timer); s.timer = null; }
      const e = s.pending;
      s.pending = null;
      send(e);
    },
    flush(id, evt) {                              // release of a drag: send the final value now
      const s = slots.get(id);
      if (s?.timer) { clearTimer(s.timer); s.timer = null; }
      if (s) s.pending = null;
      send(evt);
    },
  };
}

/** Round a slider/number value to its step so 0.1 + 0.2 never shows as 0.30000000000000004. */
export function snap(value, p) {
  let v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (p.min !== undefined) v = Math.max(p.min, v);
  if (p.max !== undefined) v = Math.min(p.max, v);
  const step = p.step || 1;
  const decimals = Math.min(6, (String(step).split('.')[1] || '').length);
  v = Number(v.toFixed(decimals));
  if (p.integer) v = Math.round(v);
  return v;
}

export function display(p) {
  if (p.kind === 'boolean') return p.value ? 'on' : 'off';
  if (p.kind === 'number') return `${p.value}${p.unit || ''}`;
  return String(p.value);
}
