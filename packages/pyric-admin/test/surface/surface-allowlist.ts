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
  // ─── firebase-admin (root namespace) ───────────────────────────────────
  {
    entry: '.',
    owner: '(exports)',
    members: ['SDK_VERSION', 'apps'],
    reason: 'non-function values a stub cannot stand in for; the sandbox claims no SDK version, and a module export cannot be the live list upstream `apps` is (the default export has an `apps` getter, and getApps() lists apps)',
  },
  {
    entry: '.',
    owner: 'default',
    members: ['SDK_VERSION'],
    reason: 'a non-function value a stub cannot stand in for; the sandbox claims no SDK version',
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

  // ─── firebase-admin/app ────────────────────────────────────────────────
  { entry: 'app', owner: '(exports)', members: ['AppErrorCodes', 'FirebaseAppError'], reason: ERROR_CLASS },
  {
    entry: 'app',
    owner: '(exports)',
    members: ['SDK_VERSION'],
    reason: 'version string; the sandbox does not claim a firebase-admin version',
  },

  // ─── firebase-admin/auth ───────────────────────────────────────────────
  {
    entry: 'auth',
    owner: '(exports)',
    members: [
      'Auth',
      'BaseAuth',
      'MultiFactorInfo',
      'MultiFactorSettings',
      'PhoneMultiFactorInfo',
      'ProjectConfig',
      'ProjectConfigManager',
      'Tenant',
      'TenantAwareAuth',
      'TenantManager',
      'UserInfo',
      'UserMetadata',
      'UserRecord',
    ],
    reason: CLASS_EXPORT,
  },
  { entry: 'auth', owner: '(exports)', members: ['AuthClientErrorCode', 'FirebaseAuthError'], reason: ERROR_CLASS },
  {
    entry: 'auth',
    owner: 'UserRecord',
    members: ['multiFactor', 'passwordHash', 'passwordSalt', 'tokensValidAfterTime'],
    reason: 'user record fields the sandbox auth store does not model (MFA enrollment, password hashes, token revocation time)',
  },

  // ─── firebase-admin/database ───────────────────────────────────────────
  { entry: 'database', owner: '(exports)', members: ['FirebaseDatabaseError'], reason: ERROR_CLASS },

  // ─── firebase-admin/firestore ──────────────────────────────────────────
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
      'WriteResult',
    ],
    reason: CLASS_EXPORT,
  },
  { entry: 'firestore', owner: '(exports)', members: ['FirebaseFirestoreError'], reason: ERROR_CLASS },
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
  {
    entry: 'firestore',
    owner: 'CollectionReference',
    members: [
      'count',
      'endAt',
      'endBefore',
      'explain',
      'explainStream',
      'findNearest',
      'firestore',
      'isEqual',
      'listDocuments',
      'offset',
      'onSnapshot',
      'parent',
      'select',
      'startAfter',
      'startAt',
      'stream',
      'withConverter',
    ],
    reason:
      'reference and query members past the modeled read and write path; not yet stubbed on the local and remote reference builders',
  },
  {
    entry: 'firestore',
    owner: 'DocumentReference',
    members: ['create', 'firestore', 'isEqual', 'listCollections', 'onSnapshot', 'withConverter'],
    reason:
      'reference and query members past the modeled read and write path; not yet stubbed on the local and remote reference builders',
  },
  {
    entry: 'firestore',
    owner: 'Query',
    members: [
      'count',
      'endAt',
      'endBefore',
      'explain',
      'explainStream',
      'findNearest',
      'firestore',
      'isEqual',
      'offset',
      'onSnapshot',
      'select',
      'startAfter',
      'startAt',
      'stream',
      'withConverter',
    ],
    reason:
      'reference and query members past the modeled read and write path; not yet stubbed on the local and remote reference builders',
  },
  {
    entry: 'firestore',
    owner: 'DocumentSnapshot',
    members: ['createTime', 'isEqual', 'readTime', 'updateTime'],
    reason: 'snapshot timestamps and equality the sandbox snapshot does not carry',
  },
  {
    entry: 'firestore',
    owner: 'QuerySnapshot',
    members: ['docChanges', 'isEqual', 'query', 'readTime'],
    reason: 'snapshot timestamps and equality the sandbox snapshot does not carry',
  },
  {
    entry: 'firestore',
    owner: 'WriteBatch',
    members: ['create'],
    reason: 'create-if-absent writes are not modeled on batches and transactions',
  },
  {
    entry: 'firestore',
    owner: 'Transaction',
    members: ['create', 'getAll'],
    reason: 'create-if-absent writes and multi-document reads are not modeled on transactions',
  },
  {
    entry: 'firestore',
    owner: 'FieldValue',
    members: ['vector'],
    reason: 'vector values are not modeled by the sandbox Firestore engine',
  },

  // ─── firebase-admin/storage ────────────────────────────────────────────
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
      'storage',
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
      'metadata',
      'parent',
      'projectId',
      'restoreToken',
      'signer',
      'storage',
      'userProject',
    ],
    reason:
      '@google-cloud/storage client properties (ACL helper, request plumbing, cached metadata); read metadata through getMetadata()',
  },
];
