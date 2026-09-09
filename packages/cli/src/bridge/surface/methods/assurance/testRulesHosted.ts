/**
 * Decide rules cases on Firebase's hosted Rules Test API.
 *
 * This is the only method on the surface that leaves the machine, so it is the
 * only one classed `production`, and three things have to be true before a
 * network client exists. The server has to have been started with
 * `--allow-production`, which the effect gate checks before this handler is
 * reached at all. The call has to confirm. And credentials have to be found,
 * from the same three sources `pyric verify --engine rules-test-api` reads.
 *
 * The local twin is `verifyCases`, which decides the same case shape with the
 * sandbox's own engine and reaches nothing. A caller comparing the two is
 * comparing engines rather than inputs.
 */
import { z } from 'zod';

import type { TestCase } from 'pyric/rules/internal';
import { CASE_SERVICES } from '../../arguments/assurance.js';
import { hostedRulesTestResult } from '../../hosted-rules.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

export default {
  tool: 'assurance',
  method: 'testRulesHosted',
  sdkOrigin: 'pyric',
  effect: 'production',
  signature: 'testRulesHosted(service: firestore, rules, cases, confirm)',
  description:
    'Decide cases on the hosted Rules Test API.',
  args: z.object({
    service: z
      .enum(CASE_SERVICES)
      .describe('The service whose rules are tested. The hosted API tests firestore only.'),
    rules: z.string().min(1).describe('The rules source the hosted API evaluates.'),
    cases: z
      .array(z.record(z.unknown()))
      .min(1)
      .describe(
        'Rules Test API cases, as verifyCases and pyric verify cases derive them from a capture.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. This call reaches Google with real credentials.'),
  }),
  operation: 'test_assurance_rules_hosted',
  renames: { testCases: 'cases', source: 'rules' },
  example: {
    service: 'firestore',
    rules: "rules_version = '2';\nservice cloud.firestore {}",
    cases: [{ description: 'owner reads', expectation: 'ALLOW', method: 'get', path: 'orders/o1' }],
    confirm: true,
  },
  async handler(args): Promise<OperationResult> {
    return hostedRulesTestResult({}, String(args.rules), args.cases as TestCase[]);
  },
} satisfies MethodRecord;
