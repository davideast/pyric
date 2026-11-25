import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { sha } from '../../corpus.mjs';

export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const now = () => new Date().toISOString();

export function privateArchive(path) {
  assert.ok(isAbsolute(path), 'supply an absolute archive directory');
  path = realpathSync(path);
  const stat = statSync(path);
  assert.ok(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'archive must be a private directory owned by the controller');
  const git = spawnSync('git', ['-C', path, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
  assert.equal(git.status, 128, 'archive must be outside any Git worktree');
  return path;
}

export function immutable(path, bytes, { identicalOk = false } = {}) {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o400);
  } catch (error) {
    if (!identicalOk || error.code !== 'EEXIST') throw error;
    assert.deepEqual(readFileSync(path), bytes);
    return;
  }
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function startJournal(path, runId) {
  path = privateArchive(path);
  const directory = join(path, runId);
  mkdirSync(directory, { mode: 0o700 });
  let sequence = 0;
  return {
    directory,
    event(kind, data) {
      immutable(join(directory, String(++sequence).padStart(5, '0') + '-' + kind + '.json'), jsonBytes({ at: now(), kind, data }));
    },
    retain(data) {
      const bytes = jsonBytes(data);
      const digest = sha(bytes);
      immutable(join(path, digest + '.json'), bytes, { identicalOk: true });
      return digest;
    },
    complete(data) { immutable(join(directory, 'completed.json'), jsonBytes(data)); },
  };
}

// Errors can contain SDK requests or credentials. Report only their classification
// and our own call site; service operations and verified release IDs are journaled separately.
export function errorDetails(error) {
  const code = String(error?.code || '');
  const location = String(error?.stack || '').split('\n').find(line => line.includes('/controller/') || line.includes('/arcade/live/control.mjs') || line.includes('/adapters/arcade-sdk/'));
  const api = /^(GET|POST|DELETE|PATCH) (\/[\w/():.-]+) (\d{3}) ([A-Z_]+)$/.exec(String(error?.message || ''));
  return {
    code: /^[\w/-]{1,80}$/.test(code) ? code : 'error',
    location: location?.match(/[\w-]+\.mjs:\d+:\d+/)?.[0],
    ...(api ? { method: api[1], path: api[2], status: Number(api[3]), serviceCode: api[4] } : {}),
  };
}
