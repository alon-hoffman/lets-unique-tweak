import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'app');

/** A throwaway copy of the fixture project (the originals are never edited). */
export function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweak-test-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return fs.realpathSync(dir);
}

export const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
export const write = (root, rel, s) => fs.writeFileSync(path.join(root, rel), s, 'utf8');

export function def(params, extra = {}) {
  return { scope: 'test', title: 'Test', params, ...extra };
}

/** line number of the first line containing `needle` */
export function lineOf(root, rel, needle) {
  const i = read(root, rel).split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${needle} not in ${rel}`);
  return i + 1;
}
