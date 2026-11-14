/**
 * Public shapes of the access-site extractor: what a client app reads and
 * writes in Firestore and the Realtime Database, read from its source.
 *
 * An access site is one operation call (`setDoc`, `update`,
 * `onDisconnect(ref).set`, `getDocs(query(...))`, ...) with the path it
 * touches, the shape of the payload it writes, and how sure the extractor
 * is. Nothing is dropped: a call the extractor recognises but can't trace
 * is reported with `resolution: 'unresolved'` and a reason.
 */
import type { AssuranceService } from '../../sandbox/internal/resource-pattern.js';
import type { EmbeddedRules } from './embedded-rules.js';
import type { SdkServiceModel } from './service-models/types.js';

/** Which service a site touches. */
export type AccessService = AssuranceService;

/**
 * How completely the extractor traced a site.
 *
 * - `resolved`: the path was traced to a database root, and every
 *   segment is a literal or a named variable.
 * - `partial`: a path was found, but some alternative could not be
 *   traced, or the trace relied on an assumption named in `reason`.
 * - `unresolved`: the operation was recognised but its path could not be
 *   traced. `reason` says where the trace stopped.
 */
export type AccessResolution = 'resolved' | 'partial' | 'unresolved';

/**
 * Where a value came from, when it came from the signed-in user.
 * `auth.uid` is the uid of the signed-in user, read from a Firebase Auth
 * user object (`auth.currentUser`, the `onAuthStateChanged` callback
 * argument, a sign-in credential's `user`).
 */
export type AuthSource =
  | 'auth.uid'
  | 'auth.displayName'
  | 'auth.email'
  | 'auth.photoURL'
  | 'auth.phoneNumber'
  | `auth.token.${string}`;

/**
 * Provenance attached to a path variable or a payload field.
 * `certainty: 'exact'` means every traced alternative is the auth value;
 * `partial` means some alternatives are (for example `user?.uid || ""`,
 * or a key built as `${uid}:${tabId}`).
 */
export interface AuthProvenance {
  source: AuthSource;
  certainty: 'exact' | 'partial';
}

/** A variable segment of a path template. */
export interface PathVariable {
  /** Name as rendered in the template, without `{}` or `$`. */
  name: string;
  /** Present when the variable's value comes from the signed-in user. */
  auth?: AuthProvenance[];
  /** For a segment built around the uid, how: `{auth.uid}:{*}`. Absent when it is the uid itself. */
  pattern?: string;
}

/** One field of a written payload. */
export interface PayloadField {
  /** Field name, or a multi-segment key (`a/b`) for RTDB multi-path updates. */
  name: string;
  /** Coarse kind of the written value. */
  kind:
    | 'string'
    | 'number'
    | 'boolean'
    | 'null'
    | 'object'
    | 'array'
    | 'serverTimestamp'
    | 'increment'
    | 'arrayUnion'
    | 'arrayRemove'
    | 'deleteField'
    | 'unknown';
  /** Set when the value comes from the signed-in user. */
  auth?: AuthProvenance[];
  /** True when the field is only written on some paths (`payload.x = ...` under a branch, a spread). */
  optional?: boolean;
  /** True when `kind === 'array'` and every traced alternative contains at least one non-null RTDB element. */
  nonEmpty?: boolean;
  /** Literal value, when it is a short literal. */
  literal?: string | number | boolean | null;
}

/** The written payload of a write site. */
export interface PayloadShape {
  /** `object` when the payload is an object literal; otherwise the value kind. */
  kind: PayloadField['kind'];
  fields: PayloadField[];
  /** True when the payload has fields the extractor could not enumerate (an unknown spread, a computed key). */
  open: boolean;
  /** True when `kind === 'array'` and every traced alternative contains at least one non-null RTDB element. */
  nonEmpty?: boolean;
  /** Present on `setDoc(..., { merge: true })`. */
  merge?: boolean;
  /** Set when the payload itself comes from the signed-in user (`set(ref, user.uid)`). */
  auth?: AuthProvenance[];
  literal?: string | number | boolean | null;
}

/** A query constraint shape, for query sites. */
export interface QueryConstraint {
  kind: string;
  field?: string;
  op?: string;
  direction?: 'asc' | 'desc';
}

export type StorageHttpHeaderKey =
  | 'cacheControl'
  | 'contentDisposition'
  | 'contentEncoding'
  | 'contentLanguage';

/** Static upload payload and metadata facts extracted from a Cloud Storage write site. */
export interface StorageUploadMetadata {
  /** Static MIME type (`metadata.contentType`, `Blob` `type`, or `data:` URL header). */
  readonly contentType?: string;
  /** True when `metadata.contentType` is omitted/unset on an untraced `Blob` or `File` payload whose `.type` is determined at runtime. */
  readonly blobContentTypeUnresolved?: boolean;
  /** Exact payload size in bytes when statically determinable. */
  readonly sizeBytes?: number;
  /** Static `cacheControl` HTTP metadata header when determinable. */
  readonly cacheControl?: string;
  /** Static `contentDisposition` HTTP metadata header when determinable. */
  readonly contentDisposition?: string;
  /** Static `contentEncoding` HTTP metadata header when determinable. */
  readonly contentEncoding?: string;
  /** Static `contentLanguage` HTTP metadata header when determinable. */
  readonly contentLanguage?: string;
  /** True when one or more HTTP metadata header properties (`cacheControl`, `contentDisposition`, `contentEncoding`, `contentLanguage`) could not be statically resolved. */
  readonly httpMetadataUnresolved?: boolean;
  /** Specific HTTP metadata header keys whose runtime values could not be statically resolved. */
  readonly httpMetadataUnresolvedFields?: readonly StorageHttpHeaderKey[];
  /** Sorted custom metadata keys when statically known. */
  readonly customMetadataKeys?: readonly string[];
  /** Per-key value shape and auth provenance for `customMetadata` entries. */
  readonly customMetadata?: Readonly<Record<string, PayloadField>>;
  /** True when `customMetadata` or the enclosing metadata object has spread or dynamic computed keys. */
  readonly customMetadataOpen?: boolean;
  /** True when an explicit metadata argument or `customMetadata` value could not be statically resolved. */
  readonly customMetadataUnresolved?: boolean;
}

/** One access site. */
export interface AccessSite {
  /**
   * Path template. Firestore and Storage variables render as `{name}`, RTDB
   * variables as `$name`. No leading slash. Empty string when unresolved.
   */
  path: string;
  service: AccessService;
  /** Non-default service resource identifier (named database, RTDB instance, or Storage bucket), when known. */
  resourceId?: string;
  /** True when invoked via an Admin SDK handle (`firebase-admin/*`, `pyric-admin/*`). */
  admin?: boolean;
  /**
   * Operation, named after the SDK call: `set`, `update`, `remove`,
   * `push`, `transaction`, `onDisconnect.set`, `setDoc`, `addDoc`,
   * `updateDoc`, `deleteDoc`, `uploadBytes`, `getDownloadURL`, `get`, `query`.
   */
  op: string;
  /** `batch` or `transaction` when a Firestore write went through one. */
  via?: 'batch' | 'transaction';
  /** True for listeners (`onSnapshot`, `onValue`, `onChild*`). */
  listen?: boolean;
  /** `file:line`, file relative to the scanned root. */
  source: string;
  /**
   * When the SDK call sits inside an in-project wrapper (a helper, a
   * driver method) and the site is attributed to the wrapper's caller,
   * the SDK call's own `file:line`.
   */
  through?: string;
  resolution: AccessResolution;
  /** Present when `resolution` is not `resolved`. */
  reason?: string;
  /** Variables in the path, in order. */
  pathVariables?: PathVariable[];
  /** Written payload, for writes that carry one. */
  payload?: PayloadShape;
  /** Static upload metadata (MIME type, byte length, customMetadata) for Storage writes. */
  storageUpload?: StorageUploadMetadata;
  /** Constraint shape, for query sites. */
  query?: QueryConstraint[];
  /** True when the site is one key of an RTDB multi-path `update`. */
  multiPath?: boolean;
}

/** App-specific conventions, supplied as data rather than code. */
export interface AccessPreset {
  /** Preset name, for reports. */
  name: string;
  /** Extra module specifiers that export the Firestore modular API. */
  firestoreModules?: string[];
  /** Extra module specifiers that export the RTDB modular API. */
  rtdbModules?: string[];
  /** Extra module specifiers that export the Storage modular API. */
  storageModules?: string[];
  /** Extra module specifiers that export the Auth modular API. */
  authModules?: string[];
  /**
   * Functions (by `module#export`) whose return value is the signed-in
   * Firebase user, for user hooks that live outside the project.
   */
  authUserFunctions?: string[];
  /** Path substrings to skip when scanning (tests, fixtures). */
  exclude?: string[];
}

/** Options for {@link extractAccessSites}. */
export interface ExtractAccessSitesOptions {
  /** Directory to scan. File paths in the result are relative to it. */
  root: string;
  /**
   * In-memory files, keyed by path relative to `root`. When present, the
   * extractor reads only these and never touches the file system.
   */
  files?: Record<string, string>;
  clientRoots?: string[];
  serverRoots?: string[];
  /** Presets to apply on top of the built-in Firebase Web preset. */
  presets?: AccessPreset[];
  /** Additional declarative SDK service models registered alongside Firestore and RTDB. */
  serviceModels?: readonly SdkServiceModel[];
  /** Include read sites (`get`, `query`, listeners). Defaults to true. */
  includeReads?: boolean;
}

/** Summary counts per resolution. */
export interface AccessSiteCounts {
  total: number;
  writes: number;
  reads: number;
  resolved: number;
  partial: number;
  unresolved: number;
}

/** Result of {@link extractAccessSites}. */
export interface AccessSiteReport {
  accessSites: AccessSite[];
  counts: AccessSiteCounts;
  /** Files scanned, relative to root. */
  filesScanned: number;
  /** tsconfig files used to build programs, relative to root. */
  projects: string[];
  /** Security rules the app installs from code (Pyric's in-page sandbox, the rules unit-testing library). */
  embeddedRules: EmbeddedRules[];
}
