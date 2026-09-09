/**
 * The twelve intent tools and the route each of their discriminator values
 * takes to a canonical operation.
 *
 * A route is the whole mapping for one value of a tool's discriminator: which
 * operation runs, what the audit log stamps as the action, and how the tool's
 * arguments (JSON-encoded strings included) translate into the operation's
 * object parameters. A discriminator value with no canonical counterpart has
 * no route and resolves to no operation.
 */
import type { z } from 'zod';
import {
  configureAiMockSchema,
  controlSandboxEnvironmentSchema,
  diagnoseRuleDenialSchema,
  dryRunExperimentSchema,
  inspectAuthFlowSchema,
  invokeCloudFunctionSchema,
  manageAuthUsersSchema,
  manageStorageFilesSchema,
  mutateSandboxDataSchema,
  querySandboxDataSchema,
  switchAuthIdentitySchema,
  verifySecurityRulesSchema,
} from './discriminator-schemas.js';

type Args = Record<string, unknown>;

/** One of the twelve tools, as the client sees it. */
export interface DiscriminatorTool {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
}

/** One discriminator value's route to a canonical operation. */
export interface DiscriminatorRoute {
  tool: string;
  /** The action the audit event records, or null for a tool with no discriminator. */
  action: string | null;
  /** Whether these arguments take this route. */
  selects(args: Args): boolean;
  operation: string;
  translate(args: Args): Args;
}

function text(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parse a JSON-encoded object parameter back into the object it stands for. */
export function parseJsonObject(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  const parsed = JSON.parse(source) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Parse a JSON-encoded value parameter back into the value it stands for. */
export function parseJsonValue(source: string | undefined): unknown {
  if (source === undefined) return undefined;
  return JSON.parse(source) as unknown;
}

function assign(target: Args, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/** Parse a JSON-encoded array parameter back into the array it stands for. */
export function parseJsonArray(source: string | undefined): unknown[] | undefined {
  if (source === undefined) return undefined;
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
  return parsed;
}

/** A route selected by one field's value. */
function on(field: string, value: string): (args: Args) => boolean {
  return (args) => args[field] === value;
}

/** A route selected by two fields' values. */
function onBoth(
  first: string,
  firstValue: string,
  second: string,
  secondValue: string,
): (args: Args) => boolean {
  return (args) => args[first] === firstValue && args[second] === secondValue;
}

export const DISCRIMINATOR_TOOLS: readonly DiscriminatorTool[] = [
  {
    name: 'switch_auth_identity',
    description:
      'Switch active authentication identity lens (impersonate user with tenant/claims, admin bypass, anonymous, or reset to app session).',
    parameters: switchAuthIdentitySchema,
  },
  {
    name: 'manage_auth_users',
    description:
      'Create, read, update, delete, import users, set custom claims, or mint custom tokens in the sandbox Auth pool.',
    parameters: manageAuthUsersSchema,
  },
  {
    name: 'inspect_auth_flow',
    description:
      'Inspect active auth sessions, retrieve outbound verification/reset emails (takeMail), inspect action codes, or stage OAuth mock results.',
    parameters: inspectAuthFlowSchema,
  },
  {
    name: 'mutate_sandbox_data',
    description:
      'Perform atomic writes (set, add, update, delete, batch, transaction) across Firestore or Realtime Database.',
    parameters: mutateSandboxDataSchema,
  },
  {
    name: 'query_sandbox_data',
    description:
      'Query Firestore documents/collections or Realtime Database paths with filter constraints, sorting, and limits.',
    parameters: querySandboxDataSchema,
  },
  {
    name: 'manage_storage_files',
    description:
      'Upload (base64), download (data: URI), delete, or list files in sandbox Cloud Storage.',
    parameters: manageStorageFilesSchema,
  },
  {
    name: 'diagnose_rule_denial',
    description:
      'Trace Security Rules AST expression evaluation step-by-step to diagnose permission denials.',
    parameters: diagnoseRuleDenialSchema,
  },
  {
    name: 'verify_security_rules',
    description:
      "Lint security rules, resolve '2+modules' imports, run assertion test suites, or check Pyric conformance.",
    parameters: verifySecurityRulesSchema,
  },
  {
    name: 'dry_run_experiment',
    description:
      'Fork an isolated sandbox branch, apply candidate rules/data, diff state/regressions against recorded traffic, and promote or discard.',
    parameters: dryRunExperimentSchema,
  },
  {
    name: 'control_sandbox_environment',
    description:
      'Control sandbox environment state: reset one or all services, advance mock clock, simulate online/offline network connectivity, checkpoint and restore, page the event log, or export and load a fixture.',
    parameters: controlSandboxEnvironmentSchema,
  },
  {
    name: 'invoke_cloud_function',
    description:
      'Invoke a callable Cloud Function or simulate an event trigger with specified payload and auth context.',
    parameters: invokeCloudFunctionSchema,
  },
  {
    name: 'configure_ai_mock',
    description:
      'Configure deterministic scripted responses or simulated HTTP errors for Vertex AI / Gemini calls in the sandbox.',
    parameters: configureAiMockSchema,
  },
];

/** The identity fields of the tools that carry a per-call auth override. */
function overrideIdentity(args: Args): Args | undefined {
  const override = args.auth;
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return undefined;
  return override as Args;
}

/** The uid a rules tool evaluates as, read from its auth override. */
function overrideUid(args: Args): string | undefined {
  const override = overrideIdentity(args);
  if (override === undefined) return undefined;
  return typeof override.uid === 'string' ? override.uid : undefined;
}

const AUTH_ROUTES: DiscriminatorRoute[] = [
  {
    // The `inspect_auth_flow` tool's schema already names `whoami` among its
    // actions; no other action of that tool has a route yet, so this is the
    // one place the discriminator variant can express "report the held
    // identity" without a new tool.
    tool: 'inspect_auth_flow',
    action: 'whoami',
    selects: on('action', 'whoami'),
    operation: 'get_auth_identity',
    translate: () => ({}),
  },
  {
    tool: 'switch_auth_identity',
    action: null,
    selects: () => true,
    operation: 'switch_auth_identity',
    translate: (args) => {
      const translated: Args = { mode: args.mode };
      assign(translated, 'uid', text(args, 'uid'));
      assign(translated, 'tenant', text(args, 'tenant'));
      assign(translated, 'claims', parseJsonObject(text(args, 'claimsJson')));
      return translated;
    },
  },
  {
    tool: 'manage_auth_users',
    action: 'create',
    selects: on('action', 'create'),
    operation: 'create_auth_user',
    translate: (args) => {
      const translated: Args = {};
      assign(translated, 'uid', text(args, 'uid'));
      assign(translated, 'email', text(args, 'email'));
      assign(translated, 'password', text(args, 'password'));
      assign(translated, 'displayName', text(args, 'displayName'));
      assign(translated, 'claims', parseJsonObject(text(args, 'claimsJson')));
      return translated;
    },
  },
  {
    tool: 'manage_auth_users',
    action: 'get',
    selects: on('action', 'get'),
    operation: 'get_auth_user',
    translate: (args) => ({ uid: args.uid }),
  },
  // The user pool is read through the `pyric://auth/users` resource on this
  // variant, so the tool's list action has no route of its own.
  {
    tool: 'manage_auth_users',
    action: 'update',
    selects: on('action', 'update'),
    operation: 'update_auth_user',
    translate: (args) => {
      const translated: Args = { uid: args.uid };
      assign(translated, 'email', text(args, 'email'));
      assign(translated, 'password', text(args, 'password'));
      assign(translated, 'displayName', text(args, 'displayName'));
      assign(translated, 'disabled', args.disabled);
      assign(translated, 'emailVerified', args.emailVerified);
      return translated;
    },
  },
  {
    tool: 'manage_auth_users',
    action: 'delete',
    selects: on('action', 'delete'),
    operation: 'delete_auth_user',
    translate: (args) => ({ uid: args.uid }),
  },
  {
    tool: 'manage_auth_users',
    action: 'set_claims',
    selects: on('action', 'set_claims'),
    operation: 'set_auth_claims',
    translate: (args) => ({
      uid: args.uid,
      claims: parseJsonObject(text(args, 'claimsJson')) ?? {},
    }),
  },
];

interface BatchOperation {
  op: string;
  path: string;
  dataJson?: string;
}

const DATA_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'mutate_sandbox_data',
    action: 'set',
    selects: onBoth('service', 'firestore', 'action', 'set'),
    operation: 'write_firestore_document',
    translate: (args) => ({
      path: args.path,
      data: parseJsonObject(text(args, 'dataJson')) ?? {},
    }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'add',
    selects: onBoth('service', 'firestore', 'action', 'add'),
    operation: 'add_firestore_document',
    translate: (args) => ({
      path: args.path,
      data: parseJsonObject(text(args, 'dataJson')) ?? {},
    }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'update',
    selects: onBoth('service', 'firestore', 'action', 'update'),
    operation: 'update_firestore_document',
    translate: (args) => ({
      path: args.path,
      data: parseJsonObject(text(args, 'dataJson')) ?? {},
    }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'delete',
    selects: onBoth('service', 'firestore', 'action', 'delete'),
    operation: 'delete_firestore_document',
    translate: (args) => ({ path: args.path }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'batch',
    selects: onBoth('service', 'firestore', 'action', 'batch'),
    operation: 'batch_firestore_writes',
    translate: (args) => {
      const authored = (args.batchOps ?? []) as BatchOperation[];
      const writes = authored.map((entry) => {
        const write: Args = { op: entry.op, path: entry.path };
        assign(write, 'data', parseJsonObject(entry.dataJson));
        return write;
      });
      return { writes };
    },
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'set',
    selects: onBoth('service', 'database', 'action', 'set'),
    operation: 'write_database_value',
    translate: (args) => ({ path: args.path, value: parseJsonValue(text(args, 'dataJson')) }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'update',
    selects: onBoth('service', 'database', 'action', 'update'),
    operation: 'update_database_value',
    translate: (args) => ({
      path: args.path,
      value: parseJsonObject(text(args, 'dataJson')) ?? {},
    }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'delete',
    selects: onBoth('service', 'database', 'action', 'delete'),
    operation: 'delete_database_value',
    translate: (args) => ({ path: args.path }),
  },
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: (args) => args.service === 'firestore' && hasFilters(args),
    operation: 'query_firestore_documents',
    translate: (args) => {
      const translated: Args = { path: args.path, filters: translateFilters(args) };
      assign(translated, 'orderBy', text(args, 'orderByField'));
      assign(translated, 'direction', text(args, 'orderDirection'));
      assign(translated, 'limit', args.limit);
      return translated;
    },
  },
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: (args) => args.service === 'firestore' && !hasFilters(args),
    operation: 'list_firestore_documents',
    translate: (args) => {
      const translated: Args = { path: args.path };
      assign(translated, 'limit', args.limit);
      return translated;
    },
  },
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: on('service', 'database'),
    operation: 'query_database_values',
    translate: (args) => {
      const translated: Args = { path: args.path };
      assign(translated, 'orderByChild', text(args, 'orderByField'));
      assign(translated, 'limitToFirst', args.limit);
      const equality = translateFilters(args).find((filter) => filter.op === '==');
      if (equality !== undefined) assign(translated, 'equalTo', equality.value);
      return translated;
    },
  },
];

interface QueryFilter {
  field: string;
  op: string;
  valueJson: string;
}

function hasFilters(args: Args): boolean {
  return Array.isArray(args.filters) && args.filters.length > 0;
}

function translateFilters(args: Args): Array<{ field: string; op: string; value: unknown }> {
  const authored = (args.filters ?? []) as QueryFilter[];
  return authored.map((filter) => ({
    field: filter.field,
    op: filter.op,
    value: parseJsonValue(filter.valueJson),
  }));
}

const STORAGE_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'manage_storage_files',
    action: 'upload',
    selects: on('action', 'upload'),
    operation: 'upload_storage_file',
    translate: (args) => {
      const translated: Args = { path: args.path, contentBase64: args.base64Content ?? '' };
      assign(translated, 'contentType', text(args, 'contentType'));
      assign(translated, 'metadata', parseJsonObject(text(args, 'customMetadataJson')));
      return translated;
    },
  },
  {
    tool: 'manage_storage_files',
    action: 'download',
    selects: on('action', 'download'),
    operation: 'download_storage_file',
    translate: (args) => ({ path: args.path }),
  },
  {
    tool: 'manage_storage_files',
    action: 'delete',
    selects: on('action', 'delete'),
    operation: 'delete_storage_file',
    translate: (args) => ({ path: args.path }),
  },
  {
    // The tool's list action takes a required object path, which the canonical
    // set expresses as that object's metadata. Bucket-wide listing is the
    // `pyric://storage/objects/{bucket}` resource.
    tool: 'manage_storage_files',
    action: 'list',
    selects: on('action', 'list'),
    operation: 'get_storage_metadata',
    translate: (args) => ({ path: args.path }),
  },
];

const RULES_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'diagnose_rule_denial',
    action: null,
    selects: on('service', 'firestore'),
    operation: 'diagnose_firestore_denial',
    translate: (args) => {
      const translated: Args = { operation: args.operation, path: args.path };
      assign(translated, 'uid', overrideUid(args));
      assign(translated, 'data', parseJsonObject(text(args, 'resourceDataJson')));
      return translated;
    },
  },
  ...(['firestore', 'database', 'storage'] as const).map((service) => ({
    tool: 'verify_security_rules',
    action: 'lint',
    selects: onBoth('service', service, 'action', 'lint'),
    operation: `lint_${service}_rules`,
    translate: (args: Args) => {
      const translated: Args = {};
      assign(translated, 'rules', text(args, 'source'));
      return translated;
    },
  })),
  ...(['firestore', 'database', 'storage'] as const).map((service) => ({
    tool: 'verify_security_rules',
    action: 'simulate_suite',
    selects: onBoth('service', service, 'action', 'simulate_suite'),
    operation: `simulate_${service}_rules`,
    translate: (args: Args) => translateFirstTestCase(args),
  })),
  ...(['firestore', 'database', 'storage'] as const).map((service) => ({
    tool: 'verify_security_rules',
    action: 'set',
    selects: onBoth('service', service, 'action', 'set'),
    operation: `set_${service}_rules`,
    translate: (args: Args) => ({ rules: text(args, 'source') ?? '' }),
  })),
];

interface RulesTestCase {
  operation: string;
  path: string;
  uid?: string;
  resourceDataJson?: string;
}

/** The suite's first case, which is the one the canonical simulate operations evaluate. */
function translateFirstTestCase(args: Args): Args {
  const cases = (args.testCases ?? []) as RulesTestCase[];
  const first = cases[0];
  if (first === undefined) throw new Error('simulate_suite requires at least one test case');
  const translated: Args = { operation: first.operation, path: first.path };
  assign(translated, 'uid', first.uid);
  assign(translated, 'data', parseJsonObject(first.resourceDataJson));
  assign(translated, 'rules', text(args, 'source'));
  return translated;
}

const ENVIRONMENT_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'control_sandbox_environment',
    action: 'reset_all',
    selects: on('action', 'reset_all'),
    operation: 'reset_sandbox',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'scope', args.scope);
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'seed',
    selects: on('action', 'seed'),
    operation: 'seed_sandbox',
    translate: (args) => parseJsonObject(text(args, 'seedSnapshotJson')) ?? {},
  },
  // Step 3A: sandbox state management (checkpoints, events, fixtures).
  {
    tool: 'control_sandbox_environment',
    action: 'checkpoint',
    selects: on('action', 'checkpoint'),
    operation: 'checkpoint_sandbox',
    translate: (args) => ({ name: args.checkpointName }),
  },
  {
    tool: 'control_sandbox_environment',
    action: 'restore',
    selects: on('action', 'restore'),
    operation: 'restore_sandbox',
    translate: (args) => {
      const call: Args = { name: args.checkpointName };
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'list_checkpoints',
    selects: on('action', 'list_checkpoints'),
    operation: 'list_sandbox_checkpoints',
    translate: () => ({}),
  },
  {
    tool: 'control_sandbox_environment',
    action: 'events',
    selects: on('action', 'events'),
    operation: 'list_sandbox_events',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'since', args.since);
      assign(call, 'limit', args.limit);
      assign(call, 'kind', args.kind);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'export_fixture',
    selects: on('action', 'export_fixture'),
    operation: 'export_sandbox_fixture',
    translate: (args) => ({ path: args.fixturePath }),
  },
  {
    tool: 'control_sandbox_environment',
    action: 'seed_fixture',
    selects: on('action', 'seed_fixture'),
    operation: 'seed_sandbox_fixture',
    translate: (args) => ({ path: args.fixturePath }),
  },
];

// Step 3B: the persisted branches, behind the `dry_run_experiment` tool whose
// discriminator already spelled this lifecycle.
const BRANCH_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'dry_run_experiment',
    action: 'fork',
    selects: on('action', 'fork'),
    operation: 'fork_sandbox_branch',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      assign(call, 'candidateRules', args.candidateRules);
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'apply',
    selects: on('action', 'apply'),
    operation: 'apply_sandbox_events',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      assign(call, 'events', parseJsonArray(text(args, 'mutationsJson')));
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'diff',
    selects: on('action', 'diff'),
    operation: 'diff_sandbox_branch',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      assign(call, 'against', args.against);
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'promote',
    selects: on('action', 'promote'),
    operation: 'promote_sandbox_branch',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'discard',
    selects: on('action', 'discard'),
    operation: 'discard_sandbox_branch',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'list',
    selects: on('action', 'list'),
    operation: 'list_sandbox_branches',
    translate: () => ({}),
  },
];

/** Every route, in tool order. */
export const DISCRIMINATOR_ROUTES: readonly DiscriminatorRoute[] = [
  ...AUTH_ROUTES,
  ...DATA_ROUTES,
  ...STORAGE_ROUTES,
  ...RULES_ROUTES,
  ...BRANCH_ROUTES,
  ...ENVIRONMENT_ROUTES,
];
