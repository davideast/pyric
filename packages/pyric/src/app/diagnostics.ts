import { FirebaseError } from './firebase-error.js';

/**
 * Firebase JS SDK version whose public app behavior the current oracle records.
 * The app conformance replay makes this pin fail visibly when observations move.
 */
export const SDK_VERSION = '12.13.0';

export type LogLevel = 'debug' | 'verbose' | 'info' | 'warn' | 'error' | 'silent';

export interface LogEntry {
  level: LogLevel;
  message: string;
  args: unknown[];
  type: string;
}

export interface LogOptions {
  level: LogLevel;
}

export type LogCallback = (entry: LogEntry) => void;

const LOGGER_NAME = '@firebase/app';
const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  verbose: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5,
};

let logLevel: LogLevel = 'info';
let logCallback: LogCallback | null = null;
let callbackLevel: LogLevel | null = null;

function stringifyLogArg(arg: unknown): string | null {
  if (arg == null) return null;
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return null;
  }
}

function emit(level: Exclude<LogLevel, 'silent'>, ...args: unknown[]): void {
  if (logCallback !== null && LEVELS[level] >= LEVELS[callbackLevel ?? logLevel]) {
    logCallback({
      level,
      message: args.map(stringifyLogArg).filter(Boolean).join(' '),
      args,
      type: LOGGER_NAME,
    });
  }

  if (LEVELS[level] < LEVELS[logLevel]) return;
  const prefix = `[${new Date().toISOString()}]  ${LOGGER_NAME}:`;
  if (level === 'debug' || level === 'verbose') console.log(prefix, ...args);
  else console[level](prefix, ...args);
}

/** Register or clear the process-wide app diagnostic handler. */
export function onLog(callback: LogCallback | null, options?: LogOptions): void {
  if (callback !== null && typeof callback !== 'function') {
    throw new FirebaseError(
      'app/invalid-log-argument',
      'Firebase: First argument to `onLog` must be null or a function. (app/invalid-log-argument).',
    );
  }
  logCallback = callback;
  callbackLevel = options?.level ?? null;
}

/** Set the threshold used by the app diagnostics logger. */
export function setLogLevel(level: LogLevel): void {
  logLevel = level;
}

/**
 * Validate a platform-logger version registration.
 *
 * A sandbox has no production component container, so valid registrations
 * need no retained component. Invalid registrations still emit the exact
 * diagnostic warning consumers can observe from Firebase.
 */
export function registerVersion(libraryKeyOrName: string, version: string, variant?: string): void {
  const library = variant ? `${libraryKeyOrName}-${variant}` : libraryKeyOrName;
  const libraryMismatch = library.match(/\s|\//);
  const versionMismatch = version.match(/\s|\//);
  if (!libraryMismatch && !versionMismatch) return;

  const warning = [`Unable to register library "${library}" with version "${version}":`];
  if (libraryMismatch) {
    warning.push(`library name "${library}" contains illegal characters (whitespace or "/")`);
  }
  if (libraryMismatch && versionMismatch) warning.push('and');
  if (versionMismatch) {
    warning.push(`version name "${version}" contains illegal characters (whitespace or "/")`);
  }
  emit('warn', warning.join(' '));
}
