/**
 * Shared typed-model converter recorder and snapshot helper for modular
 * Firestore `withConverter` probes (`firestore#46..#53b`).
 *
 * Uses a deterministic synthetic item domain (`title`/`count`/`tag` <->
 * `dbTitle`/`dbCount`/`dbTag`) and records exact `toFirestore` / `fromFirestore`
 * invocation metadata without baking expected outcomes into probe files.
 */
import type { DocumentData, FirestoreDataConverter } from 'firebase/firestore';
import { FirestoreQueryTimeoutError } from './firestore-probe-outcomes.ts';

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000;

export interface ConvertedItem {
  title: string;
  count: number;
  tag?: string | null;
  label?: string;
}

interface ToFirestoreCallRecord {
  [key: string]: unknown;
  argCount: number;
  hasOptions: boolean;
  merge: boolean | null;
  mergeFields: string[] | null;
}

interface FromFirestoreCallRecord {
  [key: string]: unknown;
  id: string;
  argCount: number;
  hasOptions: boolean;
}

interface RecordedItemConverter {
  converter: FirestoreDataConverter<ConvertedItem, DocumentData>;
  toFirestoreCalls: ToFirestoreCallRecord[];
  fromFirestoreCalls: FromFirestoreCallRecord[];
  resetCalls(): void;
}

function normalizeMergeFieldsList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw.map((entry) => String(entry));
}

export function createRecordedItemConverter(): RecordedItemConverter {
  const toFirestoreCalls: ToFirestoreCallRecord[] = [];
  const fromFirestoreCalls: FromFirestoreCallRecord[] = [];

  const converter: FirestoreDataConverter<ConvertedItem, DocumentData> = {
    toFirestore(...args: unknown[]): DocumentData {
      const model = (args[0] ?? {}) as Partial<ConvertedItem>;
      const rawOptions = args[1] as { merge?: unknown; mergeFields?: unknown } | undefined;
      let merge: boolean | null = null;
      if (rawOptions !== undefined && typeof rawOptions.merge === 'boolean') {
        merge = rawOptions.merge;
      }
      let mergeFields: string[] | null = null;
      if (rawOptions !== undefined && rawOptions.mergeFields !== undefined) {
        mergeFields = normalizeMergeFieldsList(rawOptions.mergeFields);
      }
      toFirestoreCalls.push({
        argCount: args.length,
        hasOptions: rawOptions !== undefined,
        merge,
        mergeFields,
      });

      const out: DocumentData = { convertedWrite: true };
      if (model.title !== undefined) {
        out.dbTitle = model.title;
      }
      if (model.count !== undefined) {
        out.dbCount = model.count * 10;
      }
      if (model.tag !== undefined && model.tag !== null) {
        out.dbTag = model.tag;
      }
      return out;
    },
    fromFirestore(...args: unknown[]): ConvertedItem {
      const snap = args[0] as { id: string; data(options?: unknown): DocumentData };
      const rawOptions = args[1];
      fromFirestoreCalls.push({
        id: snap.id,
        argCount: args.length,
        hasOptions: rawOptions !== undefined,
      });
      const raw = snap.data(rawOptions);
      let dbTitle = '';
      if (typeof raw.dbTitle === 'string') {
        dbTitle = raw.dbTitle;
      }
      let dbCount = 0;
      if (typeof raw.dbCount === 'number') {
        dbCount = raw.dbCount;
      }
      let tag: string | null = null;
      if (typeof raw.dbTag === 'string') {
        tag = raw.dbTag;
      }
      return {
        title: dbTitle,
        count: dbCount / 10,
        label: `${dbTitle}#${dbCount}`,
        tag,
      };
    },
  };

  return {
    converter,
    toFirestoreCalls,
    fromFirestoreCalls,
    resetCalls() {
      toFirestoreCalls.length = 0;
      fromFirestoreCalls.length = 0;
    },
  };
}

export async function observeInitialQuerySnapshot<T>(
  subscribe: (
    onNext: (snap: {
      size: number;
      docs: ReadonlyArray<{ id: string; data(): T; ref: { converter: unknown } }>;
    }) => void,
    onError: (err: unknown) => void,
  ) => () => void,
  expectedMinDocs: number,
  timeoutMs: number = DEFAULT_SNAPSHOT_TIMEOUT_MS,
): Promise<Array<{ id: string; data: T; refHasConverter: boolean }>> {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new FirestoreQueryTimeoutError(timeoutMs, 'onSnapshot(typedColl)'));
      }, timeoutMs);

      unsubscribe = subscribe(
        (snap) => {
          if (snap.size < expectedMinDocs) {
            return;
          }
          const rows = snap.docs
            .map((docSnap) => ({
              id: docSnap.id,
              data: docSnap.data(),
              refHasConverter:
                docSnap.ref.converter !== null && docSnap.ref.converter !== undefined,
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
          resolve(rows);
        },
        (err) => {
          reject(err);
        },
      );
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (unsubscribe !== undefined) {
      unsubscribe();
    }
  }
}
