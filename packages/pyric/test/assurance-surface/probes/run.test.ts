import { describe, expect, test } from 'bun:test';
import { findingFor, rtdbRulesFor, runProbe, type ProbeRules } from '../../../src/assurance-surface/probes/run.js';
import type { Probe, ProbeActor } from '../../../src/assurance-surface/probes/types.js';

const owner: ProbeActor = { role: 'owner', uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice', token: {} };
const peer: ProbeActor = { role: 'peer', uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob', token: {} };

describe('rtdbRulesFor', () => {
  test('selects the RTDB ruleset whose rule tree reaches deepest along the concrete path', () => {
    const shallow = { rules: { notes: { '.write': true } } };
    const deep = { rules: { notes: { $uid: { items: { '.write': 'auth.uid === $uid' } } } } };
    const rules: ProbeRules = { rtdb: [shallow, deep] };
    expect(rtdbRulesFor(rules, 'notes/u-alice/items')).toBe(deep);
  });
});

describe('runProbe and findingFor', () => {
  const firestoreRules = `
    rules_version = '2';
    service cloud.firestore {
      match /databases/{database}/documents {
        match /profiles/{uid} {
          allow read, write: if request.auth != null;
        }
        match /strict/{uid} {
          allow create: if request.auth != null && request.auth.uid == uid && request.resource.data.code == 'SECRET';
          allow update, delete: if request.auth != null && request.auth.uid == uid;
        }
      }
    }
  `;

  test('reports hit on foreign-slot-write when rules allow peer write and populates findingFor actorUid', async () => {
    const probe: Probe = {
      id: 'foreign-slot-write-1',
      kind: 'foreign-slot-write',
      op: 'write',
      service: 'firestore',
      template: 'profiles/{uid}',
      status: 'proven',
      seed: [],
      setup: [{ actor: 'owner', service: 'firestore', method: 'set', path: 'profiles/u-alice', data: { bio: 'ok' } }],
      attack: { actor: 'peer', service: 'firestore', method: 'set', path: 'profiles/u-alice', data: { bio: 'tampered' } },
      expect: 'deny',
      evidence: 'u-bob wrote into u-alice slot',
      sources: ['profile.ts:10'],
    };
    const result = await runProbe(probe, { firestore: firestoreRules, rtdb: [] }, [owner, peer]);
    expect(result?.outcome).toBe('hit');
    const finding = findingFor(result!, [owner, peer]);
    expect(finding).toMatchObject({
      path: 'profiles/{uid}',
      op: 'write',
      kind: 'foreign-slot-write',
      status: 'proven',
      actorUid: 'u-bob',
      probeId: 'foreign-slot-write-1',
    });
  });

  test('marks must-allow-denied probe invalid instead of hit when inconclusiveOnDeny is set', async () => {
    const probe: Probe = {
      id: 'must-allow-denied-1',
      kind: 'must-allow-denied',
      op: 'create',
      service: 'firestore',
      template: 'strict/{uid}',
      status: 'proven',
      seed: [],
      setup: [],
      attack: { actor: 'owner', service: 'firestore', method: 'set', path: 'strict/u-alice', data: { code: 'guessed' } },
      expect: 'allow',
      inconclusiveOnDeny: 'the synthesized payload may not satisfy validation',
      evidence: 'owner create denied',
      sources: ['strict.ts:5'],
    };
    const result = await runProbe(probe, { firestore: firestoreRules, rtdb: [] }, [owner, peer]);
    expect(result?.outcome).toBe('invalid');
    expect(result?.reason).toBe('the synthesized payload may not satisfy validation');
  });

  test('marks probe invalid when a setup step is denied', async () => {
    const probe: Probe = {
      id: 'foreign-delete-1',
      kind: 'foreign-delete',
      op: 'delete',
      service: 'firestore',
      template: 'strict/{uid}',
      status: 'proven',
      seed: [],
      setup: [{ actor: 'owner', service: 'firestore', method: 'set', path: 'strict/u-alice', data: { code: 'wrong' } }],
      attack: { actor: 'peer', service: 'firestore', method: 'delete', path: 'strict/u-alice' },
      expect: 'deny',
      evidence: 'peer deleted owner record',
      sources: ['strict.ts:9'],
    };
    const result = await runProbe(probe, { firestore: firestoreRules, rtdb: [] }, [owner, peer]);
    expect(result?.outcome).toBe('invalid');
    expect(result?.reason).toContain('setup owner set strict/u-alice was denied');
  });
});
