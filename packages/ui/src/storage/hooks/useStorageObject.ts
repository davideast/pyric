import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FirebaseStorage,
  FullMetadata,
} from 'pyric/storage';
import { useStorageApi } from '../storageApi.js';
import { normalizeStoragePath } from './usePathState.js';

export type StorageObjectStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseStorageObjectResult {
  /** Metadata read state. `'idle'` when `storage` or `path` is null. */
  status: StorageObjectStatus;
  metadata: FullMetadata | undefined;
  /** Typed `StorageError` (`storage/object-not-found`,
   *  `storage/unauthorized`, …). */
  error: Error | undefined;
  /** Re-read the metadata (also resets the blob, the object may
   *  have been overwritten). */
  refresh: () => void;
  /** Blob read state. Stays `'idle'` until `loadBlob()`, the blob
   *  is LAZY; metadata alone never downloads bytes. */
  blobStatus: StorageObjectStatus;
  blob: Blob | undefined;
  /**
   * `URL.createObjectURL` handle for the loaded blob, used as the local
   * preview channel. Revoked automatically when the blob is replaced,
   * the path changes, or the hook unmounts.
   */
  blobUrl: string | undefined;
  blobError: Error | undefined;
  /** Fetch the bytes via `getBlob`. Subsequent calls re-fetch. */
  loadBlob: () => void;
}

interface MetaState {
  status: StorageObjectStatus;
  metadata: FullMetadata | undefined;
  error: Error | undefined;
}

interface BlobState {
  status: StorageObjectStatus;
  blob: Blob | undefined;
  url: string | undefined;
  error: Error | undefined;
}

const IDLE_BLOB: BlobState = {
  status: 'idle',
  blob: undefined,
  url: undefined,
  error: undefined,
};

/**
 * One object's metadata + lazily-loaded bytes, the data source for
 * `<ObjectInspector>`. Read-via-get like the rest of the storage
 * half: updates on `refresh`, `path` change, or `loadBlob`.
 */
export function useStorageObject(
  storage: FirebaseStorage | null | undefined,
  path: string | null | undefined,
): UseStorageObjectResult {
  // Injected: in-process `pyric/storage` by default, or the SharedWorker client
  // bundle in Studio served mode (via StorageApiProvider).
  const { getBlob, getMetadata, ref: refFn } = useStorageApi();
  const normalized = path == null ? null : normalizeStoragePath(path);
  const active = storage != null && normalized != null && normalized !== '';

  const [meta, setMeta] = useState<MetaState>(() => ({
    status: active ? 'loading' : 'idle',
    metadata: undefined,
    error: undefined,
  }));
  const [blobState, setBlobState] = useState<BlobState>(IDLE_BLOB);
  const [tick, setTick] = useState(0);
  // Generation token: invalidates in-flight blob loads when the
  // path/storage changes or a newer load starts.
  const blobGenRef = useRef(0);

  useEffect(() => {
    // Any identity change drops the previous blob (the URL-revoking
    // effect below cleans up the old object URL when state resets).
    blobGenRef.current++;
    setBlobState(IDLE_BLOB);
    if (!active) {
      setMeta({ status: 'idle', metadata: undefined, error: undefined });
      return;
    }
    let cancelled = false;
    setMeta({ status: 'loading', metadata: undefined, error: undefined });
    getMetadata(refFn(storage, normalized))
      .then((metadata) => {
        if (cancelled) return;
        setMeta({ status: 'success', metadata, error: undefined });
      })
      .catch((e) => {
        if (cancelled) return;
        setMeta({
          status: 'error',
          metadata: undefined,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      });
    return () => {
      cancelled = true;
    };
    // `active` is derived from storage/normalized, not a dep itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage, normalized, tick]);

  // Blob-URL lifecycle: one effect owns revocation. Runs cleanup when
  // the url is replaced, reset (path change), or the hook unmounts :
  // the design plan's "revoke on unmount" requirement.
  const url = blobState.url;
  useEffect(() => {
    if (url === undefined) return;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [url]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const loadBlob = useCallback(() => {
    if (storage == null || normalized == null || normalized === '') return;
    const myGen = ++blobGenRef.current;
    setBlobState({ status: 'loading', blob: undefined, url: undefined, error: undefined });
    getBlob(refFn(storage, normalized))
      .then((blob) => {
        if (myGen !== blobGenRef.current) return;
        setBlobState({
          status: 'success',
          blob,
          url: URL.createObjectURL(blob),
          error: undefined,
        });
      })
      .catch((e) => {
        if (myGen !== blobGenRef.current) return;
        setBlobState({
          status: 'error',
          blob: undefined,
          url: undefined,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      });
  }, [storage, normalized]);

  return {
    status: meta.status,
    metadata: meta.metadata,
    error: meta.error,
    refresh,
    blobStatus: blobState.status,
    blob: blobState.blob,
    blobUrl: blobState.url,
    blobError: blobState.error,
    loadBlob,
  };
}
