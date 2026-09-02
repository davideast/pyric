/**
 * Firestore Rules standard library — a module-organized reference an
 * agent can call before writing rules.
 *
 * Three flavors of module live here, distinguished by `kind`:
 *
 *   `language-namespace` — namespaces like `math`, `timestamp`,
 *       `duration`, `latlng`, `hashing`. Functions called as
 *       `<namespace>.<fn>(...)`. Built into the rules engine; always
 *       in scope.
 *   `type-methods` — methods that dispatch on a value's type:
 *       `string`, `list`, `map`, `bytes`, `path`. Called as
 *       `<value>.<method>(...)`. Built into the engine; always in
 *       scope.
 *   `globals` — root identifiers (`request`, `resource`) that carry
 *       request-time and existing-doc state. Accessed as paths
 *       (`request.auth.uid`), not callables.
 *   `user-module` — reusable libraries shipped under
 *       `packages/pyric/src/rules/modules/stdlib/` (auth,
 *       validation, lobby, …). Imported via
 *       `import { isAuthenticated } from 'auth';` after
 *       `rules_version = '2+modules';`. Functions called bare after
 *       import. Resolver also accepts the path form
 *       `from './stdlib/auth.rules'` if the source prefers.
 *
 * Source of truth: this file's names are kept in sync with
 *   - `BUILTIN_FUNCTIONS` (`grammar/FirestoreValidator.ts`)
 *   - `BUILTIN_NAMESPACES` (`simulator/evaluator.ts`)
 *   - `KNOWN_BUILTIN_METHODS` (`linter/hallucinations.ts`)
 *   - wrapper-class implementations (`simulator/wrappers/*.ts`)
 *   - `packages/site-docs/src/content/trust/rules-standard-library.md`
 * by a drift-check vitest in `test/stdlib-modules.test.ts`. If a
 * runtime constant grows, the test fails until this file catches up.
 */

import { STDLIB_SERVICE_CONTRACTS } from './modules/stdlib-services.generated.js';

export type ModuleKind =
  | 'language-namespace'
  | 'type-methods'
  | 'globals'
  | 'user-module';

export type RulesService = 'firestore' | 'storage';

export interface StdlibEntry {
  /** Surface signature, e.g. `math.ceil(x: number): int`. */
  signature: string;
  /**
   * Whether production accepts a ruleset that calls this entry. Omitted
   * means accepted. `'rejected'` documents a name that Firebase reference
   * material lists but production's compiler refuses, so the catalog can
   * carry the correction while the signature field stays a signature.
   */
  acceptance?: 'rejected';
  /** One-line summary the agent reads first. */
  description: string;
  /** ~1–3 lines of real rule fragments. Optional. */
  examples?: string[];
  /** Gotchas / common confusions (e.g. "agents commonly write
   *  `auth.token.admin` — needs leading `request.`"). Optional. */
  notes?: string;
}

export interface StdlibModule {
  /** Module identifier — the value passed to
   *  `firestore_rules_stdlib_get({ key })`. Case-insensitive lookup. */
  key: string;
  kind: ModuleKind;
  /** Rules services where this catalog entry can be used. */
  services: readonly RulesService[];
  /** One-line for the list TOC. */
  description: string;
  /** One-paragraph: what this module is for. */
  purpose: string;
  /** One-line: the situation that should make the agent reach for it. */
  whenToUse: string;
  /** Entries inside the module. */
  entries: StdlibEntry[];
  /** Module-level snippets — typical patterns. */
  examples?: string[];
  /** Cross-references to related modules. Surfaced in the get
   *  response to help the agent navigate naturally. */
  relatedKeys?: string[];
}

type StdlibModuleDefinition = Omit<StdlibModule, 'services'>;

// ─── Top-level callables ──────────────────────────────────────────────

const BUILTINS_MODULE: StdlibModuleDefinition = {
  key: 'builtins',
  kind: 'language-namespace',
  description:
    'Top-level functions always in scope inside rules: get, exists, getAfter. Called bare, no namespace prefix. (debug() is docs-only: production rejects it at compile.)',
  purpose:
    'The built-in functions Firestore Rules ships with at the top level. They are NOT inside a namespace: call `get(path)`, not `firestore.get(path)`. Used to read other documents (cross-document gates), check existence, and peek at post-write state.',
  whenToUse:
    'Reach for `builtins` any time a rule needs information that isn\'t already on `request` or `resource`. Most common: `get(path)` to read another document\'s fields inside a predicate.',
  entries: [
    {
      signature: 'get(path: path): Resource',
      description:
        'Read another document. Returns a Resource whose `.data` is the doc map. Counts against the rule\'s `get()` budget (cap 10 per evaluation).',
      examples: [
        `allow update: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';`,
      ],
      notes:
        'Path must start with `/databases/$(database)/documents/`. Hardcoding a different database id silently fails.',
    },
    {
      signature: 'exists(path: path): bool',
      description: 'True if a document at `path` exists. Counts against the get() budget like `get`.',
      examples: [
        `allow create: if exists(/databases/$(database)/documents/teams/$(request.resource.data.teamId));`,
      ],
    },
    {
      signature: 'getAfter(path: path): Resource',
      description:
        'Like `get`, but reads the doc AS IT WILL BE after the current transaction commits. Use for cross-document consistency gates that depend on the post-write state of another doc in the same batch.',
      notes:
        'Only meaningful inside transactions / batched writes. Outside a batch, equivalent to `get`.',
    },
    {
      signature: 'debug(value: any): bool',
      acceptance: 'rejected',
      description:
        'DO NOT USE. Although Firebase reference docs list `debug()`, production Firestore REJECTS rulesets that call it at compile time (`Function not found error: Name: [debug]`). The linter and local simulator reject it for the same reason.',
      notes:
        'Remove any debug() wrapper before deploying and evaluate the inner expression directly. There is no deployable logging primitive in rules.',
    },
  ],
  relatedKeys: ['request', 'resource', 'path'],
};

// ─── Language namespaces ──────────────────────────────────────────────

const MATH: StdlibModuleDefinition = {
  key: 'math',
  kind: 'language-namespace',
  description:
    'Numeric helpers: abs, ceil, floor, round, sqrt, pow, isNaN. Use when rules need to coerce or bound numbers.',
  purpose:
    'The `math` namespace exposes a small set of numeric utilities for use inside rule predicates. Functions are called as `math.<fn>(...)`. Always in scope; no import needed.',
  whenToUse:
    'Reach for `math` whenever a rule needs to round, bound, or guard against NaN in a user-supplied field.',
  entries: [
    { signature: 'math.abs(n: number): number', description: 'Absolute value of `n`.' },
    { signature: 'math.ceil(n: number): int', description: 'Smallest integer >= `n`.' },
    { signature: 'math.floor(n: number): int', description: 'Largest integer <= `n`.' },
    { signature: 'math.round(n: number): int', description: 'Nearest integer to `n`.' },
    { signature: 'math.sqrt(n: number): number', description: 'Square root of `n`. Negative input returns NaN.' },
    { signature: 'math.pow(base: number, exp: number): number', description: '`base` raised to `exp`.' },
    {
      signature: 'math.isNaN(n: number): bool',
      description: 'True if `n` is NaN.',
      notes:
        'There is NO isInfinite function in the math namespace. Production Firestore rejects it at compile time (`Function not found error: Name: [math.isInfinite]`), despite it appearing in some Firebase reference material.',
    },
  ],
  examples: [
    `allow update: if math.ceil(request.resource.data.score) <= 100;`,
    `allow create: if !math.isNaN(request.resource.data.lat);`,
  ],
  relatedKeys: ['hashing'],
};

const TIMESTAMP_NS: StdlibModuleDefinition = {
  key: 'timestamp',
  kind: 'language-namespace',
  description:
    'Timestamp constructors — date(year, month, day), value(epochMillis). Use to build timestamps in rule comparisons.',
  purpose:
    'The `timestamp` namespace contains constructors that produce Timestamp values for use in comparisons. The Timestamp TYPE has its own methods (year, month, etc.) — those live under the `string`/`list`/`map`-style key `timestamp-methods` in this stdlib, accessed via dot notation on a timestamp value.',
  whenToUse:
    'Reach for the `timestamp` namespace when a rule needs to construct a specific Timestamp value to compare against `request.time` or a document field.',
  entries: [
    {
      signature: 'timestamp.date(year: int, month: int, day: int): Timestamp',
      description: 'Construct a Timestamp at UTC midnight of the given date.',
      examples: [`allow read: if request.time > timestamp.date(2024, 1, 1);`],
    },
    {
      signature: 'timestamp.value(epochMillis: int): Timestamp',
      description: 'Construct a Timestamp from epoch milliseconds.',
    },
  ],
  relatedKeys: ['duration', 'request', 'lifecycle'],
};

const DURATION_NS: StdlibModuleDefinition = {
  key: 'duration',
  kind: 'language-namespace',
  description:
    'Duration constructors — value(magnitude, unit), time(h, m, s, ns), abs(d). Use for "within N seconds" windows.',
  purpose:
    'The `duration` namespace builds Duration values that can be added to or subtracted from Timestamps. Useful for time-window predicates in security rules.',
  whenToUse:
    'Reach for `duration` whenever a rule expresses a time window — "within 5 minutes of write", "older than 30 days", etc.',
  entries: [
    {
      signature: "duration.value(magnitude: int, unit: 'w' | 'd' | 'h' | 'm' | 's' | 'ms' | 'ns'): Duration",
      description: 'Construct a Duration of `magnitude` of the given unit.',
      examples: [
        `allow update: if request.time < resource.data.createdAt + duration.value(5, 'm');`,
      ],
    },
    {
      signature: 'duration.time(h: int, m: int, s: int, ns: int): Duration',
      description: 'Construct a Duration as a sum of hours, minutes, seconds, nanoseconds.',
    },
    {
      signature: 'duration.abs(d: Duration): Duration',
      description: 'Absolute value of a Duration (drops sign).',
    },
  ],
  relatedKeys: ['timestamp'],
};

const LATLNG_NS: StdlibModuleDefinition = {
  key: 'latlng',
  kind: 'language-namespace',
  description:
    'GeoPoint constructor — value(lat, lng). Builds LatLng values for proximity rules.',
  purpose:
    'The `latlng` namespace constructs LatLng values. The LatLng type itself has methods (`latitude()`, `longitude()`, `distance(other)`) accessed via dot notation on a latlng value.',
  whenToUse:
    'Reach for `latlng` when a rule gates on physical proximity — e.g. "this write must come within N meters of the document\'s anchor point".',
  entries: [
    {
      signature: 'latlng.value(lat: number, lng: number): LatLng',
      description: 'Construct a LatLng. Latitude in [-90, 90], longitude in [-180, 180].',
      examples: [
        `allow update: if latlng.value(request.resource.data.lat, request.resource.data.lng).distance(resource.data.anchor) < 1000;`,
      ],
    },
  ],
};

const HASHING_NS: StdlibModuleDefinition = {
  key: 'hashing',
  kind: 'language-namespace',
  description:
    'Hash digests — md5, sha256, crc32, crc32c. Each takes Bytes or String and returns Bytes.',
  purpose:
    'The `hashing` namespace exposes one-shot digest functions. Output is Bytes; compare equality with `==` against a stored Bytes value.',
  whenToUse:
    'Reach for `hashing` for tamper-evidence checks — comparing a submitted hash against a stored digest, or verifying a public-facing checksum.',
  entries: [
    {
      signature: 'hashing.md5(input: Bytes | String): Bytes',
      description: 'MD5 digest. 128-bit; do not use for security-sensitive integrity proofs.',
    },
    {
      signature: 'hashing.sha256(input: Bytes | String): Bytes',
      description: 'SHA-256 digest. 256-bit; the right choice for integrity proofs.',
    },
    {
      signature: 'hashing.crc32(input: Bytes | String): Bytes',
      description: 'CRC32 checksum (Bytes). Use for non-cryptographic integrity.',
    },
    {
      signature: 'hashing.crc32c(input: Bytes | String): Bytes',
      description: 'CRC32C checksum (Bytes). Same role as crc32 with a different polynomial.',
    },
  ],
  examples: [
    `allow update: if hashing.sha256(request.resource.data.payload) == resource.data.checksum;`,
  ],
  relatedKeys: ['bytes'],
};

// ─── Type methods ─────────────────────────────────────────────────────

const STRING_METHODS: StdlibModuleDefinition = {
  key: 'string',
  kind: 'type-methods',
  description:
    'Methods on string values — matches, lower, upper, trim, size, split, replace, toUtf8. Called as `value.method(...)`.',
  purpose:
    'Methods available on values of type `string` inside rule expressions. Dispatched on the value: `myField.matches(...)`, not `string.matches(myField, ...)`. The engine routes the call based on the value\'s runtime type.',
  whenToUse:
    'Reach for these whenever a rule examines a string field — pattern checks, case-insensitive comparisons, trimming user input, encoding to bytes.',
  entries: [
    {
      signature: 'string.matches(pattern: string): bool',
      description: 'True if the string matches the given RE2 regex (full match).',
      examples: [`allow create: if request.resource.data.email.matches('.*@example[.]com');`],
      notes:
        'Pattern is RE2 syntax, NOT JavaScript regex. No anchors needed — the match is full-string by default.',
    },
    { signature: 'string.lower(): string', description: 'Return the string lowercased.' },
    { signature: 'string.upper(): string', description: 'Return the string uppercased.' },
    { signature: 'string.trim(): string', description: 'Strip leading + trailing whitespace.' },
    { signature: 'string.size(): int', description: 'Length in characters (NOT bytes — use `toUtf8().size()` for byte length).' },
    {
      signature: 'string.split(separator: string): list<string>',
      description: 'Split the string into a list on `separator`.',
    },
    {
      signature: 'string.replace(old: string, new: string): string',
      description: 'Replace all occurrences of `old` with `new`.',
    },
    {
      signature: 'string.toUtf8(): bytes',
      description: 'Encode the string as UTF-8 bytes.',
      notes: 'Use before hashing if the input is a string.',
    },
  ],
  examples: [
    `allow create: if request.resource.data.slug.size() > 0 && request.resource.data.slug.size() <= 64;`,
    `allow update: if request.resource.data.kind.lower() == 'public';`,
  ],
  relatedKeys: ['bytes', 'hashing', 'validation'],
};

const LIST_METHODS: StdlibModuleDefinition = {
  key: 'list',
  kind: 'type-methods',
  description:
    'Methods on list values — hasAll, hasAny, hasOnly, size, toSet, concat, removeAll, join. Called as `value.method(...)`.',
  purpose:
    'Methods on list values — used to check membership, compare contents, transform to sets, and concatenate. Lists in rules are ordered + finite; methods often have parallel semantics on the `set` view produced by `toSet()`.',
  whenToUse:
    'Reach for these whenever a rule examines an array field — tag membership ("user can update if their uid is in editors"), array-shape validation, or projecting to a set for difference checks.',
  entries: [
    {
      signature: 'list.hasAll(other: list): bool',
      description: 'True if every element of `other` is present in this list.',
      examples: [`allow update: if request.resource.data.tags.hasAll(['public', 'reviewed']);`],
    },
    {
      signature: 'list.hasAny(other: list): bool',
      description: 'True if at least one element of `other` is present in this list.',
    },
    {
      signature: 'list.hasOnly(other: list): bool',
      description: 'True if every element of THIS list is in `other` (i.e. this is a subset).',
      notes:
        'Often the right call for "no fields outside this allowlist" patterns when used with `request.resource.data.keys()`.',
    },
    { signature: 'list.size(): int', description: 'Number of elements.' },
    {
      signature: 'list.toSet(): set',
      description: 'Convert to a Set view (de-duplicated, unordered). Useful for `difference`/`union`/`intersection` operations.',
    },
    {
      signature: 'list.concat(other: list): list',
      description: 'Return a new list with `other` appended.',
    },
    {
      signature: 'list.removeAll(other: list): list',
      description: 'Return a new list with every element of `other` removed.',
    },
    {
      signature: 'list.join(separator: string): string',
      description: 'Join elements into a single string with `separator` between them.',
    },
  ],
  relatedKeys: ['map', 'string'],
};

const MAP_METHODS: StdlibModuleDefinition = {
  key: 'map',
  kind: 'type-methods',
  description:
    'Methods on map values — keys, values, size, get, diff. Called as `value.method(...)`.',
  purpose:
    'Methods on map values. The most common in rule code: `keys()` returns a list of map keys (combined with `list.hasAll`/`list.hasOnly` for shape checks), and `diff(other)` returns a MapDiff used to assert which fields changed across an update.',
  whenToUse:
    'Reach for these for shape validation (which keys exist), for default-aware reads (`get(key, default)`), and for diff-based immutability gates on updates.',
  entries: [
    {
      signature: 'map.keys(): list<string>',
      description: 'List of top-level keys in the map.',
      examples: [
        `allow create: if request.resource.data.keys().hasOnly(['title','body','authorId']);`,
      ],
    },
    {
      signature: 'map.values(): list',
      description: 'List of top-level values in the map.',
    },
    {
      signature: 'map.size(): int',
      description: 'Number of top-level keys.',
    },
    {
      signature: 'map.get(key: string, fallback: any): any',
      description: 'Return `map[key]` if present, otherwise `fallback`. Same shape as `get(map, key, fallback)`.',
    },
    {
      signature: 'map.diff(other: map): MapDiff',
      description:
        'Return a MapDiff with `.addedKeys()`, `.removedKeys()`, `.changedKeys()`, `.affectedKeys()`, `.unchangedKeys()` methods, each returning a Set of keys.',
      examples: [
        `allow update: if request.resource.data.diff(resource.data).affectedKeys().hasOnly(['updatedAt']);`,
      ],
      notes:
        'The MapDiff result is the right surface for immutability gates — easier to read than chaining individual field-unchanged checks.',
    },
  ],
  relatedKeys: ['list', 'lifecycle', 'validation'],
};

const BYTES_METHODS: StdlibModuleDefinition = {
  key: 'bytes',
  kind: 'type-methods',
  description:
    'Methods on bytes values — size, toBase64, toHexString. Called as `value.method(...)`.',
  purpose:
    'Methods on Bytes values — the output of hashing operations and the storage shape for arbitrary binary payloads. Bytes also support comparison operators (<, <=, >, >=) for lexicographic ordering.',
  whenToUse:
    'Reach for these when a rule examines a Bytes field — typically a stored digest from `hashing.sha256(...)` — or when comparing two hashes for tamper-evidence.',
  entries: [
    {
      signature: 'bytes.size(): int',
      description: 'Number of bytes.',
    },
    {
      signature: 'bytes.toBase64(): string',
      description: 'Standard base64 encoding of the bytes.',
    },
    {
      signature: 'bytes.toHexString(): string',
      description: 'Lowercase hexadecimal encoding of the bytes.',
    },
  ],
  relatedKeys: ['hashing', 'string'],
};

const PATH_METHODS: StdlibModuleDefinition = {
  key: 'path',
  kind: 'type-methods',
  description:
    'Methods on path values — bind. Used to fill in template variables in document paths.',
  purpose:
    'Path values are the type used for cross-document references inside rules (e.g. the path passed to `get()` or `exists()`). The `bind` method substitutes template variables into a path literal.',
  whenToUse:
    'Reach for `path.bind` when a `get()` or `exists()` call needs a dynamic path with one or more template variables filled in from rule context.',
  entries: [
    {
      signature: 'path.bind(bindings: map<string, string>): path',
      description: 'Return a new path with template variables (`{name}`) replaced by values from `bindings`.',
      examples: [
        `allow update: if exists(/databases/$(database)/documents/users/$(request.auth.uid)/profile/main);`,
      ],
      notes:
        'In practice most rule code constructs paths inline with `$()` interpolation instead of `path.bind`. `bind` is here for completeness.',
    },
  ],
  relatedKeys: ['request', 'resource'],
};

// ─── Globals ──────────────────────────────────────────────────────────

const REQUEST_GLOBALS: StdlibModuleDefinition = {
  key: 'request',
  kind: 'globals',
  description:
    'Root namespace for the in-flight request — auth, resource.data, time, path, method, query. Always available, no import.',
  purpose:
    'The `request` identifier carries everything the engine knows about the current request — who is making it (`auth`), what they are sending (`resource.data`), when (`time`), and where (`path`, `method`). These are *paths*, not callables — read fields off them in rule predicates.',
  whenToUse:
    'Every non-trivial rule reads from `request` to authorize the operation. The two most common touchpoints: `request.auth` (who) and `request.resource.data` (what).',
  entries: [
    {
      signature: 'request.auth: map | null',
      description: 'The authenticated user. `null` for unauthenticated requests.',
      examples: [`allow read: if request.auth != null;`],
    },
    {
      signature: 'request.auth.uid: string',
      description: 'The signed-in user\'s UID. Only safe to read after a null-check on `request.auth`.',
      examples: [`allow update: if request.auth.uid == resource.data.ownerId;`],
    },
    {
      signature: 'request.auth.token: map',
      description: 'Map of custom claims set on the user\'s ID token (e.g. `request.auth.token.admin`).',
      examples: [`allow delete: if request.auth.token.admin == true;`],
      notes:
        'Custom claims live under `request.auth.token.*`, NOT `request.auth.*`. Agents often emit `request.auth.admin` — that always reads `null`.',
    },
    {
      signature: 'request.resource.data: map',
      description: 'The document data being written (create/update/set). Read it to validate what the client is sending.',
      examples: [
        `allow create: if request.resource.data.keys().hasOnly(['title','body','authorId']);`,
      ],
    },
    {
      signature: 'request.time: timestamp',
      description: 'Server time of the request. Compare against document timestamps for windowed gates.',
    },
    {
      signature: 'request.path: path',
      description: 'Path of the document being operated on (e.g. `/databases/(default)/documents/users/alice`).',
    },
    {
      signature: "request.method: 'get' | 'list' | 'create' | 'update' | 'delete'",
      description: 'Which operation triggered the rule. Usually inferred from the `allow` clause, but available for fine-grained checks.',
    },
    {
      signature: 'request.query: map',
      description: 'Query metadata for `list` requests — `limit`, `offset`, `orderBy`. Available on `allow list` rules only.',
    },
  ],
  relatedKeys: ['resource', 'auth'],
};

const RESOURCE_GLOBALS: StdlibModuleDefinition = {
  key: 'resource',
  kind: 'globals',
  description:
    'Root namespace for the existing document — use resource.data to compare against what is already there.',
  purpose:
    'The `resource` identifier is the document state BEFORE the request — what is currently stored. When the target does not exist, evaluating `resource` raises a null-value error; it is not a comparable null. On an update/delete of an existing document, it contains the pre-write data. Use it to compare incoming changes against existing values.',
  whenToUse:
    'Whenever a rule needs the pre-write state — e.g. "the existing owner is the one updating", "the field already had this value before the write".',
  entries: [
    {
      signature: 'resource.data: map',
      description: 'The currently stored document data. When the target does not exist, evaluating `resource` raises a null-value error.',
      examples: [`allow update: if resource.data.ownerId == request.auth.uid;`],
    },
  ],
  relatedKeys: ['request'],
};

// ─── User-authored modules (mirror of the canonical site reference) ──

const AUTH_MODULE: StdlibModuleDefinition = {
  key: 'auth',
  kind: 'user-module',
  description:
    "User-authored module: authentication primitives (isAuthenticated, isOwner). Self-contained. Import via `import { isAuthenticated, isOwner } from 'auth';` (the resolver also accepts the path form `from './stdlib/auth.rules'` if you prefer).",
  purpose:
    'Two-function module covering the most common access-control predicates in any user-facing app: "is the request authenticated" and "is the request the owner of this document".',
  whenToUse:
    'Import as the first stdlib module on any project that has user-owned documents. Pairs with `validation` and `lifecycle` for full create/update/delete coverage.',
  entries: [
    {
      signature: 'isAuthenticated(): bool',
      description: '`request.auth != null`.',
    },
    {
      signature: 'isOwner(userId: string): bool',
      description: '`request.auth.uid == userId`. Pass a field path like `resource.data.ownerId`.',
      examples: [`allow update: if isAuthenticated() && isOwner(resource.data.ownerId);`],
    },
  ],
  examples: [
    `rules_version = '2+modules';\nimport { isAuthenticated } from 'auth';\n\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /posts/{id} { allow read: if isAuthenticated(); }\n  }\n}`,
  ],
  relatedKeys: ['validation', 'lifecycle', 'membership'],
};

const VALIDATION_MODULE: StdlibModuleDefinition = {
  key: 'validation',
  kind: 'user-module',
  description:
    "User-authored module: shape validation (hasRequired, hasOnly). Self-contained. Import via `import { hasRequired, hasOnly } from 'validation';` after `rules_version = '2+modules';`.",
  purpose:
    'Field-shape predicates: "the incoming doc has all these fields" and "the incoming doc has only these fields". Layered on top of `request.resource.data.keys()` so the agent does not have to remember the list-method idioms.',
  whenToUse:
    'Reach for `validation` on every `create` allow rule to gate field shape — and on `update` rules when the schema is strict.',
  entries: [
    {
      signature: 'hasRequired(fields: list<string>): bool',
      description: '`request.resource.data.keys().hasAll(fields)`.',
    },
    {
      signature: 'hasOnly(fields: list<string>): bool',
      description: '`request.resource.data.keys().hasOnly(fields)`.',
      examples: [
        // Imports resolve to FLAT names — call `hasRequired(...)`, never `validation.hasRequired(...)`.
        `allow create: if hasRequired(['title','body']) && hasOnly(['title','body','tags']);`,
      ],
    },
    {
      signature: 'validString(field: string, min: int, max: int): bool',
      description:
        'The incoming field is a string with size in [min, max] (inclusive). Uses dynamic access, so a MISSING field reads null and fails the type check instead of erroring — safe on optional fields.',
      examples: [`allow create: if validString('title', 1, 100);`],
    },
    {
      signature: 'isOneOf(field: string, values: list): bool',
      description:
        "Enum check: the incoming field value is in the allowed list (`request.resource.data[field] in values`). The rules idiom for what JS would write as `.includes()` — which does not exist here.",
      examples: [`allow create: if isOneOf('status', ['draft', 'published']);`],
    },
  ],
  relatedKeys: ['map', 'lifecycle', 'content'],
};

const LOBBY_MODULE: StdlibModuleDefinition = {
  key: 'lobby',
  kind: 'user-module',
  description:
    'User-authored module: lobby lifecycle (validCreate, validJoin, canCancel) for two-player game sessions. Self-contained.',
  purpose:
    'Convention-based lifecycle for game lobbies — assumes the document has `host`, `guest`, and `status` fields. Encapsulates the rules for opening a lobby, joining as the second player, and cancelling.',
  whenToUse:
    'Reach for `lobby` on games with a join-then-start flow. The convention names are load-bearing — if your schema differs, fork these functions rather than try to remap.',
  entries: [
    {
      signature: 'validCreate(): bool',
      description: 'Host is the auth user, guest is empty, status is "waiting".',
    },
    {
      signature: 'validJoin(): bool',
      description: 'Guest slot is empty, joiner is not the host, status transitions to "playing".',
    },
    {
      signature: 'canCancel(): bool',
      description: 'Status is "waiting" and the requester is the host.',
    },
  ],
  relatedKeys: ['turns', 'state', 'transitions'],
};

const TURNS_MODULE: StdlibModuleDefinition = {
  key: 'turns',
  kind: 'user-module',
  description:
    'User-authored module: turn enforcement for two-player games (isMyTurn, turnFlipped). Self-contained.',
  purpose:
    'Convention-based turn handling on docs with `host`, `guest`, and `currentTurn` fields. Asserts the request is from the current player and that turn alternates correctly across writes.',
  whenToUse:
    'Reach for `turns` on any turn-based game where exactly one player can act per state.',
  entries: [
    {
      signature: 'isMyTurn(): bool',
      description: 'Current player matches the auth uid (matches against `host` or `guest`).',
    },
    {
      signature: 'turnFlipped(): bool',
      description: 'After the write, `currentTurn` has switched from host to guest (or vice-versa).',
    },
  ],
  relatedKeys: ['lobby', 'state', 'transitions'],
};

const STATE_MODULE: StdlibModuleDefinition = {
  key: 'state',
  kind: 'user-module',
  description:
    'User-authored module: game state tracking (isPlaying, moveIncremented, participantsUnchanged). Self-contained.',
  purpose:
    'Mid-game state predicates: the game is in play, the move counter incremented by exactly one, the participant list did not change.',
  whenToUse:
    'Reach for `state` on per-move updates to assert the move actually advanced the game and did not change the players.',
  entries: [
    { signature: 'isPlaying(): bool', description: '`resource.data.status == "playing"`.' },
    {
      signature: 'moveIncremented(): bool',
      description: '`request.resource.data.moveCount == resource.data.moveCount + 1`.',
    },
    {
      signature: 'participantsUnchanged(): bool',
      description: 'Host and guest fields are identical pre- and post-write.',
    },
  ],
  relatedKeys: ['turns', 'lifecycle', 'transitions'],
};

const MEMBERSHIP_MODULE: StdlibModuleDefinition = {
  key: 'membership',
  kind: 'user-module',
  description:
    'User-authored module: claims + role-based access (hasClaim, hasClaimRole, isMemberOf, hasRole). Self-contained.',
  purpose:
    'Two halves: claim-based checks against the auth token, and role checks against a `members` map on a document. The module is the right cover for "team-style" apps where each doc has a participant map.',
  whenToUse:
    'Reach for `membership` whenever a rule gates on a custom claim (`request.auth.token.admin`) or on a role inside a participant map.',
  entries: [
    {
      signature: 'hasClaim(claim: string): bool',
      description: 'Auth token has a non-null value for the named claim.',
    },
    {
      signature: 'hasClaimRole(claim: string, role: string): bool',
      description: 'Auth token claim equals the named role value.',
    },
    {
      signature: 'isMemberOf(membersMap: map): bool',
      description: 'Auth uid is a key in the members map.',
    },
    {
      signature: 'hasRole(membersMap: map, role: string): bool',
      description: 'Auth uid is in the members map with the named role.',
    },
  ],
  relatedKeys: ['auth', 'request'],
};

const LIFECYCLE_MODULE: StdlibModuleDefinition = {
  key: 'lifecycle',
  kind: 'user-module',
  description:
    'User-authored module: field immutability + server-timestamp checks (fieldUnchanged, immutableFields, isServerTimestamp). Self-contained.',
  purpose:
    'Locks specific fields against modification on updates and asserts that a timestamp field matches `request.time` (i.e. the client used the server-timestamp sentinel).',
  whenToUse:
    'Reach for `lifecycle` on every update rule to lock identity fields (`createdAt`, `ownerId`) and to enforce server-set timestamps.',
  entries: [
    {
      signature: 'fieldUnchanged(field: string): bool',
      description: 'The named field is byte-identical before and after the write.',
    },
    {
      signature: 'immutableFields(fields: list<string>): bool',
      description:
        'All listed fields are unchanged. Implemented via MapDiff so it is cheaper than chaining `fieldUnchanged` calls.',
    },
    {
      signature: 'isServerTimestamp(field: string): bool',
      description: 'The named field equals `request.time` (i.e. the client wrote `FieldValue.serverTimestamp()`).',
    },
    {
      signature: 'onlyFieldsChanged(fields: list<string>): bool',
      description:
        'The dual of immutableFields: every CHANGED field is in the allowed list, so unlisted fields are implicitly immutable (adds and removes count as changes). The single most common update guard — "users may edit title/body and nothing else". Top-level keys only; nested-map diffs are unreliable in production.',
      examples: [`allow update: if onlyFieldsChanged(['title', 'body']);`],
    },
    {
      signature: 'nFieldsChanged(n: int): bool',
      description:
        'Exactly n top-level fields changed in this write. `nFieldsChanged(1)` is the board-integrity / edit-one-field-per-write guard.',
    },
  ],
  relatedKeys: ['map', 'validation', 'request', 'counters'],
};

const TRANSITIONS_MODULE: StdlibModuleDefinition = {
  key: 'transitions',
  kind: 'user-module',
  description:
    'User-authored module: state-machine transitions (validTransition, statusIs, newStatusIs). Self-contained.',
  purpose:
    'Asserts that a field moves from one specific value to another specific value on a write. Use to encode state-machine edges directly in rules.',
  whenToUse:
    'Reach for `transitions` whenever a rule encodes a state machine — order: pending → paid → shipped, etc.',
  entries: [
    {
      signature: 'validTransition(field: string, from: string, to: string): bool',
      description: 'Field was `from` before and is `to` after.',
    },
    {
      signature: 'statusIs(field: string, value: string): bool',
      description: 'Pre-write field equals `value`.',
    },
    {
      signature: 'newStatusIs(field: string, value: string): bool',
      description: 'Post-write field equals `value`.',
    },
  ],
  relatedKeys: ['state', 'lifecycle'],
};

const GEOMETRY_MODULE: StdlibModuleDefinition = {
  key: 'geometry',
  kind: 'user-module',
  description:
    'User-authored module: movement validation via config-doc lookup (validSimpleMove, validJumpMove). Caller must pass the config from a `get()` call.',
  purpose:
    'Board-game movement rules expressed as lookups in a config document — `cfg.moves[piece][from][to]` for simple moves, `cfg.jumps[piece][from][to]` for jumps (with captured-cell info). The module is "explicit parameter" style: no implicit reads — the caller passes the config explicitly.',
  whenToUse:
    'Reach for `geometry` on grid-based games (chess, checkers, go variants). Pair the function call with a `get()` on your config document.',
  entries: [
    {
      signature: 'validSimpleMove(cfg: map): bool',
      description: '`cfg.moves[piece][from][to] == true`.',
    },
    {
      signature: 'validJumpMove(cfg: map): bool',
      description: '`cfg.jumps[piece][from][to] == capturedCell`.',
    },
  ],
  relatedKeys: ['transitions', 'state'],
};

// ─── Module registry ──────────────────────────────────────────────────

const COUNTERS_MODULE: StdlibModuleDefinition = {
  key: 'counters',
  kind: 'user-module',
  description:
    'User-authored module: denormalized numeric integrity (incrementedBy, changedBy, boundedNumber). Self-contained.',
  purpose:
    'Keeps client-maintained counts honest — likes, votes, moves, quantities may only change by a known step or stay within known bounds. Generalizes the state module\'s moveIncremented() (hardcoded to moveCount) to any field.',
  whenToUse:
    'Reach for `counters` whenever a numeric field is client-written but semantically constrained: vote/like toggles (`changedBy(f, -1, 1)`), move counters (`incrementedBy(f, 1)`), ratings (`boundedNumber(f, 1, 5)`).',
  entries: [
    {
      signature: 'incrementedBy(field: string, n: int): bool',
      description:
        'The field changed by EXACTLY n vs the existing document (n may be negative). Update rules only.',
      examples: [`allow update: if incrementedBy('moveCount', 1);`],
    },
    {
      signature: 'changedBy(field: string, min: int, max: int): bool',
      description:
        'The field\'s delta is within [min, max] inclusive; a zero delta passes when the range spans 0.',
      examples: [`allow update: if changedBy('likeCount', -1, 1);`],
    },
    {
      signature: 'boundedNumber(field: string, min: number, max: number): bool',
      description:
        'The incoming value is an int or float within [min, max]. Missing field reads null (dynamic access) and fails closed.',
      examples: [`allow write: if boundedNumber('rating', 1, 5);`],
    },
  ],
  relatedKeys: ['lifecycle', 'state'],
};

const TIMING_MODULE: StdlibModuleDefinition = {
  key: 'timing',
  kind: 'user-module',
  description:
    'User-authored module: cooldown / rate-limit enforcement (cooldownElapsed). Self-contained. Live-verified against the production engine.',
  purpose:
    'Rules CAN rate-limit: compare `request.time` against a stored server timestamp with duration arithmetic. Enforces a minimum interval between writes to a document.',
  whenToUse:
    "Reach for `timing` to throttle per-document writes — game move intervals, post cooldowns, retry backoff. ALWAYS pair with lifecycle's `isServerTimestamp(field)` on the same write so the stored timestamp cannot be forged by the client. Per-document intervals only; sliding-window quotas need a counter document plus this guard.",
  entries: [
    {
      signature: 'cooldownElapsed(field: string, seconds: int): bool',
      description:
        "`request.time > resource.data[field] + duration.value(seconds, 's')` — the stored timestamp is STRICTLY older than the window. Update rules only (needs `resource`); a missing or non-timestamp field errors, which denies (fail-closed).",
      examples: [
        `allow update: if cooldownElapsed('lastMoveAt', 2) && isServerTimestamp('lastMoveAt');`,
      ],
    },
  ],
  relatedKeys: ['lifecycle', 'timestamp', 'duration'],
};

const CONTENT_MODULE: StdlibModuleDefinition = {
  key: 'content',
  kind: 'user-module',
  description:
    'User-authored module: author-owned documents (validAuthorCreate, isAuthor, canReadContent, notDeleted). Self-contained. Field names are parameters, not conventions.',
  purpose:
    'The most common Firebase app shape — posts, notes, docs, comments, tasks. Covers the create/read/update/delete lifecycle of documents that belong to their author, with draft/published visibility and soft delete.',
  whenToUse:
    'Reach for `content` on any collection whose documents have an author/owner field. Compose with lifecycle.onlyFieldsChanged to keep authorship immutable on edits.',
  entries: [
    {
      signature: 'validAuthorCreate(authorField: string): bool',
      description:
        'Create guard: signed in AND the incoming doc\'s author field is the caller\'s uid.',
      examples: [`allow create: if validAuthorCreate('author');`],
    },
    {
      signature: 'isAuthor(authorField: string): bool',
      description: 'The caller is the EXISTING document\'s author. Update/delete rules.',
      examples: [`allow update: if isAuthor('author') && onlyFieldsChanged(['title', 'body']);`],
    },
    {
      signature: 'canReadContent(statusField: string, authorField: string): bool',
      description:
        "Published content is public; anything else is visible to its author only. `get` rules — a bare collection `list` will be denied unless the query proves `status == 'published'` via filters (rules are not filters).",
      examples: [`allow read: if canReadContent('status', 'author') && notDeleted();`],
    },
    {
      signature: 'notDeleted(): bool',
      description:
        "Soft-delete guard: `resource.data['deleted'] != true`. Bracket access is the null-on-miss idiom, so a document WITHOUT the field passes.",
    },
  ],
  relatedKeys: ['auth', 'lifecycle', 'validation'],
};

const SPACES_MODULE: StdlibModuleDefinition = {
  key: 'spaces',
  kind: 'user-module',
  description:
    'User-authored module: cross-document membership gating (isSpaceMember, hasSpaceRole, validMemberCreate). Explicit param — pass the parent doc data from a get(). Live-verified against the production engine.',
  purpose:
    "Shared spaces — teams, rooms, groups, projects, parties: a PARENT document's members field gates its children. The second-most-common app shape after author-owned content.",
  whenToUse:
    "Reach for `spaces` whenever a subcollection is gated by a parent doc. Define ONE helper in the child match block — `function space() { return get(/databases/$(database)/documents/spaces/$(spaceId)).data; }` — and pass it to every function: get() is cached per request, so all rules on the request share a single read of the 10-get budget. Do NOT inline a get() per allow clause.",
  entries: [
    {
      signature: 'isSpaceMember(spaceData: map): bool',
      description:
        "The caller's uid is in `spaceData.members`. `in` covers BOTH shapes: list membership (`members: ['a','b']`) and map keys (`members: {a: 'admin'}`). Missing field / non-member / missing parent doc all fail closed.",
      examples: [`allow read: if isSpaceMember(space());`],
    },
    {
      signature: 'hasSpaceRole(spaceData: map, role: string): bool',
      description:
        "The caller's role in a MAP-shaped members field equals `role` (`spaceData.members[request.auth.uid] == role`). List-shaped members carry no roles — denies.",
      examples: [`allow delete: if hasSpaceRole(space(), 'admin');`],
    },
    {
      signature: 'validMemberCreate(spaceData: map, authorField: string): bool',
      description:
        'Member-gated authored create: caller is a member AND the incoming child doc\'s author field is the caller. The "post a message / add a task" guard.',
      examples: [`allow create: if validMemberCreate(space(), 'author');`],
    },
  ],
  relatedKeys: ['membership', 'content', 'builtins'],
};

const JOINING_MODULE: StdlibModuleDefinition = {
  key: 'joining',
  kind: 'user-module',
  description:
    'User-authored module: safe self-service membership changes (onlyAddedSelf, onlyRemovedSelf). Self-contained. Live-verified against the production engine.',
  purpose:
    'How membership CHANGES without an admin backend: users join and leave a MAP-shaped members field (uid -> role) with zero privilege escalation — no self-granted roles, no touching other members, no-op writes denied.',
  whenToUse:
    "Reach for `joining` on the PARENT doc's update rule wherever spaces gates the children. ALWAYS compose with lifecycle's onlyFieldsChanged(['members']) so a join/leave write cannot modify anything else on the doc. Invite-doc consumption (single-use invites) is a Pattern, not a function — it needs a batch write + getAfter().",
  entries: [
    {
      signature: 'onlyAddedSelf(membersField: string, role: string): bool',
      description:
        "The write adds EXACTLY the caller to the members map at EXACTLY `role` — changing nobody, removing nobody; a no-op write denies (uses set equality `diff.addedKeys() == [uid].toSet()`, not hasOnly, which passes on an empty diff). Update rules only.",
      examples: [
        `allow update: if onlyFieldsChanged(['members']) && (onlyAddedSelf('members', 'editor') || onlyRemovedSelf('members'));`,
      ],
    },
    {
      signature: 'onlyRemovedSelf(membersField: string): bool',
      description:
        'The write removes EXACTLY the caller — adding nobody, changing nobody. Self-service leave. Update rules only.',
    },
  ],
  relatedKeys: ['spaces', 'lifecycle', 'membership'],
};

const ATOMIC_MODULE: StdlibModuleDefinition = {
  key: 'atomic',
  kind: 'user-module',
  description:
    'User-authored module: cross-document BATCH-write integrity via get()/getAfter() (companionChangedBy, consumedFlag). Explicit param. Live-verified against a real production database.',
  purpose:
    'Rules that require a COMPANION write in the same atomic batch: denormalized counters (create task + increment team.taskCount), single-use invite consumption (join + mark invite used), paired documents. getAfter(path) returns the post-batch state of another doc in the batch; for docs not in the batch it equals get(path).',
  whenToUse:
    "Reach for `atomic` when two documents must change together. Define before()/after() helpers — `get(path).data` and `getAfter(path).data` for the SAME companion path — and pass both. Every write in a batch is rules-evaluated: the companion write needs its own allow rule. The client must use a batch/transaction (writeBatch / runTransaction); solo writes deny by construction.",
  entries: [
    {
      signature: 'companionChangedBy(before: map, after: map, field: string, n: int): bool',
      description:
        "The companion doc's field changed by EXACTLY n in this batch (`after[field] == before[field] + n`). A solo write denies: without a companion write, getAfter == get, so the delta is 0.",
      examples: [
        `allow create: if companionChangedBy(teamBefore(), teamAfter(), 'taskCount', 1);`,
      ],
    },
    {
      signature: 'consumedFlag(before: map, after: map, flagField: string): bool',
      description:
        'A single-use flag was consumed IN THIS BATCH: pre-batch false AND post-batch true. Replays deny (already true before the batch); solo writes deny (false != true when getAfter == get). Pair with an allow rule on the flag doc itself (e.g. invitee-only, resource.used == false).',
      examples: [
        `allow update: if consumedFlag(inviteBefore(), inviteAfter(), 'used');`,
      ],
    },
  ],
  relatedKeys: ['counters', 'joining', 'spaces', 'builtins'],
};

const STORAGE_UPLOADS_MODULE: StdlibModuleDefinition = {
  key: 'storage/uploads',
  kind: 'user-module',
  description:
    'Storage module: inclusive upload-size limits and declared MIME metadata allowlists.',
  purpose:
    'Apply bounded upload policies to the incoming Storage object. MIME helpers inspect declared metadata; they do not inspect or authenticate the uploaded bytes.',
  whenToUse:
    'Use for Storage create or update rules that limit object size or accepted content-type metadata.',
  entries: [
    {
      signature: 'sizeAtMost(maxBytes: int): bool',
      description: 'The incoming object size is at most the inclusive byte limit.',
    },
    {
      signature: 'sizeBetween(minBytes: int, maxBytes: int): bool',
      description: 'The incoming object size is inside the inclusive byte range.',
    },
    {
      signature: 'contentTypeMatches(pattern: string): bool',
      description: 'The incoming content-type metadata matches the entire RE2 pattern.',
      notes: 'This checks declared metadata, not the uploaded bytes.',
    },
    {
      signature: 'contentTypeIsOneOf(types: list): bool',
      description: 'The incoming content-type metadata equals one allowlisted value.',
      notes: 'This checks declared metadata, not the uploaded bytes.',
    },
  ],
  relatedKeys: ['auth', 'membership', 'storage/metadata', 'storage/objects'],
};

const STORAGE_METADATA_MODULE: StdlibModuleDefinition = {
  key: 'storage/metadata',
  kind: 'user-module',
  description:
    'Storage module: required custom metadata, bounded string values, and metadata ownership.',
  purpose:
    'Validate the flat string map in Storage custom metadata and connect incoming or existing ownership metadata to the authenticated UID.',
  whenToUse:
    'Use when object paths alone do not carry every upload invariant and custom metadata must be present, bounded, or owner-bound.',
  entries: [
    {
      signature: 'hasRequiredMetadata(keys: list): bool',
      description: 'The incoming custom metadata contains every required key.',
    },
    {
      signature: 'metadataString(key: string, min: int, max: int): bool',
      description: 'The incoming metadata value is a string within the inclusive size range.',
    },
    {
      signature: 'incomingMetadataOwner(key: string): bool',
      description: 'The incoming metadata value equals the authenticated UID.',
    },
    {
      signature: 'existingMetadataOwner(key: string): bool',
      description: 'The existing metadata value equals the authenticated UID.',
    },
  ],
  relatedKeys: ['auth', 'membership', 'storage/uploads', 'storage/objects'],
};

const STORAGE_OBJECTS_MODULE: StdlibModuleDefinition = {
  key: 'storage/objects',
  kind: 'user-module',
  description:
    'Storage module: distinguish create, update, and delete operations safely.',
  purpose:
    'Branch Storage authorization by request method without relying on missing resource bindings or null checks.',
  whenToUse:
    'Use when create, update, and delete require different ownership or validation checks.',
  entries: [
    {
      signature: 'isCreate(): bool',
      description: "The Storage request method is 'create'.",
    },
    {
      signature: 'isUpdate(): bool',
      description: "The Storage request method is 'update'.",
    },
    {
      signature: 'isDelete(): bool',
      description: "The Storage request method is 'delete'.",
    },
  ],
  relatedKeys: ['auth', 'membership', 'storage/uploads', 'storage/metadata'],
};

const STORAGE_TIME_MODULE: StdlibModuleDefinition = {
  key: 'storage/time',
  kind: 'user-module',
  description:
    'Storage module: strict freshness windows over server-owned object timestamps.',
  purpose:
    'Check whether an existing Storage object was created or updated within a bounded number of seconds.',
  whenToUse:
    'Use for access policies whose validity expires relative to an existing object timestamp.',
  entries: [
    {
      signature: 'createdWithin(seconds: int): bool',
      description: 'Request time is strictly before creation time plus the window.',
      notes: 'Equality with the deadline denies. Requires an existing object.',
    },
    {
      signature: 'updatedWithin(seconds: int): bool',
      description: 'Request time is strictly before update time plus the window.',
      notes: 'Equality with the deadline denies. Requires an existing object.',
    },
  ],
  relatedKeys: ['storage/objects', 'auth', 'membership'],
};

function servicesForModule(module: StdlibModuleDefinition): readonly RulesService[] {
  if (module.kind !== 'user-module') return ['firestore'];
  const contracts =
    STDLIB_SERVICE_CONTRACTS[module.key as keyof typeof STDLIB_SERVICE_CONTRACTS];
  if (!contracts) return ['firestore'];
  return contracts.map((service) =>
    service === 'firebase.storage' ? 'storage' : 'firestore',
  );
}

export const STDLIB_MODULES: ReadonlyArray<StdlibModule> = [
  // top-level callables (get / exists / getAfter / debug)
  BUILTINS_MODULE,
  // language namespaces
  MATH,
  TIMESTAMP_NS,
  DURATION_NS,
  LATLNG_NS,
  HASHING_NS,
  // type methods
  STRING_METHODS,
  LIST_METHODS,
  MAP_METHODS,
  BYTES_METHODS,
  PATH_METHODS,
  // globals
  REQUEST_GLOBALS,
  RESOURCE_GLOBALS,
  // user-authored modules
  AUTH_MODULE,
  VALIDATION_MODULE,
  LOBBY_MODULE,
  TURNS_MODULE,
  STATE_MODULE,
  MEMBERSHIP_MODULE,
  LIFECYCLE_MODULE,
  TRANSITIONS_MODULE,
  GEOMETRY_MODULE,
  COUNTERS_MODULE,
  TIMING_MODULE,
  CONTENT_MODULE,
  SPACES_MODULE,
  JOINING_MODULE,
  ATOMIC_MODULE,
  STORAGE_UPLOADS_MODULE,
  STORAGE_METADATA_MODULE,
  STORAGE_OBJECTS_MODULE,
  STORAGE_TIME_MODULE,
].map((module) => ({
  ...module,
  services: servicesForModule(module),
}));

/** Catalog entries compatible with one Rules service. */
export function modulesForService(service: RulesService): StdlibModule[] {
  return STDLIB_MODULES.filter((module) => module.services.includes(service));
}

/** Look up a module by case-insensitive key. */
export function findModuleByKey(
  key: string,
  service?: RulesService,
): StdlibModule | undefined {
  const k = key.toLowerCase();
  return STDLIB_MODULES.find(
    (m) =>
      m.key.toLowerCase() === k &&
      (service === undefined || m.services.includes(service)),
  );
}

/** All valid keys — used in the error response when a get-call misses. */
export function allModuleKeys(service?: RulesService): string[] {
  return (service ? modulesForService(service) : STDLIB_MODULES).map(
    (m) => m.key,
  );
}

/** Closest-match suggestion (cheap Levenshtein) for a bad key. */
export function suggestKey(
  input: string,
  service?: RulesService,
): string | null {
  const want = input.toLowerCase();
  let best: { key: string; d: number } | null = null;
  for (const m of service ? modulesForService(service) : STDLIB_MODULES) {
    const d = levenshtein(want, m.key.toLowerCase());
    if (best === null || d < best.d) best = { key: m.key, d };
  }
  // Only return a suggestion if it's reasonably close.
  if (best && best.d <= Math.max(2, Math.floor(want.length / 3))) return best.key;
  return null;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const v0: number[] = new Array(b.length + 1).fill(0).map((_, i) => i);
  const v1: number[] = new Array(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1]! + 1, v0[j]! + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j]!;
  }
  return v1[b.length]!;
}
