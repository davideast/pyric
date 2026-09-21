/**
 * Ledger A5: the shared worker runtime entry is evaluated inside Service
 * Worker realms, which reject top-level `await` at module evaluation. The
 * entry must consult the init payload lazily, the way the messaging Service
 * Worker client does.
 *
 * This is a source-form check: any statement at column zero that awaits is
 * a top-level await. Nested awaits inside functions are indented.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const WORKER_RUNTIME = new URL('../../../../src/serve/entries/worker-runtime.ts', import.meta.url);
const AUTH_ENTRY = new URL('../../../../src/serve/entries/auth.ts', import.meta.url);
const INIT_ENTRY = new URL('../../../../src/serve/entries/init.ts', import.meta.url);

function assertNoColumnZeroAwait(url: URL): void {
  const source = readFileSync(url, 'utf8');
  const offenders = source.split('\n').filter((line) =>
    /^(?:export\s+)?(?:const|let|var)\s+[^=]+=\s*await\b/.test(line) || /^await\b/.test(line));
  expect(offenders).toEqual([]);
}

describe('ledger A5: worker-reachable entries have no top-level await', () => {
  it('worker runtime: no column-zero statement awaits', () => {
    assertNoColumnZeroAwait(WORKER_RUNTIME);
  });

  it('firebase/auth entry: no column-zero statement awaits', () => {
    assertNoColumnZeroAwait(AUTH_ENTRY);
  });

  it('init entry: no column-zero statement awaits', () => {
    assertNoColumnZeroAwait(INIT_ENTRY);
  });
});
