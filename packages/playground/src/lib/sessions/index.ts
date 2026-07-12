/**
 * Playground sessions — sandbox-backed local storage with opt-in
 * promote-to-Firestore (a future track).
 *
 * Sessions live at the canonical path
 *
 *   pyric/playground/sessions/{userId}/items/{sessionId}
 *
 * inside the playground's `@pyric/sandbox`. The sandbox itself
 * persists to IndexedDB via the persistence track, so this module is
 * effectively writing the user's local Firestore — no network, no
 * auth, no rules deploy required for the default save path.
 *
 * The API mirrors the data shape from
 * `plans/playground-home-page-and-sessions.md`:
 *
 *   subscribeSessions(userId, onChange) → Unsubscribe
 *   loadSession(userId, sessionId)      → { meta, payload }
 *   saveSession(userId, input)          → SessionMeta
 *   deleteSession(userId, sessionId)    → void
 *
 * `promoteSession` is intentionally not exported yet — it ships with
 * the `promote-flow` track when we wire the Firestore-rules helper
 * and the GIS-bearer REST PATCH path.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  Timestamp,
} from 'pyric/firestore';

import { getSessionsSandbox } from './sandbox';
import {
  SessionError,
  type SessionDoc,
  type SessionMeta,
  type SessionPayload,
  type PlaygroundSandboxMode,
  type SessionRemoteExportMeta,
  type SessionSaveInput,
} from './types';

export type {
  SessionMeta,
  SessionPayload,
  PlaygroundSandboxMode,
  SessionRemoteExportMeta,
  SessionSaveInput,
} from './types';
export { SessionError } from './types';
export { getCurrentUserId } from './userId';

/**
 * Resolves once the sessions sandbox has restored any prior persisted
 * blob. Callers that mount components reading session state should
 * await this before rendering — see `getSessionsSandbox().ready` for
 * the underlying primitive.
 */
export function sessionsReady(): Promise<void> {
  return getSessionsSandbox().ready;
}

/**
 * Force the sessions sandbox to flush its in-memory writes to the
 * persistence backend NOW, resolving once the write has committed.
 *
 * The home page calls this after `saveSession` and BEFORE it navigates
 * to `/playground?session={id}`. The persistence controller's auto-flush
 * is debounced (250ms) and its `beforeunload` safety flush cannot finish
 * an async IndexedDB write before the page unloads. Without an awaited
 * flush, a freshly-created session never reaches IndexedDB, so the new
 * `/playground` page restores an empty store, `loadSession` throws
 * `not-found`, and the page bounces straight back to `/` (the reload
 * loop). Awaiting `ready` first guarantees persistence is attached
 * before we flush.
 */
export async function flushSessions(): Promise<void> {
  const sandbox = getSessionsSandbox();
  await sandbox.ready;
  await sandbox.getSandbox().flush();
}

/** Max characters retained in `preview`. ASCII-roundish — matches what
 *  fits comfortably on one card line in the home page list. */
const PREVIEW_LIMIT = 120;
/** Max characters retained in an auto-derived `title`. Same heuristic
 *  as the preview, just shorter to fit a card heading. */
const TITLE_LIMIT = 60;

/**
 * Build the items collection ref for `userId`. Centralized so the
 * literal path lives in exactly one place — if the canonical path ever
 * moves, only this helper changes.
 */
function itemsCollectionPath(userId: string): string[] {
  return ['pyric', 'playground', 'sessions', userId, 'items'];
}

function docRefFor(userId: string, sessionId: string) {
  return doc(getSessionsSandbox().getDb(), ...itemsCollectionPath(userId), sessionId);
}

function collectionRefFor(userId: string) {
  return collection(getSessionsSandbox().getDb(), ...itemsCollectionPath(userId));
}

/**
 * Subscribe to the user's session list, ordered most-recently-updated
 * first. Fires once on attach with the current state, then again on
 * every save/delete. Returns an unsubscribe.
 *
 * Only metadata is hydrated — the payload field is stripped before
 * the callback receives `SessionMeta[]`, so the home page never
 * deserializes payloads it isn't about to display.
 *
 * The sort is applied client-side rather than via Firestore `orderBy`:
 * the sandbox's snapshot-listener target shape doesn't yet carry query
 * constraints (filters/orders/limits), so an `orderBy('updatedAt')`
 * passed to `query()` is silently dropped at the listener layer. Sort
 * here for now; switch to a real `orderBy` when the sandbox listener
 * surface grows constraint support.
 *
 * Callers should `await sessionsReady()` before subscribing if they
 * want to avoid a brief flash of an empty list on page load — the
 * persistence layer restores asynchronously, so subscribing before
 * restore completes works but produces an initial empty snapshot
 * followed by one snapshot per restored doc.
 */
export function subscribeSessions(
  userId: string,
  onChange: (sessions: SessionMeta[]) => void,
): () => void {
  return onSnapshot(collectionRefFor(userId), (snap) => {
    const s = snap as { docs: Array<{ id: string; data: () => unknown }> };
    const out: SessionMeta[] = [];
    for (const d of s.docs) {
      const raw = d.data() as Partial<SessionDoc> | undefined;
      if (!raw) continue;
      out.push(toMeta(raw, d.id));
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    onChange(out);
  });
}

/**
 * Load a session by id. Throws {@link SessionError} with code
 * `not-found` when the session doesn't exist or has been deleted, and
 * `invalid-payload` when the stored payload can't be parsed (shouldn't
 * happen in practice — a save-then-load round-trips cleanly).
 */
export async function loadSession(
  userId: string,
  sessionId: string,
): Promise<{ meta: SessionMeta; payload: SessionPayload }> {
  const ref = docRefFor(userId, sessionId);
  const snap = await getDoc(ref);
  const exists = typeof snap.exists === 'function'
    ? (snap.exists as () => boolean)()
    : snap.exists;
  if (!exists) {
    throw new SessionError('not-found', `Session '${sessionId}' not found for user '${userId}'`);
  }
  const raw = snap.data() as Partial<SessionDoc> | undefined;
  if (!raw || typeof raw.payload !== 'string') {
    throw new SessionError(
      'invalid-payload',
      `Session '${sessionId}' has no payload field`,
    );
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(raw.payload) as SessionPayload;
  } catch (e) {
    throw new SessionError(
      'invalid-payload',
      `Session '${sessionId}' payload is not valid JSON: ${(e as Error).message}`,
    );
  }
  return { meta: toMeta(raw, sessionId), payload };
}

/**
 * Create or update a session. Returns the fresh metadata so callers
 * can update their local cache without a re-read.
 *
 * `createdAt` is preserved across updates — the first save sets it,
 * subsequent saves only touch `updatedAt`. `title` and `preview`
 * regenerate from the payload's conversation when the caller doesn't
 * supply overrides; pass them explicitly for user-edited titles or
 * non-prompt-derived previews.
 */
export async function saveSession(
  userId: string,
  input: SessionSaveInput,
): Promise<SessionMeta> {
  if (!input.id) {
    throw new SessionError('invalid-payload', 'saveSession: id is required');
  }
  const payloadJson = JSON.stringify(input.payload);
  const now = Date.now();

  // Preserve `createdAt` from the prior version. Read-then-write
  // matches the `sessions-persistent` semantics; the sandbox is local
  // so the round-trip is sub-millisecond.
  const ref = docRefFor(userId, input.id);
  const prior = await getDoc(ref);
  const priorExists = typeof prior.exists === 'function'
    ? (prior.exists as () => boolean)()
    : prior.exists;
  const priorData = priorExists ? (prior.data() as Partial<SessionDoc>) : null;

  const meta: SessionMeta = {
    id: input.id,
    userId,
    title:
      input.title?.trim() ||
      priorData?.title ||
      deriveTitle(input.payload) ||
      'Untitled session',
    preview:
      input.preview?.trim() ||
      priorData?.preview ||
      derivePreview(input.payload) ||
      '',
    createdAt: priorData?.createdAt ?? now,
    updatedAt: now,
    payloadSize: payloadJson.length,
    ...(priorData?.promotedTo ? { promotedTo: priorData.promotedTo } : {}),
    ...(priorData?.remoteExports
      ? { remoteExports: normalizeRemoteExports(priorData.remoteExports) }
      : {}),
    ...(input.githubRepo
      ? { githubRepo: input.githubRepo }
      : priorData?.githubRepo
        ? { githubRepo: priorData.githubRepo }
        : {}),
    ...(input.sandboxMode
      ? { sandboxMode: input.sandboxMode }
      : normalizeSandboxMode(priorData?.sandboxMode)
        ? { sandboxMode: normalizeSandboxMode(priorData?.sandboxMode) }
        : {}),
  };

  const docToWrite: SessionDoc = {
    ...meta,
    payload: payloadJson,
  };

  await setDoc(ref, docToWrite as unknown as Record<string, unknown>);
  return meta;
}

/**
 * Append or replace the local metadata pointer for a remote telemetry
 * export. This deliberately does not touch `payload`: full-detail blobs live
 * in Firebase Storage, and the local autosave payload remains workspace/chat
 * only.
 */
export async function recordSessionRemoteExport(
  userId: string,
  sessionId: string,
  remoteExport: SessionRemoteExportMeta,
): Promise<SessionMeta> {
  const ref = docRefFor(userId, sessionId);
  const snap = await getDoc(ref);
  const exists = typeof snap.exists === 'function'
    ? (snap.exists as () => boolean)()
    : snap.exists;
  if (!exists) {
    throw new SessionError('not-found', `Session '${sessionId}' not found for user '${userId}'`);
  }
  const raw = snap.data() as Partial<SessionDoc> | undefined;
  if (!raw || typeof raw.payload !== 'string') {
    throw new SessionError(
      'invalid-payload',
      `Session '${sessionId}' has no payload field`,
    );
  }
  const now = Date.now();
  const priorExports = normalizeRemoteExports(raw.remoteExports);
  const nextExports = [
    remoteExport,
    ...priorExports.filter((entry) => entry.exportId !== remoteExport.exportId),
  ].slice(0, 20);
  const nextDoc: SessionDoc = {
    ...toMeta(raw, sessionId),
    updatedAt: now,
    remoteExports: nextExports,
    payload: raw.payload,
  };
  await setDoc(ref, nextDoc as unknown as Record<string, unknown>);
  return toMeta(nextDoc, sessionId);
}

/**
 * Remove a session. No-op when the session doesn't exist — matches the
 * "delete is idempotent" contract the home page card menu expects.
 */
export async function deleteSession(userId: string, sessionId: string): Promise<void> {
  const ref = docRefFor(userId, sessionId);
  try {
    await deleteDoc(ref);
  } catch (e) {
    // Sandbox's deleteDoc throws 'not-found' on missing docs (matches
    // real Firestore for non-merge deletes). Swallow that so callers
    // can call delete unconditionally — every other error propagates.
    if (e instanceof Error && /not-found|does not exist/.test(e.message)) return;
    throw e;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────

/**
 * Strip the `payload` field from a doc and coerce timestamp fields
 * back to plain numbers. Sandbox stores `createdAt` / `updatedAt` as
 * numbers (we wrote them as `Date.now()`), so the coercion is a no-op
 * in practice — the branch exists so a future migration to
 * `serverTimestamp()`-backed Timestamps doesn't break consumers.
 */
function toMeta(raw: Partial<SessionDoc>, id: string): SessionMeta {
  const createdAt = coerceMillis(raw.createdAt) ?? Date.now();
  const updatedAt = coerceMillis(raw.updatedAt) ?? createdAt;
  return {
    id,
    userId: raw.userId ?? '',
    title: raw.title ?? 'Untitled session',
    preview: raw.preview ?? '',
    createdAt,
    updatedAt,
    payloadSize: raw.payloadSize ?? 0,
    ...(raw.promotedTo
      ? {
          promotedTo: {
            projectId: raw.promotedTo.projectId,
            docPath: raw.promotedTo.docPath,
            lastPromotedAt:
              coerceMillis(raw.promotedTo.lastPromotedAt) ?? createdAt,
          },
        }
      : {}),
    ...(raw.remoteExports
      ? { remoteExports: normalizeRemoteExports(raw.remoteExports) }
      : {}),
    ...(raw.githubRepo
      ? {
          githubRepo: {
            fullName: raw.githubRepo.fullName,
            htmlUrl: raw.githubRepo.htmlUrl,
            cloneUrl: raw.githubRepo.cloneUrl,
            defaultBranch: raw.githubRepo.defaultBranch,
            private: raw.githubRepo.private,
            linkedAt: coerceMillis(raw.githubRepo.linkedAt) ?? createdAt,
          },
        }
      : {}),
    ...(normalizeSandboxMode(raw.sandboxMode)
      ? { sandboxMode: normalizeSandboxMode(raw.sandboxMode) }
      : {}),
  };
}

function normalizeSandboxMode(value: unknown): PlaygroundSandboxMode | undefined {
  return value === 'shared' || value === 'isolated' ? value : undefined;
}

function coerceMillis(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value instanceof Timestamp) return value.toMillis();
  // Marker shape `{ __type: 'timestamp', seconds, nanos }` — surfaces
  // when the sandbox restored a doc whose timestamps were stored via
  // serverTimestamp(). Convert to millis without rehydrating the
  // wrapper since consumers downstream want plain numbers.
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { __type?: string }).__type === 'timestamp'
  ) {
    const t = value as { seconds: number; nanos: number };
    return t.seconds * 1000 + Math.floor(t.nanos / 1_000_000);
  }
  return undefined;
}

function normalizeRemoteExports(value: unknown): SessionRemoteExportMeta[] {
  if (!Array.isArray(value)) return [];
  const out: SessionRemoteExportMeta[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<SessionRemoteExportMeta>;
    if (
      typeof raw.exportId !== 'string' ||
      typeof raw.projectId !== 'string' ||
      typeof raw.ownerUid !== 'string' ||
      typeof raw.firestoreDocPath !== 'string'
    ) {
      continue;
    }
    const exportedAt = coerceMillis(raw.exportedAt) ?? Date.now();
    out.push({
      exportId: raw.exportId,
      status: raw.status === 'failed' ? 'failed' : 'complete',
      projectId: raw.projectId,
      ownerUid: raw.ownerUid,
      ...(typeof raw.bucketId === 'string' ? { bucketId: raw.bucketId } : {}),
      firestoreDocPath: raw.firestoreDocPath,
      ...(typeof raw.storageManifestPath === 'string'
        ? { storageManifestPath: raw.storageManifestPath }
        : {}),
      includeFullDetails: raw.includeFullDetails === true,
      ...(typeof raw.storageBytes === 'number' ? { storageBytes: raw.storageBytes } : {}),
      exportedAt,
      ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
      ...(typeof raw.errorMessage === 'string' ? { errorMessage: raw.errorMessage } : {}),
    });
  }
  return out;
}

/**
 * Find the opening user prompt inside a payload's conversation and
 * derive a short title from it. Returns empty when the conversation
 * shape doesn't surface a recognizable string — callers fall back to
 * 'Untitled session' in that case.
 *
 * Loose contract: looks for the first string field named `text`,
 * `content`, or `message` inside the first array item. Matches the
 * shapes both `useChatStore` and OpenAI-style messages produce
 * without locking the sessions module to either.
 */
function deriveTitle(payload: SessionPayload): string {
  const prompt = firstPromptString(payload);
  if (!prompt) return '';
  return prompt.slice(0, TITLE_LIMIT).trim();
}

function derivePreview(payload: SessionPayload): string {
  const prompt = firstPromptString(payload);
  if (!prompt) return '';
  return prompt.slice(0, PREVIEW_LIMIT).trim();
}

function firstPromptString(payload: SessionPayload): string | null {
  const conv = payload.conversation;
  if (!Array.isArray(conv) || conv.length === 0) return null;
  const first = conv[0] as Record<string, unknown> | null;
  if (!first || typeof first !== 'object') return null;
  for (const key of ['text', 'content', 'message'] as const) {
    const v = first[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}
