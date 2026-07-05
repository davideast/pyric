/**
 * Cross-reference detection (F2).
 *
 * A Studio data grid shows raw field values. Many of those values are really
 * *references into another service*: a `users/{uid}` doc carries a uid that
 * names an Auth user; an `avatar` field carries a `gs://…` path that names a
 * Storage object; a relation field carries a Firestore document path. This
 * module is the pure, well-tested detector that turns a raw field value into a
 * typed {@link CrossRef} the UI can render as a clickable jump.
 *
 * It is deliberately conservative: false positives (turning an ordinary string
 * into a bogus link) are worse than false negatives, so the heuristics are
 * narrow and documented. Navigation (switching the active sub-view) lives in
 * `navigation.ts`; this file only *classifies*.
 *
 * The detector is sync, allocation-light, and has no React / sandbox imports so
 * it can be unit-tested in isolation (`refs.test.ts`).
 */

/** A storage-object reference (`gs://bucket/path` or a bare bucket path). */
export interface StorageRef {
  kind: 'storage';
  /** Bucket-rooted object path (no `gs://`, no bucket, no leading slash). */
  objectPath: string;
  /** Bucket when the value was a full `gs://bucket/path` URI; else null. */
  bucket: string | null;
  /** The original raw value, preserved for display. */
  raw: string;
}

/** An Auth-user reference (a field whose value is a user uid). */
export interface UserRef {
  kind: 'user';
  uid: string;
  raw: string;
}

/** A Firestore document reference (a `collection/doc/...` path). */
export interface DocumentRef {
  kind: 'document';
  /** Normalised document path (no leading/trailing slash). */
  path: string;
  raw: string;
}

/** No cross-service meaning: render as a plain value. */
export interface PlainRef {
  kind: 'plain';
  raw: string;
}

export type CrossRef = StorageRef | UserRef | DocumentRef | PlainRef;

/** Options that sharpen detection using the value's *context*. */
export interface DetectRefOptions {
  /**
   * The field's key (e.g. `ownerUid`, `avatar`, `ref`). A key that looks
   * uid-ish (`uid`, `userId`, `ownerId`, …) lets an otherwise-ambiguous token
   * resolve to a {@link UserRef}; without it a bare token stays {@link PlainRef}
   * (conservative: we don't want every id-shaped string to become a user link).
   */
  fieldKey?: string;
  /**
   * Known Auth uids. When provided, an exact membership test is authoritative
   * for user detection, far stronger than the field-name heuristic, so a
   * value that *is* a real uid always links regardless of the field name.
   */
  knownUids?: ReadonlySet<string>;
}

// ─── gs:// + storage paths ─────────────────────────────────────────────────

const GS_URI = /^gs:\/\/([^/]+)\/(.+)$/;

/** Strip leading/trailing slashes so path forms agree. */
function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

/**
 * A field key that conventionally holds a Storage object path/URL even when the
 * value itself is a bare path (no `gs://`). Used only to upgrade a plain string
 * to a storage ref; `gs://` is detected structurally regardless of key.
 */
const STORAGE_KEY = /(^|[^a-z])(avatar|photo|image|file|object|attachment|upload|media|thumbnail|gspath|storagepath)([^a-z]|$)/i;

// ─── uid heuristics ────────────────────────────────────────────────────────

/**
 * Firebase Auth uids are 28-char base64url-ish tokens, but the sandbox also
 * mints readable `user-1` / `alice` uids. So uid *shape* alone is a weak
 * signal; we lean on `knownUids` (authoritative) and the field name.
 *
 * Field names are split into normalised word-parts (camelCase / snake_case /
 * kebab-case) before matching, so `ownerUid`, `owner_uid`, `userId`, and
 * `createdBy` all resolve. The whole-word tokens that name a user reference:
 */
const UID_WORDS = new Set([
  'uid',
  'userid',
  'ownerid',
  'authorid',
  'memberid',
  'assigneeid',
  'userref',
  'createdby',
  'updatedby',
  'owner',
  'author',
  'assignee',
]);

/** Split a field key into lowercase word-parts (camel/snake/kebab aware). */
function wordParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** Person-ish nouns that, when followed by `uid`/`id`/`ref`, name a user. */
const PERSON_WORDS = new Set([
  'user',
  'owner',
  'author',
  'member',
  'assignee',
  'creator',
  'editor',
  'account',
]);

/** True when the field key names a user reference (e.g. `ownerUid`, `userId`). */
function isUidKey(key: string): boolean {
  const parts = wordParts(key);
  // A bare `uid` part is always a user ref (`uid`, `user_uid`).
  if (parts.includes('uid')) return true;
  // A whole-word match (`userId` → ['user','id'] joins below; `userref`).
  if (parts.some((p) => UID_WORDS.has(p))) return true;
  // Adjacent-pair joins: `owner`+`uid` → `owneruid`, `user`+`id` → `userid`.
  for (let i = 0; i < parts.length - 1; i++) {
    if (UID_WORDS.has(parts[i]! + parts[i + 1]!)) return true;
  }
  // A person-ish word directly followed by `id`/`ref` (`member id`).
  for (let i = 0; i < parts.length - 1; i++) {
    if (PERSON_WORDS.has(parts[i]!) && (parts[i + 1] === 'id' || parts[i + 1] === 'ref')) {
      return true;
    }
  }
  return false;
}

/** A token that *could* be a uid: no slashes/spaces, reasonable length. */
const UID_SHAPED = /^[A-Za-z0-9_-]{1,128}$/;

// ─── document-path heuristic ───────────────────────────────────────────────

/**
 * A Firestore document path has an even number of non-empty segments
 * (collection/doc/collection/doc…), each free of characters Firestore forbids.
 * We require ≥ 2 segments and no `gs://` scheme so `users/alice` reads as a doc
 * ref but a bare collection id or a URL does not.
 */
function looksLikeDocumentPath(value: string): boolean {
  if (value.includes('://')) return false;
  const trimmed = trimSlashes(value);
  if (!trimmed.includes('/')) return false;
  const segments = trimmed.split('/');
  if (segments.length % 2 !== 0) return false;
  return segments.every((s) => s.length > 0 && !s.includes('.'));
}

// ─── the detector ──────────────────────────────────────────────────────────

/**
 * Classify a single field value into a {@link CrossRef}.
 *
 * Only string values can be references; everything else (numbers, booleans,
 * objects, arrays, null) is {@link PlainRef}. Precedence, most- to
 * least-specific:
 *   1. `gs://bucket/path`               → storage (structural, key-independent)
 *   2. known uid (exact membership)     → user
 *   3. uid-ish field name + uid shape   → user
 *   4. storage-ish field name + path    → storage (bare path)
 *   5. document path shape              → document
 *   6. otherwise                        → plain
 */
export function detectRef(value: unknown, options: DetectRefOptions = {}): CrossRef {
  if (typeof value !== 'string') {
    return { kind: 'plain', raw: stringifyForDisplay(value) };
  }
  const raw = value;
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'plain', raw };

  // 1. gs:// storage URI: structural, wins over everything.
  const gs = GS_URI.exec(trimmed);
  if (gs) {
    return {
      kind: 'storage',
      bucket: gs[1]!,
      objectPath: trimSlashes(gs[2]!),
      raw,
    };
  }

  const { fieldKey, knownUids } = options;

  // 2. Authoritative uid membership: strongest user signal.
  if (knownUids && knownUids.has(trimmed)) {
    return { kind: 'user', uid: trimmed, raw };
  }

  // 3. uid-ish field name + uid-shaped value.
  if (fieldKey && isUidKey(fieldKey) && UID_SHAPED.test(trimmed)) {
    return { kind: 'user', uid: trimmed, raw };
  }

  // 4. storage-ish field name + bare (non-gs://) path.
  if (
    fieldKey &&
    STORAGE_KEY.test(fieldKey) &&
    !trimmed.includes('://') &&
    trimmed.includes('/')
  ) {
    return { kind: 'storage', bucket: null, objectPath: trimSlashes(trimmed), raw };
  }

  // 5. Firestore document path shape.
  if (looksLikeDocumentPath(trimmed)) {
    return { kind: 'document', path: trimSlashes(trimmed), raw };
  }

  // 6. Plain.
  return { kind: 'plain', raw };
}

/** True when a value is a clickable cross-reference (not plain). */
export function isCrossRef(ref: CrossRef): ref is StorageRef | UserRef | DocumentRef {
  return ref.kind !== 'plain';
}

/** A short, human label for a detected reference (for the link text / a11y). */
export function describeRef(ref: CrossRef): string {
  switch (ref.kind) {
    case 'storage':
      return ref.bucket ? `gs://${ref.bucket}/${ref.objectPath}` : ref.objectPath;
    case 'user':
      return `user · ${ref.uid}`;
    case 'document':
      return ref.path;
    case 'plain':
      return ref.raw;
  }
}

/** Best-effort display string for a non-string field value. */
function stringifyForDisplay(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
