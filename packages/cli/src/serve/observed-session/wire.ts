/**
 * The wire shapes of Live mode's observed session data: the routes the host
 * serves, the delta a `@pyric/live` client sends on an observe frame, and the
 * snapshot Studio and `pyric sandbox seed-from-live` read.
 *
 * Privacy and persistence contract (`docs/research/live-mode.md` §§ 4, 6, 9):
 * observed Firestore documents and RTDB values live only in the live host's
 * memory (`store.ts`). Nothing reaches `.pyric/state/hosted`, capture files,
 * repro files or sandbox traffic events until the developer asks for it with
 * `POST /__pyric/live/seed-sandbox` and `{ confirm: true }`, or runs
 * `pyric sandbox seed-from-live --confirm` or `--out <file>`.
 */
import type {
  ObservedStorageBucketSnapshot,
  ObservedStorageSessionOp,
} from './storage-policy.js';

export type {
  ObservedStorageBucketSnapshot,
  ObservedStorageListItem,
  ObservedStorageObjectInput,
  ObservedStorageObjectMetadata,
  ObservedStorageSessionOp,
} from './storage-policy.js';
export { UNREAD_BUCKET } from 'pyric/sandbox/internal';

export const LIVE_SESSION_DATA_PATH = '/__pyric/live/session-data';
export const LIVE_SEED_SANDBOX_PATH = '/__pyric/live/seed-sandbox';

/** Sentinel instance string emitted by `@pyric/live` when a Database handle lacks a readable URL. */
export const UNREAD_RTDB_INSTANCE = 'instance-not-read-from-the-sdk-reference';

export type ObservedFirestoreSessionOp =
  | {
      readonly kind: 'set';
      readonly path: string;
      readonly data: Record<string, unknown>;
      readonly merge?: boolean;
      readonly deleteFields?: readonly string[];
      readonly partial?: boolean;
    }
  | {
      readonly kind: 'update';
      readonly path: string;
      readonly data: Record<string, unknown>;
      readonly deleteFields?: readonly string[];
      readonly partial?: boolean;
    }
  | {
      readonly kind: 'delete';
      readonly path: string;
    }
  | {
      readonly kind: 'invalidate';
      readonly path: string;
    };

export type ObservedRtdbSessionOp =
  | {
      readonly kind: 'set';
      readonly instance: string;
      readonly path: string;
      readonly value: unknown;
    }
  | {
      readonly kind: 'update';
      readonly instance: string;
      readonly path: string;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly kind: 'remove';
      readonly instance: string;
      readonly path: string;
    }
  | {
      readonly kind: 'invalidate';
      readonly instance: string;
      readonly path: string;
    };

export interface ObservedSessionSkipCounts {
  readonly oversized?: number;
  readonly unsupported?: number;
  readonly truncated?: number;
}

export interface ObservedSessionDelta {
  readonly firestore?: readonly ObservedFirestoreSessionOp[];
  readonly rtdb?: readonly ObservedRtdbSessionOp[];
  readonly storage?: readonly ObservedStorageSessionOp[];
  readonly skipped?: ObservedSessionSkipCounts;
}

export interface ObservedSessionSkipStats {
  readonly oversized: number;
  readonly unsupported: number;
  readonly truncated: number;
  readonly failed: number;
  /** Retained for wire compatibility with older live-host snapshots and any session-data service without Admin capture; always 0 for Firestore, RTDB, and Storage. */
  readonly admin: number;
}

export interface ObservedSessionStats {
  readonly firestoreDocs: number;
  readonly rtdbInstances: number;
  readonly storageBuckets?: number;
  readonly storageObjects?: number;
  readonly byteEstimate: number;
  readonly truncated: boolean;
  readonly droppedCount: number;
}

export type ObservedSessionSource = 'client' | 'admin';

export interface ObservedSessionSources {
  readonly client: boolean;
  readonly admin: boolean;
}

export interface ObservedSessionDataSnapshot {
  readonly revision: number;
  readonly updatedAt: number | null;
  readonly projectId: string;
  readonly firestore: Record<string, Record<string, unknown>>;
  /** Per-instance RTDB root value (usually an object tree). Empty instances are omitted. */
  readonly rtdb: Record<string, unknown>;
  readonly defaultRtdbInstance: string | null;
  /** Per-bucket observed Storage metadata catalog (omitted until a Storage call is observed). */
  readonly storage?: Record<string, ObservedStorageBucketSnapshot>;
  readonly defaultStorageBucket?: string | null;
  readonly stats: ObservedSessionStats;
  /** Which SDK planes have contributed observed session data (omitted when neither has). */
  readonly sources?: ObservedSessionSources;
  /** Counts of calls or items omitted from this snapshot (omitted when all 0). */
  readonly skips?: ObservedSessionSkipStats;
}

/** How `POST /__pyric/live/seed-sandbox` seeds: deep-merge onto the local sandbox, or replace it. */
export type LiveSeedMode = 'merge' | 'replace';

/** The body `POST /__pyric/live/seed-sandbox` answers with once the local sandbox is seeded. */
export interface LiveSeedSandboxResult {
  readonly ok: true;
  readonly mode: LiveSeedMode;
  readonly seededFirestoreDocs: number;
  readonly seededRtdbInstances: readonly string[];
  readonly revision: number;
}
