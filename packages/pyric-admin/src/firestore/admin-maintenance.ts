/**
 * `Firestore.{getAll, listCollections, recursiveDelete}` implementation across
 * local (`rawDb.snapshot()`) and remote (`admin.readState`) sandboxes.
 */
import { SandboxError, isRemoteSandbox, type Sandbox } from 'pyric/sandbox';
import {
  registeredAdminReferencePath,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type SnapshotFieldPath,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import { adminDocSnapshotBrand, adminDocumentRefBrand, adminToRootDb, isPlainMap } from './admin-handle-registry.js';
import type { AdminBulkWriter } from './admin-bulk-writer.js';
import { markAdminFirestoreStarted } from './admin-settings-lifecycle.js';
import {
  assertAdminDocumentReference,
  isPlainDocumentObject,
  validateStringOrFieldPath,
} from './admin-write-validation.js';

function isAdminDocRef(value: unknown): value is DocumentReference {
  if (value === null || typeof value !== 'object') return false;
  return adminDocumentRefBrand.has(value) || registeredAdminReferencePath(value) !== undefined;
}

function readNestedField(source: DocumentData, segments: readonly string[]): { found: boolean; value: unknown } {
  let cursor: unknown = source;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, seg)) {
      return { found: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return { found: true, value: cursor };
}

function projectDocumentByMask(
  source: DocumentData,
  maskPaths: ReadonlyArray<readonly string[]>,
): DocumentData {
  const result: Record<string, unknown> = {};
  for (const segments of maskPaths) {
    const resolved = readNestedField(source, segments);
    if (!resolved.found) continue;
    let target = result;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i] as string;
      if (!isPlainMap(target[seg])) target[seg] = {};
      target = target[seg] as Record<string, unknown>;
    }
    target[segments[segments.length - 1] as string] = resolved.value;
  }
  return result;
}

function wrapProjectedSnapshot(
  snap: DocumentSnapshot,
  rootDb: SandboxFirestore,
  maskPaths: ReadonlyArray<readonly string[]>,
): DocumentSnapshot {
  const proxy = new Proxy(snap, {
    get(target, prop) {
      if (prop === 'data') {
        return () => {
          const full = target.data();
          if (full === undefined) return undefined;
          return projectDocumentByMask(full, maskPaths);
        };
      }
      if (prop === 'get') {
        return (fieldPath: SnapshotFieldPath) => {
          const full = target.data();
          if (full === undefined) return undefined;
          const projected = projectDocumentByMask(full, maskPaths);
          return readNestedField(projected, validateStringOrFieldPath('fieldPath', fieldPath)).value;
        };
      }
      const val = Reflect.get(target, prop, target);
      if (typeof val === 'function') return val.bind(target);
      return val;
    },
  });
  adminDocSnapshotBrand.add(proxy);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

export async function adminGetAll(
  rootDb: SandboxFirestore,
  args: readonly unknown[],
): Promise<DocumentSnapshot[]> {
  markAdminFirestoreStarted(rootDb);
  if (args.length === 0) {
    throw new SandboxError('invalid-argument', 'Function "Firestore.getAll()" requires at least 1 argument.');
  }
  if (Array.isArray(args[0])) {
    throw new SandboxError('invalid-argument', 'Function "Firestore.getAll()" does not accept an array.');
  }
  let refArgs = args;
  let maskPaths: Array<readonly string[]> | undefined;
  const lastArg = args[args.length - 1];
  if (isPlainDocumentObject(lastArg) && !isAdminDocRef(lastArg)) {
    refArgs = args.slice(0, -1);
    if ('fieldMask' in lastArg && lastArg.fieldMask !== undefined) {
      if (!Array.isArray(lastArg.fieldMask)) {
        throw new SandboxError('invalid-argument', 'Value for argument "options" is not a valid read option.');
      }
      maskPaths = lastArg.fieldMask.map((entry, idx) => validateStringOrFieldPath(idx, entry));
    }
  }
  const refs: DocumentReference[] = [];
  for (const candidate of refArgs) {
    assertAdminDocumentReference('documentRefsOrReadOptions', candidate);
    refs.push(candidate as DocumentReference);
  }
  const snapshots: DocumentSnapshot[] = [];
  for (const ref of refs) {
    const snap = await ref.get();
    if (maskPaths !== undefined && snap.exists) {
      snapshots.push(wrapProjectedSnapshot(snap, rootDb, maskPaths));
    } else {
      snapshots.push(snap);
    }
  }
  return snapshots;
}

async function readStorePaths(
  rawDb: SandboxFirestore,
  sandbox: Sandbox | undefined,
  pathPrefix?: string,
): Promise<string[]> {
  if (sandbox !== undefined && isRemoteSandbox(sandbox)) {
    const payload: { method: 'admin.readState'; path?: string } = { method: 'admin.readState' };
    if (pathPrefix !== undefined && pathPrefix.length > 0) payload.path = pathPrefix;
    const state = (await sandbox.channel.op(payload)) as Record<string, unknown>;
    return Object.keys(state);
  }
  return Object.keys(rawDb.snapshot());
}

export async function adminListCollections(
  rootDb: SandboxFirestore,
  rawDb: SandboxFirestore,
  sandbox: Sandbox | undefined,
): Promise<CollectionReference[]> {
  markAdminFirestoreStarted(rootDb);
  const paths = await readStorePaths(rawDb, sandbox);
  const topIds = new Set<string>();
  for (const docPath of paths) {
    const firstSlash = docPath.indexOf('/');
    if (firstSlash > 0) topIds.add(docPath.slice(0, firstSlash));
  }
  return [...topIds].sort().map((id) => rootDb.collection(id));
}

export async function adminRecursiveDelete(
  rootDb: SandboxFirestore,
  rawDb: SandboxFirestore,
  sandbox: Sandbox | undefined,
  ref: DocumentReference | CollectionReference,
  bulkWriter?: AdminBulkWriter,
): Promise<void> {
  markAdminFirestoreStarted(rootDb);
  if (ref === null || typeof ref !== 'object' || typeof (ref as { path?: unknown }).path !== 'string') {
    throw new Error('Value for argument "ref" must be a DocumentReference or CollectionReference.');
  }
  const targetPath = ref.path.replace(/^\/+|\/+$/g, '');
  const isDocRef = targetPath.split('/').filter((s) => s.length > 0).length % 2 === 0;
  const allPaths = await readStorePaths(rawDb, sandbox, targetPath);
  const matching = allPaths
    .filter((docPath) => {
      if (isDocRef) return docPath === targetPath || docPath.startsWith(`${targetPath}/`);
      return docPath.startsWith(`${targetPath}/`);
    })
    .sort();
  if (bulkWriter !== undefined) {
    const deletes = matching.map((docPath) => bulkWriter.delete(rootDb.doc(docPath)));
    await bulkWriter.flush();
    await Promise.all(deletes);
    return;
  }
  for (const docPath of matching) {
    await rootDb.doc(docPath).delete();
  }
}
