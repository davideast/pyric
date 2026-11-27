/**
 * Redacts local secret values loaded from `.secret.local` (or declared via
 * `secretEnvironmentVariables`) before they reach console output, sandbox
 * execution events, IPC payloads, or error strings.
 */
import type {
  FunctionsChildEvent,
  FunctionsChildMessage,
  SerializedFunctionsError,
} from './child-protocol.js';

export const REDACTED_SECRET_PLACEHOLDER = '[REDACTED]';

/**
 * Minimum length for a secret value (or nested JSON leaf) to be scrubbed from
 * free-form text so trivial 1-3 character tokens never corrupt unrelated logs.
 */
const MIN_REDACTABLE_SECRET_LENGTH = 4;

const IGNORED_JSON_LEAF_VALUES: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'undefined',
]);

const JSON_PARSE_SNIPPET_RE =
  /(Unexpected token\s+'[^']*',\s*)"([^\r\n]+?)"(?:\.\.\.)?(\s+is not valid JSON)/g;

export interface SecretRedactor {
  readonly hasSecrets: boolean;
  addValues(values: Iterable<string>): void;
  addRecord(record: Readonly<Record<string, string | undefined>>): void;
  redactString(input: string): string;
  redactError(error: SerializedFunctionsError): SerializedFunctionsError;
  redactValue<T>(value: T): T;
  redactChildEvent(event: FunctionsChildEvent): FunctionsChildEvent;
  redactChildMessage(message: FunctionsChildMessage): FunctionsChildMessage;
}

function collectNestedJsonStrings(
  value: unknown,
  out: Set<string>,
  visited: Set<object>,
  depth: number,
): void {
  if (depth > 16) return;
  if (typeof value === 'string') {
    if (
      value.length >= MIN_REDACTABLE_SECRET_LENGTH &&
      !IGNORED_JSON_LEAF_VALUES.has(value.toLowerCase())
    ) {
      out.add(value);
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value && escaped.length >= MIN_REDACTABLE_SECRET_LENGTH) {
        out.add(escaped);
      }
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedJsonStrings(item, out, visited, depth + 1);
    }
    return;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectNestedJsonStrings(entry, out, visited, depth + 1);
  }
}

function expandSecretCandidates(rawValue: string, out: Set<string>): void {
  if (rawValue.length < MIN_REDACTABLE_SECRET_LENGTH) {
    return;
  }
  out.add(rawValue);
  const trimmed = rawValue.trim();
  if (trimmed.length >= MIN_REDACTABLE_SECRET_LENGTH) {
    out.add(trimmed);
  }
  const jsonEscaped = JSON.stringify(rawValue).slice(1, -1);
  if (jsonEscaped !== rawValue && jsonEscaped.length >= MIN_REDACTABLE_SECRET_LENGTH) {
    out.add(jsonEscaped);
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      collectNestedJsonStrings(parsed, out, new Set(), 0);
    } catch {
      // Non-JSON secret values are already registered in raw and escaped forms.
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Create a secret redactor that replaces every registered secret (longest first)
 * with `[REDACTED]`.
 */
export function createSecretRedactor(
  initial?: Readonly<Record<string, string | undefined>> | Iterable<string>,
): SecretRedactor {
  const candidates = new Set<string>();
  let ordered: string[] = [];
  let dirty = false;

  const ensureOrdered = (): readonly string[] => {
    if (dirty) {
      ordered = [...candidates].sort((a, b) => b.length - a.length);
      dirty = false;
    }
    return ordered;
  };

  const addValues = (values: Iterable<string>): void => {
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const before = candidates.size;
      expandSecretCandidates(value, candidates);
      if (candidates.size !== before) {
        dirty = true;
      }
    }
  };

  const addRecord = (record: Readonly<Record<string, string | undefined>>): void => {
    for (const value of Object.values(record)) {
      if (typeof value === 'string') {
        const before = candidates.size;
        expandSecretCandidates(value, candidates);
        if (candidates.size !== before) {
          dirty = true;
        }
      }
    }
  };

  if (initial !== undefined) {
    if (Symbol.iterator in initial) {
      addValues(initial as Iterable<string>);
    } else {
      addRecord(initial as Readonly<Record<string, string | undefined>>);
    }
  }

  const redactString = (input: string): string => {
    if (candidates.size === 0 || input.length === 0) {
      return input;
    }
    const secrets = ensureOrdered();
    let output = input;
    for (const token of secrets) {
      if (output.includes(token)) {
        output = output.split(token).join(REDACTED_SECRET_PLACEHOLDER);
      }
    }
    if (output.includes('is not valid JSON')) {
      output = output.replace(
        JSON_PARSE_SNIPPET_RE,
        (full, prefix: string, snippet: string, suffix: string) => {
          if (snippet.length < MIN_REDACTABLE_SECRET_LENGTH) {
            return full;
          }
          const matchesSecret = secrets.some((secret) => secret.includes(snippet));
          if (!matchesSecret) {
            return full;
          }
          return `${prefix}"${REDACTED_SECRET_PLACEHOLDER}"${suffix}`;
        },
      );
    }
    return output;
  };

  const redactError = (error: SerializedFunctionsError): SerializedFunctionsError => {
    if (candidates.size === 0) {
      return error;
    }
    const redacted: SerializedFunctionsError = {
      name: redactString(error.name),
      message: redactString(error.message),
    };
    if (error.stack !== undefined) {
      redacted.stack = redactString(error.stack);
    }
    return redacted;
  };

  const redactUnknown = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
    if (candidates.size === 0) {
      return value;
    }
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const item of value) {
        copy.push(redactUnknown(item, seen));
      }
      return copy;
    }
    if (value instanceof Error) {
      const copy = new Error(redactString(value.message));
      copy.name = redactString(value.name);
      if (value.stack !== undefined) {
        copy.stack = redactString(value.stack);
      }
      seen.set(value, copy);
      return copy;
    }
    if (isPlainRecord(value)) {
      const copy: Record<string, unknown> = {};
      seen.set(value, copy);
      for (const [key, entry] of Object.entries(value)) {
        copy[redactString(key)] = redactUnknown(entry, seen);
      }
      return copy;
    }
    return value;
  };

  const redactValue = <T>(value: T): T => {
    if (candidates.size === 0) {
      return value;
    }
    return redactUnknown(value, new WeakMap()) as T;
  };

  const redactChildEvent = (event: FunctionsChildEvent): FunctionsChildEvent => {
    if (candidates.size === 0) {
      return event;
    }
    return redactValue(event);
  };

  const redactChildMessage = (message: FunctionsChildMessage): FunctionsChildMessage => {
    if (candidates.size === 0) {
      return message;
    }
    return redactValue(message);
  };

  return {
    get hasSecrets(): boolean {
      return candidates.size > 0;
    },
    addValues,
    addRecord,
    redactString,
    redactError,
    redactValue,
    redactChildEvent,
    redactChildMessage,
  };
}

let activeProcessRedactor: SecretRedactor | null = null;

/** Install a process-wide secret redactor (used by the isolated Functions child). */
export function setActiveSecretRedactor(redactor: SecretRedactor | null): void {
  activeProcessRedactor = redactor;
}

/** Return the active process-wide secret redactor, if any. */
export function getActiveSecretRedactor(): SecretRedactor | null {
  return activeProcessRedactor;
}

/** Redact `input` with the active process secret redactor when installed. */
export function redactActiveSecretString(input: string): string {
  if (activeProcessRedactor === null || !activeProcessRedactor.hasSecrets) {
    return input;
  }
  return activeProcessRedactor.redactString(input);
}

/** Redact an arbitrary plain value with the active process secret redactor when installed. */
export function redactActiveSecretValue<T>(value: T): T {
  if (activeProcessRedactor === null || !activeProcessRedactor.hasSecrets) {
    return value;
  }
  return activeProcessRedactor.redactValue(value);
}

export interface WritableStreamLike {
  write: (...args: unknown[]) => boolean;
}

function wrapWritableStream(
  stream: WritableStreamLike,
  redactor: SecretRedactor,
): () => void {
  const originalWrite = stream.write;
  const wrappedWrite = function (this: unknown, ...args: unknown[]): boolean {
    if (!redactor.hasSecrets || args.length === 0) {
      return originalWrite.apply(this, args);
    }
    const [chunk, ...rest] = args;
    if (typeof chunk === 'string') {
      return originalWrite.apply(this, [redactor.redactString(chunk), ...rest]);
    }
    if (chunk instanceof Uint8Array) {
      const encoding = typeof rest[0] === 'string' ? (rest[0] as BufferEncoding) : 'utf8';
      const decoded = Buffer.from(chunk).toString(encoding);
      const scrubbed = redactor.redactString(decoded);
      if (scrubbed !== decoded) {
        return originalWrite.apply(this, [Buffer.from(scrubbed, encoding), ...rest]);
      }
    }
    return originalWrite.apply(this, args);
  };
  stream.write = wrappedWrite;
  return () => {
    if (stream.write === wrappedWrite) {
      stream.write = originalWrite;
    }
  };
}

/**
 * Intercept `stdout` and `stderr` writes so console/logger output never emits
 * raw values loaded from `.secret.local`. Returns a cleanup function.
 */
export function installStreamSecretRedaction(
  redactor: SecretRedactor,
  streams: {
    stdout?: WritableStreamLike;
    stderr?: WritableStreamLike;
  } = {
    stdout: process.stdout as unknown as WritableStreamLike,
    stderr: process.stderr as unknown as WritableStreamLike,
  },
): () => void {
  const restores: Array<() => void> = [];
  if (streams.stdout !== undefined) {
    restores.push(wrapWritableStream(streams.stdout, redactor));
  }
  if (streams.stderr !== undefined) {
    restores.push(wrapWritableStream(streams.stderr, redactor));
  }
  return () => {
    for (const restore of restores) {
      restore();
    }
  };
}
