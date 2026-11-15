/**
 * `sandbox.events` and its cursor.
 *
 * The cursor is an event id, so it is only meaningful against the log that
 * handed it out. A restore or a reset replaces that log, and a cursor from
 * before it names nothing. Paging from the top in that case is the dangerous
 * answer: the call succeeds, the page looks like a page, and the caller reads
 * the beginning of a new log believing it is the continuation of an old one.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { createSandboxRoot, emitSandboxEvent } from 'pyric/sandbox/internal';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getFirestore, onSnapshot, setDoc } from 'pyric/firestore';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';
import { SERVE_HISTORY_LIMITS } from '../../../../../src/serve/observation-limits.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const surface = renderSurface(undefined);

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;

async function run(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-events-'));
  sandbox = initializeSandbox();
  setRules(sandbox, OPEN_RULES);
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('sandbox.events', () => {
  it('pages from a cursor a prior call handed out', async () => {
    await run('firestore.setDoc', { path: 'ledger/one', data: { n: 1 } });
    const first = await run('sandbox.events', { limit: 1 });
    expect(first.ok).toBe(true);
    await run('firestore.setDoc', { path: 'ledger/two', data: { n: 2 } });

    const cursor = (first.data as { nextCursor: string }).nextCursor;
    const second = await run('sandbox.events', { since: cursor });
    expect(second.ok).toBe(true);
    const ids = (second.data as { events: Array<{ id: string }> }).events.map((e) => e.id);
    expect(ids).not.toContain(cursor);
  });

  it('refuses a cursor from the log a restore replaced', async () => {
    await run('firestore.setDoc', { path: 'ledger/one', data: { n: 1 } });
    expect((await run('sandbox.checkpoint', { name: 'before' })).ok).toBe(true);
    const paged = await run('sandbox.events', { limit: 1 });
    const cursor = (paged.data as { nextCursor: string }).nextCursor;

    expect((await run('sandbox.restore', { name: 'before', confirm: true })).ok).toBe(true);

    const refused = await run('sandbox.events', { since: cursor });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain(cursor);
    expect(refused.summary).toContain('replaced');
    expect(refused.summary).toContain("without 'since'");
  });

  it('pages listener lifecycle with kind listeners, and nothing else', async () => {
    const stop = onSnapshot(doc(getFirestore(sandbox), 'ledger/one'), () => {});
    await run('firestore.setDoc', { path: 'ledger/one', data: { n: 1 } });
    stop();

    const listed = await run('sandbox.events', { kind: 'listeners' });
    expect(listed.ok).toBe(true);
    const events = (listed.data as { events: Array<{ method: string }> }).events;
    const phases = events.map((event) => event.method);
    expect(phases).toContain('attach');
    expect(phases).toContain('delivery');
    expect(phases).toContain('detach');
    for (const phase of phases) {
      expect(['attach', 'detach', 'delivery', 'suppressed', 'errored']).toContain(phase);
    }
  });

  it('keeps listener lifecycle out of the write and denial pages', async () => {
    const stop = onSnapshot(doc(getFirestore(sandbox), 'ledger/one'), () => {});
    await run('firestore.setDoc', { path: 'ledger/one', data: { n: 1 } });
    stop();

    const writes = await run('sandbox.events', { kind: 'writes' });
    const methods = (writes.data as { events: Array<{ method: string }> }).events.map(
      (event) => event.method,
    );
    expect(methods).not.toContain('attach');
    expect(methods).not.toContain('detach');
    expect(methods).not.toContain('delivery');
  });

  it('refuses a cursor the sandbox never handed out', async () => {
    await run('firestore.setDoc', { path: 'ledger/one', data: { n: 1 } });
    const refused = await run('sandbox.events', { since: 'not-a-cursor' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('not-a-cursor');
    expect(refused.summary).toContain("without 'since'");
  });

  it('preserves observation_gap records and discloses omissions after bounded denial eviction', async () => {
    const boundedSandbox = createSandboxRoot(SERVE_HISTORY_LIMITS);
    const boundedCtx = createSurfaceContext(boundedSandbox, projectDir);
    const runBounded = async (
      key: string,
      args: Record<string, unknown> = {},
    ): Promise<OperationResult> => {
      const [toolName, method] = key.split('.');
      const tool = surface.tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`no rendered tool named ${toolName}`);
      return tool.execute({ method, args }, boundedCtx);
    };

    const denyRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /{document=**} { allow read, write: if false; }',
      '  }',
      '}',
    ].join('\n');
    setRules(boundedSandbox, denyRules);
    const db = getFirestore(boundedSandbox.withAuth({ uid: 'user-1' }));
    const largePayload = 'x'.repeat(200_000);
    for (let i = 0; i < 25; i += 1) {
      await setDoc(doc(db, `items/d${i}`), { payload: largePayload, i }).catch(() => undefined);
    }

    const denialsPage = await runBounded('sandbox.events', { kind: 'denials', limit: 500 });
    expect(denialsPage.ok).toBe(true);
    const denialEvents = (denialsPage.data as { events: Array<Record<string, unknown>> }).events;
    const gap = denialEvents.find((entry) => entry.kind === 'observation_gap');
    expect(gap).toBeDefined();
    expect(gap?.id).toBe('history-gap');
    expect(gap?.reason).toBe('history-limit');
    expect(typeof gap?.omittedCount).toBe('number');
    expect((gap?.omittedCount as number) > 0).toBe(true);
    expect(typeof gap?.omittedDenials).toBe('number');
    expect((gap?.omittedDenials as number) > 0).toBe(true);
    expect(Object.isFrozen(gap)).toBe(true);
    expect(denialsPage.summary).toContain('observation gap');
    expect(denialsPage.summary).toContain('omitted');

    // Also preserved under kind: 'all', 'writes', and 'listeners'.
    for (const kind of ['all', 'writes', 'listeners'] as const) {
      const page = await runBounded('sandbox.events', { kind, limit: 500 });
      expect(page.ok).toBe(true);
      const events = (page.data as { events: Array<Record<string, unknown>> }).events;
      expect(events.some((entry) => entry.kind === 'observation_gap')).toBe(true);
    }

    // Cursor pagination over a leading observation_gap advances cleanly without repeating it.
    const first = await runBounded('sandbox.events', { kind: 'denials', limit: 1 });
    expect(first.ok).toBe(true);
    const firstData = first.data as {
      events: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(firstData.events).toHaveLength(1);
    expect(firstData.events[0]?.kind).toBe('observation_gap');
    expect(firstData.nextCursor).toBe('history-gap');

    const second = await runBounded('sandbox.events', {
      kind: 'denials',
      limit: 5,
      since: firstData.nextCursor ?? undefined,
    });
    expect(second.ok).toBe(true);
    const secondEvents = (second.data as { events: Array<Record<string, unknown>> }).events;
    expect(secondEvents.length).toBeGreaterThan(0);
    expect(secondEvents.some((entry) => entry.kind === 'observation_gap')).toBe(false);
  });

  it('omits zero-denial gaps on kind: "denials" while keeping untracked and non-zero gaps', async () => {
    emitSandboxEvent(sandbox, {
      kind: 'observation_gap',
      id: 'gap-zero-denials',
      at: 100,
      reason: 'frame-limit',
      omittedCount: 4,
      omittedDenials: 0,
      firstEventId: 'e1',
      lastEventId: 'e4',
    });
    emitSandboxEvent(sandbox, {
      kind: 'observation_gap',
      id: 'gap-untracked-denials',
      at: 200,
      reason: 'frame-limit',
      omittedCount: 2,
      firstEventId: 'e5',
      lastEventId: 'e6',
    });

    const allPage = await run('sandbox.events', { kind: 'all', limit: 50 });
    expect(allPage.ok).toBe(true);
    const allIds = (allPage.data as { events: Array<{ id: string }> }).events.map((e) => e.id);
    expect(allIds).toContain('gap-zero-denials');
    expect(allIds).toContain('gap-untracked-denials');

    const denialPage = await run('sandbox.events', { kind: 'denials', limit: 50 });
    expect(denialPage.ok).toBe(true);
    const denialIds = (denialPage.data as { events: Array<{ id: string }> }).events.map((e) => e.id);
    expect(denialIds).not.toContain('gap-zero-denials');
    expect(denialIds).toContain('gap-untracked-denials');
    expect(denialPage.summary).toContain('observation gap');
  });
});
