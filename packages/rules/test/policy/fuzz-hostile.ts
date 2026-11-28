// Extended adversarial host payloads for prototype, accessor, typed-array,
// int64-bound, size-bound, and diamond-DAG node-bomb isolation checks.
import { hostilePayloads, type HostilePayload } from './fuzz-values.js';

export function extendedHostilePayloads(): HostilePayload[] {
  return [
    ...hostilePayloads(),
    {
      label: 'own-prototype-key',
      build() {
        const payload: Record<string, unknown> = {};
        Object.defineProperty(payload, 'prototype', { value: 1, enumerable: true });
        return { payload, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'nested-depth3-getter',
      build() {
        let invoked = false;
        const leaf = {};
        Object.defineProperty(leaf, 'v', {
          enumerable: true,
          get() {
            invoked = true;
            return 1;
          },
        });
        return { payload: { a: { b: [leaf] } }, wasGetterInvoked: () => invoked };
      },
    },
    {
      label: 'array-non-enum-getter',
      build() {
        let invoked = false;
        const arr: unknown[] = [1, 2];
        Object.defineProperty(arr, 'trap', {
          enumerable: false,
          get() {
            invoked = true;
            return 7;
          },
        });
        return { payload: arr, wasGetterInvoked: () => invoked };
      },
    },
    {
      label: 'uint8-subclass',
      build() {
        class SubBytes extends Uint8Array {}
        return { payload: new SubBytes([1, 2, 3]), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'uint8-getter-prop',
      build() {
        let invoked = false;
        const bytes = new Uint8Array([1, 2]);
        Object.defineProperty(bytes, 'trap', {
          enumerable: false,
          get() {
            invoked = true;
            return 9;
          },
        });
        return { payload: bytes, wasGetterInvoked: () => invoked };
      },
    },
    {
      label: 'uint8-over-limit',
      build() {
        return { payload: new Uint8Array(65537), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'int32array',
      build() {
        return { payload: new Int32Array([1, 2]), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'boxed-number',
      build() {
        return { payload: new Number(1), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'boxed-string',
      build() {
        return { payload: new String('x'), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'boxed-boolean',
      build() {
        return { payload: new Boolean(true), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'regexp-instance',
      build() {
        return { payload: /abc/, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'set-instance',
      build() {
        return { payload: new Set([1, 2]), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'weakmap-instance',
      build() {
        return { payload: new WeakMap(), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'error-instance',
      build() {
        return { payload: new Error('boom'), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'function-value',
      build() {
        return { payload: () => 1, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'symbol-value',
      build() {
        return { payload: Symbol('s'), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'undefined-value',
      build() {
        return { payload: undefined, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'bigint-above-int64',
      build() {
        return { payload: 1n << 63n, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'bigint-below-int64',
      build() {
        return { payload: -(1n << 63n) - 1n, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'string-over-4096',
      build() {
        return { payload: 'a'.repeat(4097), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'array-over-4096',
      build() {
        return { payload: new Array(4097).fill(0), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'record-over-4096-keys',
      build() {
        const rec: Record<string, number> = {};
        for (let i = 0; i < 4097; i++) rec['k' + i] = i;
        return { payload: rec, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'diamond-dag-node-bomb',
      build() {
        let node: Record<string, unknown> = { x: 1 };
        for (let i = 0; i < 15; i++) node = { l: node, r: node };
        return { payload: node, wasGetterInvoked: () => false };
      },
    },
  ];
}
