// The heavy-run slot limit through real processes: each holder below is a
// separate bun process taking a slot in a scratch slot directory, so exits,
// signals and races are the operating system's, not a mock's.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELD_SLOT_ENV, formatDuration, processStartOf, waitingLine, type SlotHolder } from './heavy-run-slots.ts';

const MODULE = fileURLToPath(new URL('./heavy-run-slots.ts', import.meta.url));

/** Takes a slot, prints "took <pid>", and holds it until its stdin closes. */
const HOLDER = `
import { takeHeavyRunSlot } from ${JSON.stringify(MODULE)};
await takeHeavyRunSlot({ command: 'fixture holder' });
console.log('took ' + process.pid);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

interface Holder {
  child: ChildProcess;
  pid: number;
  output: () => string;
}

const scratch: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function slotDir(): { dir: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), 'pyric-heavy-run-slots-'));
  scratch.push(root);
  const script = join(root, 'holder.ts');
  writeFileSync(script, HOLDER);
  const dir = join(root, 'slots');
  mkdirSync(dir);
  return { dir, script };
}

function start(script: string, dir: string, slots: number, extraEnv: Record<string, string> = {}): Holder {
  const env: NodeJS.ProcessEnv = { ...process.env, PYRIC_HEAVY_RUN_DIR: dir, PYRIC_HEAVY_RUN_SLOTS: String(slots), ...extraEnv };
  // This test may itself run inside a held slot (`bun run test`); its holders must not inherit it.
  if (extraEnv[HELD_SLOT_ENV] === undefined) delete env[HELD_SLOT_ENV];
  const child = spawn('bun', [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let text = '';
  child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  return { child, pid: child.pid ?? 0, output: () => text };
}

const took = (holder: Holder) => holder.output().includes(`took ${holder.pid}`);

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function exited(holder: Holder): Promise<number | null> {
  if (holder.child.exitCode !== null) return Promise.resolve(holder.child.exitCode);
  return new Promise((resolve) => holder.child.once('exit', (code, signal) => resolve(code ?? (signal === null ? null : -1))));
}

function slotFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('slot-'));
}

function deadPid(): number {
  const run = spawnSync('bun', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(run.stdout.trim());
}

function writeSlot(dir: string, index: number, holder: Partial<SlotHolder>): void {
  const record: SlotHolder = {
    pid: process.pid,
    processStart: processStartOf(process.pid),
    host: hostname(),
    cwd: '/somewhere',
    command: 'a planted holder',
    takenAt: Date.now(),
    token: 'planted',
    ...holder,
  };
  writeFileSync(join(dir, `slot-${index}.lock`), JSON.stringify(record));
}

describe('two slots, three runs', () => {
  test('the third waits, names both holders, and starts within a second of one exiting', async () => {
    const { dir, script } = slotDir();
    const first = start(script, dir, 2);
    const second = start(script, dir, 2);
    expect(await until(() => took(first) && took(second), 10_000)).toBe(true);
    const third = start(script, dir, 2);
    expect(await until(() => third.output().includes('waiting for a heavy-run slot (2 of 2 in use)'), 10_000)).toBe(true);
    expect(third.output()).toContain(`fixture holder in ${process.cwd()}, pid ${first.pid}`);
    expect(third.output()).toContain(`pid ${second.pid}`);
    await settle(500);
    expect(took(third)).toBe(false);

    first.child.stdin?.end();
    expect(await exited(first)).toBe(0);
    const freedAt = performance.now();
    expect(await until(() => took(third), 5000)).toBe(true);
    expect(performance.now() - freedAt).toBeLessThan(1000);
    expect(slotFiles(dir).length).toBe(2);
  }, 30_000);
});

describe('a stale slot', () => {
  test('a holder killed with SIGKILL loses its slot to the 5 s check', async () => {
    const { dir, script } = slotDir();
    const killed = start(script, dir, 1);
    expect(await until(() => took(killed), 10_000)).toBe(true);
    const waiter = start(script, dir, 1);
    expect(await until(() => waiter.output().includes('waiting for a heavy-run slot (1 of 1 in use)'), 10_000)).toBe(true);
    killed.child.kill('SIGKILL');
    await exited(killed);
    expect(await until(() => took(waiter), 8000)).toBe(true);
  }, 30_000);

  test('a live pid with a different start time is a reused pid, so its slot is taken', async () => {
    const { dir, script } = slotDir();
    writeSlot(dir, 0, { processStart: '1' });
    const holder = start(script, dir, 1);
    expect(await until(() => took(holder), 10_000)).toBe(true);
  }, 20_000);

  test('a live pid with its own start time keeps its slot', async () => {
    const { dir, script } = slotDir();
    writeSlot(dir, 0, {});
    const waiter = start(script, dir, 1);
    expect(await until(() => waiter.output().includes('a planted holder in /somewhere'), 10_000)).toBe(true);
    await settle(1000);
    expect(took(waiter)).toBe(false);
  }, 20_000);

  test('two waiters racing for one stale slot: exactly one gets it', async () => {
    for (let round = 0; round < 5; round++) {
      const { dir, script } = slotDir();
      writeSlot(dir, 0, { pid: deadPid() });
      const racers = [start(script, dir, 1), start(script, dir, 1)];
      expect(await until(() => racers.some(took), 10_000)).toBe(true);
      await settle(1000);
      expect(racers.filter(took).length).toBe(1);
      expect(slotFiles(dir)).toEqual(['slot-0.lock']);
      for (const racer of racers) racer.child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('releasing a slot', () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    test(`${signal} to a holder releases its slot`, async () => {
      const { dir, script } = slotDir();
      const holder = start(script, dir, 1);
      expect(await until(() => took(holder), 10_000)).toBe(true);
      expect(slotFiles(dir)).toEqual(['slot-0.lock']);
      holder.child.kill(signal);
      await exited(holder);
      expect(existsSync(join(dir, 'slot-0.lock'))).toBe(false);
    }, 20_000);
  }

  test('a process started inside a held slot runs in it instead of waiting', async () => {
    const { dir, script } = slotDir();
    const parent = start(script, dir, 1);
    expect(await until(() => took(parent), 10_000)).toBe(true);
    const child = start(script, dir, 1, { [HELD_SLOT_ENV]: join(dir, 'slot-0.lock') });
    expect(await until(() => took(child), 10_000)).toBe(true);
    child.child.stdin?.end();
    await exited(child);
    expect(JSON.parse(readFileSync(join(dir, 'slot-0.lock'), 'utf8')).pid).toBe(parent.pid);
  }, 20_000);
});

describe('the waiting line', () => {
  test('names each holder with its command, directory, pid and time held', () => {
    const base = { host: 'h', processStart: null, token: 't' };
    const holders: SlotHolder[] = [
      { ...base, pid: 11, cwd: '/w/a', command: 'bun run test', takenAt: 0 },
      { ...base, pid: 22, cwd: '/w/b', command: 'bun test/apps/run.ts demo', takenAt: 245_000 },
    ];
    expect(waitingLine(holders, 2, 250_000)).toBe(
      'waiting for a heavy-run slot (2 of 2 in use): bun run test in /w/a, pid 11, 4m 10s; bun test/apps/run.ts demo in /w/b, pid 22, 5s',
    );
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });
});
