/**
 * Tool factories for `pyric-tools/deploy` per F1.
 *
 * Each factory wraps the namespaced primitives (firestore, hosting,
 * functions, storage) as `ToolHandler[]` consumable by
 * `@inbrowser/agent`'s registry. Every handler takes the scope from
 * factory closure (F2) and `signal` from ctx (F8).
 *
 * Together these factories close the Deployment Agent's critical
 * path (per the proposal's "Deployment Agent critical path"
 * section: Slices 1, 2, 3, 4 + 9).
 *
 * Pre-mortem M8 note: every handler checks `ctx.signal.aborted`
 * before starting work — that's the best the factory layer can do
 * without plumbing AbortSignal through every namespace primitive's
 * fetch call. Wave B (`firebase-admin` → REST rewrite) is the
 * natural place to thread signals end-to-end; until then, the
 * pre-call abort check at least prevents the deploy from STARTING
 * if the agent already cancelled.
 */

import type { ToolHandler } from '@inbrowser/agent';
import { firestore, hosting, functions, rtdb } from './namespaces.js';
import type { ProjectScope } from './scope.js';
import type { RtdbIR, RtdbRulesJson } from 'pyric/rules/internal/rtdb';
import { loadRtdbRulesDocument } from '../rtdb/load-rules-document.js';
import type {
  IndexesConfig,
  IndexesConfigEntry,
  DeployIndexesOutcome,
  GetIndexStatusOutcome,
  IndexOperation,
} from './firestore/indexes.js';
import type { EnsureRuleOutcome } from './firestore/rules.js';
import type { ProvisionDatabaseOutcome } from './firestore/databases.js';
import type { HostingJsonConfig, DeployHostingResult } from './hosting/spec.js';
import type { EnsureSiteResult } from './hosting/sites.js';
import type { FunctionDeployConfig, DeployFunctionsResult } from './functions/spec.js';

// ─── Typed data shape map for tool returns (pre-mortem H5) ───────────
//
// Each tool's `execute` returns `{ ok, summary, data: D }`. The
// concrete `D` for each tool is named here so consumers can narrow
// without spelunking through the namespace primitives.
//
// To consume:
//
//   const handler = createFirestoreDeployTools({ scope })
//     .find(h => h.name === 'firestore_deploy_indexes')!;
//   const out = await handler.execute(args, ctx);
//   const data = out.data as DeployToolData['firestore_deploy_indexes'];
//
// A future revision may parameterize each handler as
// `ToolHandler<Args, Data>` directly — for now the map keeps the
// factory return type usable as a single `ToolHandler[]` for the
// registry while still surfacing the data contract.

export interface DeployToolData {
  firestore_get_rules: { source: string | null };
  firestore_deploy_rules: undefined;
  firestore_ensure_rules: EnsureRuleOutcome;
  firestore_provision_database: ProvisionDatabaseOutcome;
  firestore_deploy_indexes: DeployIndexesOutcome;
  firestore_create_index: IndexOperation;
  firestore_get_index_status: GetIndexStatusOutcome;
  hosting_deploy: DeployHostingResult;
  hosting_ensure_site: EnsureSiteResult;
  functions_deploy: DeployFunctionsResult;
  rtdb_get_rules: { ir: RtdbIR };
  rtdb_deploy_rules: undefined;
  rtdb_generate_rules: { rulesJson: RtdbRulesJson };
}

export interface ProjectScopedDeps {
  scope: ProjectScope;
}

// ─── Realtime Database deploy tools ─────────────────────────────────

export function createRtdbDeployTools(deps: ProjectScopedDeps): ToolHandler[] {
  const { scope } = deps;
  return [
    {
      name: 'rtdb_get_rules',
      description: 'Fetch the deployed Realtime Database rules for this project or an explicit database URL.',
      parameters: {
        type: 'object',
        properties: {
          databaseUrl: { type: 'string' },
        },
      },
      async execute(args) {
        const { databaseUrl } = args as { databaseUrl?: string };
        try {
          const ir = await rtdb.rules.fetch(scope, { databaseUrl });
          return { ok: true, summary: `Fetched RTDB rules from ${ir.databaseUrl}`, data: { ir } };
        } catch (e) {
          return { ok: false, summary: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'rtdb_deploy_rules',
      description: 'Deploy Realtime Database security rules JSON. Pass databaseUrl or let the tool discover the single default RTDB instance.',
      parameters: {
        type: 'object',
        properties: {
          rulesJson: { type: 'object' },
          databaseUrl: { type: 'string' },
        },
        required: ['rulesJson'],
      },
      async execute(args) {
        const { rulesJson, databaseUrl } = args as { rulesJson: unknown; databaseUrl?: string };
        try {
          await rtdb.rules.deploy(scope, { rulesJson, databaseUrl });
          return { ok: true, summary: 'Deployed Realtime Database rules' };
        } catch (e) {
          return { ok: false, summary: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'rtdb_generate_rules',
      description:
        'Compile a local RTDB constraints module (a file calling defineRtdbRules(...) from pyric/rules) into the static database.rules.json shape, without deploying it. Lets the caller inspect/diff/commit the rules before deploy.',
      parameters: {
        type: 'object',
        properties: {
          configPath: {
            type: 'string',
            description: "Path to the constraints module, relative to cwd. Defaults to 'database.rules.ts'.",
          },
          cwd: { type: 'string', description: 'Working directory to resolve configPath against. Defaults to process.cwd().' },
        },
      },
      async execute(args) {
        const { configPath, cwd } = args as { configPath?: string; cwd?: string };
        const loaded = await loadRtdbRulesDocument(configPath ?? 'database.rules.ts', { cwd });
        if (!loaded.ok) {
          return { ok: false, summary: loaded.message };
        }
        const rulesJson = loaded.document.toJSON();
        return {
          ok: true,
          summary: 'Compiled RTDB constraints to database.rules.json',
          data: { rulesJson },
        };
      },
    },
  ];
}

// ─── Firestore deploy tools ──────────────────────────────────────────

export function createFirestoreDeployTools(deps: ProjectScopedDeps): ToolHandler[] {
  const { scope } = deps;
  return [
    {
      name: 'firestore_get_rules',
      description: 'Fetch the deployed Firestore rules source for this project. Returns null when no release exists yet.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const source = await firestore.rules.fetch(scope);
          return { ok: true, summary: source === null ? 'No deployed ruleset' : 'Fetched ruleset', data: { source } };
        } catch (e) {
          return { ok: false, summary: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'firestore_deploy_rules',
      description: 'Deploy a Firestore rules source. Creates a new ruleset and binds the cloud.firestore release to it.',
      parameters: {
        type: 'object',
        properties: { source: { type: 'string' } },
        required: ['source'],
      },
      async execute(args) {
        const { source } = args as { source: string };
        try {
          await firestore.rules.deploy(scope, source);
          return { ok: true, summary: 'Deployed Firestore rules' };
        } catch (e) {
          return { ok: false, summary: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'firestore_ensure_rules',
      description: 'Idempotently ensure a rule snippet is deployed. Merges into existing rules or writes fresh.',
      parameters: {
        type: 'object',
        properties: {
          marker: { type: 'string' },
          snippet: { type: 'string' },
          freshTemplate: { type: 'string' },
        },
        required: ['marker', 'snippet', 'freshTemplate'],
      },
      async execute(args) {
        const config = args as { marker: string; snippet: string; freshTemplate: string };
        const result = await firestore.rules.ensure(scope, config);
        return {
          ok: result.ok,
          summary: result.ok ? `Rule ensure: ${result.status}` : `Rule ensure failed: ${result.code}`,
          data: result,
        };
      },
    },
    {
      name: 'firestore_provision_database',
      description: 'Idempotently provision the (default) Firestore database. Skips if it already exists.',
      parameters: {
        type: 'object',
        properties: {
          databaseId: { type: 'string' },
          locationId: { type: 'string' },
          type: { type: 'string', enum: ['FIRESTORE_NATIVE', 'DATASTORE_MODE'] },
        },
      },
      async execute(args) {
        const options = args as { databaseId?: string; locationId?: string; type?: 'FIRESTORE_NATIVE' | 'DATASTORE_MODE' };
        const result = await firestore.databases.provision(scope, options);
        return {
          ok: result.ok,
          summary: result.ok ? `Database: ${result.status}` : `Provision failed: ${result.code}`,
          data: result,
        };
      },
    },
    {
      name: 'firestore_deploy_indexes',
      description: 'Batch-deploy a firestore.indexes.json config. Returns per-index status (started / already-exists / failed).',
      parameters: {
        type: 'object',
        properties: {
          config: { type: 'object' },
          databaseId: { type: 'string' },
        },
        required: ['config'],
      },
      async execute(args) {
        const { config, databaseId } = args as { config: IndexesConfig; databaseId?: string };
        const result = await firestore.indexes.deployAll(scope, config, databaseId ? { databaseId } : undefined);
        return {
          ok: result.ok,
          summary: result.ok
            ? `Indexes: ${result.operationsStarted.length} started, ${result.alreadyExists} already exist`
            : `Deploy failed: ${result.code}`,
          data: result,
        };
      },
    },
    {
      name: 'firestore_create_index',
      description: 'Create a single composite index. Returns the long-running-operation handle.',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'object' },
          databaseId: { type: 'string' },
        },
        required: ['entry'],
      },
      async execute(args) {
        const { entry, databaseId } = args as { entry: IndexesConfigEntry; databaseId?: string };
        try {
          const op = await firestore.indexes.create(scope, entry, databaseId ? { databaseId } : undefined);
          return { ok: true, summary: `Index create started: ${op.name}`, data: op };
        } catch (e) {
          return { ok: false, summary: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'firestore_get_index_status',
      description: 'Poll a long-running index build operation. Returns CREATING / READY / NEEDS_REPAIR / NOT_FOUND.',
      parameters: {
        type: 'object',
        properties: { operationName: { type: 'string' } },
        required: ['operationName'],
      },
      async execute(args) {
        const { operationName } = args as { operationName: string };
        const result = await firestore.indexes.getStatus(scope, operationName);
        return {
          ok: result.ok,
          summary: result.ok ? `Index status: ${result.state}` : `Status fetch failed: ${result.code}`,
          data: result,
        };
      },
    },
  ];
}

// ─── Hosting deploy tools ────────────────────────────────────────────

export function createHostingDeployTools(deps: ProjectScopedDeps): ToolHandler[] {
  const { scope } = deps;
  return [
    {
      name: 'hosting_deploy',
      description: 'Deploy files to a Firebase Hosting site. Supply EITHER `localDir` (Node walks the directory from disk) OR `files` (pre-walked, suitable for browser hosts). Server-side content-hash dedup uploads only changed files.',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string' },
          localDir: { type: 'string', description: 'Node-only.' },
          files: {
            type: 'array',
            description: 'Pre-walked file list — for browser hosts (pre-mortem M7).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              "firebase.json `ignore` globs applied while walking localDir. Omit for the firebase-tools defaults ('firebase.json', '**/.*', '**/node_modules/**'). Not applied to pre-walked `files`.",
          },
          config: {
            type: 'object',
            description:
              'firebase.json hosting block (rewrites / redirects / headers / cleanUrls / trailingSlash / appAssociation / i18n). Translated to the Hosting REST ServingConfig; invalid entries fail before anything uploads; non-serving keys come back as configWarnings.',
          },
          channelId: {
            type: 'string',
            description: "Preview-channel id. Omit (or 'live') for a live release.",
          },
          channelTtl: {
            type: 'string',
            description: "Channel TTL as a protobuf Duration (e.g. '604800s') — applies on channel creation only.",
          },
        },
        required: ['siteId'],
      },
      async execute(args) {
        const a = args as {
          siteId: string;
          localDir?: string;
          files?: never;
          ignore?: string[];
          config?: HostingJsonConfig;
          channelId?: string;
          channelTtl?: string;
        };
        const result = await hosting.deployFiles(scope, {
          siteId: a.siteId,
          ...(a.localDir ? { localDir: a.localDir } : {}),
          ...(a.files ? { files: a.files } : {}),
          ...(a.ignore ? { ignore: a.ignore } : {}),
          ...(a.config ? { config: a.config } : {}),
          ...(a.channelId ? { channelId: a.channelId } : {}),
          ...(a.channelTtl ? { channelTtl: a.channelTtl } : {}),
        });
        return {
          ok: result.success,
          summary: result.success
            ? result.data.channelUrl
              ? `Hosting deploy ok — ${result.data.uploadedCount}/${result.data.fileCount} files uploaded; preview at ${result.data.channelUrl}${result.data.channelExpireTime ? ` (expires ${result.data.channelExpireTime})` : ''}`
              : `Hosting deploy ok — ${result.data.uploadedCount}/${result.data.fileCount} files uploaded; live at ${result.data.hostingUrl}`
            : `Hosting deploy failed: ${result.error.code}`,
          data: result,
        };
      },
    },
    {
      name: 'hosting_ensure_site',
      description: 'Create-or-get a Hosting site. Treats 409 (already exists) as success.',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string' },
          appId: { type: 'string' },
        },
        required: ['siteId'],
      },
      async execute(args) {
        const { siteId, appId } = args as { siteId: string; appId?: string };
        const result = await hosting.sites.ensure(scope, { siteId, ...(appId ? { appId } : {}) });
        return {
          ok: result.kind === 'created' || result.kind === 'existed',
          summary: result.kind === 'created'
            ? `Site created: ${siteId}`
            : result.kind === 'existed'
              ? `Site already existed: ${siteId}`
              : `Ensure failed: ${result.kind}`,
          data: result,
        };
      },
    },
  ];
}

// ─── Functions deploy tools ──────────────────────────────────────────

export function createFunctionsDeployTools(deps: ProjectScopedDeps): ToolHandler[] {
  const { scope } = deps;
  return [
    {
      name: 'functions_deploy',
      description: 'Bundle + deploy Cloud Functions Gen 2 from a local directory. Node-only (uses bundler).',
      parameters: {
        type: 'object',
        properties: {
          localDir: { type: 'string' },
          functions: { type: 'array' },
        },
        required: ['localDir', 'functions'],
      },
      async execute(args) {
        const { localDir, functions: fns } = args as {
          localDir: string;
          functions: FunctionDeployConfig[];
        };
        const result = await functions.deployLocal(scope, { localDir, functions: fns });
        return {
          ok: result.success,
          summary: result.success
            ? `Functions deployed: ${result.data.deployed.length}`
            : `Functions deploy failed: ${result.error.code}`,
          data: result,
        };
      },
    },
  ];
}
