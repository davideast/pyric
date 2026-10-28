import { describe, expect, it } from 'bun:test';
import { isRemoteActivation, parsePyricSandbox } from '../../src/sandbox/internal/sandbox-activation.js';

describe('parsePyricSandbox', () => {
  it('reads unset and blank as off', () => {
    expect(parsePyricSandbox(undefined)).toEqual({ mode: 'off' });
    expect(parsePyricSandbox('')).toEqual({ mode: 'off' });
    expect(parsePyricSandbox('  ')).toEqual({ mode: 'off' });
  });

  it('reads local as the in-process sandbox', () => {
    expect(parsePyricSandbox('local')).toEqual({ mode: 'local' });
  });

  it('reads remote, 1 and true as a remote host found through discovery', () => {
    for (const value of ['remote', '1', 'true', ' remote ']) {
      expect(parsePyricSandbox(value), value).toEqual({ mode: 'remote' });
    }
  });

  it('reads remote:<url> as that url, trimmed', () => {
    expect(parsePyricSandbox('remote:http://127.0.0.1:5173')).toEqual({ mode: 'remote', url: 'http://127.0.0.1:5173' });
    expect(parsePyricSandbox(' remote: http://h:1 ')).toEqual({ mode: 'remote', url: 'http://h:1' });
  });

  it('names an empty remote url and any other value as invalid', () => {
    expect(parsePyricSandbox('remote:')).toEqual({ mode: 'invalid', reason: 'empty-url', value: 'remote:' });
    expect(parsePyricSandbox('remote:  ')).toEqual({ mode: 'invalid', reason: 'empty-url', value: 'remote:' });
    expect(parsePyricSandbox('http://127.0.0.1:5173')).toEqual({ mode: 'invalid', reason: 'unrecognized', value: 'http://127.0.0.1:5173' });
    expect(parsePyricSandbox('yes')).toEqual({ mode: 'invalid', reason: 'unrecognized', value: 'yes' });
  });

  it('answers isRemoteActivation for remote values only', () => {
    expect(['remote', 'remote:http://h', '1', 'true'].map(isRemoteActivation)).toEqual([true, true, true, true]);
    expect([undefined, '', 'local', 'remote:', 'false'].map(isRemoteActivation)).toEqual([false, false, false, false, false]);
  });
});
