/** Local RTDB inspection tools bound to one authoritative sandbox. */
import type { ToolHandler } from '@inbrowser/agent';
import { rtdbRules, type RtdbCase } from 'pyric/rules';
import { getClock, type LocalSandbox } from 'pyric/sandbox';
import { getActiveRules, snapshotState } from 'pyric/sandbox/database';
import { projectIdentity } from '../bridge/surface/identity.js';
import { countDescendantObjects, crawlSnapshot } from './crawl-snapshot.js';

export interface RtdbInspectionToolDeps {
  resolveSandbox(): LocalSandbox | Promise<LocalSandbox>;
}

interface SimulateAccessArgs {
  operation: 'read' | 'write' | 'update' | 'validate';
  path: string;
  auth?: { uid: string; tenant?: string; claims?: Record<string, unknown> } | null;
  /** The value written: any JSON value, or for `update` the patch keyed by the paths written. */
  newData?: unknown;
  /** The query a `read` carries, in the members rules read as `query.*`. */
  query?: RtdbCase['query'];
  /** The instant `now` evaluates at, in epoch milliseconds. Defaults to the sandbox clock's own instant. */
  now?: number;
}

/** A query bound is a JSON scalar. */
const QUERY_BOUND_SCHEMA = {
  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
};

interface CrawlStructureArgs {
  path?: string;
  maxDepth?: number;
  maxChildren?: number;
}

export function createRtdbInspectionTools(
  deps: RtdbInspectionToolDeps,
): ToolHandler[] {
  return [
    {
      name: 'rtdb_simulate_access',
      description:
        'Simulate one read, write, update, or validate operation against the RTDB rules and data currently loaded in the local sandbox. newData may be any JSON value, such as 5 or true; for update it is the patch keyed by the paths written, relative to path. A read may carry a query so query.* rules evaluate. No production database is contacted and no prior rules-loading tool call is required.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['read', 'write', 'update', 'validate'],
          },
          path: { type: 'string' },
          auth: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                properties: {
                  uid: { type: 'string' },
                  tenant: { type: 'string' },
                  claims: { type: 'object' },
                },
                required: ['uid'],
              },
            ],
          },
          newData: {},
          query: {
            type: 'object',
            properties: {
              orderByChild: { type: 'string' },
              orderByKey: { type: 'boolean', enum: [true] },
              orderByValue: { type: 'boolean', enum: [true] },
              equalTo: QUERY_BOUND_SCHEMA,
              startAt: QUERY_BOUND_SCHEMA,
              endAt: QUERY_BOUND_SCHEMA,
              limitToFirst: { type: 'integer' },
              limitToLast: { type: 'integer' },
            },
            additionalProperties: false,
          },
          now: { type: 'number' },
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
        // `now` is the sandbox clock's unless the call names an instant, so a
        // simulation of a `now`-gated rule moves with a pinned or advanced
        // clock rather than against the wall clock the process runs on.
        let now = args.now;
        if (now === undefined) {
          now = getClock(sandbox).now();
        }
        let identity: RtdbCase['auth'] = null;
        if (args.auth) {
          const projected = projectIdentity(args.auth.uid, args.auth.tenant, args.auth.claims);
          identity = { uid: projected.uid, token: projected.token };
        }
        const oneCase: RtdbCase = {
          expectation: 'ALLOW',
          operation: args.operation,
          path: args.path,
          auth: identity,
          data,
          now,
        };
        if (args.newData !== undefined) {
          oneCase.newData = args.newData;
        }
        if (args.query !== undefined) {
          oneCase.query = args.query;
        }
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
    {
      name: 'rtdb_crawl_structure',
      description:
        'Describe the structure of the RTDB data currently loaded in the local sandbox without returning leaf values or contacting a production database.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Root-relative path to inspect. Defaults to /.',
          },
          maxDepth: {
            type: 'number',
            minimum: 0,
            description: 'Maximum object depth to return. Defaults to 10.',
          },
          maxChildren: {
            type: 'number',
            minimum: 1,
            description: 'Maximum object children to return per node. Defaults to 100.',
          },
        },
      },
      async execute(rawArgs) {
        const args = rawArgs as CrawlStructureArgs;
        const sandbox = await deps.resolveSandbox();
        const root = crawlSnapshot(snapshotState(sandbox), args);
        return {
          ok: true,
          summary: `Crawled ${countDescendantObjects(root)} object paths from ${root.path}`,
          data: root,
        };
      },
    },
  ];
}
