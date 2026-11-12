/**
 * tweak — app.js
 *
 * A lightweight inspector. Claude discovers the parameters once and sends them as
 * a `tweak.inspector` command; from then on every control change is sent as a
 * `tweak.set {id, value, n}` event that the tweak agent (agent/, plain Node, no
 * model) applies to the source file and answers with `tweak.result`. The window
 * never sees or sends a file path. Asking for a different scope is the one
 * thing that goes to Claude (`tweak.scope`).
 */
import { Lets } from '/sdk/lets-client.js';
import { Shell } from '/sdk/lets-shell.js';
import { createModel, loadInspector, localChange, applyResult, expirePending, setAgent, agentOnline, createSender, snap, isChanged } from './model.js';

const lets = Lets.connect({ unique: 'tweak', version: '0.1.0', caps: ['entity', 'chat', 'components'] });
const model = createModel();
const sentAt = new Map();                       // param id -> when its newest change left the window
const rows = new Map();                         // param id -> {row, sync()}

const shell = Shell.mount(lets, {
  root: document.body,
  context: () => ({ scope: model.view?.scope, changed: model.changed }),
  quickSuggestions: () => [{ id: 'scope', label: 'Tweak something else…', run: () => $('scope').focus() }],
});

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids) if (c) n.append(c);
  return n;
};

const sender = createSender({
  delay: 120,
  send: (evt) => { sentAt.set(evt.id, Date.now()); lets.emitNow('tweak.set', evt); },
});

function change(id, value, { final = false } = {}) {
  const evt = localChange(model, id, value);
  if (!evt) { if (final) sender.flushPending(id); return; }
  paintRow(id);
  if (final) sender.flush(id, evt); else sender.push(id, evt);
}

// ---- controls -------------------------------------------------------------------

function makeControl(p) {
  const ctl = el('div', { class: 'tw-ctl' });
  const sync = [];
  const unit = p.unit ? el('span', { class: 'tw-unit', text: p.unit }) : null;
  switch (p.control) {
    case 'slider': {
      const range = el('input', { type: 'range', min: p.min, max: p.max, step: p.step, 'aria-label': p.label });
      const num = el('input', { type: 'number', min: p.min, max: p.max, step: p.step, 'aria-label': `${p.label} value` });
      range.addEventListener('input', () => { const v = snap(range.value, p); if (v !== null) { num.value = v; change(p.id, v); } });
      range.addEventListener('change', () => { const v = snap(range.value, p); if (v !== null) change(p.id, v, { final: true }); });
      num.addEventListener('change', () => { const v = snap(num.value, p); if (v === null) { num.value = model.params.get(p.id).value; return; } change(p.id, v, { final: true }); });
      ctl.append(...[range, num, unit].filter(Boolean));
      sync.push((v) => { range.value = v; num.value = v; });
      break;
    }
    case 'number': {
      const num = el('input', { type: 'number', step: p.step, 'aria-label': p.label, ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}) });
      num.addEventListener('change', () => { const v = snap(num.value, p); if (v === null) { num.value = model.params.get(p.id).value; return; } change(p.id, v, { final: true }); });
      ctl.append(...[num, unit].filter(Boolean));
      sync.push((v) => { num.value = v; });
      break;
    }
    case 'toggle': {
      const box = el('input', { type: 'checkbox', role: 'switch', 'aria-label': p.label });
      box.addEventListener('change', () => change(p.id, box.checked, { final: true }));
      ctl.append(el('label', { class: 'tw-switch' }, box, el('span')));
      sync.push((v) => { box.checked = !!v; });
      break;
    }
    case 'text': {
      const t = el('input', { type: 'text', maxlength: 400, 'aria-label': p.label });
      t.addEventListener('change', () => change(p.id, t.value, { final: true }));
      ctl.append(t);
      sync.push((v) => { if (document.activeElement !== t) t.value = v; });
      break;
    }
    case 'color': {
      const c = el('input', { type: 'color', 'aria-label': p.label });
      const hex = el('span', { class: 'tw-hex' });
      c.addEventListener('input', () => { hex.textContent = c.value; change(p.id, c.value); });
      c.addEventListener('change', () => change(p.id, c.value, { final: true }));
      ctl.append(c, hex);
      sync.push((v) => { const full = /^#[0-9a-f]{3}$/i.test(v) ? '#' + [...v.slice(1)].map((x) => x + x).join('') : v; c.value = full.toLowerCase(); hex.textContent = v; });
      break;
    }
    case 'select': {
      const s = el('select', { 'aria-label': p.label }, ...p.options.map((o) => el('option', { value: String(o), text: String(o) })));
      s.addEventListener('change', () => change(p.id, p.kind === 'number' ? Number(s.value) : s.value, { final: true }));
      ctl.append(s);
      sync.push((v) => { s.value = String(v); });
      break;
    }
    case 'segmented': {
      const seg = el('div', { class: 'tw-seg', role: 'group', 'aria-label': p.label });
      const buttons = p.options.map((o) => el('button', { type: 'button', text: String(o), 'aria-pressed': 'false', onclick: () => change(p.id, o, { final: true }) }));
      seg.append(...buttons);
      ctl.append(seg);
      sync.push((v) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(p.options[i] === v))));
      break;
    }
  }
  return { ctl, sync: (v) => sync.forEach((f) => f(v)) };
}

function buildRow(p) {
  const { ctl, sync } = makeControl(p);
  const reset = el('button', { type: 'button', class: 'tw-reset', title: 'Back to the original value', 'aria-label': `Reset ${p.label}`, text: '↺', onclick: () => lets.emitNow('tweak.revert', { id: p.id, n: ++model.n }) });
  const msg = el('div', { class: 'tw-msg', role: 'alert' });
  const label = el('div', { class: 'tw-label', title: p.hint || p.label }, p.label);
  const left = el('div', { style: 'min-width:0' }, label, el('span', { class: 'tw-src', text: p.source }));
  const row = el('div', { class: 'tw-row', 'data-id': p.id, 'data-status': 'idle', 'data-changed': 'false' }, left, ctl, reset, msg);
  if (p.hint) row.title = p.hint;
  rows.set(p.id, { row, sync, msg });
  sync(p.value);
  return row;
}

function paintRow(id) {
  const r = rows.get(id);
  const p = model.params.get(id);
  if (!r || !p) return;
  r.sync(p.value);
  r.row.dataset.status = p.status;
  r.row.dataset.changed = String(isChanged(p));
  r.msg.textContent = p.message;
}

function renderAll() {
  rows.clear();
  const host = $('groups');
  host.replaceChildren();
  const has = model.params.size > 0;
  $('empty').hidden = has;
  $('title').textContent = model.view ? model.view.title : 'Tweak';
  $('summary').textContent = model.view?.summary || (has ? '' : 'Tell Claude what to tweak.');
  for (const g of model.view?.groups || []) {
    const members = [...model.params.values()].filter((p) => p.group === g);
    if (!members.length) continue;
    host.append(el('details', { class: 'tw-group', open: '' }, el('summary', {}, el('span', { text: g }), el('span', { class: 'tw-group-count', text: String(members.length) })), ...members.map(buildRow)));
  }
  paintHeader();
}

function paintHeader() {
  $('undo').disabled = !model.canUndo;
  $('revertAll').disabled = model.changed === 0;
  $('revertAll').textContent = model.changed ? `Revert all (${model.changed})` : 'Revert all';
  const on = agentOnline(model, Date.now());
  const a = $('agent');
  a.dataset.state = on ? 'on' : 'off';
  a.textContent = on ? 'agent online' : 'agent offline';
  const n = $('notice');
  n.hidden = !model.notice;
  n.textContent = model.notice;
}

// ---- messages from the agent and from Claude -----------------------------------------

lets.on('tweak.inspector', (d) => { loadInspector(model, d); sentAt.clear(); renderAll(); shell.entity.react('nod'); });
lets.on('tweak.result', (d) => {
  const touched = applyResult(model, d);
  for (const id of touched) paintRow(id);
  if (d.id && d.ok === false && d.code === 'stale') shell.toast(d.message, 'warn', 6000);
  if (d.id && d.ok) sentAt.delete(d.id);
  // a revert-all, undo or resync may have changed values that are not in `touched` by id only
  if (d.op && d.op !== 'set') for (const id of model.params.keys()) paintRow(id);
  paintHeader();
});
lets.on('tweak.agent', (d) => { setAgent(model, d, Date.now()); paintHeader(); });

setInterval(() => {
  for (const id of expirePending(model, Date.now(), sentAt)) paintRow(id);
  paintHeader();
}, 1000);

// ---- header actions and scope ------------------------------------------------------------

$('undo').addEventListener('click', () => lets.emitNow('tweak.undo', { n: ++model.n }));
$('revertAll').addEventListener('click', () => lets.emitNow('tweak.revertAll', { n: ++model.n }));
$('scopeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('scope').value.trim();
  if (!text) return;
  lets.emit('tweak.scope', { text });
  shell.entity.say({ text: 'Asked Claude. New parameters coming.', mood: 'thinking' });
  $('scope').value = '';
});

// ask the agent (if it is up) for the current inspector: a reload of this window keeps its state
lets.onStatus((s) => { if (s === 'open') lets.emitNow('tweak.hello', {}); });
renderAll();
