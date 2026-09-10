/**
 * The one place the project talks to Firebase's hosted Rules Test API.
 *
 * Two callers reach Google with rules cases: `pyric verify --engine
 * rules-test-api`, which already holds a resolved scope, and the surface's
 * `assurance.testRulesHosted` method, which holds nothing and has to find
 * credentials first. Both go through `executeHostedRulesTest`, so there is one
 * client construction in the tree and a test can count it.
 *
 * Credential discovery reads the sources `resolveScope` reads, in its order,
 * and never writes, moves, or mints one. A run that finds none gets a typed
 * `MissingCredentials` naming what was checked rather than an exception, so a
 * caller can report it as an answer.
 */
import {
  HOSTED_CREDENTIAL_SOURCES,
  PROJECT_ID_ENV_KEY,
  resolveScope,
  SERVICE_ACCOUNT_BASE64_ENV_KEY,
  SERVICE_ACCOUNT_FILE_ENV_KEY,
} from '../credentials/node/scope.js';
import type { ProjectScope } from '../credentials/core/types.js';
import type {
  ExpressionReportLevel,
  TestCase,
  TestFirestoreRulesResult,
} from 'pyric/rules/internal';

export { HOSTED_CREDENTIAL_SOURCES } from '../credentials/node/scope.js';

/** What one hosted run needs beyond the cases: a project and a token for it. */
export type HostedRulesTester = (
  scope: ProjectScope,
  rules: string,
  cases: TestCase[],
  options?: { expressionReportLevel?: ExpressionReportLevel | undefined },
) => Promise<TestFirestoreRulesResult>;

/** The real client: one handler per run, calling Firebase's hosted API. */
function defaultTester(): HostedRulesTester {
  return async (scope, rules, cases, options) => {
    const { TestFirestoreRulesHandler } = await import('pyric/rules/internal');
    return new TestFirestoreRulesHandler().execute(scope, rules, cases, {
      expressionReportLevel: options?.expressionReportLevel,
    });
  };
}

/**
 * Build the client that talks to the hosted Rules Test API.
 *
 * Held as a replaceable value so a test can count constructions and assert
 * that none happened. Nothing but a test replaces it, and a test that does
 * restores it through the function it is handed back.
 */
let buildTester: () => HostedRulesTester = defaultTester;

/** Replace the client builder for one test, and restore it through the returned function. */
export function useHostedRulesTester(next: () => HostedRulesTester): () => void {
  const previous = buildTester;
  buildTester = next;
  return () => {
    buildTester = previous;
  };
}

/** No credentials were found, with the sources that were checked for one. */
export interface MissingCredentials {
  missing: string;
  sources: readonly string[];
}

/** The credentials a hosted run will use, and which source supplied them. */
export interface HostedRulesCredentials {
  scope: ProjectScope;
  source: string;
}

/**
 * Whether one outcome is the absence of credentials rather than an answer.
 * Both the discovery call and the full run can come back this way, so the
 * check is written once over either.
 */
export function isMissingCredentials<Answered extends object>(
  outcome: Answered | MissingCredentials,
): outcome is MissingCredentials {
  return 'missing' in outcome;
}

/** Which project a hosted run asks about, and which environment it reads. */
export interface HostedRulesScope {
  projectId?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/** The sources credential discovery reads, in the order it reads them. */
export const HOSTED_CREDENTIAL_ENV_KEYS: readonly string[] = [
  SERVICE_ACCOUNT_BASE64_ENV_KEY,
  SERVICE_ACCOUNT_FILE_ENV_KEY,
  PROJECT_ID_ENV_KEY,
];

/**
 * The project scope a hosted run would use, or the sentence that says which
 * credentials are missing and how to supply them. Reading is all this does: a
 * source that is absent is reported, never created.
 */
export async function hostedRulesCredentials(
  scope: HostedRulesScope = {},
): Promise<HostedRulesCredentials | MissingCredentials> {
  const env = scope.env ?? process.env;
  try {
    const resolved = await resolveScope({ env, projectId: scope.projectId });
    return { scope: resolved.scope, source: resolved.source };
  } catch {
    return {
      missing: `No Google credentials were found for the hosted Rules Test API. It reads ${HOSTED_CREDENTIAL_SOURCES}.`,
      sources: HOSTED_CREDENTIAL_ENV_KEYS,
    };
  }
}

/**
 * Run cases on the hosted API against an already-resolved scope. This is the
 * only construction of the client; every path that reaches Google goes through
 * it.
 */
export async function executeHostedRulesTest(
  scope: ProjectScope,
  rules: string,
  cases: TestCase[],
  options: { expressionReportLevel?: ExpressionReportLevel | undefined } = {},
): Promise<TestFirestoreRulesResult> {
  return buildTester()(scope, rules, cases, options);
}

/** What a run that had to find its own credentials came back with. */
export type HostedRulesTestOutcome =
  | { credentials: HostedRulesCredentials; result: TestFirestoreRulesResult }
  | MissingCredentials;

/**
 * Find credentials and decide the cases on the hosted API. Credentials are
 * looked for first, so a run without them never builds a client.
 */
export async function runHostedRulesTest(
  scope: HostedRulesScope,
  rules: string,
  cases: TestCase[],
): Promise<HostedRulesTestOutcome> {
  const credentials = await hostedRulesCredentials(scope);
  if (isMissingCredentials(credentials)) return credentials;
  const result = await executeHostedRulesTest(credentials.scope, rules, cases);
  return { credentials, result };
}
