/**
 * `firebase-admin` names `pyric-admin` deliberately leaves absent, with the
 * reason. `admin-surface.test.ts` fails on any other absent name, and on a
 * row here whose name is present or no longer upstream.
 *
 * Prefer a not-implemented stub (`defineDeferredMembers` from
 * `pyric/app/internal`) over a row here: a stub fails at the call site with a
 * message naming the method, an absent name reads as `undefined`. A row is
 * for names a stub cannot stand in for, such as properties and members no
 * caller reaches through the sandbox.
 *
 * `owner` is the upstream class or namespace the member belongs to, as
 * `admin-surface.test.ts` names it, or `(exports)` for an entry's exports.
 */
export interface AllowlistGroup {
  readonly entry: string;
  readonly owner: string;
  readonly members: readonly string[];
  readonly reason: string;
}

const EVENT_EMITTER = [
  'addListener',
  'emit',
  'eventNames',
  'getMaxListeners',
  'listenerCount',
  'listeners',
  'off',
  'on',
  'once',
  'prependListener',
  'prependOnceListener',
  'rawListeners',
  'removeAllListeners',
  'removeListener',
  'setMaxListeners',
];

const CLASS_EXPORT =
  'class exported for typing and instanceof checks; sandbox handles are not instances of it, so no constructor is exported';
const ERROR_CLASS =
  'error class; sandbox errors carry the upstream code and message but are not instances of it, so it is not exported';

export const ALLOWLIST: readonly AllowlistGroup[] = [
  // --- firebase-admin (root namespace) -----------------------------------
  {
    entry: '.',
    owner: '(exports)',
    members: ['apps'],
    reason: 'a static module export cannot be the live list upstream `apps` is (the default export and CJS module.exports carry an `apps` getter, and getApps() lists apps)',
  },
  {
    entry: '.',
    owner: 'admin.firestore',
    members: [
      'AggregateQuery',
      'AggregateQuerySnapshot',
      'BulkWriter',
      'BundleBuilder',
      'CollectionGroup',
      'CollectionReference',
      'DocumentReference',
      'DocumentSnapshot',
      'Firestore',
      'Query',
      'QueryDocumentSnapshot',
      'QueryPartition',
      'QuerySnapshot',
      'Transaction',
      'WriteBatch',
      'WriteResult',
    ],
    reason: CLASS_EXPORT,
  },
  {
    entry: '.',
    owner: 'admin.firestore',
    members: ['v1', 'v1beta1'],
    reason: 'generated Firestore RPC clients for direct API calls; the sandbox has no RPC endpoint',
  },

  // --- firebase-admin/app ------------------------------------------------
  { entry: 'app', owner: '(exports)', members: ['AppErrorCodes', 'FirebaseAppError'], reason: ERROR_CLASS },
  {
    entry: 'app',
    owner: '(exports)',
    members: ['SDK_VERSION'],
    reason: 'version string; the sandbox does not claim a firebase-admin version',
  },

  // --- firebase-admin/auth -----------------------------------------------
  {
    entry: 'auth',
    owner: '(exports)',
    members: [
      'MultiFactorInfo',
      'MultiFactorSettings',
      'PhoneMultiFactorInfo',
      'ProjectConfig',
      'ProjectConfigManager',
      'Tenant',
      'TenantAwareAuth',
      'TenantManager',
    ],
    reason: CLASS_EXPORT,
  },
  {
    entry: 'auth',
    owner: 'UserRecord',
    members: ['multiFactor', 'passwordHash', 'passwordSalt'],
    reason: 'user record fields the sandbox auth store does not model (MFA enrollment, password hashes)',
  },

  // --- firebase-admin/firestore ------------------------------------------
  {
    entry: 'firestore',
    owner: '(exports)',
    members: [
      'AggregateQuery',
      'AggregateQuerySnapshot',
      'BulkWriter',
      'BundleBuilder',
      'CollectionGroup',
      'CollectionReference',
      'DocumentReference',
      'DocumentSnapshot',
      'Firestore',
      'Query',
      'QueryDocumentSnapshot',
      'QueryPartition',
      'QuerySnapshot',
      'Transaction',
      'WriteBatch',
    ],
    reason: CLASS_EXPORT,
  },
  {
    entry: 'firestore',
    owner: '(exports)',
    members: ['v1'],
    reason: 'generated Firestore RPC clients for direct API calls; the sandbox has no RPC endpoint',
  },
  {
    entry: 'firestore',
    owner: 'Firestore',
    members: ['databaseId'],
    reason: 'property; the sandbox handle does not carry a database id',
  },

  // --- firebase-admin/storage --------------------------------------------
  { entry: 'storage', owner: '(exports)', members: ['Storage'], reason: CLASS_EXPORT },
  {
    entry: 'storage',
    owner: 'Storage',
    members: ['app'],
    reason: 'property; the sandbox Storage handle does not carry its app',
  },
  {
    entry: 'storage',
    owner: 'Bucket',
    members: EVENT_EMITTER,
    reason: 'inherited from Node EventEmitter through the @google-cloud/storage service object; the sandbox handle emits no events',
  },
  {
    entry: 'storage',
    owner: 'Bucket',
    members: [
      'acl',
      'baseUrl',
      'cloudStorageURI',
      'crc32cGenerator',
      'iam',
      'id',
      'instancePreconditionOpts',
      'interceptors',
      'metadata',
      'parent',
      'projectId',
      'signer',
      'unreachable',
      'userProject',
    ],
    reason: '@google-cloud/storage client properties (ACL and IAM helpers, request plumbing, cached metadata) a stub cannot stand in for',
  },
  {
    entry: 'storage',
    owner: 'File',
    members: EVENT_EMITTER,
    reason: 'inherited from Node EventEmitter through the @google-cloud/storage service object; the sandbox handle emits no events',
  },
  {
    entry: 'storage',
    owner: 'File',
    members: [
      'acl',
      'baseUrl',
      'cloudStorageURI',
      'crc32cGenerator',
      'generation',
      'id',
      'instancePreconditionOpts',
      'interceptors',
      'kmsKeyName',
      'parent',
      'projectId',
      'restoreToken',
      'signer',
      'storage',
      'userProject',
    ],
    reason:
      '@google-cloud/storage client properties (ACL helper, request plumbing) a stub cannot stand in for',
  },
];
