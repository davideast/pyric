/**
 * Firestore rules `lower()` and `upper()` map the ASCII letters only (#1896).
 *
 * Capture `c11-case-mapping` (corpus scenario `string-case-mapping`): production
 * leaves é, Ä, Σ, ж, ß, İ and the fullwidth ａ as they are, so
 * `'ÉVE@X.COM'.lower()` is `'Éve@x.com'`. Each case runs through `setDoc` in
 * the in-process sandbox and expects production's verdict.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getFirestore, setDoc } from '../../src/firestore/index.js';

type Case = readonly [id: string, condition: string];

/** Production allows each of these. */
const allowed: readonly Case[] = [
  ['cm0', "'aB'.upper() == 'AB'"],
  ['cm2', "'é'.upper() == 'é'"],
  ['cm4', "'Ä'.lower() == 'Ä'"],
  ['cm6', "'ΑΣ'.lower() == 'ΑΣ'"],
  ['cm8', "'ж'.upper() == 'ж'"],
  ['cm9', "'aé'.upper() == 'Aé'"],
  ['cmb', "'ÉVE@X.COM'.lower() == 'Éve@x.com'"],
  ['cmd', "'ß'.upper() == 'ß'"],
];

/** Production denies each of these. */
const denied: readonly Case[] = [
  ['cm1', "'é'.upper() == 'É'"],
  ['cm3', "'Ä'.lower() == 'ä'"],
  ['cm5', "'ΑΣ'.lower() == 'ασ'"],
  ['cm7', "'ж'.upper() == 'Ж'"],
  ['cma', "'ÉVE@X.COM'.lower() == 'éve@x.com'"],
  ['cmc', "'ß'.upper() == 'SS'"],
  ['cme', "'İ'.lower().size() == 2"],
  ['cmf', "'ａ'.upper() == 'Ａ'"],
];

function firestoreRules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow create: if ${condition};
    }
  }
}`;
}

async function createDoc(condition: string, data: Record<string, unknown> = { v: 1 }): Promise<string> {
  const sandbox = initializeSandbox({});
  setRules(sandbox, firestoreRules(condition));
  const db = getFirestore(sandbox.withAuth({ uid: 'u' }));
  try {
    await setDoc(doc(db, 'c/1'), data);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe('Firestore rules lower() and upper() map the ASCII letters only', () => {
  for (const [id, condition] of allowed) {
    it(`${id}: ${condition} allows setDoc`, async () => {
      expect(await createDoc(condition)).toBe('ok');
    });
  }

  for (const [id, condition] of denied) {
    it(`${id}: ${condition} denies setDoc`, async () => {
      expect(await createDoc(condition)).toBe('permission-denied');
    });
  }

  it("cmg: an email of ÉVE@X.COM does not lower to 'éve@x.com'", async () => {
    const condition = "request.resource.data.email.lower() == 'éve@x.com'";
    expect(await createDoc(condition, { email: 'ÉVE@X.COM' })).toBe('permission-denied');
  });

  it("an email of ÉVE@X.COM lowers to 'Éve@x.com'", async () => {
    const condition = "request.resource.data.email.lower() == 'Éve@x.com'";
    expect(await createDoc(condition, { email: 'ÉVE@X.COM' })).toBe('ok');
  });
});
