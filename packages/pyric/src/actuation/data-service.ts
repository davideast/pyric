/**
 * Pure domain service for atomic mutations (`mutateSandboxData`) and structured
 * queries (`querySandboxData`) across Firestore and Realtime Database (`database`).
 */

import type { LocalSandbox, SandboxContext } from 'pyric/sandbox';
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  type WhereFilterOp,
} from 'pyric/firestore';
import {
  getDatabase,
  ref,
  set,
  update,
  remove,
  push,
  get,
} from 'pyric/database';
import { setData, snapshotState } from 'pyric/sandbox/database';
import { getActiveIdentityLens, buildNormalizedClaims } from './auth-service.js';
import { canonicalizePath } from '../sandbox/internal/index.js';

export interface AuthOverrideInput {
  mode: 'admin' | 'uid' | 'anonymous';
  uid?: string;
  tenant?: string;
  claimsJson?: string;
  claims?: Record<string, unknown>;
}

export interface BatchOperationInput {
  op: 'set' | 'update' | 'delete';
  path: string;
  dataJson?: string;
  data?: Record<string, unknown>;
}

export interface MutateSandboxDataInput {
  service: 'firestore' | 'database';
  action: 'set' | 'add' | 'update' | 'delete' | 'batch' | 'transaction';
  path?: string;
  dataJson?: string;
  data?: Record<string, unknown>;
  batchOps?: BatchOperationInput[];
  auth?: AuthOverrideInput;
}

export interface MutateSandboxDataOutput {
  ok: boolean;
  committed: number;
  paths: string[];
  error?: string;
}

export interface QueryFilterInput {
  field: string;
  op: WhereFilterOp;
  valueJson?: string;
  value?: unknown;
}

export interface QuerySandboxDataInput {
  service: 'firestore' | 'database';
  path: string;
  filters?: QueryFilterInput[];
  orderByField?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  auth?: AuthOverrideInput;
}

export interface QuerySandboxDataOutput {
  ok: boolean;
  count: number;
  results: Array<{ path: string; data: unknown }>;
  error?: string;
}

export function resolveAuthContext(
  sandbox: LocalSandbox,
  auth?: AuthOverrideInput
): { isAdmin: boolean; context: LocalSandbox | SandboxContext } {
  if (!auth) {
    const lens = getActiveIdentityLens(sandbox);
    if (lens.mode === 'admin') {
      return { isAdmin: true, context: sandbox };
    }
    if (lens.mode === 'anonymous') {
      return { isAdmin: false, context: sandbox.withAuth(null) };
    }
    if (lens.mode === 'uid' && lens.uid) {
      const token = buildNormalizedClaims(lens.claims ?? {}, lens.tenant);
      return {
        isAdmin: false,
        context: sandbox.withAuth({
          uid: lens.uid,
          token,
        }),
      };
    }
    return { isAdmin: false, context: sandbox };
  }
  if (auth.mode === 'admin') {
    return { isAdmin: true, context: sandbox };
  }
  if (auth.mode === 'anonymous') {
    return { isAdmin: false, context: sandbox.withAuth(null) };
  }
  if (auth.mode === 'uid') {
    if (!auth.uid) {
      throw new Error("auth.uid is required when auth.mode is 'uid'");
    }
    const claims =
      auth.claims ?? (auth.claimsJson ? (JSON.parse(auth.claimsJson) as Record<string, unknown>) : {});
    const token = buildNormalizedClaims(claims, auth.tenant);
    return {
      isAdmin: false,
      context: sandbox.withAuth({
        uid: auth.uid,
        token,
      }),
    };
  }
  return { isAdmin: false, context: sandbox };
}

function parseDataPayload(
  data?: Record<string, unknown>,
  dataJson?: string
): Record<string, unknown> {
  if (data !== undefined) return data;
  if (dataJson !== undefined) return JSON.parse(dataJson) as Record<string, unknown>;
  return {};
}

function normalizePath(path: string): string {
  return canonicalizePath(path);
}

function mutateRtdbTreeAdmin(
  sandbox: LocalSandbox,
  path: string,
  action: 'set' | 'update' | 'delete',
  data?: unknown
): void {
  const rawTree = snapshotState(sandbox);
  const tree: Record<string, unknown> =
    typeof rawTree === 'object' && rawTree !== null
      ? structuredClone(rawTree as Record<string, unknown>)
      : {};
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    if (action === 'delete') {
      setData(sandbox, {});
    } else if (action === 'update' && typeof data === 'object' && data !== null) {
      setData(sandbox, { ...tree, ...data });
    } else {
      setData(sandbox, (data as Record<string, unknown>) ?? {});
    }
    return;
  }
  let current: Record<string, unknown> = tree;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (typeof current[seg] !== 'object' || current[seg] === null) {
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }
  const lastSeg = segments[segments.length - 1]!;
  if (action === 'delete') {
    delete current[lastSeg];
  } else if (action === 'update' && typeof data === 'object' && data !== null) {
    const existing =
      typeof current[lastSeg] === 'object' && current[lastSeg] !== null
        ? (current[lastSeg] as Record<string, unknown>)
        : {};
    current[lastSeg] = { ...existing, ...data };
  } else {
    current[lastSeg] = data;
  }
  setData(sandbox, tree);
}

export async function mutateSandboxData(
  sandbox: LocalSandbox,
  input: MutateSandboxDataInput
): Promise<MutateSandboxDataOutput> {
  try {
    const { isAdmin, context } = resolveAuthContext(sandbox, input.auth);

    if (input.service === 'firestore') {
      const db = getFirestore(context);
      const path = input.path ? normalizePath(input.path) : '';

      if (input.action === 'set') {
        const data = parseDataPayload(input.data, input.dataJson);
        if (isAdmin) {
          sandbox.admin.setDocument(path, data);
        } else {
          await setDoc(doc(db, path), data);
        }
        return { ok: true, committed: 1, paths: [path] };
      }

      if (input.action === 'add') {
        const data = parseDataPayload(input.data, input.dataJson);
        if (isAdmin) {
          const autoId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const fullPath = `${path}/${autoId}`;
          sandbox.admin.setDocument(fullPath, data);
          return { ok: true, committed: 1, paths: [fullPath] };
        } else {
          const docRef = await addDoc(collection(db, path), data);
          return { ok: true, committed: 1, paths: [docRef.path] };
        }
      }

      if (input.action === 'update') {
        const data = parseDataPayload(input.data, input.dataJson);
        if (isAdmin) {
          const existing = (sandbox.admin.getDocument(path) as Record<string, unknown> | null) ?? {};
          sandbox.admin.setDocument(path, { ...existing, ...data });
        } else {
          await updateDoc(doc(db, path), data);
        }
        return { ok: true, committed: 1, paths: [path] };
      }

      if (input.action === 'delete') {
        if (isAdmin) {
          sandbox.admin.deleteDocument(path);
        } else {
          await deleteDoc(doc(db, path));
        }
        return { ok: true, committed: 1, paths: [path] };
      }

      if (input.action === 'batch' || input.action === 'transaction') {
        const ops = input.batchOps ?? [];
        const paths: string[] = [];

        if (isAdmin) {
          for (const op of ops) {
            const opPath = normalizePath(op.path);
            paths.push(opPath);
            if (op.op === 'set') {
              sandbox.admin.setDocument(opPath, parseDataPayload(op.data, op.dataJson));
            } else if (op.op === 'update') {
              const existing = (sandbox.admin.getDocument(opPath) as Record<string, unknown> | null) ?? {};
              sandbox.admin.setDocument(opPath, {
                ...existing,
                ...parseDataPayload(op.data, op.dataJson),
              });
            } else if (op.op === 'delete') {
              sandbox.admin.deleteDocument(opPath);
            }
          }
          return { ok: true, committed: ops.length, paths };
        }

        if (input.action === 'batch') {
          const batch = writeBatch(db);
          for (const op of ops) {
            const opPath = normalizePath(op.path);
            paths.push(opPath);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docRef = doc(db, opPath) as any;
            if (op.op === 'set') {
              batch.set(docRef, parseDataPayload(op.data, op.dataJson));
            } else if (op.op === 'update') {
              batch.update(docRef, parseDataPayload(op.data, op.dataJson));
            } else if (op.op === 'delete') {
              batch.delete(docRef);
            }
          }
          await batch.commit();
          return { ok: true, committed: ops.length, paths };
        } else {
          await runTransaction(db, async (tx) => {
            for (const op of ops) {
              const opPath = normalizePath(op.path);
              paths.push(opPath);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const docRef = doc(db, opPath) as any;
              if (op.op === 'set') {
                tx.set(docRef, parseDataPayload(op.data, op.dataJson));
              } else if (op.op === 'update') {
                tx.update(docRef, parseDataPayload(op.data, op.dataJson));
              } else if (op.op === 'delete') {
                tx.delete(docRef);
              }
            }
          });
          return { ok: true, committed: ops.length, paths };
        }
      }
    }

    if (input.service === 'database') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = getDatabase(context as any);
      const path = input.path ? normalizePath(input.path) : '';

      if (input.action === 'set') {
        const data = parseDataPayload(input.data, input.dataJson);
        if (isAdmin) {
          mutateRtdbTreeAdmin(sandbox, path, 'set', data);
        } else {
          await set(ref(db, path), data);
        }
        return { ok: true, committed: 1, paths: [path] };
      }

      if (input.action === 'add') {
        const data = parseDataPayload(input.data, input.dataJson);
        if (isAdmin) {
          const autoKey = `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const newPath = path ? `${path}/${autoKey}` : autoKey;
          mutateRtdbTreeAdmin(sandbox, newPath, 'set', data);
          return { ok: true, committed: 1, paths: [newPath] };
        }
        const newRef = await push(ref(db, path), data);
        const newPath = newRef.key ? `${path}/${newRef.key}` : path;
        return { ok: true, committed: 1, paths: [newPath] };
      }

      if (input.action === 'update') {
        const data = parseDataPayload(input.data, input.dataJson);
        if (isAdmin) {
          mutateRtdbTreeAdmin(sandbox, path, 'update', data);
        } else {
          await update(ref(db, path), data);
        }
        return { ok: true, committed: 1, paths: [path] };
      }

      if (input.action === 'delete') {
        if (isAdmin) {
          mutateRtdbTreeAdmin(sandbox, path, 'delete');
        } else {
          await remove(ref(db, path));
        }
        return { ok: true, committed: 1, paths: [path] };
      }

      if (input.action === 'batch' || input.action === 'transaction') {
        const ops = input.batchOps ?? [];
        const paths: string[] = [];
        for (const op of ops) {
          const opPath = normalizePath(op.path);
          paths.push(opPath);
          if (isAdmin) {
            mutateRtdbTreeAdmin(sandbox, opPath, op.op, parseDataPayload(op.data, op.dataJson));
          } else if (op.op === 'set') {
            await set(ref(db, opPath), parseDataPayload(op.data, op.dataJson));
          } else if (op.op === 'update') {
            await update(ref(db, opPath), parseDataPayload(op.data, op.dataJson));
          } else if (op.op === 'delete') {
            await remove(ref(db, opPath));
          }
        }
        return { ok: true, committed: ops.length, paths };
      }
    }

    return {
      ok: false,
      committed: 0,
      paths: [],
      error: `Unsupported service or action: ${input.service}/${input.action}`,
    };
  } catch (err) {
    return {
      ok: false,
      committed: 0,
      paths: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function evaluateFilter(itemData: Record<string, unknown>, filter: QueryFilterInput): boolean {
  const fieldVal = itemData[filter.field];
  const targetVal =
    filter.value !== undefined
      ? filter.value
      : filter.valueJson !== undefined
        ? JSON.parse(filter.valueJson)
        : undefined;

  switch (filter.op) {
    case '==':
      return fieldVal === targetVal;
    case '!=':
      return fieldVal !== targetVal;
    case '<':
      return (fieldVal as number) < (targetVal as number);
    case '<=':
      return (fieldVal as number) <= (targetVal as number);
    case '>':
      return (fieldVal as number) > (targetVal as number);
    case '>=':
      return (fieldVal as number) >= (targetVal as number);
    case 'in':
      return Array.isArray(targetVal) && targetVal.includes(fieldVal);
    case 'not-in':
      return Array.isArray(targetVal) && !targetVal.includes(fieldVal);
    case 'array-contains':
      return Array.isArray(fieldVal) && fieldVal.includes(targetVal);
    case 'array-contains-any':
      return (
        Array.isArray(fieldVal) &&
        Array.isArray(targetVal) &&
        targetVal.some((v) => fieldVal.includes(v))
      );
    default:
      return true;
  }
}

export async function querySandboxData(
  sandbox: LocalSandbox,
  input: QuerySandboxDataInput
): Promise<QuerySandboxDataOutput> {
  try {
    const { isAdmin, context } = resolveAuthContext(sandbox, input.auth);
    const path = normalizePath(input.path);
    const segments = path.split('/').filter(Boolean);

    if (input.service === 'firestore') {
      const db = getFirestore(context);
      const isDocumentPath = segments.length % 2 === 0 && segments.length > 0;

      if (isDocumentPath) {
        if (isAdmin) {
          const data = sandbox.admin.getDocument(path);
          if (data === null || data === undefined) {
            return { ok: true, count: 0, results: [] };
          }
          return { ok: true, count: 1, results: [{ path, data }] };
        } else {
          const snap = await getDoc(doc(db, path));
          const exists = typeof snap.exists === 'function' ? snap.exists() : Boolean(snap.exists);
          if (!exists) {
            return { ok: true, count: 0, results: [] };
          }
          return { ok: true, count: 1, results: [{ path: snap.ref.path, data: snap.data() }] };
        }
      }

      // Collection path
      if (isAdmin) {
        const rawDocs = sandbox.admin.listDocuments(path).filter((d) => !d.phantom);
        let filtered = rawDocs.filter((d) => {
          const docData = (d.data ?? {}) as Record<string, unknown>;
          return (input.filters ?? []).every((f) => evaluateFilter(docData, f));
        });

        if (input.orderByField) {
          const field = input.orderByField;
          const dir = input.orderDirection === 'desc' ? -1 : 1;
          filtered.sort((a, b) => {
            const va = ((a.data as Record<string, unknown>)[field] ?? 0) as number | string;
            const vb = ((b.data as Record<string, unknown>)[field] ?? 0) as number | string;
            return va < vb ? -dir : va > vb ? dir : 0;
          });
        }

        if (input.limit !== undefined && input.limit > 0) {
          filtered = filtered.slice(0, input.limit);
        }

        const results = filtered.map((d) => ({ path: d.path, data: d.data }));
        return { ok: true, count: results.length, results };
      } else {
        const constraints = [];
        for (const f of input.filters ?? []) {
          const val =
            f.value !== undefined
              ? f.value
              : f.valueJson !== undefined
                ? JSON.parse(f.valueJson)
                : undefined;
          constraints.push(where(f.field, f.op, val));
        }
        if (input.orderByField) {
          constraints.push(orderBy(input.orderByField, input.orderDirection ?? 'asc'));
        }
        if (input.limit !== undefined && input.limit > 0) {
          constraints.push(limit(input.limit));
        }
        const q = query(collection(db, path), ...constraints);
        const snap = await getDocs(q);
        const results = snap.docs.map((d) => ({ path: d.ref.path, data: d.data() }));
        return { ok: true, count: results.length, results };
      }
    }

    if (input.service === 'database') {
      if (isAdmin) {
        const fullTree = snapshotState(sandbox) as Record<string, unknown> | null;
        let node: unknown = fullTree;
        for (const seg of segments) {
          if (node && typeof node === 'object' && seg in (node as Record<string, unknown>)) {
            node = (node as Record<string, unknown>)[seg];
          } else {
            node = null;
            break;
          }
        }
        if (node === null || node === undefined) {
          return { ok: true, count: 0, results: [] };
        }
        return { ok: true, count: 1, results: [{ path, data: node }] };
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = getDatabase(context as any);
        const snap = await get(ref(db, path));
        if (!snap.exists()) {
          return { ok: true, count: 0, results: [] };
        }
        return { ok: true, count: 1, results: [{ path, data: snap.val() }] };
      }
    }

    return {
      ok: false,
      count: 0,
      results: [],
      error: `Unsupported service: ${input.service}`,
    };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      results: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
