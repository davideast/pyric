/**
 * How a canonical operation reaches the method record that implements it.
 *
 * The `discriminator` surface is measured against the canonical operation
 * vocabulary: its routes name an operation and hand over that operation's own
 * argument names. The implementations moved onto the method records, which
 * carry the SDK's argument names instead, so this module is the one adapter
 * between the two vocabularies. Most operations map straight across; the
 * entries below are the ones where a canonical name and an SDK name differ,
 * and they are the whole difference between the two surfaces.
 */
import { callMethod } from '../method-call.js';
import { methodByKey } from '../methods/registry.js';
import type { Args } from '../method-types.js';
import type { OperationResult, SurfaceContext } from '../types.js';

/** One canonical operation's method, and the arguments it is called with. */
interface CanonicalRoute {
  /**
   * `<tool>.<method>` of the record that implements this operation, or how the
   * arguments choose one when several records reach the same operation.
   */
  key: string | ((args: Args) => string);
  /** The record's arguments, from the canonical ones. Absent means unchanged. */
  toMethodArgs?(args: Args): Args;
}

/** Copy the named arguments that are present. */
function pick(args: Args, names: readonly string[]): Args {
  const copied: Args = {};
  for (const name of names) {
    if (args[name] !== undefined) copied[name] = args[name];
  }
  return copied;
}

/** The constraint list a canonical collection read describes. */
function constraintsFrom(args: Args): Args[] {
  const constraints: Args[] = [];
  for (const filter of (args.filters as Args[] | undefined) ?? []) {
    constraints.push({ type: 'where', field: filter.field, op: filter.op, value: filter.value });
  }
  if (args.orderBy !== undefined) {
    const order: Args = { type: 'orderBy', field: args.orderBy };
    if (args.direction !== undefined) order.direction = args.direction;
    constraints.push(order);
  }
  if (args.limit !== undefined) constraints.push({ type: 'limit', value: args.limit });
  return constraints;
}

/** A collection read, as `getDocs` spells it. */
function collectionRead(args: Args): Args {
  const constraints = constraintsFrom(args);
  if (constraints.length === 0) return { path: args.path };
  return { path: args.path, constraints };
}

/** A rules call for one service, as the `rules` methods spell it. */
function forService(service: string, names: readonly string[]) {
  return (args: Args): Args => ({ service, ...pick(args, names) });
}

/**
 * The identity switch: four records reach one canonical operation, so the mode
 * names the record, and only the uid mode carries arguments to it.
 */
const IDENTITY_METHODS: Readonly<Record<string, string>> = {
  admin: 'auth.actAsAdmin',
  anonymous: 'auth.actAsAnonymous',
  'app-session': 'auth.useAppSession',
  uid: 'auth.impersonate',
};

function identityKey(args: Args): string {
  const key = IDENTITY_METHODS[String(args.mode)];
  if (key === undefined) throw new Error(`unknown identity mode '${String(args.mode)}'`);
  return key;
}

function identityArgs(args: Args): Args {
  if (args.mode !== 'uid') return {};
  const call: Args = { uid: args.uid };
  if (args.tenant !== undefined) call.tenantId = args.tenant;
  if (args.claims !== undefined) call.customClaims = args.claims;
  return call;
}

const ROUTES: Readonly<Record<string, CanonicalRoute>> = {
  get_firestore_document: { key: 'firestore.getDoc' },
  list_firestore_documents: { key: 'firestore.getDocs', toMethodArgs: collectionRead },
  query_firestore_documents: { key: 'firestore.getDocs', toMethodArgs: collectionRead },
  add_firestore_document: { key: 'firestore.addDoc' },
  update_firestore_document: { key: 'firestore.updateDoc' },
  delete_firestore_document: { key: 'firestore.deleteDoc' },
  write_firestore_document: {
    key: 'firestore.setDoc',
    toMethodArgs: (args) => {
      const call: Args = { path: args.path, data: args.data };
      if (args.merge === true) call.options = { merge: true };
      return call;
    },
  },
  batch_firestore_writes: {
    key: 'firestore.writeBatch',
    toMethodArgs: (args) => ({
      writes: (args.writes as Args[]).map((write) => {
        const entry: Args = { type: write.op, path: write.path };
        if (write.data !== undefined) entry.data = write.data;
        return entry;
      }),
    }),
  },

  get_database_value: { key: 'database.get' },
  write_database_value: { key: 'database.set' },
  delete_database_value: { key: 'database.remove' },
  query_database_values: { key: 'database.query' },
  update_database_value: {
    key: 'database.update',
    toMethodArgs: (args) => ({ path: args.path, values: args.value }),
  },
  // The database lane's own additions: an auto-id write and a structural read.
  push_database_value: { key: 'database.push' },
  crawl_database_structure: { key: 'database.crawl' },

  download_storage_file: { key: 'storage.getBytes' },
  list_storage_files: { key: 'storage.listAll' },
  get_storage_metadata: { key: 'storage.getMetadata' },
  delete_storage_file: { key: 'storage.deleteObject' },
  upload_storage_file: {
    key: 'storage.uploadBytes',
    toMethodArgs: (args) => {
      const grouped: Args = {};
      if (args.contentType !== undefined) grouped.contentType = args.contentType;
      if (args.metadata !== undefined) grouped.customMetadata = args.metadata;
      const call: Args = { path: args.path };
      if (args.contentBase64 !== undefined) call.contentBase64 = args.contentBase64;
      if (args.sourcePath !== undefined) call.sourcePath = args.sourcePath;
      if (Object.keys(grouped).length > 0) call.metadata = grouped;
      return call;
    },
  },

  // Storage depth: download URLs, metadata updates, the cross-service posture,
  // and the control plane behind the production gate.
  get_storage_download_url: { key: 'storage.getDownloadURL' },
  update_storage_metadata: { key: 'storage.updateMetadata' },
  set_storage_cross_service_iam: { key: 'storage.setCrossServiceIam' },
  get_storage_service_status: {
    key: 'storage.status',
    toMethodArgs: (args) => pick(args, ['confirm']),
  },
  provision_storage_bucket: {
    key: 'storage.provision',
    toMethodArgs: (args) => pick(args, ['bucket', 'confirm']),
  },

  switch_auth_identity: { key: identityKey, toMethodArgs: identityArgs },
  get_auth_user: { key: 'auth.getUser' },
  get_auth_user_by_email: { key: 'auth.getUserByEmail' },
  import_auth_users: { key: 'auth.importUsers' },
  create_auth_token: {
    key: 'auth.createCustomToken',
    toMethodArgs: (args) => {
      const call: Args = { uid: args.uid };
      if (args.claims !== undefined) call.developerClaims = args.claims;
      return call;
    },
  },
  signin_auth_password: { key: 'auth.signInWithEmailAndPassword' },
  signin_auth_anonymous: { key: 'auth.signInAnonymously' },
  signin_auth_token: { key: 'auth.signInWithCustomToken' },
  signin_auth_credential: { key: 'auth.signInWithCredential' },
  signout_auth_session: { key: 'auth.signOut' },
  list_auth_sessions: { key: 'auth.sessions' },
  update_auth_user: { key: 'auth.updateUser' },
  delete_auth_user: { key: 'auth.deleteUser' },
  get_auth_identity: { key: 'auth.whoami' },
  list_auth_users: {
    key: 'auth.listUsers',
    toMethodArgs: (args) => (args.limit === undefined ? {} : { maxResults: args.limit }),
  },
  set_auth_claims: {
    key: 'auth.setCustomUserClaims',
    toMethodArgs: (args) => ({ uid: args.uid, customClaims: args.claims }),
  },
  create_auth_user: {
    key: 'auth.createUser',
    toMethodArgs: (args) => {
      const call = pick(args, ['uid', 'email', 'password', 'displayName']);
      if (args.claims !== undefined) call.customClaims = args.claims;
      if (args.tenant !== undefined) call.tenantId = args.tenant;
      return call;
    },
  },

  lint_firestore_rules: { key: 'rules.lint', toMethodArgs: forService('firestore', ['rules']) },
  lint_database_rules: { key: 'rules.lint', toMethodArgs: forService('database', ['rules']) },
  lint_storage_rules: { key: 'rules.lint', toMethodArgs: forService('storage', ['rules']) },
  set_firestore_rules: { key: 'rules.set', toMethodArgs: forService('firestore', ['rules']) },
  set_database_rules: { key: 'rules.set', toMethodArgs: forService('database', ['rules']) },
  set_storage_rules: { key: 'rules.set', toMethodArgs: forService('storage', ['rules']) },
  simulate_firestore_rules: {
    key: 'rules.simulate',
    toMethodArgs: forService('firestore', ['operation', 'path', 'uid', 'data', 'rules', 'requestTime']),
  },
  simulate_database_rules: {
    key: 'rules.simulate',
    toMethodArgs: forService('database', ['operation', 'path', 'uid', 'data', 'rules', 'requestTime']),
  },
  simulate_storage_rules: {
    key: 'rules.simulate',
    toMethodArgs: forService('storage', ['operation', 'path', 'uid', 'rules', 'requestTime']),
  },
  diagnose_firestore_denial: { key: 'rules.explainDenial' },
  list_rules_stdlib: { key: 'rules.listStdlib' },
  get_rules_stdlib: { key: 'rules.getStdlib' },

  inspect_sandbox: { key: 'sandbox.inspect' },
  seed_sandbox: { key: 'sandbox.seed' },
  // The confirmation the destructive gate reads is the caller's own, so it is
  // carried across rather than supplied here.
  reset_sandbox: {
    key: 'sandbox.reset',
    toMethodArgs: (args) => pick(args, ['scope', 'confirm']),
  },

  // Checkpoints, the operation log, and fixtures.
  checkpoint_sandbox: { key: 'sandbox.checkpoint' },
  restore_sandbox: { key: 'sandbox.restore', toMethodArgs: (args) => pick(args, ['name', 'confirm']) },
  list_sandbox_checkpoints: { key: 'sandbox.listCheckpoints' },
  delete_sandbox_checkpoint: {
    key: 'sandbox.deleteCheckpoint',
    toMethodArgs: (args) => pick(args, ['name', 'confirm']),
  },
  list_sandbox_events: {
    key: 'sandbox.events',
    toMethodArgs: (args) => pick(args, ['since', 'limit', 'kind']),
  },
  export_sandbox_fixture: {
    key: 'sandbox.exportFixture',
    toMethodArgs: (args) => pick(args, ['path', 'excludePasswords']),
  },
  seed_sandbox_fixture: { key: 'sandbox.seedFromFixture' },

  // Judging rules before they ship.
  replay_assurance_session: {
    key: 'assurance.replaySession',
    toMethodArgs: (args) => pick(args, ['sessionPath', 'candidateRules', 'service']),
  },
  verify_assurance_cases: {
    key: 'assurance.verifyCases',
    toMethodArgs: (args) => pick(args, ['fixture', 'candidateRules', 'service']),
  },
  check_assurance_feature: { key: 'assurance.canIUse' },
  attach_assurance_target: { key: 'assurance.attach' },
  start_assurance_campaign: { key: 'assurance.start' },
  map_assurance_campaign: { key: 'assurance.map' },
  define_assurance_invariants: { key: 'assurance.define' },
  propose_assurance_probes: { key: 'assurance.propose' },
  run_assurance_probes: { key: 'assurance.run' },
  inspect_assurance_probe: { key: 'assurance.inspect' },
  minimize_assurance_probe: { key: 'assurance.minimize' },
  verify_assurance_rules: { key: 'assurance.verify' },
  export_assurance_campaign: { key: 'assurance.export' },
  test_assurance_rules_hosted: { key: 'assurance.testRulesHosted' },

  // The sandbox clock.
  set_clock: { key: 'sandbox.setClock' },
  advance_clock: { key: 'sandbox.advanceClock' },
  reset_clock: { key: 'sandbox.resetClock' },

  // The persisted branches.
  fork_sandbox_branch: { key: 'sandbox.fork' },
  apply_sandbox_events: { key: 'sandbox.apply' },
  diff_sandbox_branch: { key: 'sandbox.diff' },
  promote_sandbox_branch: { key: 'sandbox.promote' },
  discard_sandbox_branch: { key: 'sandbox.discard' },
  list_sandbox_branches: { key: 'sandbox.listBranches' },
};

/** The record a route names, or the one its arguments choose among. */
function keyOf(route: CanonicalRoute, args: Args): string {
  if (typeof route.key === 'string') return route.key;
  return route.key(args);
}

/** Every canonical operation a surface may name. */
export const CANONICAL_OPERATION_IDS: readonly string[] = Object.keys(ROUTES).sort();

/**
 * Run one canonical operation with the arguments that vocabulary spells. The
 * call goes through `callMethod`, so this surface enforces the same argument
 * rules, destructive confirmation, and production gate as every other one.
 */
export async function runCanonicalOperation(
  operation: string,
  args: Args,
  ctx: SurfaceContext,
  allowProduction = false,
): Promise<OperationResult> {
  const route = ROUTES[operation];
  if (route === undefined) throw new Error(`unknown operation '${operation}'`);
  const method = methodByKey(keyOf(route, args));
  return callMethod(method, route.toMethodArgs?.(args) ?? args, ctx, allowProduction);
}
