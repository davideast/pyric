/**
 * Public types for the playground's session storage. Sessions live in
 * `@pyric/sandbox` at the canonical path
 *
 *   pyric/playground/sessions/{userId}/items/{sessionId}
 *
 * and persist locally via the sandbox-persistence track. The user's
 * real Firebase project sees nothing until the explicit "Promote"
 * action runs (a future track).
 *
 * The data shape is split in two: `SessionMeta` is the lightweight
 * record the home page lists (title + preview + timestamps), and
 * `SessionPayload` is the full editor + chat snapshot the workspace
 * page hydrates from on open. They're stored together in one
 * sandbox document, but consumers list metadata-only and load the
 * payload on demand.
 *
 * The doc shape mirrors `SessionDoc` below; the split exists at the
 * API boundary so the home page never deserializes payloads it isn't
 * about to display.
 *
 * See `plans/playground-home-page-and-sessions.md` for the design
 * rationale.
 */
import type {
  PersistedTraceTelemetry,
  PersistedTraceTelemetryV1,
} from '../store/trace';

export type PlaygroundSandboxMode = 'shared' | 'isolated';

/** Metadata visible on the home page session list. */
export interface SessionMeta {
  /** UUID v4 minted when the session was first saved. */
  id: string;
  /** Owning user — either the GIS `sub` claim or `local-{uuid}` for
   *  signed-out sessions. Sessions started signed-out get rebound to
   *  the user's GIS sub on first sign-in (a future track). */
  userId: string;
  /** Short title derived from the first prompt; user-editable. */
  title: string;
  /** First ~120 chars of the opening prompt. Renders under the title. */
  preview: string;
  createdAt: number;
  updatedAt: number;
  /** Byte length of the serialized payload — surfaced in the UI so
   *  users can spot oversized sessions before opening them. */
  payloadSize: number;
  /** Set after a successful promote-to-Firestore. Absent for sessions
   *  that have never been pushed to the user's real project. UI shows
   *  a "synced" badge when present. */
  promotedTo?: {
    projectId: string;
    docPath: string;
    lastPromotedAt: number;
  };
  /** Remote telemetry exports created from this local session. Firestore
   *  keeps queryable summaries; Firebase Storage may hold linked full-
   *  detail artifacts. The blobs themselves are never stored locally. */
  remoteExports?: SessionRemoteExportMeta[];
  /** Set when the user created a GitHub repo at session start on the
   *  home page. Surfaces in the session list and workspace chrome. */
  githubRepo?: {
    fullName: string;
    htmlUrl: string;
    cloneUrl: string;
    defaultBranch: string;
    private: boolean;
    linkedAt: number;
  };
  /** Runtime backing for the playground session. Legacy sessions omit it. */
  sandboxMode?: PlaygroundSandboxMode;
}

export interface SessionRemoteExportMeta {
  exportId: string;
  status: 'complete' | 'failed';
  projectId: string;
  ownerUid: string;
  bucketId?: string;
  firestoreDocPath: string;
  storageManifestPath?: string;
  includeFullDetails: boolean;
  storageBytes?: number;
  exportedAt: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Workspace + conversation snapshot. Stored as a JSON string inside
 * the session doc; only loaded when the workspace page opens a session
 * (or when an explicit Promote pushes it to the user's real project).
 *
 * Versioned via `version` so future schema changes can be detected at
 * read time and surfaced to the user rather than corrupting state.
 */
export interface SessionPayload {
  /** Schema version; bump on a breaking change. */
  version: 1;
  workspace: {
    rules: string;
    databaseRules?: string;
    code: string;
    appSource: string;
    /** Explicit preview policy for imported repositories. Legacy sessions default to React. */
    preview?: { mode: 'react'; entryPath: string } | { mode: 'none' };
  };
  /** Chat / conversation messages. Opaque to this module — the
   *  workspace page owns the shape and writes whatever it stores in
   *  `useChatStore`. Typed loosely on purpose so the sessions module
   *  doesn't have to migrate when the chat shape evolves. */
  conversation: unknown;
  /** Durable compaction events (append-only history — see
   *  plans/context-compaction-redesign.md). Additive: legacy sessions
   *  omit it. Loosely typed like `conversation` — the workspace page
   *  owns the marker shape. */
  compactionMarkers?: unknown[];
  /** Optional local-only telemetry needed to restore trace drill-ins
   *  after refresh. Additive: legacy sessions omit it and still load.
   *  New saves write the deduped v2 form; sessions saved before the
   *  dedupe carry v1 — `useTraceStore.hydrate` accepts both. */
  telemetry?: PersistedTraceTelemetry | PersistedTraceTelemetryV1;
  /** Active skill ids for this session (see lib/skills/registry.ts).
   *  Additive: legacy sessions omit it (= no skills active); unknown
   *  ids are dropped on hydrate so removed skills can't wedge a load. */
  activeSkills?: string[];
}

/** The on-disk session document stored under each user's items collection. */
export interface SessionDoc extends SessionMeta {
  /** JSON-stringified {@link SessionPayload}. Compression is a future
   *  optimization (see plan); v1 stores raw JSON to keep the dep
   *  graph small. */
  payload: string;
}

/** Input to {@link saveSession}. */
export interface SessionSaveInput {
  id: string;
  /** Override the auto-derived title. When omitted, the first ~60
   *  chars of the conversation's opening prompt are used. */
  title?: string;
  /** Override the auto-derived preview. When omitted, the first ~120
   *  chars of the opening prompt are used. */
  preview?: string;
  payload: SessionPayload;
  /** Linked GitHub repo metadata — written on first save when the home
   *  page creates a repo; preserved across subsequent autosaves. */
  githubRepo?: SessionMeta['githubRepo'];
  /** Runtime backing for this session; preserved across autosaves. */
  sandboxMode?: PlaygroundSandboxMode;
}

/** Error code surfaced by sessions APIs. */
export type SessionErrorCode =
  | 'not-found'
  | 'invalid-payload'
  | 'unavailable';

/** Thrown by sessions APIs on read/write failure. */
export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}
