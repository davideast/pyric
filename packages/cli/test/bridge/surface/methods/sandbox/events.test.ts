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
import { setRules } from 'pyric/sandbox/firestore';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';

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

  it('refuses a cursor the sandbox never handed out', async () => {
    await run('firestore.setDoc', { path: 'ledger/one', data: { n: 1 } });
    const refused = await run('sandbox.events', { since: 'not-a-cursor' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('not-a-cursor');
    expect(refused.summary).toContain("without 'since'");
  });
});
