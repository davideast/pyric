import { describe, expect, it } from 'bun:test';
import { validateSeedOps, buildSeedPrompt, makeProposeSeedTool, SEED_SYSTEM } from './seed.js';

describe('validateSeedOps', () => {
  it('keeps well-formed { path, data } ops and drops the rest', () => {
    const ops = validateSeedOps([
      { path: 'notes/a', data: { text: 'hi' } },
      { path: 'users/u1', data: { name: 'Alice' } },
      { path: 'no-slash', data: {} }, // dropped: not collection/doc
      { path: '/leading', data: {} }, // dropped: leading slash
      { path: 'notes/b', data: [] }, // dropped: array, not object
      { path: 'notes/c' }, // dropped: no data
      'nope', // dropped: not an object
    ]);
    expect(ops.map((o) => o.path)).toEqual(['notes/a', 'users/u1']);
  });
});

describe('buildSeedPrompt', () => {
  it('includes the request + existing collections', () => {
    const prompt = buildSeedPrompt({ request: 'add 3 notes', collections: ['notes', 'users'] });
    expect(prompt).toContain('add 3 notes');
    expect(prompt).toContain('notes, users');
    expect(prompt).toContain('propose_seed');
  });
});

describe('makeProposeSeedTool', () => {
  it('captures valid ops + summarizes; rejects empty/oversized', async () => {
    let captured: { path: string }[] | null = null;
    const tool = makeProposeSeedTool({ onProposed: (ops) => (captured = ops) });
    const ctx = { signal: new AbortController().signal };

    const ok = await tool.execute({ operations: [{ path: 'notes/a', data: { x: 1 } }] }, ctx);
    expect(ok.ok).toBe(true);
    expect(captured!.length).toBe(1);

    const empty = await tool.execute({ operations: [] }, ctx);
    expect(empty.ok).toBe(false);

    const tooMany = await tool.execute(
      { operations: Array.from({ length: 101 }, (_, i) => ({ path: `notes/${i}`, data: {} })) },
      ctx,
    );
    expect(tooMany.ok).toBe(false);
    expect(tooMany.summary).toContain('cap is 100');
  });
});

describe('SEED_SYSTEM', () => {
  it('caps documents + prefers existing collections', () => {
    expect(SEED_SYSTEM).toContain('100 documents');
    expect(SEED_SYSTEM).toContain('propose_seed');
  });
});
