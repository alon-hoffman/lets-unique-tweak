/**
 * The tweak agent: a small zero-dependency process that is the deterministic
 * half of Let's Tweak. It reads `tweak.*` events from the window on its OWN
 * named LIP cursor, applies them with TweakSession, and answers with `tweak.*`
 * commands. It contains no model call and no network access beyond the
 * loopback LIP host, so a slider drag costs no tokens by construction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Lip, TWEAK_HOME } from './lip.mjs';
import { TweakSession } from './session.mjs';

const UNIQUE = 'tweak';
const HEARTBEAT_MS = 4000;
const IDLE_EXIT_MS = 10 * 60_000;

export const stateFileFor = (windowId, home = TWEAK_HOME) => path.join(home, safeId(windowId), 'state.json');
export function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('bad window id');
  return id;
}

/**
 * Collapse runs of consecutive `tweak.set` events (per window) to the last one per parameter:
 * dragging a slider produces many, and only where it stopped matters. Anything else breaks a run,
 * so undo and revert keep their meaning.
 */
export function coalesce(events) {
  const out = [];
  let run = null;
  let dropped = 0;
  const flush = () => { if (run) { out.push(...run.values()); run = null; } };
  for (const e of events) {
    if (e.type === 'tweak.set') {
      const key = `${e.window}|${e.data?.id}`;
      if (!run) run = new Map();
      if (run.has(key)) { run.delete(key); dropped++; }        // re-insert at the end: keeps arrival order of the survivors
      run.set(key, e);
    } else { flush(); out.push(e); }
  }
  flush();
  return { events: out, dropped };
}

export class Agent {
  constructor({ lip, home = TWEAK_HOME, log = () => {}, now = Date.now }) {
    this.lip = lip;
    this.home = home;
    this.log = log;
    this.now = now;
    this.sessions = new Map();           // windowId -> TweakSession
    this.cursor = `tweak-${process.pid}-${now().toString(36)}`;
    this.counts = { events: 0, sets: 0, dropped: 0, results: 0 };
    this.stopped = false;
    this.lastWindowSeen = now();
  }

  session(w) {
    let s = this.sessions.get(w);
    const file = stateFileFor(w, this.home);
    if (s && s.changedOnDisk()) s = null;                                   // the CLI opened a new scope
    if (!s) {
      if (!fs.existsSync(file)) return null;
      s = TweakSession.restore(file);
      this.sessions.set(w, s);
    }
    return s;
  }

  async reply(w, type, data) {
    this.counts.results++;
    try { await this.lip.command(type, data, w); } catch (err) { this.log(`reply failed: ${err.message}`); }
  }

  /** Handle one batch of up-events; returns how many tweak events were processed. */
  async handle(events) {
    const mine = [];
    for (const e of events) {
      if (typeof e?.type !== 'string' || !e.type.startsWith('tweak.')) continue;
      const m = /^unique:tweak#([A-Za-z0-9_-]{1,64})$/.exec(String(e.from));
      if (!m) continue;                                                      // only the tweak window itself may drive edits
      mine.push({ ...e, window: m[1] });
    }
    const { events: list, dropped } = coalesce(mine);
    this.counts.dropped += dropped;
    for (const e of list) {
      this.counts.events++;
      await this.one(e).catch((err) => { this.log(`event ${e.type}: ${err.stack || err}`); });
    }
    return list.length;
  }

  async one(e) {
    const w = e.window;
    const d = e.data && typeof e.data === 'object' ? e.data : {};
    this.lastWindowSeen = this.now();
    const s = this.session(w);
    if (e.type === 'tweak.hello') {
      await this.reply(w, 'tweak.agent', this.agentInfo());
      if (s?.view()) await this.reply(w, 'tweak.inspector', { ...s.view(), changed: s.changedCount(), canUndo: s.journal.length > 0 });
      return;
    }
    if (!s) return this.reply(w, 'tweak.result', { op: e.type.slice(6), ok: false, code: 'no-inspector', message: 'No inspector is open for this window yet. Ask Claude what to tweak.' });
    let r;
    let op = e.type.slice(6);
    switch (e.type) {
      case 'tweak.set':
        if (typeof d.id !== 'string') return;
        this.counts.sets++;
        r = await s.set(d.id, d.value);
        break;
      case 'tweak.revert': if (typeof d.id !== 'string') return; r = await s.revert(d.id); break;
      case 'tweak.undo': r = await s.undo(); break;
      case 'tweak.revertAll': r = await s.revertAll(); break;
      case 'tweak.resync': r = await s.resync(); break;
      default: return;                                                       // unknown tweak.* types are ignored, as LIP asks
    }
    await this.reply(w, 'tweak.result', { op, n: d.n, ...r, changed: s.changedCount(), canUndo: s.journal.length > 0, writes: s.stats.writes });
  }

  agentInfo() { return { online: true, pid: process.pid, v: 1, sets: this.counts.sets, writes: [...this.sessions.values()].reduce((a, s) => a + s.stats.writes, 0) }; }

  async run({ onReady } = {}) {
    // start at the end of the ring: events from before this agent existed are not ours to replay
    for (let i = 0; i < 20; i++) { const r = await this.lip.listen(this.cursor, 0, 200); if (!r.pending) break; }
    onReady?.();
    let hb = 0;
    let failures = 0;
    while (!this.stopped) {
      try {
        const r = await this.lip.listen(this.cursor, 2000, 200);
        failures = 0;
        const hasWindow = r.windows?.some((x) => x.unique === UNIQUE);
        if (hasWindow) this.lastWindowSeen = this.now();
        if (r.events?.length) await this.handle(r.events);
        if (this.now() - hb > HEARTBEAT_MS && hasWindow) { hb = this.now(); await this.lip.command('tweak.agent', this.agentInfo(), `unique:${UNIQUE}`).catch(() => {}); }
        if (this.now() - this.lastWindowSeen > IDLE_EXIT_MS) { this.log('no tweak window for a while; exiting'); break; }
      } catch (err) {
        if (++failures > 15) { this.log(`host unreachable: ${err.message}; exiting`); break; }
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  }

  stop() { this.stopped = true; }
}
