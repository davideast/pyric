import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { functionsHttpRows } from '@pyric/conformance/functions-http-fixture';
import { createPrivateInvokerWarnings } from '../src/functions/http/report.js';

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
interface GateRefusal { httpStatus: number; errorStatus: string; messageText: string }

describe('docs claims pinned against production captures', () => {
  test('DT-H1-11: cloud-storage.md names storage/unauthorized for a signed-out upload, matching production', () => {
    // The page's rule is `allow write: if request.auth != null`, and the
    // capture's oracle namespace carries the same rule (namespaceRuleDeployed).
    expect(docs('build/cloud-storage.md')).toContain('An anonymous upload and an 11 MiB payload both throw `FirebaseError` with `storage/unauthorized`.');
    expect(docs('build/cloud-storage.md')).not.toContain('storage/unauthenticated');

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
      'packages/rules/test/linter/fixtures/compile-limits/captures.json',
    );
    const bound = (shape: string) => fixture.boundaries.find((b) => b.service === 'firestore' && b.shape === shape);
    // Zero-argument calls, the page's sample: 99 compile, 100 fail.
    expect(bound('and-chain-calls')).toMatchObject({ largestPass: 99, smallestFail: 100 });
    // Comparisons: 98 compile, 99 fail, as the page says.
    expect(bound('and-chain')).toMatchObject({ largestPass: 98, smallestFail: 99 });
  });

  test('#1882: AI Logic App Check docs describe the enforced 401 and cite the enforced capture', () => {
    const gateWire = json<{
      observedAt: string;
      behavior: {
        appCheckEnforcementModeAtCapture: string;
        noHeader: GateRefusal;
        streamGenerateContentNoHeader: GateRefusal;
        countTokensNoHeader: GateRefusal;
      };
    }>('packages/conformance/observations/app-check/app-check-ai-gate-wire.json');

    expect(gateWire.observedAt.startsWith('2026-11-03')).toBe(true);
    expect(gateWire.behavior.appCheckEnforcementModeAtCapture).toBe('ENFORCED');
    for (const entry of [
      gateWire.behavior.noHeader,
      gateWire.behavior.streamGenerateContentNoHeader,
      gateWire.behavior.countTokensNoHeader,
    ]) {
      expect(entry).toMatchObject({
        httpStatus: 401,
        errorStatus: 'UNAUTHENTICATED',
        messageText: 'Firebase App Check token is invalid.',
      });
    }

    const aiLogicPage = docs('build/ai-logic.md');
    expect(aiLogicPage).toContain('Pyric refuses an AI Logic request without an App Check token with a 401');
    expect(aiLogicPage).toContain('UNAUTHENTICATED');
    expect(aiLogicPage).toContain('Firebase App Check token is invalid.');
    expect(aiLogicPage).toContain('2026-11-03');
    expect(aiLogicPage).toContain('app-check-ai-gate-wire');
    expect(aiLogicPage).toContain('gets the same 401 as a request with no token');
    expect(aiLogicPage).not.toContain('without an App Check token with a 403');
    expect(aiLogicPage).not.toContain('with a 403 error');
    expect(aiLogicPage).not.toContain('what a project that enforces it answers is not yet known');
    expect(aiLogicPage).not.toContain('gets the same 403 as a request with no token');

    const tutorialPage = docs('tutorial.md');
    expect(tutorialPage).toContain('Pyric refuses AI Logic requests without an App Check token with a 401');
    expect(tutorialPage).toContain('UNAUTHENTICATED');
    expect(tutorialPage).toContain('Firebase App Check token is invalid.');
    expect(tutorialPage).toContain('2026-11-03');
    expect(tutorialPage).toContain('app-check-ai-gate-wire');
    expect(tutorialPage).not.toContain('without an App Check token with a 403');
  });

  test('#1991: realtime-database.md and functions-http#15 match the private-invoker startup warning', () => {
    const warnings = createPrivateInvokerWarnings()({
      port: 0,
      token: 'test-token',
      functions: [
        {
          exportName: 'lockedFn',
          regions: ['us-central1'],
          platform: 'gcfv2',
          privateInvoker: true,
          timeoutSeconds: null,
        },
      ],
    });
    expect(warnings).toHaveLength(1);
    const startupWarning = warnings[0] ?? '';

    const invokerClause = "sets an invoker other than 'public', such as invoker: 'private' or a service account";
    const prodRefusalClause = 'production refuses unauthenticated calls with 403';
    const servedCallersClause = "serves it without authentication to the app's own pages and to callers that are not browser pages, such as curl or server code";

    expect(startupWarning).toContain(invokerClause);
    expect(startupWarning).toContain(prodRefusalClause);
    expect(startupWarning).toContain(servedCallersClause);

    const rtdbPagePlain = docs('build/realtime-database.md').replaceAll('`', '');
    expect(rtdbPagePlain).toContain(invokerClause);
    expect(rtdbPagePlain).toContain(prodRefusalClause);
    expect(rtdbPagePlain).toContain(servedCallersClause);
    expect(rtdbPagePlain).not.toContain("A function that sets invoker: 'private' runs without authentication");
    expect(rtdbPagePlain).not.toContain('callers that send no Origin');

    const row15 = functionsHttpRows.find((row) => row.id === 'functions-http#15');
    if (!row15) {
      throw new Error('functions-http#15 row is missing');
    }
    expect(row15.behavior).toContain(invokerClause);
    expect(row15.behavior).toContain(prodRefusalClause);
    expect(row15.behavior).toContain(servedCallersClause);
    expect(row15.behavior).not.toContain("call to an invoker: 'private' function");
  });
});
