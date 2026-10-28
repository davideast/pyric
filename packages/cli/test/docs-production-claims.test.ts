import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Docs claims about production behavior, held against production captures.
 *
 * Each test is a pin from the 2026-10-27 docs and templates defect hunt: it
 * asserts what the page says today and the capture that contradicts it. When
 * the page is corrected, the first assertion fails; flip it to the corrected
 * text in the same change.
 */

const repoRoot = resolve(import.meta.dir, '../../..');
const docs = (page: string) => readFileSync(join(repoRoot, 'packages/site-docs/src/content', page), 'utf8');
const json = <T>(path: string) => JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as T;

interface UploadAttempt { threw: boolean; code: string | null; status: number | null }

describe('docs claims pinned against production captures', () => {
  test('DT-H1-11: cloud-storage.md names storage/unauthenticated for a signed-out upload; production answers storage/unauthorized', () => {
    // The page's rule is `allow write: if request.auth != null`, and the
    // capture's oracle namespace carries the same rule (namespaceRuleDeployed).
    expect(docs('build/cloud-storage.md')).toContain('An anonymous upload now throws `FirebaseError` with `storage/unauthenticated`.');

    const obs = json<{ behavior: { namespaceRuleDeployed: boolean; signedOutCurrentUser: null; signedOutNamespace: UploadAttempt } }>(
      'packages/conformance/observations/storage/storage-rules-denied-signed-out-error-code.json',
    );
    expect(obs.behavior.namespaceRuleDeployed).toBe(true);
    expect(obs.behavior.signedOutCurrentUser).toBeNull();
    expect(obs.behavior.signedOutNamespace).toMatchObject({ threw: true, code: 'storage/unauthorized', status: 403 });
  });

  test('DT-H2-7: firestore-rules-limits.md calls a 99-call flat chain invalid; production compiles 99 calls and rejects 100', () => {
    const page = docs('secure/firestore-rules-limits.md');
    expect(page).toContain('A flat `&&` or `||` chain compiles with 98 terms and fails at 99.');
    expect(page).toContain('&& check98() && check99();');

    const fixture = json<{ boundaries: { service: string; shape: string; largestPass: number; smallestFail: number }[] }>(
      'packages/pyric/test/rules/linter/fixtures/compile-limits/captures.json',
    );
    const bound = (shape: string) => fixture.boundaries.find((b) => b.service === 'firestore' && b.shape === shape);
    // Zero-argument calls, the page's sample: 99 compile, 100 fail.
    expect(bound('and-chain-calls')).toMatchObject({ largestPass: 99, smallestFail: 100 });
    // Comparisons: 98 compile, 99 fail, as the page says.
    expect(bound('and-chain')).toMatchObject({ largestPass: 98, smallestFail: 99 });
  });
});
