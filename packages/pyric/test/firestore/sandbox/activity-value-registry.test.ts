import { describe, expect, it } from 'bun:test';
import {
  boundedActivityBytes,
  boundedActivityIdentity,
  boundedActivityString,
  registeredActivityValue,
  registerActivityValue,
  trustedWireActivityValue,
} from '../../../src/firestore/sandbox/activity-value-registry.js';

describe('activity value registry', () => {
  it('builds deterministic, bounded descriptors without retaining source values', () => {
    expect(boundedActivityString('secret')).toEqual(boundedActivityString('secret'));
    expect(JSON.stringify(boundedActivityString('secret'))).not.toContain('secret');
    expect(boundedActivityBytes(new Uint8Array([1, 2, 3]))).toEqual(
      boundedActivityBytes(new Uint8Array([1, 2, 3])),
    );
    expect(boundedActivityIdentity('number', 'NaN')).not.toEqual(
      boundedActivityIdentity('number', 'Infinity'),
    );
  });

  it('canonicalizes trusted structured-clone maps and distinguishes values', () => {
    expect(trustedWireActivityValue({ b: [2, 3], a: true })).toEqual(
      trustedWireActivityValue({ a: true, b: [2, 3] }),
    );
    expect(trustedWireActivityValue({ a: ['open'] })).not.toEqual(
      trustedWireActivityValue({ a: ['closed'] }),
    );
  });

  it('looks up descriptors strictly by object identity without observation', () => {
    const value = {};
    const equivalent = {};
    const descriptor = { type: 'known' };
    registerActivityValue(value, descriptor);
    expect(registeredActivityValue(value)).toBe(descriptor);
    expect(registeredActivityValue(equivalent)).toBeUndefined();

    const fail = () => { throw new Error('registry observed a Proxy'); };
    const proxy = new Proxy({}, { get: fail, getPrototypeOf: fail, ownKeys: fail });
    expect(() => registeredActivityValue(proxy)).not.toThrow();
  });
});
