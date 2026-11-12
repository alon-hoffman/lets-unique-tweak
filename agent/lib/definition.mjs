/**
 * The inspector definition: what discovery (Claude, once) hands to the
 * deterministic side. Claude writes *hints* ("physicsConfig.ts line 8, the
 * literal 1800, a slider from 0 to 4000"); this file validates them, resolves
 * each to an exact anchored span in the real file and refuses anything unsafe.
 * A definition that does not resolve never reaches the window: bad discovery
 * fails here, loudly, instead of at the first slider drag.
 */
import { parseLiteral, TweakError } from './literal.mjs';
import path from 'node:path';
import { safePath, readSource, resolveHint, STRING_EXT } from './source.mjs';

export const MAX_PARAMS = 60;
const ID_RE = /^[a-z][a-zA-Z0-9_-]{0,39}$/;
export const CONTROLS = ['slider', 'number', 'toggle', 'text', 'color', 'select', 'segmented'];

const text = (v, max, what) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new TweakError('definition', `${what} must be 1-${max} characters`);
  return v.trim();
};

/**
 * Validate and resolve a discovery definition against `root`.
 * Returns {scope, title, summary, groups, params:[{...public, mapping, kind, currentText, originalText}]}.
 */
export function resolveDefinition(input, root) {
  if (!input || typeof input !== 'object') throw new TweakError('definition', 'the definition must be an object');
  const scope = text(input.scope, 80, 'scope');
  const title = text(input.title ?? input.scope, 80, 'title');
  const summary = input.summary === undefined ? '' : text(input.summary, 300, 'summary');
  if (!Array.isArray(input.params) || !input.params.length) throw new TweakError('definition', 'params must be a non-empty array');
  if (input.params.length > MAX_PARAMS) throw new TweakError('definition', `at most ${MAX_PARAMS} parameters: a focused inspector, not every constant (got ${input.params.length})`);

  const ids = new Set();
  const spans = new Set();
  const cache = new Map();                       // file -> content, read once per definition
  const params = [];
  const problems = [];
  for (const [i, p] of input.params.entries()) {
    const where = `params[${i}]${p?.id ? ` (${p.id})` : ''}`;
    try {
      if (!p || typeof p !== 'object') throw new TweakError('definition', 'must be an object');
      if (typeof p.id !== 'string' || !ID_RE.test(p.id)) throw new TweakError('definition', 'id must be a short identifier like "gravity" or "jump-max"');
      if (ids.has(p.id)) throw new TweakError('definition', `duplicate id "${p.id}"`);
      ids.add(p.id);
      const abs = safePath(root, p.file);
      if (!cache.has(abs)) cache.set(abs, readSource(abs));
      const mapping = resolveHint(cache.get(abs), p);
      const key = `${abs}:${mapping.start}`;
      if (spans.has(key)) throw new TweakError('definition', 'two parameters point at the same literal');
      spans.add(key);
      const parsed = parseLiteral(mapping.text);
      if (parsed.kind === 'string' && !STRING_EXT.has(path.extname(abs).toLowerCase())) throw new TweakError('definition', 'text values are only editable in JS, TS and JSON files (escaping rules differ elsewhere)');
      params.push(buildParam(p, parsed, mapping, abs));
    } catch (err) {
      if (!(err instanceof TweakError)) throw err;
      problems.push(`${where}: ${err.message}`);
    }
  }
  if (problems.length) throw new TweakError('definition', `the definition does not resolve:\n- ${problems.join('\n- ')}`, { problems });

  const groupNames = [];
  for (const p of params) if (!groupNames.includes(p.group)) groupNames.push(p.group);
  return { scope, title, summary, groups: groupNames, params };
}

function buildParam(p, parsed, mapping, abs) {
  const label = text(p.label ?? p.id, 60, 'label');
  const group = text(p.group ?? 'General', 40, 'group');
  const hint = p.hint === undefined ? '' : text(p.hint, 120, 'hint');
  const spec = { kind: parsed.kind };
  if (parsed.kind === 'number') {
    spec.decimals = parsed.decimals;
    if (p.integer === true || (p.integer === undefined && parsed.decimals === 0 && !(Number.isFinite(p.step) && p.step % 1 !== 0))) spec.integer = true;
    for (const k of ['min', 'max', 'step']) if (p[k] !== undefined) {
      if (!Number.isFinite(p[k])) throw new TweakError('definition', `${k} must be a number`);
      spec[k] = p[k];
    }
    if (spec.min !== undefined && spec.max !== undefined && spec.min >= spec.max) throw new TweakError('definition', 'min must be below max');
    if (spec.min !== undefined && parsed.value < spec.min) spec.min = parsed.value;      // the real value is the truth; never exclude it
    if (spec.max !== undefined && parsed.value > spec.max) spec.max = parsed.value;
    if (spec.step !== undefined && spec.step <= 0) throw new TweakError('definition', 'step must be positive');
    if (Array.isArray(p.options)) {
      if (!p.options.every(Number.isFinite) || p.options.length < 2 || p.options.length > 12) throw new TweakError('definition', 'number options must be 2-12 numbers');
      if (!p.options.includes(parsed.value)) throw new TweakError('definition', 'the current value must be one of the options');
      spec.options = p.options;
    }
  } else if (parsed.kind === 'string' && p.options !== undefined) {
    if (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 12 || !p.options.every((o) => typeof o === 'string' && o.length <= 60)) throw new TweakError('definition', 'options must be 2-12 short strings');
    if (!p.options.includes(parsed.value)) throw new TweakError('definition', 'the current value must be one of the options');
    spec.options = p.options;
  }
  const control = p.control ?? inferControl(parsed.kind, spec);
  if (!CONTROLS.includes(control)) throw new TweakError('definition', `unknown control "${control}"`);
  const okFor = { slider: ['number'], number: ['number'], toggle: ['boolean'], text: ['string'], color: ['color'], select: ['string', 'number'], segmented: ['string', 'number'] };
  if (!okFor[control].includes(parsed.kind)) throw new TweakError('definition', `a ${control} cannot edit a ${parsed.kind} literal`);
  if ((control === 'select' || control === 'segmented') && !spec.options) throw new TweakError('definition', `${control} needs options`);
  if (control === 'slider' && (spec.min === undefined || spec.max === undefined)) throw new TweakError('definition', 'a slider needs min and max (use control "number" when the range is unknown)');
  return {
    id: p.id, label, group, hint, control, spec, abs, file: p.file.replace(/\\/g, '/'), line: mapping.correctedLine ?? mapping.line,
    mapping: { start: mapping.start, end: mapping.end, text: mapping.text, before: mapping.before, after: mapping.after, lineBefore: mapping.lineBefore, lineAfter: mapping.lineAfter, unique: mapping.unique, fileHash: mapping.fileHash },
    unit: parsed.unit || '', value: parsed.value, originalText: mapping.text, currentText: mapping.text,
  };
}

function inferControl(kind, spec) {
  if (kind === 'boolean') return 'toggle';
  if (kind === 'color') return 'color';
  if (kind === 'string') return spec.options ? (spec.options.length <= 4 ? 'segmented' : 'select') : 'text';
  if (spec.options) return spec.options.length <= 4 ? 'segmented' : 'select';
  return spec.min !== undefined && spec.max !== undefined ? 'slider' : 'number';
}

/** What the window may see: labels, controls, values. Never a path-resolution detail it could act on. */
export function publicView(def, seq = 1) {
  return {
    seq, scope: def.scope, title: def.title, summary: def.summary, groups: def.groups,
    params: def.params.map((p) => ({
      id: p.id, label: p.label, group: p.group, hint: p.hint, control: p.control, kind: p.spec.kind,
      value: p.value, original: parseLiteral(p.originalText)?.value, unit: p.unit,
      min: p.spec.min, max: p.spec.max, step: p.spec.step ?? defaultStep(p.spec), options: p.spec.options, integer: p.spec.integer,
      source: `${p.file}:${p.line}`,
    })),
  };
}

function defaultStep(spec) {
  if (spec.kind !== 'number') return undefined;
  if (spec.integer) return 1;
  const d = Math.max(spec.decimals || 1, 1);
  return Number((10 ** -d).toFixed(d));
}
