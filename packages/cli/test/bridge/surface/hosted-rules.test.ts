/**
 * The production boundary, proved at the seam rather than described.
 *
 * The client that talks to Firebase is built by one function, so a test that
 * counts how many times it is built can assert the thing that matters: no run
 * without the flag, without a confirmation, and without credentials ever
 * builds one. Nothing here makes a network call, and the counted double is
 * what stands in for the client when one is legitimately built.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import type { TestCase, TestFirestoreRulesResult } from 'pyric/rules/internal';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import {
  HOSTED_CREDENTIAL_SOURCES,
  hostedRulesCredentials,
  isMissingCredentials,
  useHostedRulesTester,
} from '../../../src/verify/index.js';
import { OPEN_ORDER_RULES } from '../../fixtures/order-rules.js';

/** One case, in the shape the derivation produces and the hosted API takes. */
const CASES = [
  { description: 'owner reads', expectation: 'ALLOW', method: 'get', path: 'orders/o1' },
];

/** An environment with none of the three credential sources set. */
const NO_CREDENTIALS: NodeJS.ProcessEnv = {};

/** What one counted double recorded. */
interface Counted {
  built: number;
  cases: TestCase[][];
  restore: () => void;
}

/** Replace the client builder with a double that counts, and answers all-passed. */
function countTester(): Counted {
  const counted: Counted = { built: 0, cases: [], restore: () => undefined };
  counted.restore = useHostedRulesTester(() => {
    counted.built += 1;
    return async (_scope, _rules, cases): Promise<TestFirestoreRulesResult> => {
      counted.cases.push(cases);
      return {
        success: true,
        data: {
          passed: cases.length,
          failed: 0,
          unsupported: 0,
          results: cases.map((testCase) => ({
            description: testCase.description,
            expectation: testCase.expectation,
            state: 'PASSED' as const,
            decision: testCase.expectation,
            trace: [],
            notes: [],
          })),
        },
      };
    };
  });
  return counted;
}

let counted: Counted | null = null;

afterEach(() => {
  counted?.restore();
  counted = null;
  delete process.env.FIREBASE_SA_BASE64;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.PYRIC_PROJECT;
});

function assuranceTool(allowProduction: boolean) {
  const surface = renderSurface('sdk-service', { allowProduction });
  const tool = surface.tools.find((candidate) => candidate.name === 'assurance');
  if (tool === undefined) throw new Error('the sdk-service surface renders no assurance tool');
  const ctx = createSurfaceContext(initializeSandbox(), process.cwd());
  return (args: Record<string, unknown>) =>
    tool.execute({ method: 'testRulesHosted', args }, ctx);
}

const HOSTED_ARGS = { service: 'firestore', rules: OPEN_ORDER_RULES, cases: CASES };

describe('credential discovery', () => {
  it('names the three sources it reads when none of them is set', async () => {
    const found = await hostedRulesCredentials({ env: NO_CREDENTIALS });
    if (!isMissingCredentials(found)) {
      throw new Error('credentials were found in an empty environment');
    }
    expect(found.missing).toContain(HOSTED_CREDENTIAL_SOURCES);
    expect(found.sources).toEqual([
      'FIREBASE_SA_BASE64',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'PYRIC_PROJECT',
    ]);
    expect(found.missing).toContain('Application Default Credentials');
  });
});

describe('the hosted rules test builds no client until all three are true', () => {
  it('refuses without the flag, and builds nothing', async () => {
    counted = countTester();
    const refused = await assuranceTool(false)({ ...HOSTED_ARGS, confirm: true });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('--allow-production');
    expect(counted.built).toBe(0);
  });

  it('refuses with the flag and no confirmation, and builds nothing', async () => {
    counted = countTester();
    const refused = await assuranceTool(true)(HOSTED_ARGS);
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('confirm: true');
    expect(counted.built).toBe(0);
  });

  it('refuses with the flag and a confirmation but no credentials, and builds nothing', async () => {
    counted = countTester();
    const refused = await assuranceTool(true)({ ...HOSTED_ARGS, confirm: true });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('FIREBASE_SA_BASE64');
    expect(counted.built).toBe(0);
  });

  it('hands the cases to the client once all three are true', async () => {
    counted = countTester();
    process.env.FIREBASE_SA_BASE64 = Buffer.from(
      JSON.stringify({
        type: 'service_account',
        project_id: 'demo-project',
        client_email: 'tester@demo-project.iam.gserviceaccount.com',
        private_key: 'unused-by-the-double',
      }),
    ).toString('base64');

    const ran = await assuranceTool(true)({ ...HOSTED_ARGS, confirm: true });
    expect(counted.built).toBe(1);
    expect(counted.cases[0]).toEqual(CASES as unknown as TestCase[]);
    expect(ran.ok).toBe(true);
    const data = ran.data as { project: string; passed: number };
    expect(data.project).toBe('demo-project');
    expect(data.passed).toBe(1);
  });
});
