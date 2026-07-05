/**
 * Action Center: the aggregation reducer (Wave 2, F1).
 *
 * PURE. No React, no DOM, no `@pyric/sandbox` runtime import (type-only), so it
 * is trivially unit-testable and reusable. It folds a stream of `SandboxEvent`s
 * (the unified, cross-service log: Firestore `request`/`write`/listener events
 * PLUS the `service_mutation` envelope auth/storage/rtdb emit) into a small set
 * of human-readable **digest items**, each grouped by
 * `service · target · op · actor` and collapsing bursts into a count.
 *
 * WHY A REDUCER (not a list): the raw feed is high-volume and low-signal. "10
 * docs added to /users" is one line a human cares about; ten `write` events are
 * not. The reducer is the projection that turns the log into the Action Center's
 * "what just happened" digest, attributed to who did it.
 *
 * DESIGN
 * ------
 * - **Grouping key** = `service | bucket | op | actor`. `bucket` is the
 *   *collection* for Firestore doc paths (`/users/alice` → `users`), the
 *   service's own addressing for `service_mutation` (a storage *folder*, an
 *   auth scope, an rtdb path), so a burst of writes to sibling docs collapses
 *   into one item rather than fragmenting per-doc.
 * - **op** is normalised to a small verb set (`added`/`updated`/`removed`/
 *   `signed in`/`signed out`/`uploaded`/…) so the phrasing reads naturally.
 * - **actor** comes from `event.actor` (provenance): `app` / `studio` /
 *   `agent:<name>` / `app-builder`. Absent ⇒ the served `app`. The `authLens`
 *   ride-along records whether the op ran as admin / impersonating a uid.
 * - Each item keeps `count`, `firstAt`, `lastAt`, a bounded set of sample
 *   targets (for "…/users, /posts, +2 more"), and the identities seen.
 * - **Denials and reads are excluded** from the digest by default (they are
 *   Traffic's job); the reducer focuses on *mutations*, the things that change
 *   the backend. A denied `request` never produced a `write`, so folding only
 *   committed `write`s + `service_mutation`s keeps the digest about real change.
 *
 * The reducer is a plain `fold(events) → DigestItem[]`. The React view calls it
 * on the live buffer each render (cheap, the buffer is already bounded). A
 * `foldDigest(state, event)` incremental form is exported too for streaming.
 */

import type {
  AuthLens,
  AuthState,
  EventActor,
  SandboxEvent,
} from 'pyric/sandbox';

// ─── Public digest shape ────────────────────────────────────────────────────

/** The normalised verb a digest line reads with. */
export type DigestVerb =
  | 'added'
  | 'updated'
  | 'removed'
  | 'signed in'
  | 'signed out'
  | 'created' // a new auth user
  | 'deleted' // an auth user / storage object removed
  | 'cleared' // users_clear
  | 'uploaded'
  | 'changed'; // generic fallback (metadata_update, rtdb transaction, …)

/** Which actor a digest item is attributed to, normalised from provenance. */
export type DigestActor =
  | { kind: 'app' }
  | { kind: 'studio' }
  | { kind: 'agent'; name: string }
  | { kind: 'app-builder' };

/** A single aggregated activity line. */
export interface DigestItem {
  /** Stable grouping id: `service|bucket|verb|actor`. Good as a React key. */
  id: string;
  service: 'firestore' | 'auth' | 'storage' | 'rtdb';
  verb: DigestVerb;
  /**
   * The human-facing target the activity touched: a Firestore collection
   * (`users`), a storage folder (`avatars/`), an rtdb path, or `''` when the
   * op is target-less (e.g. a sign-out). Singular targets that collapsed a
   * burst still read against this.
   */
  bucket: string;
  actor: DigestActor;
  /** How many raw events folded into this item. */
  count: number;
  /** Epoch ms of the first and most recent contributing event. */
  firstAt: number;
  lastAt: number;
  /**
   * Up to {@link SAMPLE_CAP} distinct full targets seen (doc paths, object
   * paths, uids), newest first, for a "…/users/alice, /users/bob +3" detail.
   */
  samples: string[];
  /** Distinct count of full targets seen (may exceed `samples.length`). */
  distinctTargets: number;
  /**
   * Identities the op ran *as*: the auth uid(s) attached to the events
   * (`event.auth.uid`), newest first, bounded. Powers "alice@… signed in" and
   * "you, as bob" attribution. Empty when admin/anonymous.
   */
  identities: string[];
  /** True when any contributing op ran under the admin lens (rule bypass). */
  viaAdmin: boolean;
  /** When set, the uid the contributing ops impersonated (`authLens: as`). */
  impersonating?: string;
}

/** Max distinct sample targets / identities retained per item. */
export const SAMPLE_CAP = 5;

// ─── Internal accumulator ───────────────────────────────────────────────────

interface Bucket {
  item: DigestItem;
  /** Insertion-ordered distinct targets (so newest-first sampling is cheap). */
  seenTargets: Set<string>;
  seenIdentities: Set<string>;
}

export interface DigestState {
  /** Keyed by `DigestItem.id`. Insertion order ≈ first-seen order. */
  readonly buckets: Map<string, Bucket>;
}

export function emptyDigestState(): DigestState {
  return { buckets: new Map() };
}

// ─── Normalisation helpers ──────────────────────────────────────────────────

/** Firestore write method → digest verb. */
function firestoreVerb(method: string): DigestVerb {
  switch (method) {
    case 'create':
    case 'set':
      return 'added';
    case 'update':
      return 'updated';
    case 'delete':
      return 'removed';
    default:
      return 'changed';
  }
}

/** `service_mutation` `op` → digest verb, per the service vocabulary. */
function serviceVerb(service: string, op: string): DigestVerb {
  if (service === 'auth') {
    switch (op) {
      case 'user_create':
        return 'created';
      case 'user_update':
        return 'updated';
      case 'user_delete':
        return 'deleted';
      case 'users_clear':
        return 'cleared';
      case 'sign_in':
        return 'signed in';
      case 'sign_out':
        return 'signed out';
      default:
        return 'changed';
    }
  }
  if (service === 'storage') {
    switch (op) {
      case 'object_put':
        return 'uploaded';
      case 'object_delete':
        return 'deleted';
      default:
        return 'changed';
    }
  }
  // rtdb
  switch (op) {
    case 'set':
    case 'update':
      return 'updated';
    case 'remove':
      return 'removed';
    default:
      return 'changed';
  }
}

/**
 * Reduce a full target to its grouping bucket.
 *   - Firestore doc path `users/alice` → `users`; nested
 *     `users/alice/posts/p1` → `users/alice/posts` (the parent collection).
 *   - Storage `avatars/alice.png` → `avatars/` (the folder); a root object
 *     `logo.png` → `''` (root).
 *   - rtdb `/rooms/r1/messages/m1` → `/rooms/r1/messages` (parent path); other
 *     services pass the path through.
 */
function bucketFor(service: string, path: string | undefined): string {
  if (!path) return '';
  if (service === 'firestore') {
    const segs = path.split('/').filter(Boolean);
    // Doc paths have an even number of segments (coll/doc/coll/doc); drop the
    // trailing doc id to land on the collection. Already-collection paths (odd)
    // pass through.
    if (segs.length % 2 === 0) segs.pop();
    return segs.join('/');
  }
  if (service === 'storage') {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : `${path.slice(0, idx)}/`;
  }
  // rtdb / fallback: parent path.
  const segs = path.split('/').filter(Boolean);
  if (segs.length > 1) segs.pop();
  return `/${segs.join('/')}`;
}

/** Provenance actor → digest actor (absent ⇒ the served app). */
function normaliseActor(actor: EventActor | undefined): DigestActor {
  if (!actor) return { kind: 'app' };
  return actor;
}

function actorKey(actor: DigestActor): string {
  return actor.kind === 'agent' ? `agent:${actor.name}` : actor.kind;
}

function authUid(auth: AuthState | undefined): string | undefined {
  return auth && typeof auth === 'object' ? auth.uid : undefined;
}

function lensInfo(lens: AuthLens | undefined): {
  admin: boolean;
  impersonating?: string;
} {
  if (!lens) return { admin: false };
  if (lens.mode === 'admin') return { admin: true };
  if (lens.mode === 'as') return { admin: false, impersonating: lens.uid };
  return { admin: false };
}

// ─── The fold ───────────────────────────────────────────────────────────────

/**
 * One mutation extracted from a raw event, or `null` when the event is not a
 * digest-worthy mutation (reads, denials, listener lifecycle, snapshots,
 * session boundaries are all skipped; they're Traffic's domain, not the
 * activity digest's).
 */
interface Mutation {
  service: DigestItem['service'];
  verb: DigestVerb;
  bucket: string;
  /** The full target (doc/object/uid path), for sampling. May be ''. */
  target: string;
  at: number;
  actor: DigestActor;
  identity?: string;
  admin: boolean;
  impersonating?: string;
}

/** Project a raw event onto a mutation, or `null` to skip it. */
export function toMutation(event: SandboxEvent): Mutation | null {
  const actor = normaliseActor(event.actor);
  const lens = lensInfo(event.authLens);

  if (event.kind === 'write') {
    // Committed Firestore write: the real change (denied ops never reach here).
    return {
      service: 'firestore',
      verb: firestoreVerb(event.method),
      bucket: bucketFor('firestore', event.path),
      target: event.path,
      at: event.at,
      actor,
      identity: authUid(event.auth),
      admin: lens.admin,
      impersonating: lens.impersonating,
    };
  }

  if (event.kind === 'service_mutation') {
    const target =
      event.path ?? (event.service === 'auth' ? 'session' : '');
    return {
      service: event.service,
      verb: serviceVerb(event.service, event.op),
      bucket: bucketFor(event.service, event.path),
      target,
      at: event.at,
      actor,
      // For auth sign-in/out the acting identity IS the target uid; otherwise
      // the op's own auth context.
      identity:
        event.service === 'auth' && event.path && event.path !== '*'
          ? event.path
          : authUid(event.auth),
      admin: lens.admin,
      impersonating: lens.impersonating,
    };
  }

  // request / snapshot_delivery / snapshot_suppressed / listener_* /
  // session_boundary → not a mutation; skipped.
  return null;
}

function bucketKey(m: Mutation): string {
  return `${m.service}|${m.bucket}|${m.verb}|${actorKey(m.actor)}`;
}

/** Fold a single event into the running state (mutating it in place). */
export function foldDigest(state: DigestState, event: SandboxEvent): DigestState {
  const m = toMutation(event);
  if (!m) return state;

  const key = bucketKey(m);
  const existing = state.buckets.get(key);

  if (!existing) {
    const seenTargets = new Set<string>();
    const seenIdentities = new Set<string>();
    if (m.target) seenTargets.add(m.target);
    if (m.identity) seenIdentities.add(m.identity);
    state.buckets.set(key, {
      seenTargets,
      seenIdentities,
      item: {
        id: key,
        service: m.service,
        verb: m.verb,
        bucket: m.bucket,
        actor: m.actor,
        count: 1,
        firstAt: m.at,
        lastAt: m.at,
        samples: m.target ? [m.target] : [],
        distinctTargets: m.target ? 1 : 0,
        identities: m.identity ? [m.identity] : [],
        viaAdmin: m.admin,
        impersonating: m.impersonating,
      },
    });
    return state;
  }

  const { item, seenTargets, seenIdentities } = existing;
  item.count += 1;
  item.firstAt = Math.min(item.firstAt, m.at);
  item.lastAt = Math.max(item.lastAt, m.at);
  item.viaAdmin = item.viaAdmin || m.admin;
  if (m.impersonating) item.impersonating = m.impersonating;

  if (m.target && !seenTargets.has(m.target)) {
    seenTargets.add(m.target);
    item.distinctTargets = seenTargets.size;
    // newest-first, bounded
    item.samples = [m.target, ...item.samples].slice(0, SAMPLE_CAP);
  }
  if (m.identity && !seenIdentities.has(m.identity)) {
    seenIdentities.add(m.identity);
    item.identities = [m.identity, ...item.identities].slice(0, SAMPLE_CAP);
  }

  return state;
}

/**
 * Fold a whole stream into a digest, returned **newest-activity first** (by
 * `lastAt`). Pure: builds a fresh state, never mutates the input array.
 */
export function digestFromEvents(events: readonly SandboxEvent[]): DigestItem[] {
  const state = emptyDigestState();
  for (const event of events) foldDigest(state, event);
  return [...state.buckets.values()]
    .map((b) => b.item)
    .sort((a, b) => b.lastAt - a.lastAt);
}

// ─── Phrasing (display) ─────────────────────────────────────────────────────

/**
 * Render a digest item as a single human sentence: the line the Action Center
 * shows. Kept here (next to the reducer) because it is pure and unit-testable,
 * and the phrasing is part of the digest contract.
 *
 * Examples:
 *   "10 docs added to /users"            (firestore, count 10)
 *   "alice signed in"                    (auth sign_in, identity)
 *   "new user bob created"               (auth user_create)
 *   "3 objects uploaded to avatars/"     (storage object_put, count 3)
 */
export function phraseDigest(item: DigestItem): string {
  const n = item.count;
  const plural = (singular: string, many: string) => (n === 1 ? singular : many);

  if (item.service === 'firestore') {
    const noun = plural('doc', `${n} docs`);
    const where = item.bucket ? ` to /${item.bucket.replace(/^\//, '')}` : '';
    return `${noun} ${item.verb}${where}`;
  }

  if (item.service === 'auth') {
    switch (item.verb) {
      case 'signed in':
      case 'signed out': {
        const who = item.identities[0];
        if (n === 1 && who) return `${who} ${item.verb}`;
        return `${n} ${plural('user', 'users')} ${item.verb}`;
      }
      case 'created': {
        const who = item.identities[0];
        if (n === 1 && who) return `new user ${who} created`;
        return `${n} new users created`;
      }
      case 'deleted':
        return `${n} ${plural('user', 'users')} deleted`;
      case 'cleared':
        return `all users cleared`;
      default:
        return `${n} ${plural('user', 'users')} ${item.verb}`;
    }
  }

  if (item.service === 'storage') {
    const noun = plural('object', `${n} objects`);
    const where = item.bucket ? ` to ${item.bucket}` : '';
    const verb = item.verb === 'deleted' ? 'removed' : item.verb;
    return `${noun} ${verb}${where}`;
  }

  // rtdb / fallback
  const where = item.bucket ? ` at ${item.bucket}` : '';
  return `${n} ${plural('write', 'writes')} ${item.verb}${where}`;
}

/** A short attribution suffix ("· by agent:seed", "· admin", "· as alice"). */
export function attribution(item: DigestItem): string {
  const parts: string[] = [];
  const a = item.actor;
  if (a.kind === 'agent') parts.push(`agent:${a.name}`);
  else if (a.kind === 'studio') parts.push('Studio');
  else if (a.kind === 'app-builder') parts.push('App Builder');
  // 'app' is the implicit default, no suffix.
  if (item.impersonating) parts.push(`as ${item.impersonating}`);
  else if (item.viaAdmin) parts.push('admin');
  return parts.join(' · ');
}
