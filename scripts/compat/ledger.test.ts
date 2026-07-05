import { describe, expect, test } from 'bun:test';
import { buildCompatibilityLedger, parseObservationRowIds, splitMarkdownRow } from './ledger.ts';

describe('compat ledger parser', () => {
  test('keeps escaped pipes inside a table cell', () => {
    const cells = splitMarkdownRow('| 72 | `{uid \\| spec}` mints credentials | ✓ | `unit:sandbox-user-admin.test.ts` |');
    expect(cells).toHaveLength(4);
    expect(cells[1]).toContain('{uid | spec}');
  });

  test('keeps pipes inside inline code spans', () => {
    const cells = splitMarkdownRow('| 1 | `a | b` is a literal | ✓ | `unit:x.test.ts` |');
    expect(cells).toEqual(['1', '`a | b` is a literal', '✓', '`unit:x.test.ts`']);
  });

  test('parses compound observation matrix rows', () => {
    expect(parseObservationRowIds('rtdb-modular #142/#146/#147')).toEqual([
      'rtdb-modular#142',
      'rtdb-modular#146',
      'rtdb-modular#147',
    ]);
  });

  test('parses suffix row ids', () => {
    expect(parseObservationRowIds('rtdb-modular #37a/#37b')).toEqual(['rtdb-modular#37a', 'rtdb-modular#37b']);
  });

  test('builds a full derived registry with all major surfaces', () => {
    const ledger = buildCompatibilityLedger();
    expect(ledger.entries.some((e) => e.id === 'auth#21' && e.hasOracle)).toBe(true);
    expect(ledger.entries.some((e) => e.matrix === 'firestore')).toBe(true);
    expect(ledger.entries.some((e) => e.matrix === 'rtdb')).toBe(true);
    expect(ledger.entries.some((e) => e.matrix === 'rtdb-modular')).toBe(true);
    expect(ledger.entries.some((e) => e.matrix === 'storage')).toBe(true);
  });
});
