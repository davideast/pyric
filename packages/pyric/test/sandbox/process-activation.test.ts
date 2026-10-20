/** The in-process activation a host installs beside `PYRIC_SANDBOX` (#1123). */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  clearProcessActivation,
  installProcessActivation,
  onProcessActivationEnd,
  processActivation,
  type ProcessActivation,
} from '../../src/sandbox/internal/index.js';

function activation(label: string): ProcessActivation {
  return {
    label,
    host: () => Promise.resolve('http://127.0.0.1:5173'),
    offHostError: (detail) => new Error(detail),
    adminSandbox: () => initializeSandbox(),
  };
}

describe('process activation', () => {
  it('is read back until it is cleared', () => {
    const first = activation('first');
    installProcessActivation(first);
    expect(processActivation()).toBe(first);
    clearProcessActivation(first);
    expect(processActivation()).toBeUndefined();
  });

  it('keeps a replacement when the one it replaced is cleared, and ends only with no replacement', () => {
    const ended: string[] = [];
    const stop = onProcessActivationEnd(() => ended.push('ended'));
    const first = activation('first');
    const second = activation('second');
    installProcessActivation(first);
    installProcessActivation(second);
    clearProcessActivation(first);
    expect(processActivation()).toBe(second);
    expect(ended).toEqual([]);
    clearProcessActivation(second);
    expect(ended).toEqual(['ended']);
    stop();
    installProcessActivation(first);
    clearProcessActivation(first);
    expect(ended).toEqual(['ended']);
  });

  it('is shared across copies of the package through a global slot', () => {
    const first = activation('first');
    installProcessActivation(first);
    const slot = (globalThis as Record<symbol, unknown>)[Symbol.for('pyric.sandbox.processActivation')];
    expect(slot).toBe(first);
    clearProcessActivation(first);
  });
});
