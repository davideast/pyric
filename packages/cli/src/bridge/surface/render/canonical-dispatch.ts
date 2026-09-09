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
import { methodByKey } from '../methods/index.js';
import type { Args } from '../method-types.js';
import type { OperationResult, SurfaceContext } from '../types.js';

/** One canonical operation's method, and the arguments it is called with. */
interface CanonicalRoute {
  /** `<tool>.<method>` of the record that implements this operation. */
  key: string;
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

/** The identity method a canonical mode selects. */
const IDENTITY_METHODS: Readonly<Record<string, string>> = {
  admin: 'auth.actAsAdmin',
  anonymous: 'auth.actAsAnonymous',
  'app-session': 'auth.useAppSession',
  uid: 'auth.impersonate',
};

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
      const call: Args = { path: args.path, contentBase64: args.contentBase64 };
      if (Object.keys(grouped).length > 0) call.metadata = grouped;
      return call;
    },
  },

  // Four records reach this one operation, so the mode picks the record before
  // the table is read; the entry is here so the operation is in the id list.
  switch_auth_identity: { key: 'auth.impersonate' },
  get_auth_user: { key: 'auth.getUser' },
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
    toMethodArgs: forService('firestore', ['operation', 'path', 'uid', 'data', 'rules']),
  },
  simulate_database_rules: {
    key: 'rules.simulate',
    toMethodArgs: forService('database', ['operation', 'path', 'uid', 'data', 'rules']),
  },
  simulate_storage_rules: {
    key: 'rules.simulate',
    toMethodArgs: forService('storage', ['operation', 'path', 'uid', 'rules']),
  },
  diagnose_firestore_denial: { key: 'rules.explainDenial' },
  list_rules_stdlib: { key: 'rules.listStdlib' },
  get_rules_stdlib: { key: 'rules.getStdlib' },

  inspect_sandbox: { key: 'sandbox.inspect' },
  seed_sandbox: { key: 'sandbox.seed' },
  // The canonical reset carries the confirmation in the surface that named it,
  // so the method's own confirmation is already satisfied by the time the call
  // reaches here.
  reset_sandbox: { key: 'sandbox.reset', toMethodArgs: () => ({ confirm: true }) },
};

/** Every canonical operation a surface may name. */
export const CANONICAL_OPERATION_IDS: readonly string[] = Object.keys(ROUTES).sort();

/** Run one canonical operation with the arguments that vocabulary spells. */
export async function runCanonicalOperation(
  operation: string,
  args: Args,
  ctx: SurfaceContext,
): Promise<OperationResult> {
  if (operation === 'switch_auth_identity') {
    const key = IDENTITY_METHODS[String(args.mode)];
    if (key === undefined) throw new Error(`unknown identity mode '${String(args.mode)}'`);
    const identity = methodByKey(key);
    const call: Args = {};
    if (key === 'auth.impersonate') {
      call.uid = args.uid;
      if (args.tenant !== undefined) call.tenantId = args.tenant;
      if (args.claims !== undefined) call.customClaims = args.claims;
    }
    return identity.handler(call, ctx);
  }
  const route = ROUTES[operation];
  if (route === undefined) throw new Error(`unknown operation '${operation}'`);
  const method = methodByKey(route.key);
  return method.handler(route.toMethodArgs?.(args) ?? args, ctx);
}
