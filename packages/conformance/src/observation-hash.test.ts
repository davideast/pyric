import { describe, expect, it } from 'bun:test';
import { behaviorHash, behaviorHashProblem, canonicalJson, stampBehaviorHash } from './observation-hash.ts';
import { validateCompatibilityRegistry } from './validate-registry.ts';
import { loadObservations, type Observation } from './ledger.ts';
import { allCompatibilityRows } from '../registry/index.ts';
import { surfaceDescriptors } from '../surfaces/load.ts';
import { observationExceptions } from '../exceptions/load.ts';

/** The shipped registry + observations, the same inputs compat:validate runs on.
 *  Each negative case perturbs ONE observation and asserts the gate objects. */
function validateWith(observations: Observation[]): string[] {
  return validateCompatibilityRegistry({
    rows: allCompatibilityRows,
    descriptors: surfaceDescriptors,
    observations,
    observationExceptions,
  });
}

/** A committed observation with real captured production verdicts. */
function pickSealed(): Observation {
  const obs = loadObservations().find(
    (o) => o.name === 'rules-rtdb-r1-auth-only' && Object.keys(o.behavior).length > 0,
  );
  if (!obs) throw new Error('fixture observation rules-rtdb-r1-auth-only not found');
  return obs;
}

describe('observation-hash: canonical form', () => {
  it('is insensitive to object key ORDER (a reformat is not a tamper)', () => {
    expect(behaviorHash({ a: 1, b: 2 })).toBe(behaviorHash({ b: 2, a: 1 }));
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it('is sensitive to array ORDER (order is data, not serialization)', () => {
    expect(behaviorHash({ a: [1, 2] })).not.toBe(behaviorHash({ a: [2, 1] }));
  });

  it('changes when a VERDICT changes', () => {
    expect(behaviorHash({ read: 'ALLOW' })).not.toBe(behaviorHash({ read: 'DENY' }));
  });

  it('stamps an envelope from its own behavior', () => {
    const stamped = stampBehaviorHash({ name: 'x', behavior: { read: 'ALLOW' } });
    expect(behaviorHashProblem({ file: 'x.json', ...stamped })).toBeNull();
  });
});

describe('observation-hash: the gate REJECTS an edited observation', () => {
  it('NEGATIVE — a production verdict flipped after capture fails compat:validate', () => {
    // The fake this prevents: the simulator answers DENY where production
    // answered ALLOW, so instead of fixing the simulator the recorded PRODUCTION
    // verdict is "corrected" to DENY. The row still cites the file, the file
    // still parses, the replay now compares equal — every other gate goes green.
    const sealed = pickSealed();
    const key = Object.keys(sealed.behavior).find((k) => sealed.behavior[k] === 'ALLOW')!;
    const tampered: Observation = { ...sealed, behavior: { ...sealed.behavior, [key]: 'DENY' } };
    const problems = validateWith(
      loadObservations().map((o) => (o.name === tampered.name ? tampered : o)),
    );
    expect(
      problems.some((p) => p.includes(`${tampered.file}: behaviorHash does not match`)),
    ).toBe(true);
  });

  it('NEGATIVE — an observation carrying no hash at all fails compat:validate', () => {
    const sealed = pickSealed();
    const { behaviorHash: _dropped, ...unsealed } = sealed;
    const problems = validateWith(
      loadObservations().map((o) => (o.name === sealed.name ? (unsealed as Observation) : o)),
    );
    expect(problems.some((p) => p.includes(`${sealed.file}: missing behaviorHash`))).toBe(true);
  });

  it('NEGATIVE — re-stamping the hash over EDITED verdicts still moves the hash off its committed value', () => {
    // The seal is tamper-EVIDENCE, not a signature: an editor who also recomputes
    // the hash produces a self-consistent file. What that costs them is silence —
    // the observation's hash line changes, so the edit can no longer land as an
    // invisible one-character verdict flip inside a JSON blob.
    const sealed = pickSealed();
    const key = Object.keys(sealed.behavior).find((k) => sealed.behavior[k] === 'ALLOW')!;
    const restamped = stampBehaviorHash({ ...sealed, behavior: { ...sealed.behavior, [key]: 'DENY' } });
    expect(restamped.behaviorHash).not.toBe(sealed.behaviorHash);
  });
});

describe('observation-hash: every committed observation is sealed', () => {
  it('POSITIVE — all shipped observations carry a hash that matches their behavior', () => {
    const problems = loadObservations()
      .map((obs) => behaviorHashProblem(obs))
      .filter((p): p is string => p !== null);
    expect(problems).toEqual([]);
  });
});
