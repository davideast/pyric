/**
 * What a rejection from the assurance validators has to say.
 *
 * The rule is one sentence long and it is the whole of this file: a rejection
 * of a closed set names the field and lists every value that set holds, and a
 * rejection of a missing value names the field and the position of the item it
 * came from. A caller that reads the rejection knows what to send next without
 * guessing, which is the failure this suite exists to prevent.
 */
import { describe, expect, it } from 'bun:test';

import {
  assertActor,
  assertInvariant,
  assertObservation,
  assertProbe,
} from '../../src/assurance/validation.js';

/** The values every rejection of a closed set has to list. */
const CLOSED_SETS = {
  acquisitionKind: [
    'anonymous-request',
    'anonymous-account',
    'password',
    'fixture-user',
    'synthetic',
  ],
  observationSource: ['captured', 'authored', 'discovered'],
  invariantService: ['firestore', 'rtdb', 'storage', 'cross-service'],
  invariantExpected: ['ALLOW', 'DENY'],
  invariantSource: ['declared', 'authored-test', 'captured', 'derived', 'agent'],
  invariantConfidence: ['authoritative', 'strong', 'tentative'],
  operationService: ['firestore', 'rtdb', 'storage'],
  firestoreMethod: ['get', 'list', 'create', 'set', 'merge', 'update', 'delete'],
  mutationDimension: ['path', 'query', 'payload', 'operation'],
};

/** The message one call threw, or the empty string when it did not throw. */
function rejectionOf(call: () => void): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('a rejected closed set lists the values it holds', () => {
  it("names the field and every acquisition kind", () => {
    const message = rejectionOf(() =>
      assertActor({ id: 'alice', acquisition: { kind: 'guest' } }, 'actors[1]'),
    );
    expect(message).toContain('actors[1]');
    expect(message).toContain('acquisition.kind');
    for (const value of CLOSED_SETS.acquisitionKind) expect(message).toContain(value);
  });

  it('names the field and every observation source', () => {
    const message = rejectionOf(() =>
      assertObservation(
        {
          id: 'read-own-order',
          actorId: 'alice',
          result: 'ALLOW',
          source: 'declared',
          operation: { service: 'firestore', method: 'get', path: 'orders/o1' },
        },
        'observations[1]',
      ),
    );
    expect(message).toContain('observations[1]');
    expect(message).toContain('source');
    for (const value of CLOSED_SETS.observationSource) expect(message).toContain(value);
  });

  it('names the field and every observation result', () => {
    const message = rejectionOf(() =>
      assertObservation(
        {
          id: 'read-own-order',
          actorId: 'alice',
          result: 'DENY',
          source: 'captured',
          operation: { service: 'firestore', method: 'get', path: 'orders/o1' },
        },
        'observations[1]',
      ),
    );
    expect(message).toContain('observations[1]');
    expect(message).toContain('result');
    expect(message).toContain('ALLOW');
  });

  it('names the field and every value of each invariant closed set', () => {
    const base = {
      id: 'orders-are-private',
      statement: 'Only the owner reads an order.',
      service: 'firestore',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    };
    const cases: Array<[keyof typeof base, string, string[]]> = [
      ['service', 'nowhere', CLOSED_SETS.invariantService],
      ['expected', 'MAYBE', CLOSED_SETS.invariantExpected],
      ['source', 'invented', CLOSED_SETS.invariantSource],
      ['confidence', 'tentativee', CLOSED_SETS.invariantConfidence],
    ];
    for (const [field, bad, allowed] of cases) {
      const message = rejectionOf(() =>
        assertInvariant({ ...base, [field]: bad }, 'invariants[0]'),
      );
      expect(message).toContain('invariants[0]');
      expect(message).toContain(field);
      for (const value of allowed) expect(message).toContain(value);
    }
  });

  it('names the operation field and the methods that service evaluates', () => {
    const message = rejectionOf(() =>
      assertObservation(
        {
          id: 'read-own-order',
          actorId: 'alice',
          result: 'ALLOW',
          source: 'captured',
          operation: { service: 'firestore', method: 'read', path: 'orders/o1' },
        },
        'observations[0]',
      ),
    );
    expect(message).toContain('observations[0].operation.method');
    for (const value of CLOSED_SETS.firestoreMethod) expect(message).toContain(value);
  });

  it('names the operation service and every service that carries one', () => {
    const message = rejectionOf(() =>
      assertObservation(
        {
          id: 'read-own-order',
          actorId: 'alice',
          result: 'ALLOW',
          source: 'captured',
          operation: { service: 'realtime', method: 'get', path: 'orders/o1' },
        },
        'observations[0]',
      ),
    );
    expect(message).toContain('observations[0].operation.service');
    for (const value of CLOSED_SETS.operationService) expect(message).toContain(value);
  });

  it('names the field and every mutation dimension', () => {
    const message = rejectionOf(() =>
      assertProbe(
        {
          id: 'read-other-order',
          actorId: 'alice',
          invariantId: 'orders-are-private',
          control: { service: 'firestore', method: 'get', path: 'orders/o1' },
          mutation: {
            dimension: 'document',
            description: 'Read another order.',
            operation: { service: 'firestore', method: 'get', path: 'orders/o2' },
          },
        },
        'probes[2]',
      ),
    );
    expect(message).toContain('probes[2]');
    expect(message).toContain('mutation.dimension');
    for (const value of CLOSED_SETS.mutationDimension) expect(message).toContain(value);
  });
});

describe('a rejected required value names its field and its position', () => {
  it('names the item position when an actor id is missing', () => {
    const message = rejectionOf(() =>
      assertActor({ acquisition: { kind: 'anonymous-request' } }, 'actors[3]'),
    );
    expect(message).toContain('actors[3]');
    expect(message).toContain('id');
  });

  it('names the item position when an observation actorId is missing', () => {
    const message = rejectionOf(() =>
      assertObservation(
        {
          id: 'read-own-order',
          result: 'ALLOW',
          source: 'captured',
          operation: { service: 'firestore', method: 'get', path: 'orders/o1' },
        },
        'observations[2]',
      ),
    );
    expect(message).toContain('observations[2]');
    expect(message).toContain('actorId');
  });

  it('names the item position when a probe control path is missing', () => {
    const message = rejectionOf(() =>
      assertProbe(
        {
          id: 'read-other-order',
          actorId: 'alice',
          invariantId: 'orders-are-private',
          control: { service: 'firestore', method: 'get' },
          mutation: {
            dimension: 'path',
            description: 'Read another order.',
            operation: { service: 'firestore', method: 'get', path: 'orders/o2' },
          },
        },
        'probes[0]',
      ),
    );
    expect(message).toContain('probes[0].control.path');
  });
});
