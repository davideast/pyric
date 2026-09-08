import { z } from 'zod';
import {
  switchAuthIdentity,
  manageAuthUsers,
  inspectAuthFlow,
  mutateSandboxData,
  querySandboxData,
  manageStorageFiles,
  diagnoseRuleDenial,
  verifySecurityRules,
  dryRunExperiment,
  controlSandboxEnvironment,
  invokeCloudFunction,
  configureAiMock,
  readSandboxResource,
  getActiveIdentityLens,
  type AuthOverrideInput,
} from 'pyric/actuation';
import type { ActuationContext, TypedResourceContract, TypedToolContract } from './types.js';
import { assertFlatSchema, zodToJsonSchema } from './schema-depth.js';

/**
 * Helper to resolve effective AuthOverrideInput from explicit tool args,
 * caller identity lens (`ctx.caller`), or sandbox active identity lens.
 */
function resolveEffectiveAuth(
  explicitAuth: AuthOverrideInput | undefined,
  ctx: ActuationContext
): AuthOverrideInput | undefined {
  if (explicitAuth) {
    return explicitAuth;
  }
  if (ctx.caller) {
    if (ctx.caller.mode === 'admin') return { mode: 'admin' };
    if (ctx.caller.mode === 'anon') return { mode: 'anonymous' };
    if (ctx.caller.mode === 'as') {
      return {
        mode: 'uid',
        uid: ctx.caller.uid,
        tenant: ctx.caller.tenant,
        claims: ctx.caller.token,
      };
    }
  }
  const activeLens = getActiveIdentityLens(ctx.sandbox);
  if (activeLens.mode === 'admin' || activeLens.mode === 'app-session') return { mode: 'admin' };
  if (activeLens.mode === 'anonymous') return { mode: 'anonymous' };
  if (activeLens.mode === 'uid' && activeLens.uid) {
    return {
      mode: 'uid',
      uid: activeLens.uid,
      tenant: activeLens.tenant ?? undefined,
      claims: activeLens.claims,
    };
  }
  return { mode: 'admin' };
}

// ── 1. switch_auth_identity ──────────────────────────────────────────────────
const switchAuthIdentitySchema = z.object({
  mode: z
    .enum(['uid', 'admin', 'anonymous', 'app-session'])
    .describe('Authentication mode to activate.'),
  uid: z.string().optional().describe("User ID when mode is 'uid'."),
  tenant: z
    .string()
    .optional()
    .describe("Identity Platform tenant ID (request.auth.token.firebase.tenant) when mode is 'uid'."),
  claimsJson: z
    .string()
    .optional()
    .describe("JSON-encoded custom claims map (request.auth.token.<claim>) when mode is 'uid'."),
  target: z
    .string()
    .optional()
    .describe('Optional connected session ID to retarget instead of the caller.'),
});

// ── 2. manage_auth_users ─────────────────────────────────────────────────────
const manageAuthUsersSchema = z.object({
  action: z
    .enum(['create', 'get', 'list', 'update', 'delete', 'set_claims', 'mint_token', 'import'])
    .describe('Auth user administration action.'),
  uid: z
    .string()
    .optional()
    .describe('Target user ID (required for get, update, delete, set_claims, mint_token).'),
  email: z.string().optional().describe('User email address.'),
  password: z.string().optional().describe('User password (never returned in output).'),
  displayName: z.string().optional().describe('User display name.'),
  phoneNumber: z.string().optional().describe('User phone number in E.164 format.'),
  disabled: z.boolean().optional().describe('Whether the user account is disabled.'),
  emailVerified: z.boolean().optional().describe('Whether the user email is verified.'),
  claimsJson: z.string().optional().describe('JSON-encoded custom claims object.'),
  usersJson: z
    .string()
    .optional()
    .describe("JSON-encoded array of user records for 'import' action."),
});

// ── 3. inspect_auth_flow ─────────────────────────────────────────────────────
const inspectAuthFlowSchema = z.object({
  action: z
    .enum(['whoami', 'list_sessions', 'take_mail', 'verify_action_code', 'stage_oauth_mock'])
    .describe('Auth flow inspection action.'),
  email: z
    .string()
    .optional()
    .describe('Filter outbound mail by recipient email (for take_mail).'),
  code: z
    .string()
    .optional()
    .describe('Out-of-band action code string (for verify_action_code).'),
  providerId: z
    .string()
    .optional()
    .describe("OAuth provider ID e.g. 'google.com' (for stage_oauth_mock)."),
  mockCredentialJson: z
    .string()
    .optional()
    .describe('JSON-encoded mock UserCredential payload (for stage_oauth_mock).'),
});

// ── 4. mutate_sandbox_data ───────────────────────────────────────────────────
const authOverrideSchema = z.object({
  mode: z.enum(['admin', 'uid', 'anonymous']),
  uid: z.string().optional(),
  tenant: z.string().optional(),
  claimsJson: z.string().optional(),
});

const batchOpSchema = z.object({
  op: z.enum(['set', 'update', 'delete']),
  path: z.string(),
  dataJson: z.string().optional(),
});

const mutateSandboxDataSchema = z.object({
  service: z.enum(['firestore', 'database']).describe('Target data service.'),
  action: z
    .enum(['set', 'add', 'update', 'delete', 'batch', 'transaction'])
    .describe('Mutation operation.'),
  path: z.string().optional().describe('Document, collection, or database tree path.'),
  dataJson: z
    .string()
    .optional()
    .describe('JSON-encoded document object or RTDB value payload.'),
  batchOps: z
    .array(batchOpSchema)
    .optional()
    .describe("List of atomic operations when action is 'batch' or 'transaction'."),
  auth: authOverrideSchema
    .optional()
    .describe('Optional per-call auth override. Omit for ambient identity, or specify mode/uid.'),
});

// ── 5. query_sandbox_data ────────────────────────────────────────────────────
const queryFilterSchema = z.object({
  field: z.string(),
  op: z.enum([
    '<',
    '<=',
    '==',
    '!=',
    '>=',
    '>',
    'in',
    'not-in',
    'array-contains',
    'array-contains-any',
  ]),
  valueJson: z.string().describe('JSON-encoded comparison value.'),
});

const querySandboxDataSchema = z.object({
  service: z.enum(['firestore', 'database']).describe('Target data service.'),
  path: z
    .string()
    .describe('Collection path, document path, or database root-relative path.'),
  filters: z
    .array(queryFilterSchema)
    .optional()
    .describe('Where clauses applied to collection or database queries.'),
  orderByField: z.string().optional().describe('Field name to order results by.'),
  orderDirection: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of records or child keys to return.'),
  auth: authOverrideSchema.optional().describe('Optional per-call auth override.'),
});

// ── 6. manage_storage_files ──────────────────────────────────────────────────
const manageStorageFilesSchema = z.object({
  action: z
    .enum(['upload', 'download', 'delete', 'list'])
    .describe('Storage file operation.'),
  bucket: z
    .string()
    .optional()
    .describe('Storage bucket name (defaults to default sandbox bucket).'),
  path: z.string().describe('Object full path within the bucket.'),
  base64Content: z
    .string()
    .optional()
    .describe("Base64-encoded file payload for 'upload'."),
  contentType: z.string().optional().describe('MIME type of the uploaded file.'),
  customMetadataJson: z
    .string()
    .optional()
    .describe('JSON-encoded flat key-value custom metadata.'),
});

// ── 7. diagnose_rule_denial ──────────────────────────────────────────────────
const diagnoseRuleDenialSchema = z.object({
  service: z
    .enum(['firestore', 'database', 'storage'])
    .describe('Service whose rules to diagnose.'),
  operation: z
    .enum(['get', 'list', 'create', 'update', 'delete', 'read', 'write', 'validate'])
    .describe('Simulated operation.'),
  path: z.string().describe('Target resource path.'),
  resourceDataJson: z
    .string()
    .optional()
    .describe('JSON-encoded incoming request.resource.data or RTDB newData.'),
  auth: z
    .object({
      uid: z.string().optional(),
      tenant: z.string().optional(),
      claimsJson: z.string().optional(),
    })
    .optional()
    .describe('Authenticated identity context for rule evaluation.'),
});

// ── 8. verify_security_rules ─────────────────────────────────────────────────
const testCaseSchema = z.object({
  expectation: z.enum(['ALLOW', 'DENY']),
  operation: z.enum([
    'get',
    'list',
    'create',
    'update',
    'delete',
    'read',
    'write',
    'validate',
  ]),
  path: z.string(),
  uid: z.string().optional(),
  resourceDataJson: z.string().optional(),
});

const verifySecurityRulesSchema = z.object({
  service: z
    .enum(['firestore', 'database', 'storage'])
    .describe('Target rules service.'),
  action: z
    .enum(['lint', 'resolve_modules', 'simulate_suite', 'check_conformance'])
    .describe('Verification action.'),
  source: z
    .string()
    .optional()
    .describe('Rules source code string (defaults to active sandbox rules if omitted).'),
  feature: z
    .string()
    .optional()
    .describe("Feature identifier when action is 'check_conformance'."),
  testCases: z
    .array(testCaseSchema)
    .optional()
    .describe("Test cases when action is 'simulate_suite'."),
});

// ── 9. dry_run_experiment ────────────────────────────────────────────────────
const dryRunExperimentSchema = z.object({
  action: z
    .enum(['fork', 'apply', 'diff', 'promote', 'discard'])
    .describe('Branch lifecycle operation.'),
  branchId: z.string().optional().describe('Identifier of the experiment branch.'),
  candidateRules: z
    .string()
    .optional()
    .describe('Candidate Firestore/RTDB security rules source to test on the branch.'),
  mutationsJson: z
    .string()
    .optional()
    .describe('JSON-encoded mutations or replay events to apply on the branch.'),
});

// ── 10. control_sandbox_environment ──────────────────────────────────────────
const controlSandboxEnvironmentSchema = z.object({
  action: z
    .enum(['reset_all', 'advance_clock', 'set_network', 'seed'])
    .describe('Environment control action.'),
  advanceMs: z
    .number()
    .optional()
    .describe("Milliseconds to advance mock clock (when action is 'advance_clock')."),
  targetTimestampIso: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp to set mock clock to (when action is 'advance_clock')."),
  networkState: z
    .enum(['online', 'offline'])
    .optional()
    .describe("Simulated network state (when action is 'set_network')."),
  seedSnapshotJson: z
    .string()
    .optional()
    .describe("JSON-encoded SandboxSnapshot to clobber-restore (when action is 'seed')."),
});

// ── 11. invoke_cloud_function ────────────────────────────────────────────────
const invokeCloudFunctionSchema = z.object({
  functionName: z.string().describe('Name of the Cloud Function to invoke.'),
  triggerType: z
    .enum(['callable', 'firestore_write', 'auth_create', 'storage_object'])
    .describe('Invocation trigger type.'),
  dataJson: z.string().optional().describe('JSON-encoded request payload or event data.'),
  auth: z
    .object({
      uid: z.string().optional(),
      tenant: z.string().optional(),
      claimsJson: z.string().optional(),
    })
    .optional()
    .describe('Optional auth context for the function invocation.'),
});

// ── 12. configure_ai_mock ────────────────────────────────────────────────────
const aiScriptEntrySchema = z.object({
  matchSubstring: z.string().optional().describe('Optional prompt substring to match.'),
  responseType: z.enum(['text', 'json', 'error']),
  responsePayload: z.string().describe('Text response, JSON string, or error message.'),
  errorCode: z
    .number()
    .optional()
    .describe("HTTP status code when responseType is 'error'."),
});

const configureAiMockSchema = z.object({
  action: z
    .enum(['append_script', 'clear_scripts'])
    .describe('Queue operation on the scripted AI engine.'),
  entries: z
    .array(aiScriptEntrySchema)
    .optional()
    .describe('Scripted response entries pushed to the FIFO match queue.'),
});

function defineToolContract<TName extends string, TParams extends z.ZodObject<any>, TResult>(
  contract: {
    name: TName;
    description: string;
    transport: 'forwarded' | 'in-process';
    parameters: TParams;
    execute: (args: z.infer<TParams>, ctx: ActuationContext) => Promise<TResult> | TResult;
  }
): TypedToolContract<TName, TParams, TResult> {
  assertFlatSchema(contract.parameters, 2);
  return {
    ...contract,
    jsonSchema: zodToJsonSchema(contract.parameters),
  };
}

export const MCP_TOOL_CONTRACTS: readonly TypedToolContract[] = [
  defineToolContract({
    name: 'switch_auth_identity',
    description:
      'Switch active authentication identity lens (impersonate user with tenant/claims, admin bypass, anonymous, or reset to app session).',
    transport: 'forwarded',
    parameters: switchAuthIdentitySchema,
    execute: (args, ctx) => switchAuthIdentity(ctx.sandbox, args),
  }),
  defineToolContract({
    name: 'manage_auth_users',
    description:
      'Create, read, update, delete, import users, set custom claims, or mint custom tokens in the sandbox Auth pool.',
    transport: 'forwarded',
    parameters: manageAuthUsersSchema,
    execute: (args, ctx) => manageAuthUsers(ctx.sandbox, args),
  }),
  defineToolContract({
    name: 'inspect_auth_flow',
    description:
      'Inspect active auth sessions, retrieve outbound verification/reset emails (takeMail), inspect action codes, or stage OAuth mock results.',
    transport: 'forwarded',
    parameters: inspectAuthFlowSchema,
    execute: (args, ctx) => inspectAuthFlow(ctx.sandbox, args),
  }),
  defineToolContract({
    name: 'mutate_sandbox_data',
    description:
      'Perform atomic writes (set, add, update, delete, batch, transaction) across Firestore or Realtime Database.',
    transport: 'forwarded',
    parameters: mutateSandboxDataSchema,
    execute: (args, ctx) =>
      mutateSandboxData(ctx.sandbox, {
        ...args,
        auth: resolveEffectiveAuth(args.auth, ctx),
      }),
  }),
  defineToolContract({
    name: 'query_sandbox_data',
    description:
      'Query Firestore documents/collections or Realtime Database paths with filter constraints, sorting, and limits.',
    transport: 'forwarded',
    parameters: querySandboxDataSchema,
    execute: (args, ctx) =>
      querySandboxData(ctx.sandbox, {
        ...args,
        auth: resolveEffectiveAuth(args.auth, ctx),
      }),
  }),
  defineToolContract({
    name: 'manage_storage_files',
    description: 'Upload (base64), download (data: URI), delete, or list files in sandbox Cloud Storage.',
    transport: 'forwarded',
    parameters: manageStorageFilesSchema,
    execute: async (args, ctx) => {
      const res = await manageStorageFiles(ctx.sandbox, {
        ...args,
        auth: resolveEffectiveAuth(undefined, ctx),
      });
      if (res.dataUri && res.dataUri.includes(';charset=utf-8;base64,')) {
        res.dataUri = res.dataUri.replace(';charset=utf-8;base64,', ';base64,');
      }
      return res;
    },
  }),
  defineToolContract({
    name: 'diagnose_rule_denial',
    description:
      'Trace Security Rules AST expression evaluation step-by-step to diagnose permission denials.',
    transport: 'forwarded',
    parameters: diagnoseRuleDenialSchema,
    execute: (args, ctx) =>
      diagnoseRuleDenial(ctx.sandbox, {
        ...args,
        auth: resolveEffectiveAuth(args.auth, ctx),
      }),
  }),
  defineToolContract({
    name: 'verify_security_rules',
    description:
      "Lint security rules, resolve '2+modules' imports, run assertion test suites, or check Pyric conformance.",
    transport: 'forwarded',
    parameters: verifySecurityRulesSchema,
    execute: (args, ctx) => verifySecurityRules(ctx.sandbox, args),
  }),
  defineToolContract({
    name: 'dry_run_experiment',
    description:
      'Fork an isolated sandbox branch, apply candidate rules/data, diff state/regressions against recorded traffic, and promote or discard.',
    transport: 'forwarded',
    parameters: dryRunExperimentSchema,
    execute: (args, ctx) => dryRunExperiment(ctx.sandbox, args),
  }),
  defineToolContract({
    name: 'control_sandbox_environment',
    description:
      'Control sandbox environment state: reset all services, advance mock clock, or simulate online/offline network connectivity.',
    transport: 'forwarded',
    parameters: controlSandboxEnvironmentSchema,
    execute: (args, ctx) => controlSandboxEnvironment(ctx.sandbox, args),
  }),
  defineToolContract({
    name: 'invoke_cloud_function',
    description:
      'Invoke a callable Cloud Function or simulate an event trigger with specified payload and auth context.',
    transport: 'forwarded',
    parameters: invokeCloudFunctionSchema,
    execute: (args, ctx) =>
      invokeCloudFunction(ctx.sandbox, {
        ...args,
        auth: resolveEffectiveAuth(args.auth, ctx),
      }),
  }),
  defineToolContract({
    name: 'configure_ai_mock',
    description:
      'Configure deterministic scripted responses or simulated HTTP errors for Vertex AI / Gemini calls in the sandbox.',
    transport: 'forwarded',
    parameters: configureAiMockSchema,
    execute: (args, ctx) => configureAiMock(ctx.sandbox, args),
  }),
] as const;

const KNOWN_STDLIB_MODULES = [
  'index',
  'math',
  'string',
  'list',
  'auth',
  'latlng',
  'timestamp',
  'duration',
  'hashing',
  'bytes',
  'map',
  'set',
] as const;

async function readResourceWithStdlibValidation(
  uri: URL,
  ctx: ActuationContext
): Promise<unknown> {
  const href = uri.href;
  if (href.startsWith('pyric://stdlib/rules/')) {
    const modKey = href.slice('pyric://stdlib/rules/'.length) || 'index';
    if (!KNOWN_STDLIB_MODULES.includes(modKey as (typeof KNOWN_STDLIB_MODULES)[number])) {
      return {
        error: `Unknown stdlib module: ${modKey}`,
        suggestion: 'math',
        validKeys: KNOWN_STDLIB_MODULES.filter((k) => k !== 'index'),
      };
    }
  }
  return readSandboxResource(ctx.sandbox, href);
}

export const MCP_RESOURCE_CONTRACTS: readonly TypedResourceContract[] = [
  {
    uriTemplate: 'pyric://sandbox/status',
    name: 'sandbox_status',
    description: 'Real-time sandbox service status, active identity lens, mock clock, and document/object counts.',
    mimeType: 'application/json',
    read: (uri, _params, ctx) => readResourceWithStdlibValidation(uri, ctx),
  },
  {
    uriTemplate: 'pyric://sandbox/events',
    name: 'sandbox_events',
    description: 'Chronological stream of recorded sandbox requests, mutations, and rule evaluations.',
    mimeType: 'application/json',
    read: (uri, _params, ctx) => readResourceWithStdlibValidation(uri, ctx),
  },
  {
    uriTemplate: 'pyric://firestore/docs/{path}',
    name: 'firestore_docs',
    description: 'Read a Firestore document or list documents in a collection by slash-separated path.',
    mimeType: 'application/json',
    read: (uri, _params, ctx) => readResourceWithStdlibValidation(uri, ctx),
  },
  {
    uriTemplate: 'pyric://database/tree/{path}',
    name: 'database_tree',
    description: 'Inspect Realtime Database JSON tree node and child keys at the specified path.',
    mimeType: 'application/json',
    read: (uri, _params, ctx) => readResourceWithStdlibValidation(uri, ctx),
  },
  {
    uriTemplate: 'pyric://auth/users',
    name: 'auth_users',
    description: 'List all user records registered in the sandbox Authentication user pool.',
    mimeType: 'application/json',
    read: (uri, _params, ctx) => readResourceWithStdlibValidation(uri, ctx),
  },
  {
    uriTemplate: 'pyric://storage/objects/{bucket}',
    name: 'storage_objects',
    description: 'List all stored files and metadata in the specified Cloud Storage bucket.',
    mimeType: 'application/json',
    read: (uri, _params, ctx) => readResourceWithStdlibValidation(uri, ctx),
  },
  {
    uriTemplate: 'pyric://stdlib/rules/{module}',
    name: 'stdlib_rules',
    description: 'Inspect Security Rules standard library documentation by module name (or index).',
    mimeType: 'application/json',
    read: (uri, _params, ctx) => readResourceWithStdlibValidation(uri, ctx),
  },
] as const;
