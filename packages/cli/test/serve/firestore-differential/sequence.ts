/**
 * JSON-serializable Firestore operation sequences for differential testing
 * across the in-process sandbox and hosted HTTP/WebSocket serve planes.
 *
 * Every sequence is plain JSON so failing seeds can be shrunk, saved as
 * regression fixtures, and replayed deterministically in any process.
 */

export type SpecialNumberTag = '-0' | 'NaN' | 'Infinity' | '-Infinity';

/**
 * Rich Firestore value AST. Map entries are stored as ordered `[key, value]`
 * pairs so key insertion order (e.g. `{ a: 1, b: 2 }` vs `{ b: 2, a: 1 }`)
 * survives JSON serialization verbatim.
 */
export type ValueSpec =
  | null
  | boolean
  | number
  | string
  | { $num: SpecialNumberTag }
  | { $bytes: number[] }
  | { $geo: [number, number] }
  | { $ts: [number, number] }
  | { $ref: { path: string; db?: number } }
  | { $array: ValueSpec[] }
  | { $map: Array<[string, ValueSpec]> }
  | { $delete: true }
  | { $serverTs: true }
  | { $inc: number }
  | { $union: ValueSpec[] }
  | { $remove: ValueSpec[] };

/** Dot-delimited field path string or explicit `new FieldPath(...segments)`. */
export type FieldPathSpec = string | { segments: string[] };

export type WhereOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not-in'
  | 'array-contains'
  | 'array-contains-any';

export type QueryFieldSpec = FieldPathSpec | { documentId: true };

export type FilterSpec =
  | { kind: 'where'; field: QueryFieldSpec; op: WhereOp; value: ValueSpec }
  | { kind: 'and'; filters: FilterSpec[] }
  | { kind: 'or'; filters: FilterSpec[] };

export interface OrderSpec {
  field: QueryFieldSpec;
  dir: 'asc' | 'desc';
}

export type CursorSpec =
  | { mode: 'values'; values: ValueSpec[] }
  | { mode: 'docSnap'; path: string };

export type QuerySourceSpec =
  | { kind: 'collection'; path: string }
  | { kind: 'collectionGroup'; collectionId: string };

export interface QuerySpec {
  source: QuerySourceSpec;
  filter?: FilterSpec;
  orderBy?: OrderSpec[];
  limit?: number;
  limitToLast?: number;
  startAt?: CursorSpec;
  startAfter?: CursorSpec;
  endAt?: CursorSpec;
  endBefore?: CursorSpec;
}

export type SetMode =
  | { kind: 'replace' }
  | { kind: 'merge' }
  | { kind: 'mergeFields'; fields: FieldPathSpec[] };

export interface UpdateEntry {
  field: FieldPathSpec;
  value: ValueSpec;
}

export type BatchMutation =
  | { kind: 'set'; path: string; data: ValueSpec; mode: SetMode }
  | { kind: 'update'; path: string; style: 'object' | 'pairs'; updates: UpdateEntry[] }
  | { kind: 'delete'; path: string };

export type TxnScript =
  | 'conditionalIncrement'
  | 'readTwoSwap'
  | 'deleteThenSet'
  | 'setThenUpdate'
  | 'abortAfterWrites'
  | 'readAfterWriteInvalid';

export type ClaimScalar = string | number | boolean;

export type Step =
  | { op: 'setDoc'; db: number; path: string; data: ValueSpec; mode: SetMode }
  | { op: 'updateDoc'; db: number; path: string; style: 'object' | 'pairs'; updates: UpdateEntry[] }
  | { op: 'deleteDoc'; db: number; path: string }
  | { op: 'addDoc'; db: number; collectionPath: string; data: ValueSpec }
  | { op: 'writeBatch'; db: number; mutations: BatchMutation[]; postCommitWrite?: boolean }
  | {
    op: 'runTransaction';
    db: number;
    paths: string[];
    script: TxnScript;
    auxData: ValueSpec;
    auxUpdates: UpdateEntry[];
  }
  | { op: 'getDoc'; db: number; path: string }
  | { op: 'getDocs'; db: number; query: QuerySpec }
  | { op: 'listenDoc'; db: number; id: number; path: string }
  | { op: 'listenQuery'; db: number; id: number; query: QuerySpec }
  | { op: 'unlisten'; id: number }
  | { op: 'signIn'; uid: string; claims?: Record<string, ClaimScalar> }
  | { op: 'signInAnonymously' }
  | { op: 'signOut' }
  | { op: 'refreshToken' }
  | { op: 'rules'; rules: number };

export interface Sequence {
  seed: number;
  initialRules: number;
  steps: Step[];
}

export const PROJECT_ID = 'diff-project';

/**
 * Database handle selectors exercised across both arms:
 * - 0: `getFirestore(app)` (implicit default)
 * - 1: `getFirestore(app, '(default)')` (explicit default)
 * - 2: `initializeFirestore(app, {}, 'reports')` (named database handle)
 */
export const DATABASE_IDS: ReadonlyArray<string | undefined> = [
  undefined,
  '(default)',
  'reports',
];

/** Collections scanned during quiescent client-state verification. */
export const KNOWN_COLLECTION_PATHS: readonly string[] = [
  'users',
  'items',
  'orgs',
  'orgs/o1/docs',
  'orgs/o2/docs',
  'rooms/r1/items',
  'rooms/r2/items',
  'metrics',
];

/**
 * Representative Firestore Security Rules v2 programs covering open access,
 * auth gates, custom claims, `request.resource.data` validation,
 * `resource.data` transitions, and cross-document `get()` / `exists()`.
 */
export const RULES_POOL: readonly string[] = [
  [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /{document=**} {',
    '      allow read, write: if true;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
  [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /{document=**} {',
    '      allow read, write: if request.auth != null;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
  [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /users/{uid} {',
    '      allow read: if true;',
    '      allow write: if request.auth != null && request.auth.uid == uid;',
    '    }',
    '    match /items/{itemId} {',
    '      allow read: if true;',
    '      allow create, update: if !(("n" in request.resource.data)) || request.resource.data.n is number;',
    '      allow delete: if request.auth != null;',
    '    }',
    '    match /orgs/{orgId} {',
    '      allow read, write: if true;',
    '      match /docs/{docId} {',
    '        allow read: if true;',
    '        allow write: if exists(/databases/$(database)/documents/orgs/$(orgId));',
    '      }',
    '    }',
    '    match /rooms/{roomId}/items/{itemId} {',
    '      allow read: if true;',
    '      allow write: if request.auth != null;',
    '    }',
    '    match /metrics/{metricId} {',
    '      allow read, write: if true;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
  [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    function isAdmin() {',
    "      return request.auth != null && request.auth.token.role == 'admin';",
    '    }',
    '    function hasProfileTier() {',
    '      return request.auth != null',
    '        && exists(/databases/$(database)/documents/users/$(request.auth.uid))',
    '        && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.n >= 2;',
    '    }',
    '    match /users/{uid} {',
    '      allow read: if request.auth != null && (request.auth.uid == uid || isAdmin());',
    '      allow write: if request.auth != null && (request.auth.uid == uid || isAdmin());',
    '    }',
    '    match /items/{itemId} {',
    '      allow read: if true;',
    "      allow write: if isAdmin() || hasProfileTier() || (request.auth != null && request.auth.token.role == 'editor');",
    '    }',
    '    match /orgs/{orgId} {',
    '      allow read: if true;',
    '      allow write: if request.auth != null;',
    '      match /docs/{docId} {',
    '        allow read: if true;',
    '        allow write: if isAdmin() || hasProfileTier();',
    '      }',
    '    }',
    '    match /rooms/{roomId}/items/{itemId} {',
    '      allow read, write: if true;',
    '    }',
    '    match /metrics/{metricId} {',
    '      allow read: if true;',
    '      allow write: if request.auth != null && request.auth.token.tier >= 2;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
  [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{itemId} {',
    '      allow read: if true;',
    '      allow create: if request.resource.data.n is number;',
    '      allow update: if resource.data.n is number && request.resource.data.n is number && request.resource.data.n >= resource.data.n;',
    '      allow delete: if resource.data.flag != true;',
    '    }',
    '    match /{path=**}/items/{itemId} {',
    '      allow read: if true;',
    '    }',
    '    match /users/{uid} {',
    '      allow read, write: if true;',
    '    }',
    '    match /orgs/{orgId} {',
    '      allow read, write: if true;',
    '      match /docs/{docId} {',
    '        allow read, write: if true;',
    '      }',
    '    }',
    '    match /rooms/{roomId}/items/{itemId} {',
    '      allow read, write: if true;',
    '    }',
    '    match /metrics/{metricId} {',
    '      allow read, write: if true;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
  [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /{document=**} {',
    '      allow read, write: if false;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
];
