import { describe, expect, test } from 'bun:test';
import { getAdminDatabase, ref as rtdbRef, setWithPriority } from 'pyric/database';
import { doc, getAdminFirestore, setDoc } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { captureSandboxSnapshot } from 'pyric/sandbox/internal';
import type { AccessSite } from '../../../src/assurance-surface/code/types.js';
import { concretePath, isConcretePayload } from '../../../src/assurance-surface/probes/fixtures.js';
import type { ProbeActor } from '../../../src/assurance-surface/probes/types.js';

describe('isConcretePayload', () => {
  test('treats optional unknown fields as non-concrete while allowing optional determined kinds', () => {
    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [
          { name: 'kind', kind: 'string', literal: 'note' },
          { name: 'url', kind: 'unknown', optional: true },
        ],
      }),
    ).toBe(false);

    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [
          { name: 'kind', kind: 'string', literal: 'note' },
          { name: 'label', kind: 'string', optional: true },
        ],
      }),
    ).toBe(true);
  });

  test('treats childless object fields as non-concrete while accepting object fields with concrete subfields', () => {
    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [{ name: 'meta', kind: 'object' }],
      }),
    ).toBe(false);

    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [
          { name: 'meta', kind: 'object' },
          { name: 'meta.tag', kind: 'string', optional: true },
        ],
      }),
    ).toBe(false);

    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [
          { name: 'meta', kind: 'object' },
          { name: 'meta.count', kind: 'number', literal: 1 },
        ],
      }),
    ).toBe(true);
  });
});

describe('concretePath', () => {
  const actor: ProbeActor = {
    role: 'owner',
    uid: 'u-alice',
    email: 'alice@probe.local',
    displayName: 'Alice',
    token: {},
  };

  test('resolves non-leaf segment keys from WorldState.snapshot and leading-slash state.firestore identically', async () => {
    const fsSite: AccessSite = {
      service: 'firestore',
      op: 'setDoc',
      path: 'orgs/{orgId}/items/{itemId}',
      source: 'items.ts:10',
      resolution: 'resolved',
      pathVariables: [{ name: 'orgId' }, { name: 'itemId' }],
    };
    const rtdbSite: AccessSite = {
      service: 'rtdb',
      op: 'set',
      path: 'orgs/$orgId/items/$itemId',
      source: 'items.ts:20',
      resolution: 'resolved',
      pathVariables: [{ name: 'orgId' }, { name: 'itemId' }],
    };

    const sandbox = initializeSandbox();
    try {
      await setDoc(doc(getAdminFirestore(sandbox), 'orgs/acme/items/i-1'), { ok: true });
      await setWithPriority(
        rtdbRef(getAdminDatabase(sandbox), 'orgs/acme'),
        { items: { i1: { ok: true } } },
        5,
      );
      const snapshot = await captureSandboxSnapshot(sandbox);

      expect(
        concretePath(fsSite, actor, {
          state: { firestore: { '/orgs/acme/items/i-1': { ok: true } } },
        }),
      ).toBe('orgs/acme/items/v-itemId');
      expect(concretePath(fsSite, actor, { state: { snapshot } })).toBe('orgs/acme/items/v-itemId');
      expect(concretePath(rtdbSite, actor, { state: { snapshot } })).toBe(
        'orgs/acme/items/v-itemId',
      );
    } finally {
      sandbox.dispose();
    }
  });
});
