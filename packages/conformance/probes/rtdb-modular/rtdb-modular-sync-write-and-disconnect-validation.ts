import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface SyncWriteValidationProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  update: typeof import('firebase/database').update;
  push: typeof import('firebase/database').push;
  setPriority: typeof import('firebase/database').setPriority;
  setWithPriority: typeof import('firebase/database').setWithPriority;
  onDisconnect: typeof import('firebase/database').onDisconnect;
  get: typeof import('firebase/database').get;
}

export interface ValidationCallOutcome {
  label: string;
  timing: 'synchronous-throw' | 'asynchronous-reject' | 'resolved';
  errorName: string | null;
  hasCode: boolean;
  message: string | null;
}

export function scrubBasePathFromValidationMessage(rawMessage: string, basePath: string): string {
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let scrubbed = rawMessage;
  if (cleanBase) {
    const dotPrefix = `${cleanBase.split('/').join('.')}.`;
    scrubbed = scrubbed
      .split(dotPrefix)
      .join('')
      .split(`/${cleanBase}/`)
      .join('/')
      .split(cleanBase)
      .join('<runPath>');
  }
  return scrubbed
    .replace(/pyric_oracle\.rtdb_[a-z0-9_-]+\./gi, '')
    .replace(/\/pyric_oracle\/rtdb_[a-z0-9_-]+\//gi, '/');
}

async function runValidationCase(
  label: string,
  basePath: string,
  invoke: () => unknown,
): Promise<ValidationCallOutcome> {
  let returnedValue: unknown;
  try {
    returnedValue = invoke();
  } catch (err) {
    const errorObj = err as Error & { code?: unknown };
    return {
      label,
      timing: 'synchronous-throw',
      errorName: errorObj.name,
      hasCode: errorObj.code !== undefined,
      message: scrubBasePathFromValidationMessage(errorObj.message, basePath),
    };
  }

  if (
    returnedValue !== null &&
    typeof returnedValue === 'object' &&
    typeof (returnedValue as { then?: unknown }).then === 'function'
  ) {
    try {
      await (returnedValue as Promise<unknown>);
      return {
        label,
        timing: 'resolved',
        errorName: null,
        hasCode: false,
        message: null,
      };
    } catch (err) {
      const errorObj = err as Error & { code?: unknown };
      return {
        label,
        timing: 'asynchronous-reject',
        errorName: errorObj.name,
        hasCode: errorObj.code !== undefined,
        message: scrubBasePathFromValidationMessage(errorObj.message, basePath),
      };
    }
  }

  return {
    label,
    timing: 'resolved',
    errorName: null,
    hasCode: false,
    message: null,
  };
}

export async function observeSyncWriteAndDisconnectValidation(
  sdk: SyncWriteValidationProbeSdk,
  basePath: string,
): Promise<{
  cases: ValidationCallOutcome[];
  pushUndefinedArgMintsKeyWithoutThrowing: {
    threwSynchronously: boolean;
    mintedKeyLength: number | null;
  };
  storedDataAfterRefusedCalls: {
    val: unknown;
    priority: string | number | null;
  };
}> {
  const { db, ref, set, update, push, setPriority, setWithPriority, onDisconnect, get } = sdk;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let nodePath = 'validation/node';
  if (cleanBase) {
    nodePath = `${cleanBase}/validation/node`;
  }
  const nodeRef = ref(db, nodePath);

  await set(nodeRef, { baseline: 'intact' });

  const invalidFn = () => 1;
  const cases: ValidationCallOutcome[] = [];

  const definitions: Array<[string, () => unknown]> = [
    ['set-undefined', () => set(nodeRef, undefined)],
    ['set-nan-child', () => set(nodeRef, { a: NaN })],
    ['set-positive-infinity', () => set(nodeRef, { a: Infinity })],
    ['set-negative-infinity', () => set(nodeRef, { a: -Infinity })],
    ['set-function', () => set(nodeRef, invalidFn)],
    ['set-dot-key', () => set(nodeRef, { 'bad.key': 1 })],
    ['set-hash-key', () => set(nodeRef, { 'bad#key': 1 })],
    ['set-dollar-key', () => set(nodeRef, { 'bad$key': 1 })],
    ['set-slash-key', () => set(nodeRef, { 'bad/key': 1 })],
    ['set-lbracket-key', () => set(nodeRef, { 'bad[key': 1 })],
    ['set-rbracket-key', () => set(nodeRef, { 'bad]key': 1 })],
    ['set-value-beside-child', () => set(nodeRef, { '.value': 1, a: 2 })],
    [
      'update-null-map',
      () => update(nodeRef, null as unknown as Record<string, unknown>),
    ],
    [
      'update-primitive-map',
      () => update(nodeRef, 'not-an-object' as unknown as Record<string, unknown>),
    ],
    ['update-nan-child', () => update(nodeRef, { a: NaN })],
    ['update-invalid-path-key', () => update(nodeRef, { 'bad#key': 1 })],
    ['push-nan', () => push(nodeRef, NaN)],
    ['push-nested-undefined', () => push(nodeRef, { a: undefined })],
    [
      'setPriority-object',
      () => setPriority(nodeRef, { bad: 1 } as unknown as number),
    ],
    ['setPriority-nan', () => setPriority(nodeRef, NaN)],
    ['setWithPriority-nan-value', () => setWithPriority(nodeRef, NaN, 1)],
    [
      'setWithPriority-boolean-priority',
      () => setWithPriority(nodeRef, 'ok', true as unknown as number),
    ],
    ['onDisconnect-set-nan', () => onDisconnect(nodeRef).set(NaN)],
    [
      'onDisconnect-setWithPriority-nan',
      () => onDisconnect(nodeRef).setWithPriority(NaN, 1),
    ],
    ['onDisconnect-update-nan', () => onDisconnect(nodeRef).update({ a: NaN })],
    [
      'onDisconnect-update-null-map',
      () => onDisconnect(nodeRef).update(null as unknown as Record<string, unknown>),
    ],
  ];

  for (const [label, invoke] of definitions) {
    cases.push(await runValidationCase(label, cleanBase, invoke));
  }

  let pushUndefinedThrew = false;
  let mintedKeyLength: number | null = null;
  try {
    const mintedRef = push(nodeRef, undefined);
    if (typeof mintedRef.key === 'string') {
      mintedKeyLength = mintedRef.key.length;
    }
  } catch {
    pushUndefinedThrew = true;
  }

  const finalSnap = await get(nodeRef);

  return {
    cases,
    pushUndefinedArgMintsKeyWithoutThrowing: {
      threwSynchronously: pushUndefinedThrew,
      mintedKeyLength,
    },
    storedDataAfterRefusedCalls: {
      val: finalSnap.val(),
      priority: finalSnap.priority,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Modular RTDB synchronous write, priority, and OnDisconnect validation: observes synchronous Error throws (vs async rejections), scrubbed SDK error messages, push(ref, undefined) key-only overload vs push(ref, invalid) throw, and unchanged stored RTDB data across set, update, push, setPriority, setWithPriority, and onDisconnect.',
  matrixRow: 'rtdb-modular#M68',
  rowIds: ['rtdb-modular#M68', 'rtdb-modular#SW1'],
  observe() {
    return withRtdbProbeSession({}, async ({ runPath, db, rtdbSdk }) => {
      return observeSyncWriteAndDisconnectValidation(
        {
          db,
          ref: rtdbSdk.ref,
          set: rtdbSdk.set,
          update: rtdbSdk.update,
          push: rtdbSdk.push,
          setPriority: rtdbSdk.setPriority,
          setWithPriority: rtdbSdk.setWithPriority,
          onDisconnect: rtdbSdk.onDisconnect,
          get: rtdbSdk.get,
        },
        runPath,
      );
    });
  },
};
