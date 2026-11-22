/**
 * Auth resolution, operation provenance, and bucket-name handle views for
 * sandbox-backed `FirebaseStorage` handles.
 */
import type { AuthState, EventCaller, EventProvenance } from 'pyric/sandbox';
import {
  bindOperationContext,
  provenanceForOperationContext,
  resolveOperationContext,
} from 'pyric/sandbox/internal';
import type { FirebaseApp } from '../../app/types.js';
import { getAuthLens } from '../../sandbox/internal/auth-lens.js';
import { createStorageRetryHandle } from '../handle-retry-times.js';
import {
  TARGET_SYMBOL,
  targetOf,
  type FirebaseStorage,
  type SandboxTarget,
} from './service-caches.js';

export function storageAuth(target: SandboxTarget): AuthState {
  if (target.admin === true) return null;
  if (target.currentAuth !== undefined) {
    const lens = getAuthLens();
    if (lens?.mode === 'admin' || lens?.mode === 'anon') return null;
    if (lens?.mode === 'as') {
      const impersonated: NonNullable<AuthState> = { uid: lens.uid };
      if (lens.tenant) impersonated.tenant = lens.tenant;
      if (lens.token) impersonated.token = lens.token;
      return impersonated;
    }
    return target.currentAuth();
  }
  return target.context.auth;
}

/**
 * Merge a host override with the immutable provenance bound to a Storage
 * handle. Captured before awaits so concurrent async operations cannot exchange
 * source or auth-lens identity.
 */
export function storageOperationProvenance(
  target: SandboxTarget,
  override?: EventProvenance,
): EventProvenance {
  let lensOverride = override;
  if (target.currentAuth !== undefined && override?.authLens === undefined) {
    const activeLens = getAuthLens();
    if (activeLens !== undefined) {
      lensOverride = { ...override, authLens: activeLens };
    }
  }
  const context = resolveOperationContext(
    lensOverride,
    provenanceForOperationContext(target.context.operationContext),
  );
  let caller: EventCaller | undefined = target.caller;
  if (override?.caller !== undefined) {
    caller = override.caller;
  }
  const provenance: EventProvenance = {
    ...lensOverride,
    ...provenanceForOperationContext(context),
    service: 'storage',
  };
  if (caller !== undefined) {
    provenance.caller = caller;
  }
  return provenance;
}

/**
 * Return an operation-scoped view of a Storage handle. The backing service,
 * bucket, and admin/rules mode are shared; only immutable operation identity is
 * rebound.
 */
export function bindStorageOperationContext(
  storage: FirebaseStorage,
  provenance: EventProvenance | undefined,
): FirebaseStorage {
  if (!provenance) return storage;
  const target = targetOf(storage);
  const context = resolveOperationContext(
    provenance,
    provenanceForOperationContext(target.context.operationContext),
  );
  const scopedTarget: {
    kind: 'sandbox';
    sandbox: SandboxTarget['sandbox'];
    context: SandboxTarget['context'];
    currentAuth?: SandboxTarget['currentAuth'];
    bucket: string;
    bucketName?: string;
    servicePromise: SandboxTarget['servicePromise'];
    admin?: boolean;
    caller?: EventCaller;
  } = {
    ...target,
    context: bindOperationContext(target.context, context),
  };
  if (provenance.caller !== undefined) {
    scopedTarget.caller = provenance.caller;
  }
  const props: { [TARGET_SYMBOL]: SandboxTarget; app?: FirebaseApp } = {
    [TARGET_SYMBOL]: scopedTarget,
  };
  if (storage.app !== undefined) props.app = storage.app;
  return createStorageRetryHandle<FirebaseStorage>(props, storage);
}

/**
 * A view of a Storage handle whose rules see the bucket as `name`, the name
 * its caller knows it by. Objects, metadata, and persistence keep the store's
 * bucket key; only the rules input changes.
 */
export function nameStorageBucket(
  storage: FirebaseStorage,
  name: string | undefined,
): FirebaseStorage {
  if (name === undefined || name === '') return storage;
  const target = targetOf(storage);
  if (target.bucketName === name) return storage;
  const namedTarget: SandboxTarget = { ...target, bucketName: name };
  const props: { [TARGET_SYMBOL]: SandboxTarget; app?: FirebaseApp } = {
    [TARGET_SYMBOL]: namedTarget,
  };
  if (storage.app !== undefined) props.app = storage.app;
  return createStorageRetryHandle<FirebaseStorage>(props, storage);
}
