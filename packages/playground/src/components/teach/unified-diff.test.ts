/** Unified-diff builder — row stream, hunk collapsing, guards. */
import { describe, test, expect } from 'bun:test';
import {
  buildUnifiedDiff,
  serializeUnifiedDiff,
  languageForPath,
  type DiffPart,
  type DiffRow,
} from './unified-diff';

function allRows(parts: DiffPart[]): DiffRow[] {
  return parts.flatMap((p) => (p.kind === 'rows' ? p.rows : []));
}

describe('buildUnifiedDiff', () => {
  test('identical inputs → unchanged, no parts', () => {
    const d = buildUnifiedDiff('a\nb', 'a\nb');
    expect(d.unchanged).toBe(true);
    expect(d.parts).toEqual([]);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  test('pure addition (new file) counts every line as added', () => {
    const d = buildUnifiedDiff('', 'one\ntwo\nthree');
    expect(d.added).toBe(3);
    expect(d.removed).toBe(0);
    expect(allRows(d.parts).map((r) => r.kind)).toEqual(['add', 'add', 'add']);
  });

  test('pure deletion counts every line as removed', () => {
    const d = buildUnifiedDiff('one\ntwo', '');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(2);
    expect(allRows(d.parts).map((r) => r.kind)).toEqual(['del', 'del']);
  });

  test('a modified line reads as del + add with correct line numbers', () => {
    const d = buildUnifiedDiff('keep\nold\nkeep2', 'keep\nnew\nkeep2');
    const rows = allRows(d.parts);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    const del = rows.find((r) => r.kind === 'del')!;
    const add = rows.find((r) => r.kind === 'add')!;
    expect(del.text).toBe('old');
    expect(del.oldLine).toBe(2);
    expect(add.text).toBe('new');
    expect(add.newLine).toBe(2);
    // Context rows carry BOTH line numbers.
    const ctx = rows.filter((r) => r.kind === 'context');
    expect(ctx.map((r) => [r.oldLine, r.newLine])).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  test('long unchanged runs collapse into a skip part with context kept', () => {
    const mid = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const before = `start\n${mid}\nend-old`;
    const after = `start\n${mid}\nend-new`;
    const d = buildUnifiedDiff(before, after, { context: 3 });
    const skip = d.parts.find((p) => p.kind === 'skip');
    expect(skip).toBeDefined();
    // 22 lines total before the change; 3 context kept above the change,
    // so the skip swallows the rest.
    expect(skip!.kind === 'skip' && skip!.count).toBeGreaterThan(10);
    // The changed tail is visible with its preceding context.
    const rows = allRows(d.parts);
    expect(rows.some((r) => r.kind === 'del' && r.text === 'end-old')).toBe(true);
    expect(rows.some((r) => r.kind === 'add' && r.text === 'end-new')).toBe(true);
  });

  test('tiny hidden runs fold into the visible stream (no 1-line skips)', () => {
    // Changes 5 lines apart with context 2 → the 1-line gap between
    // context windows must NOT become a skip separator.
    const before = 'a0\nXold\na2\na3\na4\nYold\na6';
    const after = 'a0\nXnew\na2\na3\na4\nYnew\na6';
    const d = buildUnifiedDiff(before, after, { context: 2 });
    expect(d.parts.every((p) => p.kind === 'rows')).toBe(true);
  });

  test('oversize input returns tooLarge instead of janking', () => {
    const big = Array.from({ length: 600 }, (_, i) => `unique-a-${i}`).join('\n');
    const big2 = Array.from({ length: 600 }, (_, i) => `unique-b-${i}`).join('\n');
    const d = buildUnifiedDiff(big, big2, { maxCells: 1000 });
    expect(d.tooLarge).toBe(true);
    expect(d.parts).toEqual([]);
  });

  test('common prefix/suffix trim keeps big-but-similar files diffable', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `same-${i}`);
    const before = body.join('\n');
    const after = [...body.slice(0, 2500), 'INSERTED', ...body.slice(2500)].join('\n');
    // 5000×5001 cells would blow a 1M budget — but the trim reduces the
    // middle to ~1 line, so this must succeed.
    const d = buildUnifiedDiff(before, after, { maxCells: 1_000_000 });
    expect(d.tooLarge).toBe(false);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
  });
});

describe('serializeUnifiedDiff', () => {
  test('emits +/-/space prefixes and skip separators', () => {
    const mid = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const d = buildUnifiedDiff(`old\n${mid}`, `new\n${mid}`);
    const text = serializeUnifiedDiff(d);
    expect(text).toContain('- old');
    expect(text).toContain('+ new');
    expect(text).toMatch(/⋯ \d+ unchanged lines/);
  });
});

describe('languageForPath', () => {
  test('maps the workspace vocabulary', () => {
    expect(languageForPath('/workspace/firestore.rules')).toBe('firestore rules');
    expect(languageForPath('/workspace/src/App.tsx')).toBe('tsx');
    expect(languageForPath('/workspace/src/util.js')).toBe('javascript');
    expect(languageForPath('/workspace/data.json')).toBe('json');
    expect(languageForPath('/workspace/Makefile')).toBe('text');
  });
});
