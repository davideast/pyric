/**
 * Reusable JSON, flag, binding, template, and scenario parsers/validators for
 * `pyric policy`.
 */
import type { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { FlagValue } from '../parse-args.js';
import type {
  FirestorePlacement,
  FirestoreTemplate,
  PolicyMode,
  PolicyProgramKind,
  PolicyTarget,
  ProvePolicyScenario,
  RtdbBinding,
  RtdbBindings,
  StoragePlacement,
  StorageTemplate,
} from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_KINDS: ReadonlySet<string> = new Set(['transition', 'function', 'module']);
const VALID_MODES: ReadonlySet<string> = new Set(['mixed', 'complete']);
const VALID_TARGETS: ReadonlySet<string> = new Set(['standalone', 'firestore', 'storage', 'rtdb']);
const VALID_RTDB_TYPES: ReadonlySet<string> = new Set(['number', 'string', 'boolean', 'any']);
const VALID_FIRESTORE_OPS: ReadonlySet<string> = new Set(['create', 'update', 'delete']);
const SAFE_STEM_RE = /^[A-Za-z0-9._-]+$/;

export class PolicyInputError extends Error {
  readonly kind: 'usage' | 'io';
  constructor(message: string, kind: 'usage' | 'io' = 'usage') {
    super(message);
    this.name = 'PolicyInputError';
    this.kind = kind;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertSafeKeys(obj: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new PolicyInputError(`${label} contains forbidden key '${key}'`);
    }
  }
}

export function readBooleanFlag(value: FlagValue | undefined): boolean {
  if (value === true || value === 'true') return true;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return last === true || last === 'true';
  }
  return false;
}

export function isJsonOutput(flags: ReadonlyMap<string, FlagValue>): boolean {
  return readBooleanFlag(flags.get('json'));
}

export function readStringFlag(value: FlagValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    if (typeof last === 'string') return last;
  }
  return undefined;
}

export function readStringListFlags(
  flags: ReadonlyMap<string, FlagValue>,
  names: readonly string[],
): string[] | undefined {
  const out: string[] = [];
  let seen = false;
  for (const name of names) {
    const raw = flags.get(name);
    if (raw === undefined) continue;
    seen = true;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const item of values) {
      if (typeof item !== 'string') throw new PolicyInputError(`missing value for --${name}`);
      for (const token of item.split(',')) {
        const trimmed = token.trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
    }
  }
  return seen ? out : undefined;
}

export function parseIntInRange(raw: string, label: string, min: number, max: number): number {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new PolicyInputError(`invalid ${label} '${raw}'; expected integer between ${min} and ${max}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PolicyInputError(`invalid ${label} '${raw}'; expected integer between ${min} and ${max}`);
  }
  return value;
}

export function parseConfigInt(raw: unknown, label: string, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new PolicyInputError(`invalid ${label}; expected integer between ${min} and ${max}`);
  }
  return raw;
}

export function parseConfigBool(raw: unknown, label: string): boolean {
  if (typeof raw !== 'boolean') {
    throw new PolicyInputError(`invalid ${label}; expected boolean`);
  }
  return raw;
}

export function parseStringBindings(raw: unknown, label: string): Record<string, string> {
  if (!isPlainRecord(raw)) {
    throw new PolicyInputError(`${label} must be a JSON object mapping policy paths to strings`);
  }
  assertSafeKeys(raw, label);
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.trim().length === 0 || typeof val !== 'string') {
      throw new PolicyInputError(`${label} entry '${key}' must map to a string expression`);
    }
    out[key] = val;
  }
  return out;
}

export function parseRtdbBindings(raw: unknown, label: string): RtdbBindings {
  if (!isPlainRecord(raw)) {
    throw new PolicyInputError(`${label} must be a JSON object mapping policy paths to RTDB bindings`);
  }
  assertSafeKeys(raw, label);
  const out: Record<string, RtdbBinding> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.trim().length === 0) {
      throw new PolicyInputError(`${label} cannot contain an empty binding key`);
    }
    if (val === 'data' || val === 'newData') {
      out[key] = val;
      continue;
    }
    if (!isPlainRecord(val)) {
      throw new PolicyInputError(`${label} entry '${key}' must be 'data', 'newData', or a snapshot object`);
    }
    assertSafeKeys(val, `${label}.${key}`);
    if (val.snapshot !== 'data' && val.snapshot !== 'newData') {
      throw new PolicyInputError(`${label}.${key}.snapshot must be 'data' or 'newData'`);
    }
    if (val.parent !== undefined && typeof val.parent !== 'boolean') {
      throw new PolicyInputError(`${label}.${key}.parent must be a boolean`);
    }
    if (val.path !== undefined && (typeof val.path !== 'string' || val.path.length === 0)) {
      throw new PolicyInputError(`${label}.${key}.path must be a non-empty string`);
    }
    if (val.type !== undefined && (typeof val.type !== 'string' || !VALID_RTDB_TYPES.has(val.type))) {
      throw new PolicyInputError(`${label}.${key}.type must be number, string, boolean, or any`);
    }
    out[key] = {
      snapshot: val.snapshot,
      ...(val.parent !== undefined ? { parent: val.parent } : {}),
      ...(val.path !== undefined ? { path: val.path } : {}),
      ...(val.type !== undefined ? { type: val.type as 'number' | 'string' | 'boolean' | 'any' } : {}),
    };
  }
  return out;
}

export function validateRtdbPath(path: string): string {
  const parts = path.split('/').slice(1);
  if (!path.startsWith('/') || parts.length === 0) {
    throw new PolicyInputError(`invalid RTDB path '${path}'; expected an absolute path like /items/$id`);
  }
  for (const part of parts) {
    if (part.length === 0 || /[.#[\]]/.test(part) || FORBIDDEN_KEYS.has(part)) {
      throw new PolicyInputError(`invalid RTDB path segment '${part}' in '${path}'`);
    }
  }
  return path;
}

export function validateOutputStem(stem: string): string {
  if (!SAFE_STEM_RE.test(stem) || stem === '.' || stem === '..') {
    throw new PolicyInputError(
      `invalid --name '${stem}'; expected filename stem matching [A-Za-z0-9._-]+`,
    );
  }
  return stem;
}

export function defaultOutputStem(file: string, preferred?: string | null): string {
  if (preferred && SAFE_STEM_RE.test(preferred) && preferred !== '.' && preferred !== '..') {
    return preferred;
  }
  if (file === '-') return 'policy';
  const base = basename(file, extname(file)).replace(/[^A-Za-z0-9._-]+/g, '-');
  return base.length === 0 || base === '.' || base === '..' ? 'policy' : base;
}

export function parseScenarios(raw: unknown, label: string): ProvePolicyScenario[] {
  const list = Array.isArray(raw)
    ? raw
    : isPlainRecord(raw) && Array.isArray(raw.scenarios)
      ? raw.scenarios
      : null;
  if (list === null) {
    throw new PolicyInputError(`${label} must be a JSON array or an object with a 'scenarios' array`);
  }
  return list.map((item, i) => {
    if (!isPlainRecord(item) || typeof item.name !== 'string' || item.name.trim().length === 0) {
      throw new PolicyInputError(`${label}[${i}] must be an object with a non-empty string 'name'`);
    }
    if (item.transition !== undefined && !isPlainRecord(item.transition)) {
      throw new PolicyInputError(`${label}[${i}].transition must be an object`);
    }
    if (item.functionName !== undefined && typeof item.functionName !== 'string') {
      throw new PolicyInputError(`${label}[${i}].functionName must be a string`);
    }
    if (item.args !== undefined && !Array.isArray(item.args)) {
      throw new PolicyInputError(`${label}[${i}].args must be an array`);
    }
    if (item.expectOk !== undefined && typeof item.expectOk !== 'boolean') {
      throw new PolicyInputError(`${label}[${i}].expectOk must be a boolean`);
    }
    if (item.expectError !== undefined && typeof item.expectError !== 'boolean') {
      throw new PolicyInputError(`${label}[${i}].expectError must be a boolean`);
    }
    if (item.expectRequirement !== undefined && typeof item.expectRequirement !== 'string') {
      throw new PolicyInputError(`${label}[${i}].expectRequirement must be a string`);
    }
    return {
      name: item.name,
      ...(item.transition !== undefined
        ? {
            transition: {
              before: item.transition.before,
              after: item.transition.after,
              input: item.transition.input,
            },
          }
        : {}),
      ...(item.functionName !== undefined ? { functionName: item.functionName } : {}),
      ...(item.args !== undefined ? { args: item.args } : {}),
      ...(item.expectOk !== undefined ? { expectOk: item.expectOk } : {}),
      ...(item.expectRequirement !== undefined ? { expectRequirement: item.expectRequirement } : {}),
      ...(Object.hasOwn(item, 'expectValue') ? { expectValue: item.expectValue } : {}),
      ...(item.expectError !== undefined ? { expectError: item.expectError } : {}),
    };
  });
}

export async function readText(
  filePath: string,
  readFileFn: typeof readFile,
  label: string,
): Promise<string> {
  try {
    return await readFileFn(filePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolicyInputError(`failed to read ${label} '${filePath}': ${msg}`, 'io');
  }
}

export async function readJsonFile(
  filePath: string,
  readFileFn: typeof readFile,
  label: string,
): Promise<unknown> {
  const raw = await readText(filePath, readFileFn, label);
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolicyInputError(`invalid JSON in ${label} '${filePath}': ${msg}`);
  }
}

export async function parseTemplate(
  raw: unknown,
  baseDir: string,
  kind: 'firestore' | 'storage',
  readFileFn: typeof readFile,
  label: string,
): Promise<FirestoreTemplate | StorageTemplate> {
  if (!isPlainRecord(raw)) throw new PolicyInputError(`${label} must be a JSON object`);
  assertSafeKeys(raw, label);
  if (typeof raw.slot !== 'string' || raw.slot.trim().length === 0) {
    throw new PolicyInputError(`${label}.slot must be a non-empty string`);
  }
  const hasRules = typeof raw.rules === 'string';
  const hasRulesFile = typeof raw.rulesFile === 'string';
  if (!hasRules && !hasRulesFile) {
    throw new PolicyInputError(`${label} must provide either 'rules' or 'rulesFile'`);
  }
  if (hasRules && hasRulesFile) {
    throw new PolicyInputError(`${label} must not provide both 'rules' and 'rulesFile'`);
  }
  const rules = hasRules
    ? (raw.rules as string)
    : await readText(resolve(baseDir, raw.rulesFile as string), readFileFn, `${label}.rulesFile`);
  if (!Array.isArray(raw.placements)) {
    throw new PolicyInputError(`${label}.placements must be an array`);
  }
  const checkEntry = (entry: unknown, idx: number) => {
    if (!isPlainRecord(entry)) {
      throw new PolicyInputError(`${label}.placements[${idx}] must be an object`);
    }
    assertSafeKeys(entry, `${label}.placements[${idx}]`);
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new PolicyInputError(`${label}.placements[${idx}].path must be a non-empty string`);
    }
    if (typeof entry.operation !== 'string' || entry.operation.trim().length === 0) {
      throw new PolicyInputError(`${label}.placements[${idx}].operation must be a non-empty string`);
    }
    return {
      path: entry.path,
      operation: entry.operation,
      bindings: parseStringBindings(entry.bindings, `${label}.placements[${idx}].bindings`),
    };
  };
  if (kind === 'firestore') {
    const placements: FirestorePlacement[] = raw.placements.map((entry, idx) => {
      const parsed = checkEntry(entry, idx);
      if (!VALID_FIRESTORE_OPS.has(parsed.operation)) {
        throw new PolicyInputError(
          `${label}.placements[${idx}].operation must be create, update, or delete`,
        );
      }
      return { ...parsed, operation: parsed.operation as 'create' | 'update' | 'delete' };
    });
    return { rules, slot: raw.slot, placements };
  }
  const placements: StoragePlacement[] = raw.placements.map(checkEntry);
  return { rules, slot: raw.slot, placements };
}

export function parseTargetsList(raw: readonly string[], label: string): PolicyTarget[] {
  const seen = new Set<PolicyTarget>();
  for (const item of raw) {
    if (!VALID_TARGETS.has(item)) {
      throw new PolicyInputError(
        `invalid ${label} '${item}'; expected standalone, firestore, storage, or rtdb`,
      );
    }
    seen.add(item as PolicyTarget);
  }
  if (seen.size === 0) throw new PolicyInputError(`${label} must specify at least one target`);
  return [...seen];
}

export function validateKind(raw: unknown, label: string): PolicyProgramKind {
  if (typeof raw !== 'string' || !VALID_KINDS.has(raw)) {
    throw new PolicyInputError(
      `invalid ${label} '${String(raw)}'; expected transition, function, or module`,
    );
  }
  return raw as PolicyProgramKind;
}

export function validateMode(raw: unknown, label: string): PolicyMode {
  if (typeof raw !== 'string' || !VALID_MODES.has(raw)) {
    throw new PolicyInputError(`invalid ${label} '${String(raw)}'; expected mixed or complete`);
  }
  return raw as PolicyMode;
}
