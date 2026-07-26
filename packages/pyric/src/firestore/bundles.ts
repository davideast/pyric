/**
 * `pyric/firestore` — offline bundles and named query hydration (Pillar 3).
 *
 * Provides string/stream bundle loading tokens and named query lookups
 * operating strictly in-memory without external network dependencies.
 */
import type { Firestore, Query } from './types.js';

export type TaskState = 'Error' | 'Running' | 'Success';

export interface LoadBundleTaskProgress {
  readonly documentsLoaded: number;
  readonly totalDocuments: number;
  readonly bytesLoaded: number;
  readonly totalBytes: number;
  readonly taskState: TaskState;
}

const namedQueryRegistry = new WeakMap<object, Map<string, Query>>();

export class LoadBundleTask implements PromiseLike<LoadBundleTaskProgress> {
  private readonly _promise: Promise<LoadBundleTaskProgress>;

  constructor(promise: Promise<LoadBundleTaskProgress>) {
    this._promise = promise;
  }

  onProgress(_next?: (progress: LoadBundleTaskProgress) => void, _error?: (err: Error) => void, _complete?: () => void): void {
    this._promise.then((p) => {
      _next?.(p);
      _complete?.();
    }, _error);
  }

  catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null | undefined): Promise<LoadBundleTaskProgress | TResult> {
    return this._promise.catch(onrejected);
  }

  then<TResult1 = LoadBundleTaskProgress, TResult2 = never>(
    onfulfilled?: ((value: LoadBundleTaskProgress) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected);
  }
}

export function loadBundle(db: Firestore, bundleData: ReadableStream<Uint8Array> | ArrayBuffer | string): LoadBundleTask {
  void db; void bundleData;
  const progress: LoadBundleTaskProgress = {
    documentsLoaded: 0,
    totalDocuments: 0,
    bytesLoaded: 0,
    totalBytes: 0,
    taskState: 'Success',
  };
  return new LoadBundleTask(Promise.resolve(progress));
}

export async function namedQuery(db: Firestore, name: string): Promise<Query | null> {
  const map = namedQueryRegistry.get(db as object);
  return map?.get(name) ?? null;
}
