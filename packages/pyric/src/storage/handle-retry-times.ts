const DEFAULT_MAX_OPERATION_RETRY_TIME = 120_000;
const DEFAULT_MAX_UPLOAD_RETRY_TIME = 600_000;

const RETRY_TIMES_KEY = Symbol.for('pyric.storage.retry-times');

interface RetryTimeState {
  maxOperationRetryTime: number;
  maxUploadRetryTime: number;
}

const globalRetryCache = globalThis as { [RETRY_TIMES_KEY]?: WeakMap<object, RetryTimeState> };
const RETRY_TIMES = (globalRetryCache[RETRY_TIMES_KEY] ??= new WeakMap());

/**
 * Freeze a Storage handle with mutable `maxOperationRetryTime` and
 * `maxUploadRetryTime` accessors matching `firebase/storage` defaults.
 */
export function createStorageRetryHandle<T extends object>(
  props: Omit<T, 'maxOperationRetryTime' | 'maxUploadRetryTime'>,
  base?: object,
): T {
  let state: RetryTimeState | undefined;
  if (base !== undefined) {
    state = RETRY_TIMES.get(base);
  }
  if (state === undefined) {
    state = {
      maxOperationRetryTime: DEFAULT_MAX_OPERATION_RETRY_TIME,
      maxUploadRetryTime: DEFAULT_MAX_UPLOAD_RETRY_TIME,
    };
  }
  const activeState = state;
  const handle = Object.freeze({
    ...props,
    get maxOperationRetryTime(): number {
      return activeState.maxOperationRetryTime;
    },
    set maxOperationRetryTime(value: number) {
      activeState.maxOperationRetryTime = value;
    },
    get maxUploadRetryTime(): number {
      return activeState.maxUploadRetryTime;
    },
    set maxUploadRetryTime(value: number) {
      activeState.maxUploadRetryTime = value;
    },
  }) as unknown as T;
  RETRY_TIMES.set(handle, activeState);
  return handle;
}
