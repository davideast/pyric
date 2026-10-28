/**
 * The SDK's checks on an RTDB write's value, priority and update map, run by
 * the served client before it sends a frame. Production's SDK throws these
 * synchronously (`core/util/validation.ts` in `@firebase/database`), and the
 * texts are its texts. On the Node host the frame is JSON, where NaN and
 * Infinity become null and an undefined member vanishes, so a value that got
 * past this point would arrive as a delete (RP-1, #1362).
 */

const INVALID_KEY = /[[\].#$/\u0000-\u001F\u007F]/;
const MAX_LEAF_BYTES = 10 * 1024 * 1024;
const MAX_PATH_BYTES = 768;
const MAX_PATH_DEPTH = 32;
const PRIORITY_RULE = 'must be a valid Firebase priority (a string, finite number, server value, or null).';

/** Where in the written value a check is looking, as the SDK's `ValidationPath` tracks it. */
interface ValidationPath {
  readonly prefix: string;
  readonly parts: string[];
  bytes: number;
}

function argumentPrefix(fnName: string, argument: string): string {
  return `${fnName} failed: ${argument} argument `;
}

function pathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** UTF-8 length as the SDK counts it (`stringLength`). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (isHighSurrogate) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function isInvalidJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isFinite(value);
}

function isValidKey(key: string): boolean {
  return key.length !== 0 && !INVALID_KEY.test(key);
}

function isServerValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, '.sv');
}

function isValidPriority(priority: unknown): boolean {
  const isFiniteNumber = typeof priority === 'number' && Number.isFinite(priority);
  return priority === null || typeof priority === 'string' || isFiniteNumber || isServerValue(priority);
}

function describePath(path: ValidationPath): string {
  const isAtRoot = path.parts.length === 0;
  if (isAtRoot) return '';
  return `in property '${path.parts.join('.')}'`;
}

function checkPathLimits(path: ValidationPath): void {
  const isTooLong = path.bytes > MAX_PATH_BYTES;
  if (isTooLong) throw new Error(`${path.prefix}has a key path longer than ${MAX_PATH_BYTES} bytes (${path.bytes}).`);
  const isTooDeep = path.parts.length > MAX_PATH_DEPTH;
  if (isTooDeep) {
    throw new Error(
      `${path.prefix}path specified exceeds the maximum depth that can be written (${MAX_PATH_DEPTH}) ` +
      `or object contains a cycle ${describePath(path)}`,
    );
  }
}

function startPath(prefix: string, segments: string[]): ValidationPath {
  const bytes = Math.max(1, segments.length) + segments.reduce((sum, part) => sum + utf8Length(part), 0);
  const path = { prefix, parts: [...segments], bytes };
  checkPathLimits(path);
  return path;
}

function pushPart(path: ValidationPath, part: string): void {
  const needsSeparator = path.parts.length > 0;
  if (needsSeparator) path.bytes += 1;
  path.parts.push(part);
  path.bytes += utf8Length(part);
  checkPathLimits(path);
}

function popPart(path: ValidationPath): void {
  const last = path.parts.pop() ?? '';
  path.bytes -= utf8Length(last);
  const hadSeparator = path.parts.length > 0;
  if (hadSeparator) path.bytes -= 1;
}

function checkLeaf(data: unknown, path: ValidationPath): void {
  const where = describePath(path);
  if (data === undefined) throw new Error(`${path.prefix}contains undefined ${where}`);
  if (typeof data === 'function') {
    throw new Error(`${path.prefix}contains a function ${where} with contents = ${String(data)}`);
  }
  if (isInvalidJsonNumber(data)) throw new Error(`${path.prefix}contains ${String(data)} ${where}`);
  const isLongString = typeof data === 'string' && data.length > MAX_LEAF_BYTES / 3 && utf8Length(data) > MAX_LEAF_BYTES;
  if (isLongString) {
    throw new Error(
      `${path.prefix}contains a string greater than ${MAX_LEAF_BYTES} utf8 bytes ${where} ('${data.substring(0, 50)}...')`,
    );
  }
}

function checkChildren(data: object, path: ValidationPath): void {
  let hasDotValue = false;
  let hasActualChild = false;
  for (const [key, child] of Object.entries(data)) {
    const isDotValue = key === '.value';
    const isMetadata = key === '.priority' || key === '.sv';
    if (isDotValue) hasDotValue = true;
    else if (!isMetadata) {
      hasActualChild = true;
      const isInvalidKey = !isValidKey(key);
      if (isInvalidKey) {
        throw new Error(
          `${path.prefix} contains an invalid key (${key}) ${describePath(path)}.  Keys must be non-empty strings ` +
          'and can\'t contain ".", "#", "$", "/", "[", or "]"',
        );
      }
    }
    pushPart(path, key);
    checkData(child, path);
    popPart(path);
  }
  const mixesDotValue = hasDotValue && hasActualChild;
  if (mixesDotValue) {
    throw new Error(`${path.prefix} contains ".value" child ${describePath(path)} in addition to actual children.`);
  }
}

/** `validateFirebaseData`: the value and every member under it. */
function checkData(data: unknown, path: ValidationPath): void {
  checkLeaf(data, path);
  const isContainer = typeof data === 'object' && data !== null;
  if (isContainer) checkChildren(data, path);
}

/** `validateFirebaseDataArg`: `fnName` writes `value` at `path`; `optional` lets `undefined` through. */
export function validateRtdbValue(fnName: string, value: unknown, path: string, optional = false): void {
  const isOmitted = optional && value === undefined;
  if (isOmitted) return;
  checkData(value, startPath(argumentPrefix(fnName, 'value'), pathSegments(path)));
}

/** `validatePriority`: a string, finite number, server value or null. */
export function validateRtdbPriority(fnName: string, priority: unknown): void {
  const prefix = argumentPrefix(fnName, 'priority');
  if (isInvalidJsonNumber(priority)) throw new Error(`${prefix}is ${String(priority)}, but ${PRIORITY_RULE}`);
  const isInvalid = !isValidPriority(priority);
  if (isInvalid) throw new Error(`${prefix}${PRIORITY_RULE}`);
}

/** The SDK's refusal of an update map that is not a plain object. */
export function updateValuesShapeError(fnName: string): Error {
  return new Error(`${argumentPrefix(fnName, 'values')} must be an object containing the children to replace.`);
}

function isUpdateMap(values: unknown): values is Record<string, unknown> {
  return typeof values === 'object' && values !== null && !Array.isArray(values);
}

/**
 * `validateFirebaseMergeDataArg` up to its key-path checks: `values` is an
 * object, each value is writable at its own path, and a `.priority` entry is
 * a valid priority. The key paths themselves are `validateUpdatePaths`'s.
 */
export function validateRtdbUpdateValues(fnName: string, values: unknown, path: string): asserts values is Record<string, unknown> {
  const isNotAMap = !isUpdateMap(values);
  if (isNotAMap) throw updateValuesShapeError(fnName);
  const prefix = argumentPrefix(fnName, 'values');
  for (const [key, value] of Object.entries(values)) {
    const keySegments = pathSegments(key);
    checkData(value, startPath(prefix, [...pathSegments(path), ...keySegments]));
    const setsPriority = keySegments.at(-1) === '.priority';
    const isInvalidPriority = setsPriority && !isValidPriority(value);
    if (isInvalidPriority) {
      throw new Error(`${prefix}contains an invalid value for '/${keySegments.join('/')}', which ${PRIORITY_RULE}`);
    }
  }
}
