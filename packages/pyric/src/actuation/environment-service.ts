/**
 * Pure domain service for global environment controls (`controlSandboxEnvironment`),
 * Cloud Function invocation (`invokeCloudFunction`), AI mock configuration (`configureAiMock`),
 * and MCP Resource reading (`readSandboxResource`).
 */

import type { LocalSandbox, SandboxSnapshot } from 'pyric/sandbox';
import { getFirestore, enableNetwork, disableNetwork } from 'pyric/firestore';
import { getDatabase, goOnline, goOffline } from 'pyric/database';
import { snapshotState } from 'pyric/sandbox/database';
import { getAuth, sandbox as authDriver } from 'pyric/auth';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { ref, listAll } from 'pyric/storage';
import { getAI } from 'pyric/ai';
import { script, type ScriptingEntry } from 'pyric/ai/scripting';
import { getActiveIdentityLens, resetActiveIdentityLens } from './auth-service.js';
import { parsePathSegments, canonicalizePath } from '../sandbox/internal/index.js';

export interface SandboxClockState {
  offsetMs: number;
  fixedTimestampMs: number | null;
}

const clockStateMap = new WeakMap<LocalSandbox, SandboxClockState>();
const networkStateMap = new WeakMap<LocalSandbox, 'online' | 'offline'>();

export function getSandboxCurrentTimeIso(sandbox: LocalSandbox): string {
  const state = clockStateMap.get(sandbox);
  if (!state) {
    return new Date().toISOString();
  }
  if (state.fixedTimestampMs !== null) {
    return new Date(state.fixedTimestampMs + state.offsetMs).toISOString();
  }
  return new Date(Date.now() + state.offsetMs).toISOString();
}

export function getSandboxNetworkState(sandbox: LocalSandbox): 'online' | 'offline' {
  return networkStateMap.get(sandbox) ?? 'online';
}

export interface ControlSandboxEnvironmentInput {
  action: 'reset_all' | 'advance_clock' | 'set_network' | 'seed';
  advanceMs?: number;
  targetTimestampIso?: string;
  networkState?: 'online' | 'offline';
  seedSnapshotJson?: string;
  seedSnapshot?: SandboxSnapshot;
}

export interface ControlSandboxEnvironmentOutput {
  ok: boolean;
  action: ControlSandboxEnvironmentInput['action'];
  errors: string[];
  currentTimeIso: string;
  networkState: 'online' | 'offline';
}

export async function controlSandboxEnvironment(
  sandbox: LocalSandbox,
  input: ControlSandboxEnvironmentInput
): Promise<ControlSandboxEnvironmentOutput> {
  const errors: string[] = [];

  if (input.action === 'reset_all') {
    const res = await sandbox.resetAll();
    if (res.errors.length > 0) {
      errors.push(...res.errors);
    }
    clockStateMap.delete(sandbox);
    networkStateMap.set(sandbox, 'online');
    resetActiveIdentityLens(sandbox);
    return {
      ok: errors.length === 0,
      action: 'reset_all',
      errors,
      currentTimeIso: getSandboxCurrentTimeIso(sandbox),
      networkState: 'online',
    };
  }

  if (input.action === 'advance_clock') {
    let state = clockStateMap.get(sandbox);
    if (!state) {
      state = { offsetMs: 0, fixedTimestampMs: null };
      clockStateMap.set(sandbox, state);
    }
    if (input.targetTimestampIso) {
      const parsed = Date.parse(input.targetTimestampIso);
      if (!Number.isNaN(parsed)) {
        state.fixedTimestampMs = parsed;
        state.offsetMs = 0;
      }
    }
    if (input.advanceMs !== undefined) {
      state.offsetMs += input.advanceMs;
    }
    return {
      ok: true,
      action: 'advance_clock',
      errors: [],
      currentTimeIso: getSandboxCurrentTimeIso(sandbox),
      networkState: getSandboxNetworkState(sandbox),
    };
  }

  if (input.action === 'set_network') {
    const state = input.networkState ?? 'online';
    networkStateMap.set(sandbox, state);
    try {
      const db = getFirestore(sandbox);
      if (state === 'online') {
        await enableNetwork(db);
      } else {
        await disableNetwork(db);
      }
    } catch {
      // Ignore if Firestore is not active
    }
    try {
      const rtdb = getDatabase(sandbox);
      if (state === 'online') {
        goOnline(rtdb);
      } else {
        goOffline(rtdb);
      }
    } catch {
      // Ignore if RTDB is not active
    }
    return {
      ok: true,
      action: 'set_network',
      errors: [],
      currentTimeIso: getSandboxCurrentTimeIso(sandbox),
      networkState: state,
    };
  }

  if (input.action === 'seed') {
    const snap =
      input.seedSnapshot ??
      (input.seedSnapshotJson ? (JSON.parse(input.seedSnapshotJson) as SandboxSnapshot) : null);
    if (snap) {
      sandbox.loadSnapshot(snap);
    }
    return {
      ok: true,
      action: 'seed',
      errors: [],
      currentTimeIso: getSandboxCurrentTimeIso(sandbox),
      networkState: getSandboxNetworkState(sandbox),
    };
  }

  return {
    ok: false,
    action: input.action,
    errors: [`Unsupported environment action: ${input.action}`],
    currentTimeIso: getSandboxCurrentTimeIso(sandbox),
    networkState: getSandboxNetworkState(sandbox),
  };
}

export interface InvokeCloudFunctionInput {
  functionName: string;
  triggerType: 'callable' | 'firestore_write' | 'auth_create' | 'storage_object';
  dataJson?: string;
  data?: unknown;
  auth?: {
    uid?: string;
    tenant?: string;
    claimsJson?: string;
  };
}

export interface InvokeCloudFunctionOutput {
  ok: boolean;
  functionName: string;
  triggerType: InvokeCloudFunctionInput['triggerType'];
  result: unknown;
  error?: string;
}

export async function invokeCloudFunction(
  sandbox: LocalSandbox,
  input: InvokeCloudFunctionInput
): Promise<InvokeCloudFunctionOutput> {
  const payload =
    input.data !== undefined
      ? input.data
      : input.dataJson !== undefined
        ? JSON.parse(input.dataJson)
        : {};

  return {
    ok: true,
    functionName: input.functionName,
    triggerType: input.triggerType,
    result: {
      invoked: input.functionName,
      triggerType: input.triggerType,
      payload,
      timestampIso: getSandboxCurrentTimeIso(sandbox),
    },
  };
}

export interface ConfigureAiMockInput {
  action: 'append_script' | 'clear_scripts';
  entries?: Array<{
    matchSubstring?: string;
    responseType: 'text' | 'json' | 'error';
    responsePayload: string;
    errorCode?: number;
  }>;
}

export interface ConfigureAiMockOutput {
  ok: boolean;
  action: ConfigureAiMockInput['action'];
  queuedCount: number;
  error?: string;
}

export async function configureAiMock(
  sandbox: LocalSandbox,
  input: ConfigureAiMockInput
): Promise<ConfigureAiMockOutput> {
  try {
    const ai = getAI(sandbox);
    if (input.action === 'append_script') {
      const scriptingEntries: ScriptingEntry[] = (input.entries ?? []).map((e) => {
        if (e.responseType === 'json') {
          return {
            match: e.matchSubstring,
            respond: { json: JSON.parse(e.responsePayload) },
          };
        }
        if (e.responseType === 'error') {
          return {
            match: e.matchSubstring,
            respond: {
              error: {
                httpStatus: e.errorCode ?? 500,
                body: { error: { message: e.responsePayload } },
              },
            },
          };
        }
        return {
          match: e.matchSubstring,
          respond: { text: e.responsePayload },
        };
      });
      script(ai, scriptingEntries);
      return {
        ok: true,
        action: 'append_script',
        queuedCount: scriptingEntries.length,
      };
    }
    return {
      ok: true,
      action: 'clear_scripts',
      queuedCount: 0,
    };
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      queuedCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readSandboxResource(
  sandbox: LocalSandbox,
  uri: string
): Promise<unknown> {
  const cleanUri = uri.trim();

  if (cleanUri === 'pyric://sandbox/status') {
    const docs = sandbox.admin.listDocuments('').filter((d) => !d.phantom);
    const rtdbTree = snapshotState(sandbox) as Record<string, unknown> | null;
    const authUsers = authDriver.listUsers(getAuth(sandbox));
    const storageList = await listAll(ref(getAdminStorageSandbox(sandbox), ''));

    return {
      status: 'ok',
      project: 'default-sandbox',
      networkState: getSandboxNetworkState(sandbox),
      currentTimeIso: getSandboxCurrentTimeIso(sandbox),
      activeIdentity: getActiveIdentityLens(sandbox),
      services: {
        firestore: { documentCount: docs.length, rulesLoaded: true },
        database: {
          rootNodeCount: rtdbTree ? Object.keys(rtdbTree).length : 0,
          rulesLoaded: true,
        },
        auth: { userCount: authUsers.length },
        storage: { objectCount: storageList.items.length },
      },
    };
  }

  if (cleanUri.startsWith('pyric://sandbox/events')) {
    const events = sandbox.history();
    return {
      totalCount: events.length,
      events,
    };
  }

  if (cleanUri.startsWith('pyric://firestore/docs/')) {
    const rawPath = cleanUri.slice('pyric://firestore/docs/'.length);
    const path = canonicalizePath(rawPath);
    const segments = parsePathSegments(path);
    const isDocument = segments.length % 2 === 0 && segments.length > 0;
    if (isDocument) {
      const docData = sandbox.admin.getDocument(path);
      return {
        kind: 'document',
        path,
        exists: docData !== null && docData !== undefined,
        data: docData ?? null,
      };
    }
    const docs = sandbox.admin.listDocuments(path).filter((d) => !d.phantom);
    return {
      kind: 'collection',
      path,
      documents: docs.map((d) => ({ path: d.path, data: d.data })),
    };
  }

  if (cleanUri.startsWith('pyric://database/tree/')) {
    const rawPath = cleanUri.slice('pyric://database/tree/'.length);
    const path = canonicalizePath(rawPath);
    const segments = parsePathSegments(path);
    const fullTree = snapshotState(sandbox) as Record<string, unknown> | null;
    let node: unknown = fullTree;
    if (path && path !== 'root') {
      for (const seg of segments) {
        if (node && typeof node === 'object' && seg in (node as Record<string, unknown>)) {
          node = (node as Record<string, unknown>)[seg];
        } else {
          node = null;
          break;
        }
      }
    }
    const exists = node !== null && node !== undefined;
    const childKeys =
      exists && typeof node === 'object' ? Object.keys(node as Record<string, unknown>) : [];
    return {
      path: `/${path}`,
      exists,
      value: node ?? null,
      childKeys,
    };
  }

  if (cleanUri === 'pyric://auth/users') {
    const users = authDriver.listUsers(getAuth(sandbox));
    return {
      count: users.length,
      users,
    };
  }

  if (cleanUri.startsWith('pyric://storage/objects/')) {
    const bucket = cleanUri.slice('pyric://storage/objects/'.length) || 'default';
    const storageList = await listAll(ref(getAdminStorageSandbox(sandbox), ''));
    return {
      bucket,
      objects: storageList.items.map((item) => ({
        path: item.fullPath,
      })),
    };
  }

  if (cleanUri.startsWith('pyric://stdlib/rules/')) {
    const moduleKey = cleanUri.slice('pyric://stdlib/rules/'.length) || 'index';
    if (moduleKey === 'index') {
      return {
        modules: [
          {
            key: 'math',
            kind: 'namespace',
            services: ['firestore', 'storage'],
            description: 'Mathematical helper functions (abs, ceil, floor, round, pow, sqrt).',
          },
          {
            key: 'string',
            kind: 'namespace',
            services: ['firestore', 'storage'],
            description: 'String manipulation helpers (size, split, matches, lower, upper).',
          },
          {
            key: 'list',
            kind: 'namespace',
            services: ['firestore', 'storage'],
            description: 'List operations (hasAll, hasAny, hasOnly, size).',
          },
        ],
      };
    }
    return {
      key: moduleKey,
      kind: 'namespace',
      description: `Standard library rules documentation for ${moduleKey}.`,
      entries: [],
    };
  }

  throw new Error(`Unsupported MCP Resource URI: ${uri}`);
}
