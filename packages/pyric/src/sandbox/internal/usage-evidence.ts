/** Numeric evidence only. Never retain documents, tokens, or serialized payloads. */
export interface UsageEvidence {
  readonly aiInputTokens?: number;
  readonly aiOutputTokens?: number;
  readonly aiEstimatedTokens?: number;
  readonly aiUnknownUsage?: number;
  readonly aiCompleted?: number;
  readonly aiFailures?: number;

  readonly uploadedBytes?: number;
  readonly downloadedBytes?: number;
  readonly documentReads?: number;
  readonly documentWrites?: number;
  readonly documentDeletes?: number;
  readonly payloadBytes?: number;
  readonly unmeasured?: number;
}

interface ReadSnapshot {
  readonly size?: number;
  readonly docs?: readonly unknown[];
  readonly metadata?: { fromCache?: boolean; hasPendingWrites?: boolean };
  exists?: boolean | (() => boolean);
  docChanges?: () => readonly { type: string }[];
  val?: () => unknown;
}

/** Query removals cannot distinguish deletion from leaving a query here. */
export function firestoreReadUsage(value: unknown, listener = false, initial = true): UsageEvidence {
  if (!value || typeof value !== 'object') return { unmeasured: 1 };
  const snapshot = value as ReadSnapshot;
  if (snapshot.metadata?.fromCache) return { documentReads: 0 };
  if (Array.isArray(snapshot.docs)) {
    if (!listener || initial) return { documentReads: Math.max(1, snapshot.docs.length) };
    if (!snapshot.docChanges) return { unmeasured: 1 };
    const changes = snapshot.docChanges();
    return {
      documentReads: changes.filter(change => change.type === 'added' || change.type === 'modified').length,
      ...(changes.some(change => change.type === 'removed') ? { unmeasured: 1 } : {}),
    };
  }
  if (snapshot.exists !== undefined) {
    const exists = typeof snapshot.exists === 'function' ? snapshot.exists() : snapshot.exists;
    return { documentReads: !listener || initial || exists ? 1 : 0 };
  }
  // Aggregation/index-entry scans have no document-result billing equivalent.
  return { unmeasured: 1 };
}

/** Full callback JSON, not transport deltas, protocol overhead, or billed bytes. */
export function databaseReadUsage(value: unknown): UsageEvidence {
  if (!value || typeof value !== 'object' || !('val' in value) || typeof value.val !== 'function') {
    return { unmeasured: 1 };
  }
  const json = JSON.stringify(value.val());
  return json === undefined ? { unmeasured: 1 } : { payloadBytes: new TextEncoder().encode(json).byteLength };
}

export function firestoreWriteUsage(method: string): UsageEvidence | undefined {
  if (['setDoc', 'updateDoc', 'addDoc'].includes(method)) return { documentWrites: 1 };
  if (method === 'deleteDoc') return { documentDeletes: 1 };
  if (method === 'writeBatch.commit' || method === 'runTransaction') return { unmeasured: 1 };
  return undefined;
}

/** Shared page/host accounting: synthetic and estimated tokens are never backend usage. */
export function aiCompletionUsage(detail: import('./ai-evidence.js').AiEvidence, method: string): UsageEvidence {
  if (method === 'countTokens') return { aiCompleted: 1 };
  const backend = detail.usageSource === 'backend';
  const estimated = detail.usageSource === 'estimated' || detail.usageSource === 'scripted';
  const incomplete = detail.inputTokens === undefined || detail.outputTokens === undefined || detail.usageSource === 'unknown';
  return { aiCompleted: 1,
    ...(backend ? { aiInputTokens: detail.inputTokens, aiOutputTokens: detail.outputTokens } : {}),
    ...(estimated ? { aiEstimatedTokens: detail.totalTokens } : {}),
    aiUnknownUsage: incomplete ? 1 : 0,
  };
}
