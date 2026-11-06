/**
 * Storage rules `lower()` and `upper()` map the ASCII letters only (#1885).
 *
 * Captures `st3-case-mapping` and `st3-case-mapping-ascii` (corpus scenarios
 * of the same names): production leaves é, Ä, Σ, ж, ß, İ, ı, ſ, ǅ, ﬁ, և
 * and the fullwidth ａ as they are, so `'ÉVE@X.COM'.lower()` is
 * `'Éve@x.com'`. Each case runs through `uploadBytes` in the in-process
 * sandbox and expects production's verdict.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from '../../../src/app/internal.js';
import { getStorage, ref, uploadBytes } from '../../../src/storage/index.js';
import { getStorageSandbox } from '../../../src/storage/service.js';

type Case = readonly [id: string, condition: string];

/** Production allows each of these. */
const allowed: readonly Case[] = [
  ['ascii-upper', "'aB'.upper() == 'AB'"],
  ['latin1-upper-unchanged', "'é'.upper() == 'é'"],
  ['latin1-lower-unchanged', "'Ä'.lower() == 'Ä'"],
  ['greek-lower-unchanged', "'ΑΣ'.lower() == 'ΑΣ'"],
  ['cyrillic-upper-unchanged', "'ж'.upper() == 'ж'"],
  ['dotted-i-lower-unchanged', "'İ'.lower() == 'İ'"],
  ['dotted-i-lower-size-1', "'İ'.lower().size() == 1"],
  ['dotless-i-upper-unchanged', "'ı'.upper() == 'ı'"],
  ['mixed-ascii-part', "'aé'.upper() == 'Aé'"],
  ['sharp-s-upper-unchanged', "'ß'.upper() == 'ß'"],
  ['sharp-s-upper-size', "'ß'.upper().size() == 1"],
  ['ligature-upper-unchanged', "'ﬁ'.upper() == 'ﬁ'"],
  ['armenian-ligature-upper-size', "'և'.upper().size() == 1"],
];

/** Production denies each of these. */
const denied: readonly Case[] = [
  ['latin1-upper', "'é'.upper() == 'É'"],
  ['latin1-lower', "'Ä'.lower() == 'ä'"],
  ['sigma-lower-simple', "'ΑΣ'.lower() == 'ασ'"],
  ['cyrillic-upper', "'ж'.upper() == 'Ж'"],
  ['dotted-i-lower-plain-i', "'İ'.lower() == 'i'"],
  ['dotless-i-upper', "'ı'.upper() == 'I'"],
  ['long-s-upper', "'ſ'.upper() == 'S'"],
  ['titlecase-dz-upper', "'ǅ'.upper() == 'Ǆ'"],
  ['upper-sharp-s-to-capital', "'ß'.upper() == 'ẞ'"],
  ['fullwidth-upper', "'ａ'.upper() == 'Ａ'"],
  ['email-lower', "'ÉVE@X.COM'.lower() == 'éve@x.com'"],
];

function storageRules(condition: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /case/{file} {
      allow create: if ${condition};
    }
  }
}`;
}

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

const BYTES = new TextEncoder().encode('x');

async function upload(condition: string, customMetadata?: Record<string, string>): Promise<string> {
  const sandbox = initializeSandbox({});
  getStorageSandbox(sandbox, { dbName: uniqueName('ascii-case'), rules: storageRules(condition) });
  const app = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' }, uniqueName('app'));
  try {
    await uploadBytes(ref(getStorage(app), 'case/x'), BYTES, customMetadata ? { customMetadata } : undefined);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe('Storage rules lower() and upper() map the ASCII letters only', () => {
  for (const [id, condition] of allowed) {
    it(`${id}: ${condition} allows uploadBytes`, async () => {
      expect(await upload(condition)).toBe('ok');
    });
  }

  for (const [id, condition] of denied) {
    it(`${id}: ${condition} denies uploadBytes`, async () => {
      expect(await upload(condition)).toBe('storage/unauthorized');
    });
  }

  it("custom metadata email ÉVE@X.COM does not lower to 'éve@x.com'", async () => {
    const condition = "request.resource.metadata.email.lower() == 'éve@x.com'";
    expect(await upload(condition, { email: 'ÉVE@X.COM' })).toBe('storage/unauthorized');
  });

  it("custom metadata email ÉVE@X.COM lowers to 'Éve@x.com'", async () => {
    const condition = "request.resource.metadata.email.lower() == 'Éve@x.com'";
    expect(await upload(condition, { email: 'ÉVE@X.COM' })).toBe('ok');
  });
});
