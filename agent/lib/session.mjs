/**
 * A tweak session: the deterministic half of Let's Tweak.
 *
 * set / revert / undo take a parameter id and a value and nothing else. They
 * look the id up in the resolved definition, re-verify the mapped span in the
 * real file, validate the value, replace exactly that span and write the file
 * atomically. No step involves a model, and the window never names a path.
 *
 * Safety rules, all enforced here:
 *   - the literal on disk must be what we last wrote (or the original); if
 *     someone edited it, we report `changed` and adopt their value, never overwrite
 *   - a span that cannot be found again unambiguously is `stale`; we do not guess
 *   - edits elsewhere in the file are preserved byte for byte
 *   - writes are atomic (temp file + rename), line endings and BOM untouched
 *   - undo restores only when the file still holds what we wrote
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { formatValue, parseLiteral, TweakError } from './literal.mjs';
import { readSource, locate, splice, anchorsAt, safePath } from './source.mjs';
import { publicView } from './definition.mjs';

const locks = new Map();                  // abs path -> promise chain: one writer per file, in order
const JOURNAL_MAX = 500;

function withLock(abs, fn) {
  const prev = locks.get(abs) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(abs, next.catch(() => {}));
  return next;
}

export class TweakSession {
  /**
   * @param {object} o
   * @param {string} o.root     project root (real path)
   * @param {string} [o.stateFile]  where to persist mappings and the undo journal (outside the project)
   */
  constructor({ root, stateFile = null }) {
    this.root = fs.realpathSync(root);
    this.stateFile = stateFile;
    this.seq = 0;
    this.def = null;                      // the active definition (scope, params)
    this.retired = [];                    // params of earlier scopes: kept only so Revert all reaches them
    this.journal = [];                    // [{id, abs, file, beforeText, afterText, ts}]
    this.stats = { writes: 0, sets: 0, skipped: 0, superseded: 0, failures: 0 };
    this.mtime = 0;
  }

  // ---- definitions ---------------------------------------------------------

  /** Activate a resolved definition (see resolveDefinition). The previous scope's parameters are retired, not reverted. */
  load(def) {
    // a literal that an earlier scope already changed keeps its true original; the earlier entry is dropped so it cannot revert twice
    const earlier = [...(this.def?.params || []), ...this.retired];
    const dropped = new Set();
    for (const p of def.params) {
      const q = earlier.find((r) => !dropped.has(r) && r.abs === p.abs && r.currentText !== r.originalText && this.sameSpan(r, p));
      if (q) { p.originalText = q.originalText; dropped.add(q); }
    }
    if (this.def) this.retired.push(...this.def.params.filter((p) => p.currentText !== p.originalText));
    this.retired = this.retired.filter((r) => !dropped.has(r));
    this.def = def;
    this.seq++;
    this.persist();
    return this.view();
  }

  /** Do two mappings (from different scopes) point at the same literal in the file as it is now? */
  sameSpan(a, b) {
    try {
      const content = readSource(a.abs);
      const loc = locate(content, a.mapping, a.spec.kind);
      return (loc.status === 'ok' || loc.status === 'moved') && loc.start === b.mapping.start;
    } catch { return false; }
  }

  view() { return this.def ? { ...publicView(this.def, this.seq), projectKey: crypto.createHash('sha256').update(this.root).digest('hex').slice(0, 24) } : null; }

  param(id) {
    const p = this.def?.params.find((x) => x.id === id);
    if (!p) throw new TweakError('unknown', `no parameter "${id}" in the current inspector`);
    return p;
  }

  changedCount() { return this.allParams().filter((p) => p.currentText !== p.originalText).length; }
  allParams() { return [...(this.def?.params || []), ...this.retired]; }

  // ---- edits ---------------------------------------------------------------

  /** Set a parameter to `value`. Resolves {ok, id, value, changes} or {ok:false, id, code, message}. */
  async set(id, value) {
    this.stats.sets++;
    let p;
    try { p = this.param(id); } catch (e) { return this.fail(id, e); }
    return this.edit(p, (cur) => {
      const next = formatValue(p.spec, parseLiteral(cur), value);
      return next;
    });
  }

  /** Put one parameter back to the text it had when it was first mapped. */
  async revert(id) {
    let p;
    try { p = this.param(id); } catch (e) { return this.fail(id, e); }
    return this.edit(p, () => p.originalText, { isRevert: true });
  }

  /** Undo the most recent change (drags of one parameter count as one change). */
  async undo() {
    const e = this.journal.at(-1);
    if (!e) return { ok: false, code: 'nothing', message: 'nothing to undo' };
    const p = this.allParams().find((x) => x.id === e.id && x.abs === e.abs && x.currentText === e.afterText);
    if (!p) return { ok: false, code: 'conflict', message: 'that change no longer matches the file; use Revert on the parameter' };
    const r = await this.edit(p, () => e.beforeText, { journal: false });
    if (r.ok) this.journal.pop();
    this.persist();
    return r;
  }

  /** Restore every parameter of this session, across scopes, to its original text. */
  async revertAll() {
    const changes = [];
    const errors = [];
    for (const p of [...this.allParams()].reverse()) {
      if (p.currentText === p.originalText) continue;
      const r = await this.edit(p, () => p.originalText, { journal: false });
      if (r.ok) changes.push(...r.changes); else errors.push({ id: p.id, code: r.code, message: r.message });
    }
    if (!errors.length) this.journal = [];
    this.retired = this.retired.filter((p) => p.currentText !== p.originalText);
    this.persist();
    return { ok: errors.length === 0, changes, errors, code: errors[0]?.code, message: errors.length ? `${errors.length} parameter(s) could not be restored: ${errors[0].message}` : undefined };
  }

  /** Re-read every mapped literal from disk (after someone edited files, or a stale report). No writes. */
  async resync() {
    const changes = [];
    for (const p of this.def?.params || []) {
      try {
        const content = readSource(p.abs);
        const loc = locate(content, p.mapping, p.spec.kind);
        if (loc.status === 'lost' || loc.status === 'ambiguous') { p.stale = true; continue; }
        p.stale = false;
        if (loc.text !== p.currentText) this.adopt(p, content, loc);
        else p.mapping = anchorsAt(content, loc.start, loc.end);            // only moved: refresh the anchors, keep the baseline
        changes.push(this.change(p));
      } catch { p.stale = true; }
    }
    this.persist();
    return { ok: true, changes, stale: (this.def?.params || []).filter((p) => p.stale).map((p) => p.id) };
  }

  // ---- the one write path ------------------------------------------------------

  edit(p, nextText, { journal = true, isRevert = false } = {}) {
    return withLock(p.abs, async () => {
      try {
        // the path must still be safe, and the file is read fresh every time: never trust an earlier read
        safePath(this.root, p.file);
        const content = readSource(p.abs);
        const loc = locate(content, p.mapping, p.spec.kind);
        if (loc.status === 'lost' || loc.status === 'ambiguous') {
          p.stale = true;
          throw new TweakError('stale', `${p.label}: the code around ${p.file}:${p.line} changed and the value can no longer be found safely. Ask Claude to re-discover this scope.`);
        }
        if (loc.status === 'changed') {
          // the literal was edited outside Let's Tweak: adopt it, never overwrite it
          this.adopt(p, content, loc);
          this.persist();
          throw new TweakError('changed', `${p.label} was changed in the file to ${loc.text}. Showing that value; nothing was overwritten.`, { value: p.value, changes: [this.change(p)] });
        }
        if (loc.text !== p.currentText) this.adopt(p, content, loc);
        const cur = parseLiteral(loc.text);
        const text = nextText(loc.text, cur);
        if (text === loc.text) { this.stats.skipped++; return { ok: true, id: p.id, value: p.value, text, unchanged: true, changes: [this.change(p)] }; }
        const before0 = content[loc.start - 1];
        if ((text[0] === '-' || text[0] === '+') && before0 === text[0]) throw new TweakError('value', `${p.label}: writing ${text} here would form "${before0}${text[0]}" with the code before it`);
        const updated = splice(content, loc.start, loc.end, text);
        this.write(p.abs, updated);
        this.stats.writes++;
        const before = loc.text;
        this.rebase(p, content, updated, loc, text);
        p.stale = false;
        const last = this.journal.at(-1);
        if (journal && !isRevert) {
          if (last && last.id === p.id && last.abs === p.abs && last.afterText === before) last.afterText = text;
          else this.journal.push({ id: p.id, abs: p.abs, file: p.file, beforeText: before, afterText: text, ts: Date.now() });
          if (this.journal.length > JOURNAL_MAX) this.journal.shift();
        } else if (isRevert) {
          // a revert is itself undoable
          this.journal.push({ id: p.id, abs: p.abs, file: p.file, beforeText: before, afterText: text, ts: Date.now() });
        }
        this.persist();
        return { ok: true, id: p.id, value: p.value, text, changes: [this.change(p)] };
      } catch (err) {
        if (!(err instanceof TweakError)) { this.stats.failures++; return { ok: false, id: p.id, code: 'io', message: `${p.label}: ${err.message}` }; }
        return this.fail(p.id, err);
      }
    });
  }

  fail(id, err) {
    this.stats.failures++;
    return { ok: false, id, code: err.code || 'error', message: err.message, ...(err.value !== undefined ? { value: err.value } : {}), ...(err.changes ? { changes: err.changes } : {}) };
  }

  /** Adopt the literal currently on disk as the known one (relocating the span, refreshing anchors). */
  adopt(p, content, loc) {
    p.mapping = { ...anchorsAt(content, loc.start, loc.end) };
    p.currentText = loc.text;
    // someone else's edit is the new baseline: Revert never overwrites it, and earlier undo steps for it no longer apply
    p.originalText = loc.text;
    this.journal = this.journal.filter((e) => !(e.id === p.id && e.abs === p.abs));
    const parsed = parseLiteral(loc.text);
    p.value = parsed.value;
    p.unit = parsed.unit || '';
  }

  change(p) { return { id: p.id, value: p.value, original: parseLiteral(p.originalText).value }; }

  /** After replacing one span: the file's other mapped spans moved; recompute them against the new text. */
  rebase(edited, oldContent, newContent, loc, text) {
    const delta = text.length - (loc.end - loc.start);
    edited.mapping = anchorsAt(newContent, loc.start, loc.start + text.length);
    edited.currentText = text;
    const parsed = parseLiteral(text);
    edited.value = parsed.value;
    edited.unit = parsed.unit || '';
    for (const q of this.allParams()) {
      if (q === edited || q.abs !== edited.abs) continue;
      const at = locate(oldContent, q.mapping, q.spec.kind);
      if (at.status !== 'ok' && at.status !== 'moved') continue;        // already stale: leave it, it reports itself on use
      const start = at.start >= loc.end ? at.start + delta : at.start;
      q.mapping = anchorsAt(newContent, start, start + at.text.length);
    }
  }

  write(abs, content) {
    const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.lets-tweak.tmp`;
    try { fs.writeFileSync(tmp, content, 'utf8'); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* none */ } throw err; }
    try { fs.renameSync(tmp, abs); }
    catch (err) {
      // Windows can refuse to rename over a file a dev server is holding open: fall back to an in-place write
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
      fs.writeFileSync(abs, content, 'utf8');
    }
  }

  // ---- persistence -----------------------------------------------------------

  persist() {
    if (!this.stateFile) return;
    const strip = (p) => ({ ...p });
    const state = { root: this.root, seq: this.seq, def: this.def && { ...this.def, params: this.def.params.map(strip) }, retired: this.retired.map(strip), journal: this.journal, stats: this.stats };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.stateFile);
      this.mtime = fs.statSync(this.stateFile).mtimeMs;
    } catch { /* state is a convenience; edits are already on disk */ }
  }

  /** Load state written by this class (the CLI writes it when a new scope opens, the daemon reloads it). */
  static restore(stateFile) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const s = new TweakSession({ root: state.root, stateFile });
    s.seq = state.seq || 0;
    s.def = state.def;
    s.retired = state.retired || [];
    s.journal = state.journal || [];
    s.stats = { ...s.stats, ...(state.stats || {}) };
    for (const p of [...(s.def?.params || []), ...s.retired]) if (safePath(s.root, p.file) !== p.abs) throw new TweakError('state', `the saved state for ${p.file} does not match the project; open the inspector again`);
    s.mtime = fs.statSync(stateFile).mtimeMs;
    return s;
  }

  /** True when another process (the CLI opening a new scope) rewrote the state file since we last wrote it. */
  changedOnDisk() {
    try { return fs.statSync(this.stateFile).mtimeMs > this.mtime; } catch { return false; }
  }
}
