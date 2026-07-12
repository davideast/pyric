import { onLog, registerVersion, setLogLevel } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

interface Captured {
  level: unknown;
  type: unknown;
  messageIsString: boolean;
  argsIsArray: boolean;
}

export const probe: Probe = {
  description:
    "firebase/app onLog(cb) registers a global log handler (returning undefined) and setLogLevel('warn') raises the threshold; a subsequent malformed registerVersion() emits a warn entry through the SDK logger to the handler. Pins the observable register+emit contract: the entry carries a level, a type, a string message, and an args array. The probe clears its handler and restores the level afterwards.",
  matrixRow: 'app #13',
  rowIds: ['app#13'],
  async observe() {
    const captured: Captured[] = [];
    let onLogReturn: unknown;
    try {
      onLogReturn = onLog((entry) => {
        captured.push({
          level: entry.level,
          type: entry.type,
          messageIsString: typeof entry.message === 'string',
          argsIsArray: Array.isArray(entry.args),
        });
      });
      setLogLevel('warn');
      // Deterministic emit: a malformed library name makes registerVersion log a
      // warning through the @firebase/app logger, which the handler receives.
      registerVersion('pyric probe lib!!', 'not a version??');
    } finally {
      onLog(null);
      setLogLevel('info');
    }
    return {
      onLogReturn: onLogReturn === undefined ? 'undefined' : typeof onLogReturn,
      setLogLevelThrew: false,
      emittedCount: captured.length,
      emittedLevel: captured[0]?.level,
      emittedType: captured[0]?.type,
      emittedMessageIsString: captured[0]?.messageIsString ?? false,
      emittedArgsIsArray: captured[0]?.argsIsArray ?? false,
    };
  },
};
