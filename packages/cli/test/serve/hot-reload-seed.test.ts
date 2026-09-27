/** P3 — rules hot-reload over SSE + --seed (plan steps 3.1/3.2). */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger, type ServeLogger } from '../../src/serve/server.js';

const RULES_V1 = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /a/{id} { allow read: if true; }
  }
}`;
const RULES_V2 = RULES_V1.replace('/a/{id}', '/b/{id}');

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-p3-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({
    firestore: { rules: 'firestore.rules' },
    hosting: { public: 'public' },
  }));
  writeFileSync(join(dir, 'firestore.rules'), RULES_V1);
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  return dir;
}

const stops: ServeRuntime[] = [];
afterAll(async () => {
  for (const r of stops) await r.handle.stop();
});

describe('rules hot-reload (SSE)', () => {
  it('file change → SSE rules-changed + live init.json hash', async () => {
    const cwd = project();
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.c'), logger: silentServeLogger() });
    stops.push(r);
    const before = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { rulesHash: string };

    // open the SSE stream, then touch the file
    const stream = await fetch(r.handle.url + '/__pyric/events');
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const eventArrived = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value);
        const m = buffer.match(/event: rules-changed\ndata: (.*)\n\n/);
        if (m) return JSON.parse(m[1]!) as { rules: string; rulesHash: string };
      }
    })();

    await new Promise((res) => setTimeout(res, 100)); // let the watcher arm
    writeFileSync(join(cwd, 'firestore.rules'), RULES_V2);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const evt = await Promise.race([
      eventArrived,
      new Promise<null>((res) => { timer = setTimeout(() => res(null), 5000); }),
    ]);
    clearTimeout(timer);
    expect(evt).not.toBeNull();
    expect(evt!.rules).toContain('/b/{id}');
    expect(evt!.rulesHash).not.toBe(before.rulesHash);

    const after = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { rulesHash: string; rules: string };
    expect(after.rulesHash).toBe(evt!.rulesHash); // live payload follows
    await reader.cancel().catch(() => {});
  }, 15_000);

  it('a broken save is skipped — last-good stays live', async () => {
    const cwd = project();
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.c'), logger: silentServeLogger() });
    stops.push(r);
    const before = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { rulesHash: string };
    await new Promise((res) => setTimeout(res, 100));
    writeFileSync(join(cwd, 'firestore.rules'), 'rules_version = ;;; broken');
    await new Promise((res) => setTimeout(res, 500)); // watcher debounce + processing
    const after = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { rulesHash: string };
    expect(after.rulesHash).toBe(before.rulesHash); // unchanged
  }, 10_000);
});

/** A project with hosting and no rules files. */
function projectWithoutRules(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-no-rules-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  return dir;
}

function capturingLogger(): { logger: ServeLogger; notes: string[] } {
  const notes: string[] = [];
  return { logger: { info: () => {}, note: (m) => notes.push(m) }, notes };
}

async function waitForNote(notes: string[], text: string, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = notes.find((line) => line.includes(text));
    if (found) return found;
    await new Promise((res) => setTimeout(res, 50));
  }
  return null;
}

const DATABASE_RULES = JSON.stringify({ rules: { notes: { '.read': 'auth != null', '.write': 'auth != null' } } });

describe('rules files that do not exist at startup', () => {
  it('loads database.rules.json created after startup', async () => {
    const cwd = projectWithoutRules();
    const { logger, notes } = capturingLogger();
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.c'), logger });
    stops.push(r);
    await new Promise((res) => setTimeout(res, 100));
    writeFileSync(join(cwd, 'database.rules.json'), DATABASE_RULES);

    expect(await waitForNote(notes, 'rtdb rules reloaded')).not.toBeNull();
    const payload = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { databaseRules: unknown };
    expect(payload.databaseRules).toEqual(JSON.parse(DATABASE_RULES));
  }, 15_000);

  it('returns RTDB to deny-all with a notice when database.rules.json is deleted, and loads it again when it returns', async () => {
    const cwd = projectWithoutRules();
    writeFileSync(join(cwd, 'database.rules.json'), DATABASE_RULES);
    const { logger, notes } = capturingLogger();
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.c'), logger });
    stops.push(r);
    await new Promise((res) => setTimeout(res, 100));
    rmSync(join(cwd, 'database.rules.json'));

    const notice = await waitForNote(notes, 'rtdb rules removed');
    expect(notice).not.toBeNull();
    expect(notice).toContain('DENY');
    const payload = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { databaseRules: unknown };
    expect(payload.databaseRules).toBeNull();

    writeFileSync(join(cwd, 'database.rules.json'), DATABASE_RULES);
    expect(await waitForNote(notes, 'rtdb rules reloaded')).not.toBeNull();
  }, 15_000);

  it('loads firestore.rules created after startup', async () => {
    const cwd = projectWithoutRules();
    const { logger, notes } = capturingLogger();
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.c'), logger });
    stops.push(r);
    await new Promise((res) => setTimeout(res, 100));
    writeFileSync(join(cwd, 'firestore.rules'), RULES_V1);

    expect(await waitForNote(notes, 'rules reloaded')).not.toBeNull();
    const payload = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { rules: string | null };
    expect(payload.rules).toContain('/a/{id}');
  }, 15_000);

  it('keeps the last-good Firestore rules with a notice when firestore.rules is deleted', async () => {
    const cwd = project();
    const { logger, notes } = capturingLogger();
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.c'), logger });
    stops.push(r);
    await new Promise((res) => setTimeout(res, 100));
    rmSync(join(cwd, 'firestore.rules'));

    const notice = await waitForNote(notes, 'rules NOT reloaded');
    expect(notice).not.toBeNull();
    expect(notice).toContain('does not exist');
    const payload = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { rules: string | null };
    expect(payload.rules).toContain('/a/{id}');
  }, 15_000);
});

describe('--seed', () => {
  it('valid seed lands in the init payload', async () => {
    const cwd = project();
    writeFileSync(join(cwd, 'seed.json'), JSON.stringify({ 'tasks/t1': { title: 'seeded', done: false } }));
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.c'), logger: silentServeLogger(), seed: 'seed.json' });
    stops.push(r);
    const payload = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as {
      seed: Record<string, Record<string, unknown>>;
    };
    expect(payload.seed['tasks/t1']).toEqual({ title: 'seeded', done: false });
  });

  it('rejects a non-object seed file with a clear error', async () => {
    const cwd = project();
    writeFileSync(join(cwd, 'seed.json'), '["not", "a", "map"]');
    await expect(
      startServe({ cwd, port: 0, cacheRoot: join(cwd, '.c'), logger: silentServeLogger(), seed: 'seed.json' }),
    ).rejects.toThrow(/--seed must be a JSON object/);
  });
});
