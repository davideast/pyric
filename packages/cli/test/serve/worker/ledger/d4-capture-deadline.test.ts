import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBackend } from 'pyric/sandbox';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getFirestore } from 'pyric/firestore';
import { applyServeInit } from '../../../../src/serve/worker/serve-init.js';
import { handleMessage, type HostCtx } from '../../../../src/serve/worker/host.js';
import { createCaptureStore } from '../../../../src/serve/capture-store.js';

test('continuous traffic reaches capture within two seconds despite a stalled older POST', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-capture-deadline-'));
  const store = createCaptureStore(project);
  const sandbox = createSandboxRoot();
  await sandbox.enablePersistence({ key: 'capture-deadline', injectedBackend: createMemoryBackend() });
  const ctx: HostCtx = { sandbox, db: getFirestore(sandbox), subs: new Map(), instanceId: 'capture-deadline' };
  const firstStarted = Promise.withResolvers<void>();
  const firstPost = Promise.withResolvers<Response>();
  const saved = Promise.withResolvers<void>();
  let requests = 0;
  let firstSignal: AbortSignal | undefined;
  const captureFetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests++;
    if (requests === 1) {
      firstSignal = init?.signal ?? undefined;
      firstSignal?.addEventListener('abort', () => firstPost.reject(firstSignal!.reason), { once: true });
      firstStarted.resolve();
      return firstPost.promise;
    }
    store.write(String(init?.body));
    saved.resolve();
    return new Response(null, { status: 204 });
  }, { preconnect() {} });
  const initialized = applyServeInit(ctx, {
    rules: null, rulesHash: null, bridgeUrl: null, seed: null, capture: true,
  }, { fetch: captureFetch });
  const write = (version: number) => handleMessage(ctx, { postMessage() {} }, {
    t: 'op', id: `write-${version}`, method: 'setDoc', path: 'notes/current',
    data: { version }, actAs: { mode: 'admin' },
  });
  let updates: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await write(0);
    await firstStarted.promise;
    let version = 1;
    await write(version);
    updates = setInterval(() => { void write(++version); }, 20);
    // Allow timer dispatch jitter, but not an additional 400 ms coalescing interval.
    await Promise.race([saved.promise, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Pending capture exceeded its two-second flush deadline')), 2200);
    })]);
    expect(firstSignal?.aborted).toBe(true);
    const capture = JSON.parse(store.read()!);
    expect(capture.services.firestore.state.documents['notes/current'].version).toBeGreaterThan(1);
    expect(requests).toBe(2);
  } finally {
    clearInterval(updates);
    clearTimeout(deadline);
    initialized.dispose();
    firstPost.resolve(new Response(null, { status: 204 }));
    sandbox.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});
