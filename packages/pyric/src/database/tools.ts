/**
 * Agent-tool factory for the Realtime Database surface.
 *
 * `createRtdbAdminTools({ host })` returns the 11 RTDB tools as
 * `ToolHandler[]`, consumable by `@inbrowser/agent`'s registry —
 * including by `composeMcpRegistry`. Mirrors the
 * `createFirestoreRulesTools` / `createStorageAdminTools` factory
 * shape: a host in, JSON-Schema-typed `ToolHandler`s out.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { buildRuleExpression } from './mapper.js';
import { getRtdbTools } from './resolver.js';
import type { RtdbHost } from './host.js';
import type { RtdbIR, UserAuth } from './types.js';

export interface RtdbAdminToolDeps {
  /** Project identity + token resolvers + client-SDK factory. Factory
   *  consumers (e.g. `composeMcpRegistry`) pass it directly. */
  host: RtdbHost;
}

export type RtdbRulesToolDeps = RtdbAdminToolDeps;
export type RtdbDataToolDeps = RtdbAdminToolDeps;

/** JSON Schema for the optional per-call `auth` argument shared by
 *  every data tool. When supplied, the operation goes through
 *  `host.getClientForUser(auth)` so rules are enforced; when omitted,
 *  admin access is used. */
const AUTH_SCHEMA = {
  description:
    'When provided, request is made as this user with security rules enforced. When omitted, uses admin access (rules bypassed). Requires FIREBASE_API_KEY env var on the host.',
  type: 'object',
  properties: {
    uid: { type: 'string', description: 'User ID to act as' },
    claims: { type: 'object', description: 'Custom claims for the user', additionalProperties: true },
  },
  required: ['uid'],
};

/** Reject a crawl path that could steer the underlying REST fetch off
 *  the database origin. `fetchDatabase` origin-pins as the real backstop;
 *  this rejects the obvious cases at the agent-facing boundary with a
 *  clear error instead of letting them reach the network layer. */
function assertSafeCrawlPath(path: string): void {
  // Protocol-relative (`//host`), backslashes, whitespace, and control
  // chars are never valid in an RTDB path and are the SSRF-shaped inputs.
  if (/^\s*\/\//.test(path) || /[\\\s\u0000-\u001F\u007F]/.test(path)) {
    throw new Error(
      `Invalid crawl path '${path}': RTDB paths cannot contain '//', backslashes, whitespace, or control characters.`,
    );
  }
}

export function createRtdbRulesTools(deps: RtdbRulesToolDeps): ToolHandler[] {
  const { host } = deps;
  const db = getRtdbTools(host);

  return [
    {
      name: 'rtdb_build_expression',
      description:
        'Construct a validated Realtime Database rule expression from a raw string. Returns the expression with parse results, validation errors, linter warnings, and referenced identifiers. Use this when building or modifying security rules to ensure expressions are correct before deploying.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'The rule expression, e.g. "auth.uid === $userId"' },
          context: { type: 'string', enum: ['read', 'write', 'validate'], description: 'Which rule type this expression is for' },
          pathVariables: { type: 'array', items: { type: 'string' }, description: 'Path variables in scope, e.g. ["$userId"]' },
        },
        required: ['expression', 'context'],
      },
      async execute(args) {
        const { expression, context, pathVariables } = args as {
          expression: string;
          context: 'read' | 'write' | 'validate';
          pathVariables?: string[];
        };
        const data = buildRuleExpression(expression, context, pathVariables);
        return { ok: true, summary: `Built ${context} expression`, data };
      },
    },
    {
      name: 'rtdb_get_rules',
      description:
        'Fetch and parse the security rules for this Realtime Database. Returns a tree of rule expressions with validation results, linter warnings, and referenced variables. Use this to understand access controls before modifying them.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const result = await db.generateIR();
        return {
          ok: result.success,
          summary: result.success ? 'Generated rule IR' : `IR generation failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'rtdb_simulate_access',
      description:
        'Test whether a user with given auth credentials would be allowed to read, write, or validate at a specific database path. Evaluates security rules locally against mock data without touching the live database. Requires `rtdb_get_rules` to be called first to load the rules.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          operation: { type: 'string', enum: ['read', 'write', 'validate'] },
          auth: AUTH_SCHEMA,
          data: { description: 'Mock value at the path (or proposed value for write)' },
        },
        required: ['path', 'operation'],
      },
      async execute(args) {
        const result = db.simulate(args);
        return {
          ok: result.success,
          summary: result.success ? `Simulation: ${result.data.allowed ? 'allowed' : 'denied'}` : `Simulation failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'rtdb_deploy_rules',
      description:
        'Deploy security rules to the Realtime Database via REST API. Takes a complete rules IR and writes it. Always use `rtdb_simulate_access` first to verify rules behave correctly before deploying.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: ['realtime-database'] },
          databaseUrl: { type: 'string' },
          rules: { description: 'Rule tree' },
        },
        required: ['service', 'databaseUrl', 'rules'],
      },
      async execute(args) {
        const result = await db.writeRules(args as RtdbIR);
        return {
          ok: result.success,
          summary: result.success ? 'Rules deployed' : `Deploy failed: ${result.error.code}`,
          data: result,
        };
      },
    },
  ];
}

export function createRtdbDataTools(deps: RtdbDataToolDeps): ToolHandler[] {
  const { host } = deps;
  const db = getRtdbTools(host);

  return [
    {
      name: 'rtdb_crawl_structure',
      description:
        'Discover the shape of the Realtime Database by recursively fetching paths without downloading values. Returns a tree of paths with child counts. Use this to understand what data exists before generating code or writing rules.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Starting path, defaults to root /' },
          maxDepth: { type: 'number', description: 'How many levels deep to crawl, defaults to 10' },
          maxChildren: { type: 'number', description: 'Max children to explore per node, defaults to 100' },
        },
      },
      async execute(args) {
        const params = (args ?? {}) as { path?: string; maxDepth?: number; maxChildren?: number };
        if (params.path !== undefined) assertSafeCrawlPath(params.path);
        const result = await db.crawlStructure(params);
        return {
          ok: result.success,
          summary: result.success ? 'Crawled structure' : `Crawl failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'rtdb_get',
      description:
        'Read data at a database path. Returns the value stored at that location, or null if the path is empty. Use this to inspect actual data values, not just structure. Pass `auth` to read as a specific user with security rules enforced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Database path to read, e.g. "/users/alice"' },
          auth: AUTH_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const { path, auth } = args as { path: string; auth?: UserAuth };
        const result = await db.readData(path, { auth });
        return {
          ok: result.success,
          summary: result.success ? `Read ${path}` : `Read failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'rtdb_set',
      description:
        'Replace data at a database path. Overwrites everything at that location with the provided value. Use `rtdb_update` instead if you only want to change specific fields. Pass `auth` to write as a specific user with security rules enforced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Database path to write to, e.g. "/users/alice"' },
          data: { description: 'The data to write (replaces existing)' },
          auth: AUTH_SCHEMA,
        },
        required: ['path', 'data'],
      },
      async execute(args) {
        const { path, data, auth } = args as { path: string; data: unknown; auth?: UserAuth };
        const result = await db.setData(path, data, { auth });
        return {
          ok: result.success,
          summary: result.success ? `Set ${path}` : `Set failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'rtdb_update',
      description:
        'Merge data at a database path, or perform an atomic multi-location update. When path is "/" and keys are root-relative paths, all paths are written atomically — the fan-out write mechanism for keeping denormalized data consistent. When path is a specific location, only the specified keys at that location are merged. Pass `auth` to write as a specific user with security rules enforced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Use "/" with root-relative keys for atomic multi-location updates, or a specific path like "/users/alice" for a merge.' },
          data: { type: 'object', description: 'Key-value pairs to merge', additionalProperties: true },
          auth: AUTH_SCHEMA,
        },
        required: ['path', 'data'],
      },
      async execute(args) {
        const { path, data, auth } = args as { path: string; data: Record<string, unknown>; auth?: UserAuth };
        const result = await db.updateData(path, data, { auth });
        return {
          ok: result.success,
          summary: result.success ? `Updated ${path}` : `Update failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'rtdb_push',
      description:
        'Create a new child at a database path with an auto-generated unique key. Returns the generated key name. Use this for list-like data (e.g. adding a new post to /posts). Pass `auth` to write as a specific user with security rules enforced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Database path to push to, e.g. "/posts"' },
          data: { description: 'The data for the new child entry' },
          auth: AUTH_SCHEMA,
        },
        required: ['path', 'data'],
      },
      async execute(args) {
        const { path, data, auth } = args as { path: string; data: unknown; auth?: UserAuth };
        const result = await db.pushData(path, data, { auth });
        return {
          ok: result.success,
          summary: result.success ? `Pushed to ${path}` : `Push failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'rtdb_delete',
      description:
        'Delete data at a database path. Removes the value and all children at that location. Pass `auth` to delete as a specific user with security rules enforced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Database path to delete, e.g. "/users/alice"' },
          auth: AUTH_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const { path, auth } = args as { path: string; auth?: UserAuth };
        const result = await db.removeData(path, { auth });
        return {
          ok: result.success,
          summary: result.success ? `Deleted ${path}` : `Delete failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'rtdb_validated_write',
      description:
        'Write data with pre-flight safety checks. Infers the schema at the target path, validates that your data matches the expected types, simulates security rules to verify permission, then executes the write. The `auth` param controls mode: when provided, the write enforces real security rules (simulation is advisory since cross-path lookups use empty mock data). When omitted, uses admin access and simulation denial blocks the write. Returns schema warnings and simulation results alongside the write outcome.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          operation: { type: 'string', enum: ['set', 'update', 'push'] },
          data: { description: 'The write payload' },
          auth: AUTH_SCHEMA,
        },
        required: ['path', 'operation', 'data'],
      },
      async execute(args) {
        const result = await db.validatedWrite(args as Parameters<typeof db.validatedWrite>[0]);
        return {
          ok: result.success,
          summary: result.success ? 'Validated write committed' : `Validated write failed: ${result.error.code}`,
          data: result,
        };
      },
    },
  ];
}

export function createRtdbAdminTools(deps: RtdbAdminToolDeps): ToolHandler[] {
  return [
    ...createRtdbRulesTools(deps),
    ...createRtdbDataTools(deps),
  ];
}
