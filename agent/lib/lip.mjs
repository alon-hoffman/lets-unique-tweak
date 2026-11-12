/**
 * A minimal client for the documented LIP host endpoints (protocol/LIP.md §4):
 *   GET  /lip/listen?cursor=<name>&wait_ms=   read up-events on this agent's own named cursor
 *   POST /lip/command                         send down-commands to a window
 *   GET  /lip/windows                         which windows exist
 * Nothing here is a new protocol: it is the same envelope and the same routes the
 * `lets` CLI uses. The agent never touches the `claude` or `hook` cursors.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.LETS_HOME || path.join(os.homedir(), '.lets');
export const TWEAK_HOME = path.join(HOME, 'tweak');

export function runFiles() {
  const dir = path.join(HOME, 'run');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^host-\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j?.port && j?.token) out.push({ port: j.port, token: j.token });
    } catch { /* half-written */ }
  }
  return out;
}

export class Lip {
  constructor({ port, token }) { this.port = port; this.token = token; this.base = `http://127.0.0.1:${port}`; }

  async req(method, url, body, timeoutMs = 10_000) {
    const res = await fetch(this.base + url, {
      method, headers: { 'x-lets-token': this.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${method} ${url.split('?')[0]} → ${res.status}`);
    return res.json();
  }

  windows() { return this.req('GET', '/lip/windows'); }
  listen(cursor, waitMs = 0, max = 200) { return this.req('GET', `/lip/listen?cursor=${encodeURIComponent(cursor)}&wait_ms=${waitMs}&max=${max}`, null, waitMs + 8000); }
  /** Send a down-command. `to` is a window id or "unique:tweak". */
  command(type, data, to) { return this.req('POST', '/lip/command', { type, data, to, ttl: 60_000 }); }
}

/** Find the running host that holds `windowId` (or the only host, when no id is given). */
export async function findHost({ windowId = null, port = null, token = null } = {}) {
  if (port && token) return new Lip({ port: Number(port), token });
  const candidates = runFiles().map((r) => new Lip(r));
  const live = [];
  for (const c of candidates) {
    try { const w = await c.windows(); live.push({ c, w }); } catch { /* stale run file */ }
  }
  if (windowId) {
    const hit = live.find((l) => l.w.some((x) => x.id === windowId));
    if (hit) return hit.c;
    throw new Error(`no running lets host has a window "${windowId}"`);
  }
  if (live.length === 1) return live[0].c;
  throw new Error(live.length ? 'several lets hosts are running; pass --window' : 'no running lets host found (open the window first with /lets tweak)');
}
