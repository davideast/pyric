import { describe, expect, it } from 'bun:test';
import {
  copyQueryValueRegistration,
  registerQueryValue,
  registerReferenceQueryValue,
  registeredQueryExecutionValue,
  registeredReferenceQueryValuePath,
  registeredQueryValue,
  registeredQueryValueOwner,
} from '../../../src/firestore/sandbox/query-value-registry.js';

describe('query value registry', () => {
  it('copies comparison, execution, and owner registrations to converter shells', () => {
    const owner = {};
    const executionReference = { path: 'items/a', get: () => undefined };
    const reference = {};
    const converted = {};

    registerReferenceQueryValue(reference, 'items/a', owner, executionReference);
    copyQueryValueRegistration(reference, converted);

    expect(registeredQueryValueOwner(converted)).toBe(owner);
    expect(registeredReferenceQueryValuePath(converted)).toBe('items/a');
    expect(registeredQueryExecutionValue(converted)).toBe(executionReference);
    const comparison = registeredQueryValue(converted) as { isEqual(other: unknown): boolean };
    expect(comparison.isEqual(registeredQueryValue(reference))).toBe(true);
  });

  it('uses the registered execution factory instead of the source wrapper', () => {
    const wrapper = {};
    let executionValue = { bytes: [1, 2] };
    registerQueryValue(wrapper, { kind: 'bytes', values: [1, 2] }, () => executionValue);

    expect(registeredQueryValue(wrapper)).toEqual({ kind: 'bytes', values: [1, 2] });
    expect(registeredQueryExecutionValue(wrapper)).toBe(executionValue);
    executionValue = { bytes: [1, 3] };
    expect(registeredQueryExecutionValue(wrapper)).toBe(executionValue);
  });
});
