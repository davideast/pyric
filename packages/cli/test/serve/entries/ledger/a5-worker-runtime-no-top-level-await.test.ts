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

const ENTRY = new URL('../../../../src/serve/entries/worker-runtime.ts', import.meta.url);

describe('ledger A5: worker runtime entry has no top-level await', () => {
  it('no column-zero statement awaits', () => {
    const source = readFileSync(ENTRY, 'utf8');
    const offenders = source.split('\n').filter((line) =>
      /^(?:export\s+)?(?:const|let|var)\s+[^=]+=\s*await\b/.test(line) || /^await\b/.test(line));
    expect(offenders).toEqual([]);
  });
});
