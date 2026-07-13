/**
 * Agent-tool factory for the Firebase Storage control plane.
 *
 * `createStorageAdminTools({ scope })` returns the two
 * provisioning/status tools as `ToolHandler[]`, consumable by
 * an `@inbrowser/agent` registry.
 * Uses the same tool-factory shape as `createFirestoreRulesTools`: a
 * `ProjectScope` in, JSON-Schema-typed `ToolHandler`s out.
 */
import type { ToolHandler } from '@inbrowser/agent';
import type { ProjectScope } from '../../project-scope.js';
import { InspectStorageHandler, ProvisionStorageHandler } from './handler.js';
import type { ProvisionStorageInput } from './spec.js';
import type { ProvisionProgress } from './api.js';

export interface StorageAdminToolDeps {
  /** Project identity + token resolver. */
  scope: ProjectScope;
}

/**
 * Bundles:
 *   - `storage_get_status`
 *   - `storage_provision`
 */
export function createStorageAdminTools(deps: StorageAdminToolDeps): ToolHandler[] {
  const { scope } = deps;
  const inspectHandler = new InspectStorageHandler();
  const provisionHandler = new ProvisionStorageHandler();

  return [
    {
      name: 'storage_get_status',
      description:
        'Probe whether Firebase Storage is enabled on the project. Returns the underlying ' +
        'service state (enabled/disabled/unknown), the default GCP resources location, and the ' +
        'list of Firebase-linked Storage buckets. Use this before `storage_provision` ' +
        'to see what work is actually needed.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const result = await inspectHandler.execute(scope);
        return {
          ok: true,
          summary: `Storage service is ${result.serviceState}; ${result.buckets.length} linked bucket(s)`,
          data: result,
        };
      },
    },
    {
      name: 'storage_provision',
      description:
        'Enable Firebase Storage on the project end-to-end: enable the underlying ' +
        '`firebasestorage.googleapis.com` service, set the default GCP resources location (one-time, ' +
        'irreversible), and create + link the default Firebase Storage bucket. Optionally deploys ' +
        'a Storage rules source as the final step. Idempotent — each sub-step probes state before ' +
        'mutating. **Caller identity requirements**: enabling the service requires ' +
        '`roles/serviceusage.serviceUsageAdmin` or `roles/owner`. The default Firebase Admin SDK ' +
        'service account does NOT have this — returns `PERMISSION_DENIED` in that case. Grant the ' +
        'role manually via IAM Console once if you want this tool to work server-side, or call ' +
        'the underlying `provisionStorage(token, projectId)` function directly from a browser ' +
        'context using a `cloud-platform`-scoped user OAuth token.',
      parameters: {
        type: 'object',
        properties: {
          locationId: {
            type: 'string',
            description:
              'Default GCP resources location to use when the project has not been finalized yet. ' +
              'IRREVERSIBLE once set. Common values: "us-central", "nam5", "eur3". Default: "us-central".',
          },
          bucketId: {
            type: 'string',
            description:
              'Override the default Firebase Storage bucket ID. Defaults to "{projectId}.firebasestorage.app".',
          },
          rules: {
            type: 'string',
            description:
              'Storage rules source to deploy after the bucket is linked. Optional; when omitted, ' +
              'whatever rules are currently released (possibly the deny-all default) stay in place.',
          },
          cors: {
            type: 'array',
            description:
              'CORS rules to apply to the bucket. Required for browser-side reads/writes from a ' +
              'non-Firebase origin. Omit to leave existing CORS untouched.',
            items: {
              type: 'object',
              properties: {
                origin: { type: 'array', items: { type: 'string' } },
                method: { type: 'array', items: { type: 'string' } },
                responseHeader: { type: 'array', items: { type: 'string' } },
                maxAgeSeconds: { type: 'number' },
              },
              required: ['origin', 'method'],
            },
          },
        },
      },
      async execute(args, ctx) {
        // The deploy CLI puts a `report` on the context (the status board); the
        // agent runtime does not, so this is a no-op there.
        const onProgress = (ctx as typeof ctx & { report?: ProvisionProgress }).report;
        const result = await provisionHandler.execute(scope, (args ?? {}) as ProvisionStorageInput, onProgress);
        return {
          ok: result.success,
          summary: result.success
            ? `Provisioned Storage bucket ${result.bucketId}`
            : `Storage provisioning failed (${result.error.code}): ${result.error.message}`,
          data: result,
        };
      },
    },
  ];
}
