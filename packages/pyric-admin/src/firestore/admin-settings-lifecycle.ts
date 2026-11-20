/**
 * Per-handle `settings(...)`, `ignoreUndefinedProperties`, and `terminate()`
 * lifecycle tracking for `pyric-admin/firestore`.
 */
import { isPlainMap } from './admin-handle-registry.js';

export interface AdminFirestoreSettings {
  readonly ignoreUndefinedProperties?: boolean;
  readonly preferRest?: boolean;
  readonly host?: string;
  readonly ssl?: boolean;
  readonly [key: string]: unknown;
}

interface AdminHandleLifecycle {
  started: boolean;
  settingsApplied: boolean;
  ignoreUndefinedProperties: boolean;
  terminated: boolean;
}

const handleLifecycleMap = new WeakMap<object, AdminHandleLifecycle>();

const TERMINATED_MESSAGE = 'The client has already been terminated';
const ALREADY_INITIALIZED_MESSAGE =
  'Firestore has already been initialized. You can only call settings() once, ' +
  'and only before calling any other methods on a Firestore object.';

function lifecycleFor(rootDb: object): AdminHandleLifecycle {
  let state = handleLifecycleMap.get(rootDb);
  if (state === undefined) {
    state = {
      started: false,
      settingsApplied: false,
      ignoreUndefinedProperties: false,
      terminated: false,
    };
    handleLifecycleMap.set(rootDb, state);
  }
  return state;
}

function assertAdminFirestoreNotTerminated(rootDb: object): void {
  if (lifecycleFor(rootDb).terminated) {
    throw new Error(TERMINATED_MESSAGE);
  }
}

export function markAdminFirestoreStarted(rootDb: object): void {
  assertAdminFirestoreNotTerminated(rootDb);
  lifecycleFor(rootDb).started = true;
}

export function applyAdminFirestoreSettings(
  rootDb: object,
  settings: AdminFirestoreSettings,
  allowIfUnset = false,
): void {
  if (settings === null || typeof settings !== 'object') {
    throw new Error('Value for argument "settings" is not a valid object.');
  }
  const state = lifecycleFor(rootDb);
  if (state.terminated) {
    throw new Error(TERMINATED_MESSAGE);
  }
  if (state.started || state.settingsApplied) {
    if (allowIfUnset) {
      return;
    }
    throw new Error(ALREADY_INITIALIZED_MESSAGE);
  }
  state.settingsApplied = true;
  if (settings.ignoreUndefinedProperties !== undefined) {
    if (typeof settings.ignoreUndefinedProperties !== 'boolean') {
      throw new Error('Value for argument "settings.ignoreUndefinedProperties" is not a valid boolean.');
    }
    state.ignoreUndefinedProperties = settings.ignoreUndefinedProperties;
  }
}

export function terminateAdminFirestore(rootDb: object): Promise<void> {
  lifecycleFor(rootDb).terminated = true;
  return Promise.resolve();
}

export function shouldIgnoreUndefinedProperties(rootDb: object): boolean {
  return lifecycleFor(rootDb).ignoreUndefinedProperties;
}

export function stripUndefinedForSettings<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    const cleanedItems = value
      .filter((item) => item !== undefined)
      .map((item) => stripUndefinedForSettings(item));
    return cleanedItems as unknown as T;
  }
  if (isPlainMap(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[key] = stripUndefinedForSettings(entry);
      }
    }
    return out as T;
  }
  return value;
}
