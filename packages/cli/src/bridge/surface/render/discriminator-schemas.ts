/**
 * The parameter schemas of the twelve intent tools, reproduced from the typed
 * service contract they were authored on.
 *
 * They are kept exactly as they are there, JSON-encoded string parameters
 * included, because the point of this variant is to measure that surface as it
 * was designed. The renderer parses those strings back into the objects the
 * canonical operations take, so the shape an agent sees differs while the code
 * that runs does not.
 */
import { z } from 'zod';

import { RESET_SCOPES } from '../methods/sandbox/reset.js';

export const switchAuthIdentitySchema = z.object({
  mode: z
    .enum(['uid', 'admin', 'anonymous', 'app-session'])
    .describe('Authentication mode to activate.'),
  uid: z.string().optional().describe("User ID when mode is 'uid'."),
  tenant: z
    .string()
    .optional()
    .describe(
      "Identity Platform tenant ID (request.auth.token.firebase.tenant) when mode is 'uid'.",
    ),
  claimsJson: z
    .string()
    .optional()
    .describe("JSON-encoded custom claims map (request.auth.token.<claim>) when mode is 'uid'."),
  target: z
    .string()
    .optional()
    .describe('Optional connected session ID to retarget instead of the caller.'),
});

export const manageAuthUsersSchema = z.object({
  action: z
    .enum([
      'create',
      'get',
      'get_by_email',
      'list',
      'update',
      'delete',
      'set_claims',
      'mint_token',
      'import',
    ])
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

export const inspectAuthFlowSchema = z.object({
  action: z
    .enum(['whoami', 'list_sessions', 'take_mail', 'verify_action_code', 'stage_oauth_mock'])
    .describe('Auth flow inspection action.'),
  email: z.string().optional().describe('Filter outbound mail by recipient email (for take_mail).'),
  code: z.string().optional().describe('Out-of-band action code string (for verify_action_code).'),
  providerId: z
    .string()
    .optional()
    .describe("OAuth provider ID e.g. 'google.com' (for stage_oauth_mock)."),
  mockCredentialJson: z
    .string()
    .optional()
    .describe('JSON-encoded mock UserCredential payload (for stage_oauth_mock).'),
});

export const manageAppSessionSchema = z.object({
  action: z
    .enum(['sign_in_password', 'sign_in_anonymous', 'sign_in_custom_token', 'sign_in_credential', 'sign_out'])
    .describe("The app's own sign-in action. None of these change the caller's identity."),
  email: z.string().optional().describe('Email address, for password and credential sign-in.'),
  password: z.string().optional().describe('Password, for password sign-in.'),
  token: z.string().optional().describe('Custom token, for custom-token sign-in.'),
  providerId: z
    .string()
    .optional()
    .describe("Federated provider id e.g. 'google.com', for credential sign-in."),
  idToken: z.string().optional().describe('Provider id token, for credential sign-in.'),
  accessToken: z.string().optional().describe('Provider access token, for credential sign-in.'),
});

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

export const mutateSandboxDataSchema = z.object({
  service: z.enum(['firestore', 'database']).describe('Target data service.'),
  action: z
    .enum(['set', 'add', 'update', 'delete', 'batch', 'transaction', 'push', 'writeIndexes'])
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

export const querySandboxDataSchema = z.object({
  service: z.enum(['firestore', 'database']).describe('Target data service.'),
  path: z.string().describe('Collection path, document path, or database root-relative path.'),
  filters: z
    .array(queryFilterSchema)
    .optional()
    .describe('Where clauses applied to collection or database queries.'),
  orderByField: z.string().optional().describe('Field name to order results by.'),
  orderDirection: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
  limit: z.number().optional().describe('Maximum number of records or child keys to return.'),
  auth: authOverrideSchema.optional().describe('Optional per-call auth override.'),
  // The database lane's own addition: a structural read with no leaf values.
  // Firestore reads carry 'read'; only 'crawl' changes what the call does.
  action: z
    .enum(['read', 'crawl'])
    .describe(
      "Realtime Database only. 'crawl' returns structure (child names, counts), no leaf values.",
    ),
  depth: z
    .number()
    .optional()
    .describe("Realtime Database only, with action 'crawl'. Maximum object depth, 0 to 10, default 10."),
});

export const manageStorageFilesSchema = z.object({
  action: z
    .enum([
      'upload',
      'download',
      'delete',
      'list',
      // Step 7, the storage lane: download URLs, metadata updates, the
      // cross-service posture, and the control plane.
      'download_url',
      'update_metadata',
      'set_cross_service_iam',
      'service_status',
      'provision',
    ])
    .describe('Storage file operation.'),
  bucket: z
    .string()
    .optional()
    .describe('Storage bucket name (defaults to default sandbox bucket).'),
  path: z.string().describe('Object full path within the bucket.'),
  base64Content: z.string().optional().describe("Base64-encoded file payload for 'upload'."),
  sourcePath: z
    .string()
    .optional()
    .describe("Path of a file inside the project directory to upload for 'upload'."),
  contentType: z.string().optional().describe('MIME type of the uploaded file.'),
  customMetadataJson: z
    .string()
    .optional()
    .describe('JSON-encoded flat key-value custom metadata.'),
  cacheControl: z.string().optional().describe("Cache-Control for 'update_metadata'."),
  crossServiceIam: z
    .enum(['granted', 'denied'])
    .optional()
    .describe("Whether storage rules may read Firestore, for 'set_cross_service_iam'."),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true for 'service_status' and 'provision', which reach Google."),
});

export const diagnoseRuleDenialSchema = z.object({
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

const testCaseSchema = z.object({
  expectation: z.enum(['ALLOW', 'DENY']),
  operation: z.enum(['get', 'list', 'create', 'update', 'delete', 'read', 'write', 'validate']),
  path: z.string(),
  uid: z.string().optional(),
  resourceDataJson: z.string().optional(),
});

export const verifySecurityRulesSchema = z.object({
  service: z.enum(['firestore', 'database', 'storage']).describe('Target rules service.'),
  action: z
    .enum(['lint', 'resolve_modules', 'simulate_suite', 'check_conformance', 'set'])
    .describe('Verification action.'),
  source: z
    .string()
    .optional()
    .describe('Rules source code string (defaults to active sandbox rules if omitted).'),
  feature: z.string().optional().describe("Feature identifier when action is 'check_conformance'."),
  testCases: z
    .array(testCaseSchema)
    .optional()
    .describe("Test cases when action is 'simulate_suite'."),
});

export const judgeAuthorizationRiskSchema = z.object({
  action: z
    .enum([
      'replay_session',
      'verify_cases',
      'test_rules_hosted',
      'attach',
      'start',
      'map',
      'define',
      'propose',
      'run',
      'inspect',
      'minimize',
      'verify',
      'export',
    ])
    .describe('Assurance operation.'),
  campaignId: z.string().optional().describe('Identifier of the assurance campaign.'),
  probeId: z.string().optional().describe('Identifier of one probe within the campaign.'),
  observationId: z.string().optional().describe("Known-good observation when action is 'propose'."),
  invariantId: z.string().optional().describe("Invariant a proposed probe is judged against."),
  sessionPath: z
    .string()
    .optional()
    .describe('Recorded session or fixture path, relative to the project directory.'),
  candidateRules: z
    .string()
    .optional()
    .describe('Candidate Firestore security rules source the run evaluates.'),
  service: z
    .enum(['firestore', 'database'])
    .optional()
    .describe("Service whose rules a replay evaluates."),
  recordsJson: z
    .string()
    .optional()
    .describe('JSON-encoded actors, invariants, or mutations, depending on the action.'),
  targetJson: z
    .string()
    .optional()
    .describe("JSON-encoded campaign target when action is 'start'."),
  casesJson: z
    .string()
    .optional()
    .describe("JSON-encoded rules test cases when action is 'test_rules_hosted'."),
  exportPath: z
    .string()
    .optional()
    .describe("Where to write the exported bundle when action is 'export'."),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to reach Firebase's hosted Rules Test API."),
});

export const dryRunExperimentSchema = z.object({
  action: z
    .enum(['fork', 'apply', 'diff', 'promote', 'discard', 'list'])
    .describe('Branch lifecycle operation.'),
  branchId: z.string().optional().describe('Identifier of the experiment branch.'),
  against: z
    .string()
    .optional()
    .describe("Reference a diff compares against: 'live', or a checkpoint name."),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to promote, which overwrites live state (when action is 'promote')."),
  candidateRules: z
    .string()
    .optional()
    .describe('Candidate Firestore/RTDB security rules source to test on the branch.'),
  mutationsJson: z
    .string()
    .optional()
    .describe('JSON-encoded mutations or replay events to apply on the branch.'),
});

export const controlSandboxEnvironmentSchema = z.object({
  action: z
    .enum([
      'reset_all',
      'set_clock',
      'advance_clock',
      'reset_clock',
      'set_network',
      'seed',
      'checkpoint',
      'restore',
      'list_checkpoints',
      'delete_checkpoint',
      'events',
      'export_fixture',
      'seed_fixture',
    ])
    .describe('Environment control action.'),
  scope: z
    .enum(RESET_SCOPES)
    .optional()
    .describe("Service to reset alone (when action is 'reset_all'). Default is all."),
  checkpointName: z
    .string()
    .optional()
    .describe(
      "Checkpoint name (when action is 'checkpoint', 'restore', or 'delete_checkpoint').",
    ),
  fixturePath: z
    .string()
    .optional()
    .describe("Fixture file path, relative to the project (when action is 'export_fixture' or 'seed_fixture')."),
  excludePasswords: z
    .boolean()
    .optional()
    .describe(
      "Leave the seeded passwords out of the fixture (when action is 'export_fixture'). Default false.",
    ),
  since: z.string().optional().describe("Cursor from a prior 'events' call."),
  limit: z.number().optional().describe("Maximum events to return (when action is 'events')."),
  kind: z
    .enum(['all', 'denials', 'writes'])
    .optional()
    .describe("Event filter (when action is 'events')."),
  advanceMs: z
    .number()
    .optional()
    .describe("Milliseconds to advance the clock by (when action is 'advance_clock')."),
  targetTimestampIso: z
    .string()
    .optional()
    .describe("ISO-8601 instant to pin the clock to, frozen there (when action is 'set_clock')."),
  networkState: z
    .enum(['online', 'offline'])
    .optional()
    .describe("Simulated network state (when action is 'set_network')."),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Must be true for the three actions that replace or discard state: 'reset_all', which clears the services in scope, 'restore', which discards every change made since the checkpoint, and 'delete_checkpoint', which discards the only copy of a saved state.",
    ),
  seedSnapshotJson: z
    .string()
    .optional()
    .describe(
      "JSON-encoded seed object (users, firestore, database, storage, firestoreRules, databaseRules, storageRules), all optional (when action is 'seed').",
    ),
});

export const manageFunctionsSchema = z.object({
  action: z
    .enum(['list_triggers', 'fire', 'executions'])
    .describe('Which functions operation to run.'),
  trigger: z
    .string()
    .optional()
    .describe("The trigger's export name, as list_triggers names it (when action is 'fire')."),
  path: z
    .string()
    .optional()
    .describe("Realtime Database path the synthetic event is built at (when action is 'fire')."),
  valueJson: z
    .string()
    .optional()
    .describe("JSON-encoded value the synthetic event carries at path (when action is 'fire')."),
  since: z
    .number()
    .optional()
    .describe("Clock timestamp cursor; only executions at or after it are returned (when action is 'executions')."),
});

const aiScriptEntrySchema = z.object({
  matchSubstring: z.string().optional().describe('Optional prompt substring to match.'),
  responseType: z.enum(['text', 'json', 'error']),
  responsePayload: z.string().describe('Text response, JSON string, or error message.'),
  errorCode: z.number().optional().describe("HTTP status code when responseType is 'error'."),
});

export const configureAiMockSchema = z.object({
  action: z
    .enum(['append_script', 'clear_scripts'])
    .describe('Queue operation on the scripted AI engine.'),
  entries: z
    .array(aiScriptEntrySchema)
    .optional()
    .describe('Scripted response entries pushed to the FIFO match queue.'),
});

// ─── Firestore lane: depth reads (count, aggregate, discovery, indexes) ────

export const inspectFirestoreStructureSchema = z.object({
  action: z
    .enum(['count', 'aggregate', 'discoverPaths', 'findCollectionGroup', 'extractIndexes'])
    .describe('Which Firestore depth read to run.'),
  path: z.string().optional().describe("Collection path for 'count' and 'aggregate'."),
  filtersJson: z
    .string()
    .optional()
    .describe("JSON-encoded where clauses narrowing 'count' or 'aggregate'."),
  specJson: z
    .string()
    .optional()
    .describe("JSON-encoded aggregate spec for 'aggregate': {count?, sum?, average?}."),
  collectionId: z.string().optional().describe("Collection id for 'findCollectionGroup'."),
  depth: z.number().optional().describe("Deepest collection nesting level for 'discoverPaths'."),
  limit: z.number().optional().describe("Maximum document paths for 'discoverPaths'."),
  queriesJson: z
    .string()
    .optional()
    .describe("JSON-encoded queries[] for 'extractIndexes'."),
});

// ─── Messaging lane ─────────────────────────────────────────────────────

export const manageMessagingSchema = z.object({
  action: z
    .enum(['send', 'subscribe', 'unsubscribe', 'list_tokens', 'list_deliveries'])
    .describe('Firebase Cloud Messaging operation.'),
  token: z.string().optional().describe("Single device token, for 'send'."),
  topic: z.string().optional().describe("Topic name, for 'send', 'subscribe', 'unsubscribe'."),
  condition: z.string().optional().describe("Boolean expression over topics, for 'send'."),
  notificationJson: z
    .string()
    .optional()
    .describe("JSON-encoded {title?, body?}, for 'send'."),
  dataJson: z
    .string()
    .optional()
    .describe("JSON-encoded flat string map payload, for 'send'."),
  tokensJson: z
    .string()
    .optional()
    .describe("JSON-encoded array of device tokens, for 'subscribe' and 'unsubscribe'."),
  since: z
    .number()
    .optional()
    .describe("Clock timestamp cursor, for 'list_deliveries'."),
});
