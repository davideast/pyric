import { describe, expect, it } from 'bun:test';
import { loadSnapshot } from '../../rules-language/load.ts';
import { resolveFirestoreConstructProbe } from '../../src/rules-language-capability.ts';

const constructs = new Map(loadSnapshot('firestore').constructs.map((construct) => [construct.id, construct]));

function probe(id: string) {
  const construct = constructs.get(id);
  if (!construct) throw new Error(`missing test construct ${id}`);
  const resolved = resolveFirestoreConstructProbe(construct);
  if ('unprobeable' in resolved) throw new Error(`${id} unexpectedly unprobeable: ${resolved.unprobeable}`);
  return resolved;
}

describe('canonical Firestore Rules capability probes', () => {
  it('exercises request.query through a list request carrying the compared limit', () => {
    const resolved = probe('firestore.binding.request.query');
    expect(resolved.rules).toContain('request.query.limit == 10');
    expect(resolved.cases).toEqual([expect.objectContaining({
      method: 'list', query: { limit: 10 }, expectation: 'ALLOW',
    })]);
    expect(resolveFirestoreConstructProbe(constructs.get('firestore.binding.request.method')!))
      .not.toEqual(resolved);
  });

  it('exercises CEL error absorption with the risky operand first', () => {
    expect(probe('firestore.semantic.error-absorption-or').rules)
      .toContain('(request.resource.data.missing.deep == 1) || true');
    expect(probe('firestore.semantic.error-absorption-and').rules)
      .toContain('!((request.resource.data.missing.deep == 1) && false)');
  });
});
