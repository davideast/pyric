/**
 * Undeclared named-database (`C3`) listener enforcement, late-declared
 * placeholder-environment rebinding, and `C4` cross-database target validation
 * for `pyric-admin/firestore`.
 */

import { Reference as InternalReference } from 'pyric/rules/internal';
import { isRemoteSandbox, SandboxError } from 'pyric/sandbox';
import type {
  CollectionReference,
  DocumentReference,
  Query,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore, Unsubscribe } from 'pyric/sandbox/admin-firestore';
import {
  createPrefixedAdminGrpcError,
  translateErrorForRootDb,
} from './admin-grpc-errors.js';
import { GrpcStatus } from './admin-grpc-log.js';
import {
  adminDocumentRefBrand,
  adminRawDbSandbox,
  adminToRootDb,
  getAdminHandleDatabaseId,
  getAdminHandleProjectId,
  isAppBackedRoot,
  unwrapAdminObject,
} from './admin-handle-registry.js';
import {
  assertAdminRootDatabaseDeclared,
  getAdminRootOriginalSandbox,
  isBoundToUndeclaredPlaceholderEnv,
} from './admin-named-databases.js';
import { adminQueryMetadata } from './admin-query-validation.js';

function formatCrossDatabaseDetails(
  ownerProjectId: string,
  ownerDatabaseId: string,
  targetProjectId: string,
  targetDatabaseId: string,
): string {
  return (
    `The request was for database 'projects/${ownerProjectId}/databases/${ownerDatabaseId}' ` +
    `but was attempting to access database 'projects/${targetProjectId}/databases/${targetDatabaseId}'`
  );
}

function resolveCandidateDatabaseAndProject(
  ownerRootDb: SandboxFirestore,
  candidateTarget: object,
): { readonly databaseId: string; readonly projectId: string } {
  const ownerProject = getAdminHandleProjectId(ownerRootDb);
  const targetRoot = adminToRootDb.get(candidateTarget);
  if (targetRoot !== undefined) {
    return {
      databaseId: getAdminHandleDatabaseId(targetRoot),
      projectId: getAdminHandleProjectId(targetRoot),
    };
  }
  const candidate = candidateTarget as {
    databaseId?: unknown;
    formattedName?: unknown;
    firestore?: { databaseId?: unknown };
  };
  if (typeof candidate.databaseId === 'string' && candidate.databaseId.length > 0) {
    return { databaseId: candidate.databaseId, projectId: ownerProject };
  }
  if (typeof candidate.formattedName === 'string' && candidate.formattedName.length > 0) {
    const parsed = new InternalReference(candidate.formattedName);
    return { databaseId: parsed.databaseId, projectId: ownerProject };
  }
  if (
    candidate.firestore !== null &&
    typeof candidate.firestore === 'object' &&
    typeof candidate.firestore.databaseId === 'string' &&
    candidate.firestore.databaseId.length > 0
  ) {
    return { databaseId: candidate.firestore.databaseId, projectId: ownerProject };
  }
  return { databaseId: getAdminHandleDatabaseId(ownerRootDb), projectId: ownerProject };
}

export function hasCrossDatabaseMismatch(
  ownerRootDb: SandboxFirestore,
  candidateTarget: object,
): boolean {
  const ownerDbId = getAdminHandleDatabaseId(ownerRootDb);
  const resolved = resolveCandidateDatabaseAndProject(ownerRootDb, candidateTarget);
  return resolved.databaseId !== ownerDbId;
}

export function assertSameDatabaseTarget(
  ownerRootDb: SandboxFirestore,
  candidateTarget: object,
): void {
  const ownerDbId = getAdminHandleDatabaseId(ownerRootDb);
  const ownerProject = getAdminHandleProjectId(ownerRootDb);
  const resolved = resolveCandidateDatabaseAndProject(ownerRootDb, candidateTarget);
  if (resolved.databaseId === ownerDbId) {
    return;
  }
  const details = formatCrossDatabaseDetails(
    ownerProject,
    ownerDbId,
    resolved.projectId,
    resolved.databaseId,
  );
  if (isAppBackedRoot(ownerRootDb)) {
    throw createPrefixedAdminGrpcError(
      GrpcStatus.INVALID_ARGUMENT as number,
      'INVALID_ARGUMENT',
      details,
    );
  }
  throw new SandboxError('invalid-argument', details);
}

function extractSnapshotErrorCallback(
  arg2IsOptions: boolean,
  arg2: unknown,
  arg3: unknown,
  arg4: unknown,
): ((err: unknown) => void) | undefined {
  if (!arg2IsOptions) {
    if (arg2 !== null && typeof arg2 === 'object') {
      const obsErr = (arg2 as { error?: unknown }).error;
      if (typeof obsErr === 'function') {
        return (err: unknown) => (obsErr as (e: unknown) => void).call(arg2, err);
      }
    }
    if (typeof arg3 === 'function') {
      return arg3 as (err: unknown) => void;
    }
    return undefined;
  }
  if (arg3 !== null && typeof arg3 === 'object') {
    const obsErr = (arg3 as { error?: unknown }).error;
    if (typeof obsErr === 'function') {
      return (err: unknown) => (obsErr as (e: unknown) => void).call(arg3, err);
    }
  }
  if (typeof arg4 === 'function') {
    return arg4 as (err: unknown) => void;
  }
  return undefined;
}

export interface PreparedAdminSnapshotSubscription {
  readonly immediateUnsub?: Unsubscribe;
  readonly resolvedRawReference: unknown;
}

export function prepareAdminSnapshotSubscription(
  reference: DocumentReference | Query | CollectionReference,
  rawReference: unknown,
  rootDb: SandboxFirestore,
  arg2IsOptions: boolean,
  arg2: unknown,
  arg3: unknown,
  arg4: unknown,
): PreparedAdminSnapshotSubscription {
  const rawDb = unwrapAdminObject(rootDb);
  let origSandbox = getAdminRootOriginalSandbox(rootDb);
  if (origSandbox === undefined) {
    origSandbox = adminRawDbSandbox.get(rawDb);
  }
  if (origSandbox === undefined || !isRemoteSandbox(origSandbox)) {
    try {
      assertAdminRootDatabaseDeclared(rootDb);
    } catch (err) {
      const errCb = extractSnapshotErrorCallback(arg2IsOptions, arg2, arg3, arg4);
      let cancelled = false;
      if (errCb !== undefined) {
        const translated = translateErrorForRootDb(err, rootDb);
        queueMicrotask(() => {
          if (!cancelled) {
            errCb(translated);
          }
        });
      }
      return {
        immediateUnsub: () => {
          cancelled = true;
        },
        resolvedRawReference: rawReference,
      };
    }
  }

  let resolvedRawReference = rawReference;
  if (
    rawReference !== null &&
    typeof rawReference === 'object' &&
    isBoundToUndeclaredPlaceholderEnv(rawReference)
  ) {
    if (adminDocumentRefBrand.has(reference)) {
      resolvedRawReference = unwrapAdminObject(
        rootDb.doc((reference as DocumentReference).path),
      );
    } else if (adminQueryMetadata.has(reference)) {
      const meta = adminQueryMetadata.get(reference);
      if (meta !== undefined && typeof meta.replayOnRoot === 'function') {
        resolvedRawReference = unwrapAdminObject(meta.replayOnRoot(rootDb));
      }
    } else if (typeof (reference as { path?: unknown }).path === 'string') {
      resolvedRawReference = unwrapAdminObject(
        rootDb.collection((reference as CollectionReference).path),
      );
    }
  }

  return {
    resolvedRawReference,
  };
}
