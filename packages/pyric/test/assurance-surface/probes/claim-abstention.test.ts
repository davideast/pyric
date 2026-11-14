import { describe, expect, test } from 'bun:test';
import { extractAccessSites } from '../../../src/assurance-surface/code/extractor.js';
import { probeActors, runProbes } from '../../../src/assurance-surface/probes/run-probes.js';
import { ownerConditionsFrom } from '../../../src/assurance-surface/rules/analyze-owners.js';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';
import type { RuleSources } from '../../../src/assurance-surface/rules/rule-sources.js';

describe('seeded actor emailVerified defaults and counterfactual claim abstentions', () => {
  test('treats omitted emailVerified on non-synthetic ProbeUser as false while keeping synthetic actors verified by default', async () => {
    const actors = probeActors({}, [
      { uid: 'u1', email: 'u1@example.test' },
    ]);
    expect(actors.owner.synthetic).toBe(false);
    expect(actors.owner.token.email_verified).toBe(false);
    expect(actors.peer.synthetic).toBe(true);
    expect(actors.peer.token.email_verified).toBe(true);

    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /verifiedNotes/{uid} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.email_verified == true;
    }
  }
}`;
    const code = `
import { getAuth } from 'firebase/auth';
import { doc, getFirestore, setDoc } from 'firebase/firestore';
export async function save() {
  const uid = getAuth().currentUser!.uid;
  await setDoc(doc(getFirestore(), 'verifiedNotes', uid), { text: 'hello' });
}`;
    const accessSites = extractAccessSites({ root: '/app', files: { 'app.ts': code } }).accessSites;
    const sources: RuleSources = {
      firestore: [{ source: 'firestore.rules', text: rules }],
      rtdb: [],
      storage: [],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);
    const ownerBindings = inferOwnerBindings(conditions, accessSites);

    const report = await runProbes({
      accessSites,
      ownerBindings,
      conditions,
      sources,
      users: [{ uid: 'u1', email: 'u1@example.test' }],
    });
    expect(report.actors[0]?.token.email_verified).toBe(false);
    expect(report.findings.some((f) => f.kind === 'must-allow-denied')).toBe(false);
    expect(report.results.some((r) => r.abstained === true)).toBe(true);
  });

  test('abstains when emailVerified: true seeded owner hits email_verified == false rule, but still catches guaranteed payload denials behind missing claims', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /reqUnverified/{uid} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.email_verified == false;
    }
    match /staffOnly/{uid} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.role == 'staff'
        && request.resource.data.kind == 'valid';
    }
  }
}`;
    const code = `
import { getAuth } from 'firebase/auth';
import { doc, getFirestore, setDoc } from 'firebase/firestore';
export async function save() {
  const uid = getAuth().currentUser!.uid;
  const db = getFirestore();
  await setDoc(doc(db, 'reqUnverified', uid), { a: 1 });
  await setDoc(doc(db, 'staffOnly', uid), { kind: 'INVALID' });
}`;
    const accessSites = extractAccessSites({ root: '/app', files: { 'app.ts': code } }).accessSites;
    const sources: RuleSources = {
      firestore: [{ source: 'firestore.rules', text: rules }],
      rtdb: [],
      storage: [],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);
    const ownerBindings = inferOwnerBindings(conditions, accessSites);

    const report = await runProbes({
      accessSites,
      ownerBindings,
      conditions,
      sources,
      users: [{ uid: 'u1', email: 'u1@example.test', emailVerified: true }],
    });

    // reqUnverified abstains cleanly without false must-allow-denied
    expect(
      report.findings.some((f) => f.path === 'reqUnverified/{uid}' && f.kind === 'must-allow-denied'),
    ).toBe(false);
    expect(
      report.results.some(
        (r) => r.probe.template === 'reqUnverified/{uid}' && r.abstained === true,
      ),
    ).toBe(true);

    // staffOnly with kind: 'INVALID' fails even with role == 'staff', so must-allow-denied MUST fire!
    expect(
      report.findings.some((f) => f.path === 'staffOnly/{uid}' && f.kind === 'must-allow-denied'),
    ).toBe(true);
  });
});
