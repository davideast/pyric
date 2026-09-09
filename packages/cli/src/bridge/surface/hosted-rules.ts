/**
 * The one seam between the service surface and Firebase's hosted Rules Test
 * API.
 *
 * `assurance.testRulesHosted` is the surface's first `production` method: it
 * reaches Google with real credentials, so everything that can refuse the call
 * before a network client exists is gathered here. The order is the point.
 * The effect gate refuses the call before this module is reached at all, the
 * confirmation is refused next, and the credentials are looked for last. The
 * client is constructed only after all three have passed, which is what lets a
 * test prove that a run without the flag, without a confirmation, or without
 * credentials never builds one.
 *
 * Credential discovery reads the same three sources `pyric verify --engine
 * rules-test-api` reads, through the same `resolveScope`. This module reads
 * whether they are present and never writes, moves, or mints one.
 */
import type { TestCase, TestFirestoreRulesResult } from 'pyric/rules/internal';

import { resolveScope } from '../../cli/scope.js';
import type { ProjectScope } from '../../credentials/core/types.js';

/** The credentials the hosted engine accepts, in the order `resolveScope` reads them. */
export const HOSTED_CREDENTIAL_SOURCES =
  'FIREBASE_SA_BASE64, GOOGLE_APPLICATION_CREDENTIALS, or Application Default Credentials from `gcloud auth application-default login` with a project id in PYRIC_PROJECT';

/** What one hosted run needs beyond the cases: a project and a token for it. */
export type HostedRulesTester = (
  scope: ProjectScope,
  rules: string,
  cases: TestCase[],
) => Promise<TestFirestoreRulesResult>;

/**
 * Build the client that talks to the hosted Rules Test API.
 *
 * Held as a replaceable value so a test can count constructions and assert
 * that none happened. Nothing but a test replaces it, and a test that does
 * restores it through the function it is handed back.
 */
let buildTester: () => HostedRulesTester = defaultTester;

/** The real client: one handler per run, calling Firebase's hosted API. */
function defaultTester(): HostedRulesTester {
  return async (scope, rules, cases) => {
    const { TestFirestoreRulesHandler } = await import('pyric/rules/internal');
    return new TestFirestoreRulesHandler().execute(scope, rules, cases);
  };
}

/** The client this process builds for a hosted run. */
export function hostedRulesTester(): HostedRulesTester {
  return buildTester();
}

/** Replace the client builder for one test, and restore it through the returned function. */
export function useHostedRulesTester(next: () => HostedRulesTester): () => void {
  const previous = buildTester;
  buildTester = next;
  return () => {
    buildTester = previous;
  };
}

/** The credentials a hosted run found, or the reason it found none. */
export type HostedCredentials =
  | { scope: ProjectScope; source: string }
  | { missing: string };

/**
 * The project scope a hosted run would use, or the sentence that says which
 * credentials are missing and how to supply them. Reading is all this does:
 * a source that is absent is reported, never created.
 */
export async function hostedCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostedCredentials> {
  try {
    const resolved = await resolveScope({ env });
    return { scope: resolved.scope, source: resolved.source };
  } catch {
    return {
      missing: `No Google credentials were found for the hosted Rules Test API. It reads ${HOSTED_CREDENTIAL_SOURCES}.`,
    };
  }
}
