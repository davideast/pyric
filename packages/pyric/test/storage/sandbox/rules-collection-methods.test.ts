import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// ─── Sets, List membership, and MapDiff ──────────────────────────
//
// Values replay corpus scenario stdlib-sets-and-mapdiff
// (rules-storage-stdlib-sets-and-mapdiff).

const path = 'b/pyric-default/o/docs/d1.json';

function evalRead(cond: string): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o {
      match /docs/{docId} { allow read: if ${cond}; }
    }
  }`);
  return evaluateStorageRules(rules, {
    request: { auth: { uid: 'alice' }, method: 'read', path },
    resource: { size: 10, metadata: { owner: 'alice', label: 'old' } },
  });
}

function evalUpdate(
  cond: string,
  incoming: Record<string, string>,
  existing: Record<string, string>,
): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o {
      match /docs/{docId} { allow update: if ${cond}; }
    }
  }`);
  return evaluateStorageRules(rules, {
    request: { auth: { uid: 'alice' }, method: 'update', path, resource: { size: 10, metadata: incoming } },
    resource: { size: 10, metadata: existing },
  });
}

describe('evaluateStorageRules — sets', () => {
  it('removes duplicates in toSet() and compares sets regardless of order', () => {
    expect(evalRead("['a', 'a', 'b'].toSet().size() == 2").allowed).toBe(true);
    expect(evalRead("['a', 'b'].toSet() == ['b', 'a'].toSet()").allowed).toBe(true);
    expect(evalRead("['a'].toSet() != ['a', 'b'].toSet()").allowed).toBe(true);
  });

  it('tests set membership with a list or set argument', () => {
    expect(evalRead(
      "['a', 'b'].toSet().hasAll(['a']) && ['a', 'b'].toSet().hasAny(['z', 'b'])"
        + " && ['a'].toSet().hasOnly(['a', 'b']) && ['a', 'b'].toSet().hasAll(['a'].toSet())",
    ).allowed).toBe(true);
    expect(evalRead("['a', 'c'].toSet().hasOnly(['a', 'b'])").allowed).toBe(false);
  });

  it('tests list membership with hasAny and hasOnly', () => {
    expect(evalRead("['a', 'b'].hasAny(['z', 'b']) && ['a'].hasOnly(['a', 'b'])").allowed).toBe(true);
    expect(evalRead("['a', 'c'].hasOnly(['a', 'b'])").allowed).toBe(false);
  });

  it('computes set difference, union, and intersection', () => {
    expect(evalRead(
      "['a', 'b'].toSet().difference(['a'].toSet()) == ['b'].toSet()"
        + " && ['a'].toSet().union(['b'].toSet()).size() == 2"
        + " && ['a', 'b'].toSet().intersection(['b', 'c'].toSet()) == ['b'].toSet()",
    ).allowed).toBe(true);
  });

  it('denies set algebra with a list argument', () => {
    const r = evalRead("['a', 'b'].toSet().difference(['a']).size() == 1");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('set.difference(list)');
  });

  it('gives a list receiver no set algebra, an error || true absorbs', () => {
    const r = evalRead("['a', 'b'].difference(['a'].toSet()).size() == 1");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Function not found error: Name: [difference].');
    expect(evalRead("['a', 'b'].difference(['a'].toSet()).size() == 1 || true").allowed).toBe(true);
  });

  it('tests membership with in over a set', () => {
    expect(evalRead("'a' in ['a', 'b'].toSet() && !('z' in ['a', 'b'].toSet())").allowed).toBe(true);
  });

  it('turns metadata keys into a set', () => {
    expect(evalRead("resource.metadata.keys().toSet().hasOnly(['owner', 'label'])").allowed).toBe(true);
  });
});

describe('evaluateStorageRules — metadata diff', () => {
  const diff = 'request.resource.metadata.diff(resource.metadata)';

  it('reads every MapDiff key set', () => {
    expect(evalUpdate(
      `${diff}.addedKeys() == ['tag'].toSet() && ${diff}.removedKeys() == ['gone'].toSet()`
        + ` && ${diff}.changedKeys() == ['label'].toSet() && ${diff}.unchangedKeys() == ['owner'].toSet()`
        + ` && ${diff}.affectedKeys() == ['tag', 'gone', 'label'].toSet()`,
      { owner: 'alice', label: 'new', tag: 'x' },
      { owner: 'alice', label: 'old', gone: 'y' },
    ).allowed).toBe(true);
  });

  it('allows a change to the listed keys and denies any other', () => {
    const guard = `${diff}.affectedKeys().hasOnly(['label'])`;
    expect(evalUpdate(guard, { owner: 'alice', label: 'new' }, { owner: 'alice', label: 'old' }).allowed).toBe(true);
    expect(evalUpdate(guard, { owner: 'bob', label: 'old' }, { owner: 'alice', label: 'old' }).allowed).toBe(false);
  });

  it('diffs keys named like prototype members as own keys', () => {
    expect(evalUpdate(
      `${diff}.addedKeys() == ['constructor'].toSet() && ${diff}.removedKeys() == ['toString'].toSet()`,
      { owner: 'alice', constructor: 'x' },
      { owner: 'alice', toString: 'y' },
    ).allowed).toBe(true);
  });

  it('tests membership with in over a MapDiff key set', () => {
    expect(evalUpdate(
      `'label' in ${diff}.changedKeys()`,
      { owner: 'alice', label: 'new' },
      { owner: 'alice', label: 'old' },
    ).allowed).toBe(true);
  });

  it('denies diff() against a non-map argument', () => {
    expect(evalUpdate("request.resource.metadata.diff('x').addedKeys().size() == 0", { a: 'b' }, { a: 'b' }).allowed)
      .toBe(false);
  });
});
