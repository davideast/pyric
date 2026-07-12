import * as WorkerRuntime from '@pyric/cli/serve/worker';
import { readPlaygroundSandboxMode, type PlaygroundSandboxMode } from '~/lib/studio-embed';
import {
  getRunner,
  type DeployResult,
  type SandboxRunner,
} from './runner';
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';

export type { PlaygroundSandboxMode };

const WORKER_URL = '/__pyric/sdk/worker.js';

let workerDb: WorkerRuntime.ClientDb | null = null;
let workerAuth: WorkerRuntime.ClientAuth | null = null;
let activeSandboxMode: PlaygroundSandboxMode | null = null;
const sandboxModeSubscribers = new Set<(mode: PlaygroundSandboxMode) => void>();

function fallbackSandboxMode(): PlaygroundSandboxMode {
  if (typeof window === 'undefined') return 'isolated';
  return readPlaygroundSandboxMode(window.location?.search ?? '');
}

export function getPlaygroundSandboxMode(): PlaygroundSandboxMode {
  return activeSandboxMode ?? fallbackSandboxMode();
}

export function setActivePlaygroundSandboxMode(mode: PlaygroundSandboxMode): void {
  if (activeSandboxMode === mode) return;
  activeSandboxMode = mode;
  for (const subscriber of sandboxModeSubscribers) subscriber(mode);
}

export function subscribePlaygroundSandboxMode(
  subscriber: (mode: PlaygroundSandboxMode) => void,
): () => void {
  sandboxModeSubscribers.add(subscriber);
  return () => sandboxModeSubscribers.delete(subscriber);
}

export function isSharedSandboxMode(): boolean {
  return getPlaygroundSandboxMode() === 'shared';
}

export function getWorkerDb(): WorkerRuntime.ClientDb {
  if (!workerDb) workerDb = WorkerRuntime.getFirestore(WORKER_URL);
  return workerDb;
}

export function getWorkerAuth(): WorkerRuntime.ClientAuth {
  if (!workerAuth) workerAuth = WorkerRuntime.getAuth(getWorkerDb());
  return workerAuth;
}

function normalizeDeployMessages(value: unknown): DeployResult['messages'] {
  if (!Array.isArray(value)) return [];
  return value.map((message) => {
    const raw = message as { severity?: unknown; text?: unknown; line?: unknown; column?: unknown; message?: unknown };
    return {
      severity: raw.severity === 'error' ? 'error' : raw.severity === 'warn' ? 'warn' : 'info',
      text: String(raw.text ?? raw.message ?? ''),
      ...(typeof raw.line === 'number' ? { line: raw.line } : {}),
      ...(typeof raw.column === 'number' ? { column: raw.column } : {}),
    };
  });
}

export interface AdminDocumentRecord {
  path: string;
  data: unknown;
  phantom?: true;
}

export interface PlaygroundRuntime {
  readonly mode: PlaygroundSandboxMode;
  deployFirestoreRules(source: string): Promise<DeployResult>;
  deployDatabaseRules(source: string): Promise<DeployResult>;
  readFirestoreState(opts?: { path?: string; maxDepth?: number }): Promise<Record<string, unknown>>;
  adminGetDocument(path: string): Promise<Record<string, unknown> | null>;
  adminListDocuments(path: string): Promise<AdminDocumentRecord[]>;
  adminSetDocument(path: string, data: unknown): Promise<void>;
  adminDeleteDocument(path: string): Promise<boolean>;
  readDatabaseState(): Promise<unknown>;
  adminSetDatabaseValue(path: string, value: unknown): Promise<void>;
  adminUpdateDatabaseValue(path: string, values: Record<string, unknown>): Promise<void>;
  adminDeleteDatabaseValue(path: string): Promise<void>;
  listAuthUsers(): Promise<AuthUserRecord[]>;
  adminCreateUser(request: CreateUserRequest): Promise<AuthUserRecord>;
  adminUpdateUser(uid: string, request: UpdateUserRequest): Promise<AuthUserRecord>;
  adminDeleteUser(uid: string): Promise<void>;
  adminClearUsers(): Promise<void>;
  eventHistory(): Promise<readonly unknown[]>;
  subscribeEvents(callback: (events: readonly unknown[]) => void): () => void;
  requireInProcessRunner(operation: string): SandboxRunner;
}

class InProcessPlaygroundRuntime implements PlaygroundRuntime {
  readonly mode = 'isolated' as const;

  deployFirestoreRules(source: string): Promise<DeployResult> {
    return Promise.resolve(getRunner().deployRules(source));
  }

  deployDatabaseRules(): Promise<DeployResult> {
    return Promise.resolve({
      ok: false,
      messages: [{ severity: 'error', text: 'Realtime Database rules require shared sandbox mode.' }],
    });
  }

  readFirestoreState(opts: { path?: string; maxDepth?: number } = {}): Promise<Record<string, unknown>> {
    return Promise.resolve(getRunner().readState(opts));
  }

  adminGetDocument(path: string): Promise<Record<string, unknown> | null> {
    return Promise.resolve(getRunner().getSandbox().admin.getDocument(path) as Record<string, unknown> | null);
  }

  adminListDocuments(path: string): Promise<AdminDocumentRecord[]> {
    return Promise.resolve(getRunner().getSandbox().admin.listDocuments(path) as AdminDocumentRecord[]);
  }

  adminSetDocument(path: string, data: unknown): Promise<void> {
    getRunner().admin.setDocument(path, data as Record<string, unknown>);
    return Promise.resolve();
  }

  adminDeleteDocument(path: string): Promise<boolean> {
    const result = getRunner().admin.deleteDocument(path);
    return Promise.resolve(typeof result === 'object' ? Boolean(result.deleted) : Boolean(result));
  }

  readDatabaseState(): Promise<unknown> {
    return import('pyric/database').then(({ getAdminDatabase, sandbox }) =>
      sandbox.snapshotState(getAdminDatabase(getRunner().getSandbox() as never)),
    );
  }

  adminSetDatabaseValue(path: string, value: unknown): Promise<void> {
    return import('pyric/database').then(({ getAdminDatabase, ref, set }) =>
      set(ref(getAdminDatabase(getRunner().getSandbox() as never), path), value),
    );
  }

  adminUpdateDatabaseValue(path: string, values: Record<string, unknown>): Promise<void> {
    return import('pyric/database').then(({ getAdminDatabase, ref, update }) =>
      update(ref(getAdminDatabase(getRunner().getSandbox() as never), path), values),
    );
  }

  adminDeleteDatabaseValue(path: string): Promise<void> {
    return import('pyric/database').then(({ getAdminDatabase, ref, remove }) =>
      remove(ref(getAdminDatabase(getRunner().getSandbox() as never), path)),
    );
  }

  listAuthUsers(): Promise<AuthUserRecord[]> {
    return import('pyric/auth').then(({ getAuth, sandbox }) =>
      sandbox.listUsers(getAuth(getRunner().getSandbox() as never)),
    );
  }

  adminCreateUser(request: CreateUserRequest): Promise<AuthUserRecord> {
    return import('pyric/auth').then(({ getAuth, sandbox }) =>
      sandbox.createUser(getAuth(getRunner().getSandbox() as never), request),
    );
  }

  adminUpdateUser(uid: string, request: UpdateUserRequest): Promise<AuthUserRecord> {
    return import('pyric/auth').then(({ getAuth, sandbox }) =>
      sandbox.updateUser(getAuth(getRunner().getSandbox() as never), uid, request),
    );
  }

  adminDeleteUser(uid: string): Promise<void> {
    return import('pyric/auth').then(({ getAuth, sandbox }) => {
      sandbox.deleteUser(getAuth(getRunner().getSandbox() as never), uid);
    });
  }

  adminClearUsers(): Promise<void> {
    return import('pyric/auth').then(({ getAuth, sandbox }) => {
      sandbox.clearUsers(getAuth(getRunner().getSandbox() as never));
    });
  }

  eventHistory(): Promise<readonly unknown[]> {
    return Promise.resolve(getRunner().getSandbox().history());
  }

  subscribeEvents(callback: (events: readonly unknown[]) => void): () => void {
    return getRunner().getSandbox().onEvent((event) => callback([event]));
  }

  requireInProcessRunner(): SandboxRunner {
    return getRunner();
  }
}

class SharedWorkerPlaygroundRuntime implements PlaygroundRuntime {
  readonly mode = 'shared' as const;

  async deployFirestoreRules(source: string): Promise<DeployResult> {
    try {
      const result = await WorkerRuntime.setFirestoreRules(getWorkerDb(), source);
      return {
        ok: result.ok,
        messages: normalizeDeployMessages(result.messages),
      };
    } catch (e) {
      return {
        ok: false,
        messages: [{ severity: 'error', text: e instanceof Error ? e.message : String(e) }],
      };
    }
  }

  async deployDatabaseRules(source: string): Promise<DeployResult> {
    try {
      const parsed = JSON.parse(source) as unknown;
      const result = await WorkerRuntime.setDatabaseRules(getWorkerDb(), parsed);
      return {
        ok: result.ok,
        messages: normalizeDeployMessages(result.messages),
      };
    } catch (e) {
      return {
        ok: false,
        messages: [{ severity: 'error', text: e instanceof Error ? e.message : String(e) }],
      };
    }
  }

  readFirestoreState(opts: { path?: string; maxDepth?: number } = {}): Promise<Record<string, unknown>> {
    return WorkerRuntime.adminReadState(getWorkerDb(), opts);
  }

  adminGetDocument(path: string): Promise<Record<string, unknown> | null> {
    return WorkerRuntime.adminGetDocument(getWorkerDb(), path) as Promise<Record<string, unknown> | null>;
  }

  adminListDocuments(path: string): Promise<AdminDocumentRecord[]> {
    return WorkerRuntime.adminListDocuments(getWorkerDb(), path) as Promise<AdminDocumentRecord[]>;
  }

  async adminSetDocument(path: string, data: unknown): Promise<void> {
    await WorkerRuntime.adminSetDocument(getWorkerDb(), path, data);
  }

  adminDeleteDocument(path: string): Promise<boolean> {
    return WorkerRuntime.adminDeleteDocument(getWorkerDb(), path);
  }

  readDatabaseState(): Promise<unknown> {
    return WorkerRuntime.adminReadRtdbState(getWorkerDb());
  }

  adminSetDatabaseValue(path: string, value: unknown): Promise<void> {
    return WorkerRuntime.adminSetRtdbValue(getWorkerDb(), path, value);
  }

  adminUpdateDatabaseValue(path: string, values: Record<string, unknown>): Promise<void> {
    return WorkerRuntime.adminUpdateRtdbValue(getWorkerDb(), path, values);
  }

  adminDeleteDatabaseValue(path: string): Promise<void> {
    return WorkerRuntime.adminDeleteRtdbValue(getWorkerDb(), path);
  }

  listAuthUsers(): Promise<AuthUserRecord[]> {
    return WorkerRuntime.listUsers(getWorkerAuth());
  }

  adminCreateUser(request: CreateUserRequest): Promise<AuthUserRecord> {
    return WorkerRuntime.adminCreateUser(getWorkerAuth(), request);
  }

  adminUpdateUser(uid: string, request: UpdateUserRequest): Promise<AuthUserRecord> {
    return WorkerRuntime.adminUpdateUser(getWorkerAuth(), uid, request);
  }

  adminDeleteUser(uid: string): Promise<void> {
    return WorkerRuntime.adminDeleteUser(getWorkerAuth(), uid);
  }

  adminClearUsers(): Promise<void> {
    return WorkerRuntime.adminClearUsers(getWorkerAuth());
  }

  eventHistory(): Promise<readonly unknown[]> {
    return WorkerRuntime.eventHistory(getWorkerDb());
  }

  subscribeEvents(callback: (events: readonly unknown[]) => void): () => void {
    return WorkerRuntime.subscribeEvents(getWorkerDb(), callback);
  }

  requireInProcessRunner(operation: string): SandboxRunner {
    throw new Error(`${operation} is not available in shared sandbox mode yet. Use the shared runtime APIs instead.`);
  }
}

const inProcessRuntime = new InProcessPlaygroundRuntime();
const workerRuntime = new SharedWorkerPlaygroundRuntime();

export function getPlaygroundRuntime(): PlaygroundRuntime {
  return isSharedSandboxMode() ? workerRuntime : inProcessRuntime;
}

export async function deployFirestoreRules(source: string): Promise<DeployResult> {
  return getPlaygroundRuntime().deployFirestoreRules(source);
}

export async function deployDatabaseRules(source: string): Promise<DeployResult> {
  return getPlaygroundRuntime().deployDatabaseRules(source);
}

export async function readFirestoreState(
  opts: { path?: string; maxDepth?: number } = {},
): Promise<Record<string, unknown>> {
  return getPlaygroundRuntime().readFirestoreState(opts);
}

export async function readDatabaseState(): Promise<unknown> {
  return getPlaygroundRuntime().readDatabaseState();
}

export async function adminSetDatabaseValue(path: string, value: unknown): Promise<void> {
  return getPlaygroundRuntime().adminSetDatabaseValue(path, value);
}

export async function adminUpdateDatabaseValue(
  path: string,
  values: Record<string, unknown>,
): Promise<void> {
  return getPlaygroundRuntime().adminUpdateDatabaseValue(path, values);
}

export async function adminDeleteDatabaseValue(path: string): Promise<void> {
  return getPlaygroundRuntime().adminDeleteDatabaseValue(path);
}

export const sharedWorkerRuntime = WorkerRuntime;
