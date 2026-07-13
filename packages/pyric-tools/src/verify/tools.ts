import type { ToolHandler } from '@inbrowser/agent';
import type { ProjectScope } from '../credentials/core/types.js';
import {
  deriveRulesTestCases,
  verifyFixture,
  type VerifyEngine,
  type VerifyRulesInput,
  type VerifiableService,
} from './index.js';

export interface VerifyToolDeps {
  scope?: ProjectScope;
}

export function createVerifyTools(deps: VerifyToolDeps = {}): ToolHandler[] {
  return [
    {
      name: 'pyric_verify_fixture',
      description:
        'Verify a pyric captured fixture against candidate rules. Uses local sandbox replay by default; rulesTestApi is Firestore-only and requires configured project credentials.',
      parameters: {
        type: 'object',
        properties: {
          fixture: { type: 'object' },
          rules: { type: 'object' },
          services: { type: 'array', items: { type: 'string', enum: ['firestore', 'rtdb'] } },
          engines: { type: 'array', items: { type: 'string', enum: ['sandbox', 'rulesTestApi'] } },
          expressionReportLevel: { type: 'string', enum: ['NONE', 'VISITED', 'FULL'] },
          caseDerivation: { type: 'object' },
        },
        required: ['fixture', 'rules'],
      },
      async execute(args) {
        const input = args as {
          fixture: unknown;
          rules: VerifyRulesInput;
          services?: VerifiableService[];
          engines?: VerifyEngine[];
          expressionReportLevel?: 'NONE' | 'VISITED' | 'FULL';
          caseDerivation?: { includeAllowed?: boolean; includeDenied?: boolean; mockReads?: 'strict' | 'omit' };
        };
        try {
          if (input.engines?.includes('rulesTestApi') && !deps.scope) {
            throw new Error('pyric_verify_fixture: rulesTestApi engine requires a ProjectScope.');
          }
          const result = await verifyFixture(input.fixture, {
            rules: input.rules,
            ...(input.services ? { services: input.services } : {}),
            ...(input.engines ? { engines: input.engines } : {}),
            ...(input.caseDerivation ? { caseDerivation: input.caseDerivation } : {}),
            ...(input.engines?.includes('rulesTestApi') && deps.scope
              ? { rulesTestApi: { scope: deps.scope, expressionReportLevel: input.expressionReportLevel } }
              : {}),
          });
          return {
            ok: result.ok,
            summary: result.ok ? 'Fixture verified' : 'Fixture verification found divergences',
            data: result,
          };
        } catch (e) {
          return { ok: false, summary: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'pyric_derive_rules_test_cases',
      description:
        'Derive Firestore Rules Test API test cases from a pyric captured fixture. This is inspection-only and does not call Firebase.',
      parameters: {
        type: 'object',
        properties: {
          fixture: { type: 'object' },
          service: { type: 'string', enum: ['firestore'] },
          includeAllowed: { type: 'boolean' },
          includeDenied: { type: 'boolean' },
          mockReads: { type: 'string', enum: ['strict', 'omit'] },
        },
        required: ['fixture'],
      },
      async execute(args) {
        const input = args as {
          fixture: unknown;
          service?: 'firestore';
          includeAllowed?: boolean;
          includeDenied?: boolean;
          mockReads?: 'strict' | 'omit';
        };
        try {
          const result = deriveRulesTestCases(input.fixture, {
            service: input.service ?? 'firestore',
            includeAllowed: input.includeAllowed,
            includeDenied: input.includeDenied,
            mockReads: input.mockReads,
          });
          return {
            ok: result.ok,
            summary: result.ok
              ? `Derived ${result.testCases.length} Firestore test case(s)`
              : `Derived ${result.testCases.length} case(s), ${result.unsupportedEvents.length} unsupported event(s)`,
            data: result,
          };
        } catch (e) {
          return { ok: false, summary: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}
