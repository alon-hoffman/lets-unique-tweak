/**
 * Shared by the integration test and the demo: a fake window that speaks LIP the way lets-client.js does
 * (SSE down, POST /lip/event up), and an async runner for the lets-tweak CLI.
 * The CLI must be async: the lets host runs in the same process as the caller, and a blocking spawn would starve it.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

export const CLI = path.join(ROOT, 'agent', 'bin', 'lets-tweak.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
}

export async function fakeWindow(host, windowId, unique = 'tweak') {
  const got = [];
  const ctl = new AbortController();
  const res = await fetch(`${host.origin}/lip/stream?w=${windowId}&u=${unique}&t=${host.token}`, { signal: ctl.signal });
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) got.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* closed */ }
  })();
  const w = {
    id: windowId, got, close: () => ctl.abort(),
    emit: (type, data) => fetch(`${host.origin}/lip/event?w=${windowId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-lets-token': host.token },
      body: JSON.stringify({ lip: 1, id: `ev_${Math.random().toString(36).slice(2)}`, ts: Date.now(), dir: 'up', from: `unique:${unique}#${windowId}`, type, data }),
    }),
    results: () => got.filter((m) => m.type === 'tweak.result'),
    last: (type) => [...got].reverse().find((m) => m.type === type),
  };
  await until(() => got.some((m) => m.type === 'lip.hello'), 5000, 'lip.hello');
  return w;
}

export function cli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } }, (err, stdout, stderr) => {
      let json = null;
      try { json = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* not json */ }
      resolve({ status: err ? (err.code ?? 1) : 0, json, stdout, stderr });
    });
  });
}
