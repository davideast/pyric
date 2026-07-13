/** Local RTDB inspection tools bound to one authoritative sandbox. */
import type { ToolHandler } from '@inbrowser/agent';
import { rtdbRules, type RtdbCase } from 'pyric/rules';
import type { LocalSandbox } from 'pyric/sandbox';
import { getActiveRules, snapshotState } from 'pyric/sandbox/database';

export interface RtdbInspectionToolDeps {
  resolveSandbox(): LocalSandbox | Promise<LocalSandbox>;
}

interface SimulateAccessArgs {
  operation: 'read' | 'write' | 'validate';
  path: string;
  auth?: { uid: string; claims?: Record<string, unknown> } | null;
  newData?: unknown;
}

export function createRtdbInspectionTools(
  deps: RtdbInspectionToolDeps,
): ToolHandler[] {
  return [
    {
      name: 'rtdb_simulate_access',
      description:
        'Simulate one read, write, or validate operation against the RTDB rules and data currently loaded in the local sandbox. No production database is contacted and no prior rules-loading tool call is required.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['read', 'write', 'validate'],
          },
          path: { type: 'string' },
          auth: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                properties: {
                  uid: { type: 'string' },
                  claims: { type: 'object' },
                },
                required: ['uid'],
              },
            ],
          },
          newData: {},
        },
        required: ['operation', 'path'],
      },
      async execute(rawArgs) {
        const args = rawArgs as SimulateAccessArgs;
        const sandbox = await deps.resolveSandbox();
        const rules = getActiveRules(sandbox);
        if (!rules) {
          return {
            ok: false,
            summary: 'No RTDB rules are loaded in the local sandbox.',
            data: { code: 'NO_ACTIVE_RULES' },
          };
        }

        const state = snapshotState(sandbox);
        const data = state !== null && typeof state === 'object' && !Array.isArray(state)
          ? state as Record<string, unknown>
          : {};
        const oneCase: RtdbCase = {
          expectation: 'ALLOW',
          operation: args.operation,
          path: args.path,
          auth: args.auth
            ? { uid: args.auth.uid, token: args.auth.claims ?? {} }
            : null,
          data,
          ...(args.newData !== undefined ? { newData: args.newData } : {}),
        };
        const result = rtdbRules(rules).simulate([oneCase]).cases[0];

        return {
          ok: !result.unsupported,
          summary: result.unsupported
            ? `Simulation unsupported: ${result.reason}`
            : `Simulation: ${result.decision.toLowerCase()}`,
          data: {
            decision: result.decision,
            allowed: result.decision === 'ALLOW',
            unsupported: result.unsupported,
            matchedPath: result.matchedPath,
            matchedRule: result.matchedRule,
            reason: result.reason,
          },
        };
      },
    },
  ];
}
