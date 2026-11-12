/**
 * Literals: what a tweakable value looks like in source text, how to read it,
 * how to validate a new value against it and how to print it back.
 *
 * Nothing here evaluates code. A literal is recognised by a strict pattern; a
 * new value is checked and then printed by this file, never spliced in as text
 * the caller wrote. That is what makes edits safe to do without an LLM.
 *
 * Kinds: number (with an optional CSS-style unit), boolean, string, color.
 */

const NUM = '(?:\\d+(?:_\\d+)*(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const UNITS = 'px|rem|em|%|ms|s|deg|vh|vw|pt|fr';
const NUMBER_RE = new RegExp(`^(-?${NUM})(${UNITS})?$`);
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_STRING = 400;

export const KINDS = ['number', 'boolean', 'string', 'color'];

/** Read a literal's text into {kind, value, quote?, unit?} or null when it is not a safe literal. */
export function parseLiteral(text) {
  if (typeof text !== 'string' || !text) return null;
  if (text === 'true' || text === 'false') return { kind: 'boolean', value: text === 'true' };
  const num = NUMBER_RE.exec(text);
  if (num) return { kind: 'number', value: Number(num[1].replace(/_/g, '')), unit: num[2] || '', decimals: decimalsOf(num[1]) };
  if (HEX_RE.test(text)) return { kind: 'color', value: text.toLowerCase(), quote: '', upper: /[A-F]/.test(text) };
  const q = text[0];
  if ((q === '"' || q === "'" || q === '`') && text.length >= 2 && text.at(-1) === q) {
    const body = text.slice(1, -1);
    if (q === '`' && body.includes('${')) return null;                 // a template with an expression is code, not a value
    const value = unescapeString(body, q);
    if (value === null) return null;
    if (HEX_RE.test(value)) return { kind: 'color', value: value.toLowerCase(), quote: q, upper: /[A-F]/.test(value) };
    return { kind: 'string', value, quote: q };
  }
  return null;
}

function decimalsOf(s) {
  const m = /\.(\d+)/.exec(s.replace(/[eE].*$/, ''));
  return m ? m[1].length : 0;
}

function unescapeString(body, q) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === q && q !== '`') return null;                              // an unescaped quote inside means the span is not one literal
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    if (n === undefined) return null;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === '\\' || n === '"' || n === "'" || n === '`') out += n;
    else return null;                                                   // \u, \x, line continuations: leave those alone
  }
  return out;
}

function escapeString(value, q) {
  let out = '';
  for (const c of value) {
    if (c === '\\') out += '\\\\';
    else if (c === q) out += '\\' + q;
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r' || c < ' ' || c === ' ' || c === ' ') throw new TweakError('value', 'control characters are not allowed in a text value');
    else out += c;
  }
  return out;
}

export class TweakError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/**
 * Check `value` against a parameter spec ({kind, min?, max?, step?, options?, maxLength?}) and the
 * literal it will replace, and return the exact text to write. Throws TweakError('value'|'range').
 */
export function formatValue(spec, current, value) {
  switch (spec.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TweakError('value', 'expected a finite number');
      if (spec.integer && !Number.isInteger(value)) throw new TweakError('value', 'expected a whole number');
      if (spec.options && !spec.options.includes(value)) throw new TweakError('value', `${value} is not one of the allowed options`);
      if (spec.min !== undefined && value < spec.min) throw new TweakError('range', `${value} is below the minimum ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) throw new TweakError('range', `${value} is above the maximum ${spec.max}`);
      const decimals = Math.min(6, Math.max(spec.decimals ?? 0, current.decimals ?? 0, decimalsOfNumber(value)));
      let text = Number.isInteger(value) && decimals === 0 ? String(value) : trimZeros(value.toFixed(decimals), current.decimals);
      if (/e/i.test(text)) text = value.toFixed(decimals);
      return text + (current.unit || '');
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new TweakError('value', 'expected true or false');
      return String(value);
    case 'color': {
      if (typeof value !== 'string' || !HEX_RE.test(value)) throw new TweakError('value', 'expected a #rgb or #rrggbb color');
      const hex = current.upper ? value.toUpperCase() : value.toLowerCase();
      return current.quote ? current.quote + hex + current.quote : hex;
    }
    case 'string': {
      if (typeof value !== 'string') throw new TweakError('value', 'expected text');
      if (value.length > (spec.maxLength ?? MAX_STRING)) throw new TweakError('value', `text is longer than ${spec.maxLength ?? MAX_STRING} characters`);
      if (spec.options && !spec.options.includes(value)) throw new TweakError('value', `"${value}" is not one of the allowed options`);
      const q = current.quote;
      if (q === '`' && value.includes('${')) throw new TweakError('value', 'template placeholders are not allowed');
      return q + escapeString(value, q) + q;
    }
    default:
      throw new TweakError('kind', `unsupported kind "${spec.kind}"`);
  }
}

function decimalsOfNumber(v) {
  const s = String(v);
  if (/e/i.test(s)) return 6;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** 1.50 stays 1.50 only when the source used two decimals; otherwise drop pointless zeros. */
function trimZeros(s, sourceDecimals) {
  if (!s.includes('.')) return s;
  const keep = sourceDecimals ?? 0;
  const [i, f] = s.split('.');
  let frac = f;
  while (frac.length > keep && frac.endsWith('0')) frac = frac.slice(0, -1);
  return frac ? `${i}.${frac}` : i;
}

/** The value a window shows for a parsed literal. */
export function publicValue(parsed) { return parsed.value; }
