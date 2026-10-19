/**
 * Recorded verdicts against a candidate ruleset: the pair a divergence is
 * made of, checked against a capture whose verdicts are known.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/sandbox/admin-firestore';

import { runDerivedCases } from '../../../src/bridge/surface/assurance-cases.js';
import { buildVerifyFixture } from '../../../src/verify/index.js';
import { ALICE_NOTE_RULES, NO_NOTE_RULES, recordNoteSession } from './assurance-fixture.js';

/** Rules that keep one note writable and close the other. */
const ONE_NOTE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/first { allow read, write: if request.auth.uid == 'alice'; }
    match /notes/{id} { allow read, write: if false; }
  }
}`;

describe('runDerivedCases', () => {
  it('agrees with itself when the candidate is the ruleset the capture ran under', async () => {
    const run = runDerivedCases(await recordNoteSession(), ALICE_NOTE_RULES);
    if ('error' in run) throw new Error(run.error);
    expect(run.cases.length).toBe(2);
    expect(run.diverged).toBe(0);
    for (const decided of run.cases) {
      expect(decided.recorded).toBe('allow');
      expect(decided.candidate).toBe('allow');
    }
  });

  it('names both verdicts when the candidate denies what the capture allowed', async () => {
    const run = runDerivedCases(await recordNoteSession(), NO_NOTE_RULES);
    if ('error' in run) throw new Error(run.error);
    expect(run.agreed).toBe(0);
    expect(run.diverged).toBe(2);
    const welcome = run.cases.find((decided) => decided.path === 'notes/welcome');
    expect(welcome?.recorded).toBe('allow');
    expect(welcome?.candidate).toBe('deny');
    expect(welcome?.agrees).toBe(false);
  });

  it('separates the case that still passes from the case that stopped', async () => {
    const run = runDerivedCases(await recordNoteSession(), ONE_NOTE_RULES);
    if ('error' in run) throw new Error(run.error);
    expect(run.agreed).toBe(1);
    expect(run.diverged).toBe(1);
    expect(run.cases.find((decided) => !decided.agrees)?.path).toBe('notes/welcome');
    expect(run.cases.find((decided) => decided.agrees)?.path).toBe('notes/first');
  });

  it('reports the engine failure rather than a verdict when the rules do not parse', async () => {
    const run = runDerivedCases(await recordNoteSession(), 'not rules at all {');
    if (!('error' in run)) throw new Error('an unparseable ruleset produced verdicts');
    expect(run.error.length).toBeGreaterThan(0);
  });

  it('resolves exists() and get() against fixture.services.firestore.state.documents', async () => {
    const initialRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    db.setRules(initialRules);
    await db.doc('rooms/r1/members/alice').set({ role: 'member' });
    await db.doc('rooms/r1/messages/m1').set({ text: 'hello', author: 'alice' });

    const fixture = buildVerifyFixture({
      sandbox,
      description: 'alice joins room r1 and posts message m1',
      firestoreRules: initialRules,
    });

    const candidateRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId}/members/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /rooms/{roomId}/messages/{msgId} {
      allow create: if request.auth != null &&
        exists(/databases/$(database)/documents/rooms/$(roomId)/members/$(request.auth.uid)) &&
        get(/databases/$(database)/documents/rooms/$(roomId)/members/$(request.auth.uid)).data.role == 'member';
    }
  }
}`;

    const run = runDerivedCases(fixture, candidateRules);
    if ('error' in run) throw new Error(run.error);
    expect(run.diverged).toBe(0);
    expect(run.agreed).toBe(2);
  });
});
