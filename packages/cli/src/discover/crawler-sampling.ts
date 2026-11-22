/**
 * Template-path inference, recoverable RPC error classification, and
 * per-template document sampling for `firestore_discover_paths`.
 */
import { runWithLimit } from './concurrency.js';
import type { DiscoveredCollection } from './crawler-types.js';
import type { CrawlerCollectionRef } from './firestore-source.js';
import { emptySchema, mergeDoc } from './merge.js';
import type {
  DiscoverEvent,
  FieldSchema,
  SamplingComplete,
} from './types.js';
import { snapshotToObservations } from './wire.js';

/**
 * Map a concrete collection path (`coll/doc/coll/.../coll`, odd segment count)
 * to its template-path form (`users/uid_1/posts` -> `users/{userId}/posts`).
 */
export function toTemplatePath(concretePath: string): string {
  const segs = concretePath.split('/');
  if (segs.length % 2 === 0) {
    throw new Error(
      `toTemplatePath: expected odd-length collection path, got ${segs.length} segments: ${concretePath}`,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === undefined) continue;
    if (i % 2 === 0) {
      out.push(seg);
    } else {
      const parentColl = segs[i - 1] ?? '';
      out.push(`{${inferTemplateVariable(parentColl)}}`);
    }
  }
  return out.join('/');
}

/**
 * Convert a collection ID to the conventional template-variable name a
 * Firestore rules author writes for its docs (`ttt_lobbies` -> `lobbyId`).
 */
export function inferTemplateVariable(collectionId: string): string {
  const lastWord = collectionId.split('_').pop() ?? collectionId;
  const singular = singularize(lastWord);
  return `${singular}Id`;
}

function singularize(word: string): string {
  if (word.length <= 2) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const RETRYABLE_NUMERIC_CODES = new Set([4, 7, 10, 14]);
const RETRYABLE_STRING_CODES = new Set([
  'PERMISSION_DENIED',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'permission-denied',
  'unavailable',
  'deadline-exceeded',
  'aborted',
]);

interface ClassifiedError {
  code: string;
  message: string;
}

export function classifyRpcError(err: unknown): ClassifiedError | null {
  if (err === null || typeof err !== 'object') return null;
  const e = err as { code?: unknown; message?: unknown };
  let codeStr: string | null = null;
  if (typeof e.code === 'number' && RETRYABLE_NUMERIC_CODES.has(e.code)) {
    codeStr = numericCodeToString(e.code);
  } else if (typeof e.code === 'string' && RETRYABLE_STRING_CODES.has(e.code)) {
    codeStr = e.code.toUpperCase().replace(/-/g, '_');
  }
  if (codeStr === null) return null;
  let message = String(err);
  if (typeof e.message === 'string') {
    message = e.message;
  }
  return { code: codeStr, message };
}

function numericCodeToString(code: number): string {
  switch (code) {
    case 4:
      return 'DEADLINE_EXCEEDED';
    case 7:
      return 'PERMISSION_DENIED';
    case 10:
      return 'ABORTED';
    case 14:
      return 'UNAVAILABLE';
    default:
      return `CODE_${code}`;
  }
}

/**
 * Run an RPC, returning the value on success or null on a classified
 * recoverable error (recorded onto `events`). Unrecognized errors re-throw.
 */
export async function safeRpc<T>(
  fn: () => Promise<T>,
  templatePath: string,
  events: DiscoverEvent[],
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const classified = classifyRpcError(err);
    if (classified === null) throw err;
    events.push({
      kind: 'error',
      templatePath,
      code: classified.code,
      message: classified.message,
    });
    return null;
  }
}

export interface SampleOpts {
  maxConcurrency: number;
  maxSamples: number;
  stopOnStable: number;
  maxErrorsPerCollection: number;
}

export interface TemplateSampleResult {
  schema: FieldSchema;
  samplingComplete: SamplingComplete;
  declaredAt: number | null;
}

function selectSamplingComplete(
  errorBudgetExhausted: boolean,
  earlyExitViaStable: boolean,
  consumedAll: boolean,
  cappedByMax: boolean,
): SamplingComplete {
  if (errorBudgetExhausted) return 'sampling_open';
  if (earlyExitViaStable) return 'converged_via_stable';
  if (consumedAll && !cappedByMax) return 'converged_via_exhausted';
  return 'converged_via_max';
}

/**
 * Sample one templatePath: read up to `maxSamples` docs in chunks of
 * `stopOnStable`, feed each through `mergeDoc`, and classify termination.
 */
export async function sampleOneTemplate(
  entry: DiscoveredCollection,
  opts: SampleOpts,
  events: DiscoverEvent[],
): Promise<{ schema: TemplateSampleResult; readOps: number }> {
  const { maxConcurrency, maxSamples, stopOnStable, maxErrorsPerCollection } = opts;
  const capRefs = entry.docRefs.slice(0, maxSamples);
  const cappedByMax = entry.docRefs.length > maxSamples;

  let schema: FieldSchema = emptySchema();
  let errorsThisCollection = 0;
  let errorBudgetExhausted = false;
  let consecutiveStable = 0;
  let declaredAt: number | null = null;
  let earlyExitViaStable = false;
  let readOps = 0;

  const chunkSize = Math.max(1, stopOnStable);
  let i = 0;
  while (i < capRefs.length && !earlyExitViaStable && !errorBudgetExhausted) {
    const chunk = capRefs.slice(i, i + chunkSize);
    const snaps = await runWithLimit(chunk, maxConcurrency, async (ref) => {
      if (errorBudgetExhausted) return null;
      readOps++;
      try {
        return await ref.get();
      } catch (err) {
        const classified = classifyRpcError(err);
        if (classified === null) throw err;
        errorsThisCollection++;
        events.push({
          kind: 'error',
          templatePath: entry.templatePath,
          code: classified.code,
          message: classified.message,
        });
        if (errorsThisCollection >= maxErrorsPerCollection) {
          errorBudgetExhausted = true;
        }
        return null;
      }
    });

    for (const snap of snaps) {
      if (errorBudgetExhausted) break;
      if (snap === null || snap._fieldsProto === undefined || snap._fieldsProto === null) {
        i++;
        continue;
      }
      const { observations, reservedNames } = snapshotToObservations(snap);
      if (Object.keys(observations).length === 0) {
        i++;
        continue;
      }
      const { next, changes } = mergeDoc(schema, observations);
      for (const [k, reason] of Object.entries(reservedNames)) {
        if (Object.hasOwn(next.fields, k)) {
          const desc = next.fields[k];
          if (desc !== undefined) desc.reservedReason = reason;
        }
      }
      schema = next;
      if (changes.length > 0) {
        events.push({
          kind: 'schema_updated',
          templatePath: entry.templatePath,
          changes,
        });
        consecutiveStable = 0;
      } else {
        consecutiveStable++;
        if (declaredAt === null && consecutiveStable >= stopOnStable) {
          declaredAt = next.samplesSeen - 1;
          earlyExitViaStable = true;
        }
      }
      i++;
      if (earlyExitViaStable) break;
    }
  }

  const consumedAll = i >= capRefs.length;
  const samplingComplete = selectSamplingComplete(
    errorBudgetExhausted,
    earlyExitViaStable,
    consumedAll,
    cappedByMax,
  );

  events.push({
    kind: 'sampling_complete',
    templatePath: entry.templatePath,
    samplingComplete,
    samplesSeen: schema.samplesSeen,
    declaredAt,
  });

  return {
    schema: { schema, samplingComplete, declaredAt },
    readOps,
  };
}

export function directChildTemplatePaths(
  parentTpl: string,
  discovered: Map<string, DiscoveredCollection>,
): string[] {
  const prefix = parentTpl + '/';
  const out: string[] = [];
  for (const tpl of discovered.keys()) {
    if (!tpl.startsWith(prefix)) continue;
    const tail = tpl.slice(prefix.length);
    if (tail.split('/').length === 2) out.push(tpl);
  }
  return out;
}

export function recordCollection(
  discovered: Map<string, DiscoveredCollection>,
  events: DiscoverEvent[],
  ref: CrawlerCollectionRef,
  depth: number,
  parentPath: string | undefined,
): void {
  const templatePath = toTemplatePath(ref.path);
  const existing = discovered.get(templatePath);
  if (existing !== undefined) {
    existing.refs.push(ref);
    return;
  }
  discovered.set(templatePath, {
    templatePath,
    depth,
    examplePath: ref.path,
    refs: [ref],
    docRefs: [],
  });
  let event: DiscoverEvent = { kind: 'collection_discovered', templatePath, depth };
  if (parentPath !== undefined && parentPath !== '') {
    event = { kind: 'collection_discovered', templatePath, depth, parentPath };
  }
  events.push(event);
}
