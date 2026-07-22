/**
 * Unit tests for the shared observation completeness gate. These pin the
 * ratchet the surface suites rely on: a comment-only mention or an unused
 * `load()` must NOT count an observation as asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservationGate } from '../../src/observation-gate.ts';

const dir = mkdtempSync(join(tmpdir(), 'obs-gate-'));

beforeAll(() => {
  const write = (name: string, behavior: Record<string, unknown>) =>
    writeFileSync(join(dir, name), JSON.stringify({ behavior }));
  write('demo-alpha.json', { count: 3, colonSeparated: true });
  write('demo-beta.json', { ok: true });
  write('demo-gamma.json', { fired: true });
  write('demo-empty.json', {}); // no fields to read
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const match = (f: string) => f.startsWith('demo-');

describe('observation completeness gate', () => {
  it('marks a file asserted only when a behavior field is actually read', () => {
    const gate = createObservationGate({ dir, match });
    const alpha = gate.load('demo-alpha');
    expect(alpha.count).toBe(3); // real read → asserted

    // demo-beta is loaded but never read → loadedButUnused, and demo-gamma is
    // only mentioned in this comment (demo-gamma) → never loaded.
    gate.load('demo-beta');

    const r = gate.report();
    expect(r.asserted).toEqual(['demo-alpha']);
    expect(r.loadedButUnused).toEqual(['demo-beta']);
    // Both the unused load and the comment-only mention fail the gate; the empty
    // observation is uncovered too (no field can ever be read).
    expect(r.uncovered.sort()).toEqual(['demo-beta', 'demo-empty', 'demo-gamma']);
  });

  it('a comment-only mention does not satisfy the gate (the core ratchet)', () => {
    const gate = createObservationGate({ dir, match });
    // demo-alpha, demo-beta, demo-gamma, demo-empty are named here — a substring
    // gate would pass all four. This one asserts none, so all are uncovered.
    const r = gate.report();
    expect(r.asserted).toEqual([]);
    expect(r.uncovered).toEqual(['demo-alpha', 'demo-beta', 'demo-empty', 'demo-gamma']);
  });

  it('siblingSources: a real load() call in a sibling covers a file, a comment does not', () => {
    const goodSibling = join(dir, 'sibling-good.ts');
    const commentSibling = join(dir, 'sibling-comment.ts');
    writeFileSync(goodSibling, `const o = load('demo-gamma'); expect(o.fired).toBe(true);\n`);
    // demo-empty is only NAMED in a comment here — no load() call.
    writeFileSync(commentSibling, `// demo-empty is covered elsewhere (it is not)\n`);

    const gate = createObservationGate({
      dir,
      match,
      siblingSources: [goodSibling, commentSibling],
    });
    gate.load('demo-alpha').count;
    gate.load('demo-beta').ok;
    const r = gate.report();
    expect(r.assertedInSibling).toEqual(['demo-gamma']); // real load() in sibling
    expect(r.uncovered).toEqual(['demo-empty']); // comment-only in sibling still fails
  });

  it('NOT_APPLICABLE entries (with reasons) cover a file without a read', () => {
    const gate = createObservationGate({
      dir,
      match,
      notApplicable: {
        'demo-empty.json': 'empty behavior block — nothing to replay',
        'demo-gamma': 'not replayable in-process',
      },
    });
    gate.load('demo-alpha').count;
    gate.load('demo-beta').ok;
    const r = gate.report();
    expect(r.notApplicable.sort()).toEqual(['demo-empty', 'demo-gamma']);
    expect(r.uncovered).toEqual([]);
    expect(r.committed.length).toBe(4);
  });
});
