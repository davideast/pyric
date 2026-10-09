// Preloaded by bunfig.toml for every `bun test` run in packages/cli. Points
// TMPDIR at a directory owned by this run, so every `mkdtemp(tmpdir(), ...)`
// in the suite lands inside it, then removes
// that directory after the last test file. `bun test` emits no `exit` event to
// a preload, but an `afterAll` registered here runs once, after every file. A
// run that is killed first leaves its directory behind; the next run removes
// any whose process is gone.
//
// A process spawned by Bun receives the environment Bun started with, not
// later `process.env` writes, so a test whose child process makes temp files
// passes `env: process.env` to the spawn.
import { afterAll } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'pyric-test-run-';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const base = tmpdir();
for (const name of readdirSync(base)) {
  if (!name.startsWith(PREFIX)) continue;
  const pid = Number(name.slice(PREFIX.length).split('-')[0]);
  if (Number.isInteger(pid) && pid > 0 && !alive(pid)) rmSync(join(base, name), { recursive: true, force: true });
}

const runDir = mkdtempSync(join(base, `${PREFIX}${process.pid}-`));
process.env.TMPDIR = runDir;
process.env.TMP = runDir;
process.env.TEMP = runDir;
afterAll(() => rmSync(runDir, { recursive: true, force: true }));
