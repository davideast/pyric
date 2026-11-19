/** RTDB environment controls, emulator binding, and logging for served apps. */
import type { AuthLens } from 'pyric/sandbox';
import {
  DELETED_DATABASE_USE_EMULATOR_ERROR,
  emitClientDatabaseLog,
  enableLogging,
  evaluateEmulatorConnect,
  type AppliedEmulatorConfig,
  type EmulatorConnectOptions,
} from 'pyric/database/internal';
import { isDisconnectedPort } from './core.js';
import type { ClientPort, ClientRtdb, ClientRtdbInstance } from './handles.js';

interface WorkerEmulatorState {
  started: boolean;
  config?: AppliedEmulatorConfig;
}

type WorkerInstanceHandle = {
  readonly port: ClientPort;
  readonly instance?: ClientRtdbInstance;
};

const emulatorStates = new WeakMap<ClientPort, Map<string, WorkerEmulatorState>>();

function instanceKeyOf(handle: WorkerInstanceHandle): string {
  if (handle.instance?.name !== undefined) {
    return handle.instance.name;
  }
  return '';
}

function stateFor(handle: WorkerInstanceHandle): WorkerEmulatorState {
  let byInstance = emulatorStates.get(handle.port);
  if (byInstance === undefined) {
    byInstance = new Map();
    emulatorStates.set(handle.port, byInstance);
  }
  const key = instanceKeyOf(handle);
  let state = byInstance.get(key);
  if (state === undefined) {
    state = { started: false };
    byInstance.set(key, state);
  }
  return state;
}

export function markWorkerDatabaseStarted(handle: WorkerInstanceHandle): void {
  stateFor(handle).started = true;
}

export function workerEmulatorLensFor(
  handle: WorkerInstanceHandle,
): Extract<AuthLens, { mode: 'as' }> | undefined {
  const byInstance = emulatorStates.get(handle.port);
  if (byInstance === undefined) {
    return undefined;
  }
  const state = byInstance.get(instanceKeyOf(handle));
  const mockAuth = state?.config?.mockUserAuth;
  if (mockAuth === undefined) {
    return undefined;
  }
  return {
    mode: 'as',
    uid: mockAuth.uid,
    token: mockAuth.token,
  };
}

export function rtdbServerTimestamp(): { readonly '.sv': 'timestamp' } {
  return { '.sv': 'timestamp' };
}

export function rtdbEnableLogging(
  logger?: boolean | ((message: string) => void),
  persistent?: boolean,
): void {
  enableLogging(logger, persistent);
}

export function rtdbConnectDatabaseEmulator(
  db: ClientRtdb,
  host: string,
  port: number,
  options?: EmulatorConnectOptions,
): void {
  if (isDisconnectedPort(db.port)) {
    throw new Error(DELETED_DATABASE_USE_EMULATOR_ERROR);
  }
  let projectId: string | undefined;
  const appCandidate = (db as { app?: { options?: { projectId?: string } } }).app;
  if (appCandidate !== undefined) {
    try {
      projectId = appCandidate.options?.projectId;
    } catch {
      projectId = undefined;
    }
  }
  const state = stateFor(db);
  const next = evaluateEmulatorConnect(
    state.started,
    state.config,
    host,
    port,
    options,
    projectId,
  );
  state.config = next;
  const mutableDb = db as { instance?: { readonly name?: string; url: string } };
  if (mutableDb.instance === undefined) {
    mutableDb.instance = { url: next.normalizedOriginUrl };
  } else {
    mutableDb.instance.url = next.normalizedOriginUrl;
  }
  emitClientDatabaseLog('connectDatabaseEmulator', next.hostAndPort);
}
