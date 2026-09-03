/**
 * Tool factory for Cloud Storage Security Rules source tooling.
 *
 * `createStorageRulesTools()` yields the pure-local handlers behind
 * `pyric storage rules lint` and `pyric storage rules simulate`: parse a
 * rules source, and evaluate one request against it. Both run without a
 * sandbox, a project, or a network call, in Node or in the browser.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { parseStorageRules } from './sandbox/rules.js';
import { evaluateStorageRules } from './sandbox/rules-evaluator.js';
import type { StorageRequest, StorageResource } from './sandbox/rules.js';

interface StorageLintArgs {
  source: string;
}

interface StorageSimulateArgs {
  source: string;
  request: StorageRequest;
  resource?: StorageResource | null;
  now?: string;
}

const STORAGE_METHODS = ['read', 'write', 'get', 'list', 'create', 'update', 'delete'] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bundles:
 *   - `storage_lint_rules`
 *   - `storage_simulate_rules`
 */
export function createStorageRulesTools(): ToolHandler[] {
  return [
    {
      name: 'storage_lint_rules',
      description:
        'Parse a Cloud Storage Security Rules source and report whether it compiles. Pure-local: no project, no network. Returns the parse error with its message when the source does not parse.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Cloud Storage Security Rules source text to lint.',
          },
        },
        required: ['source'],
      },
      async execute(rawArgs) {
        const { source } = rawArgs as StorageLintArgs;
        const metrics = { sourceSize: source.length };
        try {
          parseStorageRules(source);
        } catch (error) {
          return {
            ok: false,
            summary: `Parse failed: ${errorMessage(error)}`,
            data: { warnings: [], parseError: { message: errorMessage(error) }, metrics },
          };
        }
        return {
          ok: true,
          summary: 'Lint clean',
          data: { warnings: [], metrics },
        };
      },
    },
    {
      name: 'storage_simulate_rules',
      description:
        'Evaluate one request against a Cloud Storage Security Rules source and report whether it is allowed and why. Pure-local: no bucket is contacted. `firestore.get()` and `firestore.exists()` lookups are unsupported here and deny with a reason.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Cloud Storage Security Rules source text to evaluate.',
          },
          request: {
            type: 'object',
            description:
              'The request the rules see: `auth` (null or { uid, token? }), `method` (read, write, get, list, create, update, or delete), `path` (the object path, for example b/bucket/o/uploads/pic.png), and on writes `resource` ({ size, contentType?, metadata? }).',
            properties: {
              auth: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    properties: {
                      uid: { type: 'string' },
                      token: { type: 'object' },
                    },
                    required: ['uid'],
                  },
                ],
              },
              method: { type: 'string', enum: [...STORAGE_METHODS] },
              path: { type: 'string' },
              resource: {
                type: 'object',
                properties: {
                  size: { type: 'number' },
                  contentType: { type: 'string' },
                  metadata: { type: 'object' },
                },
                required: ['size'],
              },
            },
            required: ['auth', 'method', 'path'],
          },
          resource: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                properties: {
                  size: { type: 'number' },
                  contentType: { type: 'string' },
                  metadata: { type: 'object' },
                  name: { type: 'string' },
                  bucket: { type: 'string' },
                  timeCreated: { type: 'string' },
                  updated: { type: 'string' },
                  generation: { type: 'number' },
                  metageneration: { type: 'number' },
                },
                required: ['size'],
              },
            ],
            description:
              'The existing object at the path (`resource.*` in rules), or null when no object exists. Defaults to null.',
          },
          now: {
            type: 'string',
            description: 'ISO-8601 timestamp for `request.time`. Defaults to the current time.',
          },
        },
        required: ['source', 'request'],
      },
      async execute(rawArgs) {
        const args = rawArgs as StorageSimulateArgs;
        let now = new Date();
        if (args.now !== undefined) {
          now = new Date(args.now);
          if (Number.isNaN(now.getTime())) {
            return {
              ok: false,
              summary: '`now` must be an ISO-8601 timestamp.',
              data: { code: 'INVALID_INPUT' },
            };
          }
        }
        try {
          const rules = parseStorageRules(args.source);
          const result = evaluateStorageRules(
            rules,
            { request: args.request, resource: args.resource ?? null },
            now,
          );
          return {
            ok: true,
            summary: `Simulation: ${result.allowed ? 'allow' : 'deny'}`,
            data: result,
          };
        } catch (error) {
          return {
            ok: false,
            summary: `Simulation failed: ${errorMessage(error)}`,
            data: { code: 'EVALUATION_ERROR', message: errorMessage(error) },
          };
        }
      },
    },
  ];
}
