/**
 * The fourteen intent tools, and the routes for the auth, app session, data,
 * storage, and rules families.
 *
 * A discriminator value with no canonical counterpart has no route and
 * resolves to no operation. The sandbox-state and branch families have their
 * own files; what a route is, and the readings every route makes of a call's
 * arguments, is `discriminator-route-shapes.ts`. This module assembles the
 * whole set in tool order.
 */
import { APP_SESSION_ROUTES } from './discriminator-app-session-routes.js';
import { ASSURANCE_ROUTES } from './discriminator-assurance-routes.js';
import { BRANCH_ROUTES } from './discriminator-branch-routes.js';
import { SANDBOX_STATE_ROUTES } from './discriminator-sandbox-state-routes.js';
import type { Args, DiscriminatorRoute, DiscriminatorTool } from './discriminator-route-shapes.js';
import {
  assign,
  on,
  onBoth,
  parseJsonArray,
  parseJsonObject,
  parseJsonValue,
  text,
} from './discriminator-route-shapes.js';
import {
  configureAiMockSchema,
  controlSandboxEnvironmentSchema,
  diagnoseRuleDenialSchema,
  dryRunExperimentSchema,
  inspectAuthFlowSchema,
  invokeCloudFunctionSchema,
  judgeAuthorizationRiskSchema,
  manageAppSessionSchema,
  manageAuthUsersSchema,
  manageStorageFilesSchema,
  mutateSandboxDataSchema,
  querySandboxDataSchema,
  switchAuthIdentitySchema,
  verifySecurityRulesSchema,
} from './discriminator-schemas.js';

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
    name: 'manage_app_session',
    description:
      "Sign the application's own session in with an email and password, anonymously, with a custom token, or with a federated credential, or sign it out. The caller's own identity is unchanged.",
    parameters: manageAppSessionSchema,
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
    name: 'judge_authorization_risk',
    description:
      'Replay a captured session against candidate rules, decide its cases locally or on the hosted Rules Test API, and drive an authorization campaign from attach through export.',
    parameters: judgeAuthorizationRiskSchema,
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
      'Control sandbox environment state: reset one or all services, pin or advance or reset the clock, simulate online/offline network connectivity, checkpoint and restore, page the event log, or export and load a fixture.',
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
    // actions, so this is where the discriminator variant expresses "report
    // the held identity" without a new tool.
    tool: 'inspect_auth_flow',
    action: 'whoami',
    selects: on('action', 'whoami'),
    operation: 'get_auth_identity',
    translate: () => ({}),
  },
  {
    tool: 'inspect_auth_flow',
    action: 'list_sessions',
    selects: on('action', 'list_sessions'),
    operation: 'list_auth_sessions',
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
  {
    tool: 'manage_auth_users',
    action: 'get_by_email',
    selects: on('action', 'get_by_email'),
    operation: 'get_auth_user_by_email',
    translate: (args) => ({ email: args.email }),
  },
  {
    tool: 'manage_auth_users',
    action: 'import',
    selects: on('action', 'import'),
    operation: 'import_auth_users',
    translate: (args) => ({ users: parseJsonArray(text(args, 'usersJson')) ?? [] }),
  },
  {
    tool: 'manage_auth_users',
    action: 'mint_token',
    selects: on('action', 'mint_token'),
    operation: 'create_auth_token',
    translate: (args) => {
      const translated: Args = { uid: args.uid };
      assign(translated, 'claims', parseJsonObject(text(args, 'claimsJson')));
      return translated;
    },
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
  // The database lane's own addition: an auto-id write.
  {
    tool: 'mutate_sandbox_data',
    action: 'push',
    selects: onBoth('service', 'database', 'action', 'push'),
    operation: 'push_database_value',
    translate: (args) => {
      const translated: Args = { path: args.path };
      assign(translated, 'value', parseJsonValue(text(args, 'dataJson')));
      return translated;
    },
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
  // The database lane's own addition: a structural read, checked before the
  // generic database query route since it also matches on service alone.
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: (args) => args.service === 'database' && args.action === 'crawl',
    operation: 'crawl_database_structure',
    translate: (args) => {
      const translated: Args = {};
      assign(translated, 'path', args.path);
      assign(translated, 'depth', args.depth);
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

/** Every route, in tool order. */
export const DISCRIMINATOR_ROUTES: readonly DiscriminatorRoute[] = [
  ...AUTH_ROUTES,
  ...APP_SESSION_ROUTES,
  ...DATA_ROUTES,
  ...STORAGE_ROUTES,
  ...RULES_ROUTES,
  ...ASSURANCE_ROUTES,
  ...BRANCH_ROUTES,
  ...SANDBOX_STATE_ROUTES,
];
