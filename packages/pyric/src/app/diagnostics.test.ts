import { describe, expect, it } from 'bun:test';

import {
  SDK_VERSION,
  onLog,
  registerVersion,
  setLogLevel,
  type LogEntry,
} from './diagnostics.js';

describe('app diagnostics mirror', () => {
  it('reports the Firebase SDK version captured by the current oracle', () => {
    expect(SDK_VERSION).toBe('12.13.0');
  });

  it('delivers malformed registerVersion warnings through the configured logger', () => {
    const entries: LogEntry[] = [];

    try {
      expect(onLog((entry) => entries.push(entry))).toBeUndefined();
      setLogLevel('warn');
      expect(registerVersion('pyric probe lib!!', 'not a version??')).toBeUndefined();
    } finally {
      onLog(null);
      setLogLevel('info');
    }

    expect(entries).toEqual([
      {
        level: 'warn',
        type: '@firebase/app',
        message:
          'Unable to register library "pyric probe lib!!" with version "not a version??": ' +
          'library name "pyric probe lib!!" contains illegal characters (whitespace or "/") and ' +
          'version name "not a version??" contains illegal characters (whitespace or "/")',
        args: [
          'Unable to register library "pyric probe lib!!" with version "not a version??": ' +
            'library name "pyric probe lib!!" contains illegal characters (whitespace or "/") and ' +
            'version name "not a version??" contains illegal characters (whitespace or "/")',
        ],
      },
    ]);
  });
});
