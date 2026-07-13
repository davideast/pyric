/** P3 — rules hot-reload over SSE + --seed (plan steps 3.1/3.2). */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger } from '../../src/serve/server.js';

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
