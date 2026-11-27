/**
 * Evaluates `firebase-functions/params` Expression and SecretParam objects
 * (`defineString`, `defineBoolean`, `defineInt`, `defineFloat`, `defineList`,
 * `defineSecret`, `defineJsonSecret`, built-in internal params, `expr`,
 * `transform`, and conditional `compare` / `ternary` expressions) against a
 * loaded env/secrets map.
 *
 * Unset parameters without defaults, malformed values, non-Expression objects,
 * and circular or overly deep expression graphs fail cleanly without leaking
 * secret values.
 */

const EXPRESSION_TAG = Symbol.for('firebase-functions:Expression:Tag');
const RESET_VALUE_TAG = Symbol.for('firebase-functions:ResetValue:Tag');
const MAX_EXPRESSION_DEPTH = 64;

export type ParamExpressionFailureReason =
  | 'missing'
  | 'invalid'
  | 'circular'
  | 'unsupported';

export type ParamExpressionResolution =
  | { ok: true; value: unknown; containsSecret: boolean }
  | { ok: false; reason: ParamExpressionFailureReason; paramName?: string };

export type ParamsEnvMap = Readonly<Record<string, string | undefined>>;

type RawComparator = '==' | '!=' | '>' | '>=' | '<' | '<=';

interface ParamSpecLike {
  type?: unknown;
  format?: unknown;
}

function isResetSentinel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if ((value as Record<symbol, unknown>)[RESET_VALUE_TAG] === true) return true;
  const candidate = value as { toJSON?: unknown };
  if (typeof candidate.toJSON !== 'function') return false;
  try {
    return (candidate.toJSON as () => unknown)() === null;
  } catch {
    return false;
  }
}

function readParamSpec(candidate: object): ParamSpecLike | null {
  const maybeSpec = (candidate as { toSpec?: unknown }).toSpec;
  if (typeof maybeSpec !== 'function') return null;
  try {
    const spec = (maybeSpec as () => unknown).call(candidate);
    if (typeof spec === 'object' && spec !== null) {
      return spec as ParamSpecLike;
    }
  } catch {
    // InternalExpression throws from toSpec(); callers fall back to constructor metadata.
  }
  return null;
}

function detectStaticParamType(candidate: object): string | undefined {
  const ctor = (candidate as { constructor?: { type?: unknown; name?: unknown } }).constructor;
  if (typeof ctor?.type === 'string' && ctor.type.length > 0) {
    return ctor.type;
  }
  const spec = readParamSpec(candidate);
  if (typeof spec?.type === 'string' && spec.type.length > 0) {
    return spec.type;
  }
  const ctorName = typeof ctor?.name === 'string' ? ctor.name : '';
  if (ctorName === 'StringParam') return 'string';
  if (ctorName === 'BooleanParam') return 'boolean';
  if (ctorName === 'IntParam') return 'int';
  if (ctorName === 'FloatParam') return 'float';
  if (ctorName === 'ListParam') return 'list';
  if (ctorName === 'SecretParam' || ctorName === 'JsonSecretParam') return 'secret';
  return undefined;
}

function isSecretParamObject(candidate: object): boolean {
  const record = candidate as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.length === 0) return false;
  if (typeof record.value !== 'function') return false;
  return detectStaticParamType(candidate) === 'secret';
}

function isJsonSecretParamObject(candidate: object): boolean {
  const ctorName = (candidate as { constructor?: { name?: unknown } }).constructor?.name;
  if (ctorName === 'JsonSecretParam') return true;
  const spec = readParamSpec(candidate);
  return spec?.format === 'json';
}

function isCompareExpressionObject(candidate: object): candidate is {
  cmp: unknown;
  lhs: unknown;
  rhs: unknown;
} {
  const record = candidate as Record<string, unknown>;
  return (
    typeof record.cmp === 'string' &&
    Object.prototype.hasOwnProperty.call(record, 'lhs') &&
    Object.prototype.hasOwnProperty.call(record, 'rhs')
  );
}

function isTernaryExpressionObject(candidate: object): candidate is {
  test: unknown;
  ifTrue: unknown;
  ifFalse: unknown;
} {
  const record = candidate as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(record, 'test') &&
    Object.prototype.hasOwnProperty.call(record, 'ifTrue') &&
    Object.prototype.hasOwnProperty.call(record, 'ifFalse')
  );
}

function isInterpolationExpressionObject(candidate: object): candidate is {
  strings: readonly string[];
  values: readonly unknown[];
} {
  const record = candidate as Record<string, unknown>;
  return (
    Array.isArray(record.strings) &&
    record.strings.every((part) => typeof part === 'string') &&
    Array.isArray(record.values)
  );
}

function isTransformedExpressionObject(candidate: object): candidate is {
  source: unknown;
  transformer: (value: unknown) => unknown;
} {
  const record = candidate as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(record, 'source') &&
    typeof record.transformer === 'function'
  );
}

function isInternalExpressionObject(candidate: object): candidate is {
  name: string;
  getter: (env: ParamsEnvMap) => unknown;
} {
  const record = candidate as Record<string, unknown>;
  return (
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    typeof record.getter === 'function'
  );
}

/**
 * Whether `value` is a `firebase-functions/params` Expression, Param,
 * SecretParam, or JsonSecretParam object.
 */
export function isParamExpression(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (isResetSentinel(value)) {
    return false;
  }
  if ((value as Record<symbol, unknown>)[EXPRESSION_TAG] === true) {
    return true;
  }
  if (isSecretParamObject(value)) {
    return true;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.toCEL === 'function' && typeof record.value === 'function') {
    return true;
  }
  return false;
}

function readEnvValue(env: ParamsEnvMap, name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, name)) {
    return undefined;
  }
  const raw = env[name];
  if (typeof raw !== 'string') {
    return undefined;
  }
  return raw;
}

function parseBooleanEnvValue(raw: string): { ok: true; value: boolean } | { ok: false } {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return { ok: true, value: true };
  if (normalized === 'false') return { ok: true, value: false };
  return { ok: false };
}

function parseIntEnvValue(raw: string): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return { ok: false };
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return { ok: false };
  return { ok: true, value: parsed };
}

function parseFloatEnvValue(raw: string): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false };
  return { ok: true, value: parsed };
}

function parseListEnvValue(raw: string): { ok: true; value: string[] } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: [] };
  }
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return { ok: true, value: [...parsed] };
      }
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }
  const items = trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return { ok: true, value: items };
}

function stringArraysEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.every((item) => right.includes(item)) &&
    right.every((item) => left.includes(item))
  );
}

function evaluateComparison(
  cmp: string,
  left: unknown,
  right: unknown,
  containsSecret: boolean,
): ParamExpressionResolution {
  const op = cmp as RawComparator;
  if (op === '==' || op === '!=') {
    let equal: boolean;
    if (Array.isArray(left) && Array.isArray(right)) {
      equal = stringArraysEqual(left, right);
    } else if (Array.isArray(left) || Array.isArray(right)) {
      equal = false;
    } else {
      equal = left === right;
    }
    return { ok: true, value: op === '==' ? equal : !equal, containsSecret };
  }
  if (op === '>' || op === '>=' || op === '<' || op === '<=') {
    const bothNumbers =
      typeof left === 'number' &&
      typeof right === 'number' &&
      Number.isFinite(left) &&
      Number.isFinite(right);
    const bothStrings = typeof left === 'string' && typeof right === 'string';
    if (!bothNumbers && !bothStrings) {
      return { ok: false, reason: 'invalid' };
    }
    let result: boolean;
    if (op === '>') result = left > right;
    else if (op === '>=') result = left >= right;
    else if (op === '<') result = left < right;
    else result = left <= right;
    return { ok: true, value: result, containsSecret };
  }
  return { ok: false, reason: 'invalid' };
}

function matchesExpectedParamType(paramType: string, value: unknown): boolean {
  if (paramType === 'string') return typeof value === 'string';
  if (paramType === 'boolean') return typeof value === 'boolean';
  if (paramType === 'int') return typeof value === 'number' && Number.isSafeInteger(value);
  if (paramType === 'float') return typeof value === 'number' && Number.isFinite(value);
  if (paramType === 'list') {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
  return false;
}

function evaluateInternalExpression(
  expr: { name: string; getter: (env: ParamsEnvMap) => unknown },
  env: ParamsEnvMap,
): ParamExpressionResolution {
  let raw: unknown;
  try {
    raw = expr.getter(env);
  } catch {
    return { ok: false, reason: 'invalid', paramName: expr.name };
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return { ok: true, value: raw, containsSecret: false };
  }
  if (expr.name === 'PROJECT_ID' || expr.name === 'GCLOUD_PROJECT') {
    const fallback =
      readEnvValue(env, 'GCLOUD_PROJECT') ??
      readEnvValue(env, 'GOOGLE_CLOUD_PROJECT') ??
      readEnvValue(env, 'GCP_PROJECT');
    if (typeof fallback === 'string' && fallback.length > 0) {
      return { ok: true, value: fallback, containsSecret: false };
    }
  }
  if (typeof raw === 'string') {
    return { ok: true, value: raw, containsSecret: false };
  }
  return { ok: false, reason: 'invalid', paramName: expr.name };
}

function evaluateSecretParam(
  expr: object,
  name: string,
  env: ParamsEnvMap,
): ParamExpressionResolution {
  const raw = readEnvValue(env, name);
  if (raw === undefined) {
    return { ok: false, reason: 'missing', paramName: name };
  }
  if (isJsonSecretParamObject(expr)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return { ok: true, value: parsed, containsSecret: true };
    } catch {
      // Never propagate JSON.parse error details that may quote secret bytes.
      return { ok: false, reason: 'invalid', paramName: name };
    }
  }
  return { ok: true, value: raw, containsSecret: true };
}

function evaluateNode(
  node: unknown,
  env: ParamsEnvMap,
  activeStack: Set<object>,
  depth: number,
): ParamExpressionResolution {
  if (depth > MAX_EXPRESSION_DEPTH) {
    return { ok: false, reason: 'circular' };
  }
  if (!isParamExpression(node)) {
    return { ok: true, value: node, containsSecret: false };
  }
  if (activeStack.has(node)) {
    return { ok: false, reason: 'circular' };
  }
  activeStack.add(node);
  try {
    if (isTernaryExpressionObject(node)) {
      const testResult = evaluateNode(node.test, env, activeStack, depth + 1);
      if (!testResult.ok) return testResult;
      if (typeof testResult.value !== 'boolean') {
        return { ok: false, reason: 'invalid' };
      }
      const branch = testResult.value ? node.ifTrue : node.ifFalse;
      const branchResult = evaluateNode(branch, env, activeStack, depth + 1);
      if (!branchResult.ok) return branchResult;
      return {
        ok: true,
        value: branchResult.value,
        containsSecret: testResult.containsSecret || branchResult.containsSecret,
      };
    }

    if (isCompareExpressionObject(node)) {
      const lhsResult = evaluateNode(node.lhs, env, activeStack, depth + 1);
      if (!lhsResult.ok) return lhsResult;
      const rhsResult = evaluateNode(node.rhs, env, activeStack, depth + 1);
      if (!rhsResult.ok) return rhsResult;
      return evaluateComparison(
        String(node.cmp),
        lhsResult.value,
        rhsResult.value,
        lhsResult.containsSecret || rhsResult.containsSecret,
      );
    }

    if (isInterpolationExpressionObject(node)) {
      let out = '';
      let containsSecret = false;
      for (let i = 0; i < node.strings.length; i += 1) {
        out += node.strings[i] ?? '';
        if (i < node.values.length) {
          const partResult = evaluateNode(node.values[i], env, activeStack, depth + 1);
          if (!partResult.ok) return partResult;
          containsSecret = containsSecret || partResult.containsSecret;
          out += String(partResult.value);
        }
      }
      return { ok: true, value: out, containsSecret };
    }

    if (isTransformedExpressionObject(node)) {
      const sourceResult = evaluateNode(node.source, env, activeStack, depth + 1);
      if (!sourceResult.ok) return sourceResult;
      try {
        const transformed = node.transformer(sourceResult.value);
        return {
          ok: true,
          value: transformed,
          containsSecret: sourceResult.containsSecret,
        };
      } catch {
        return { ok: false, reason: 'invalid' };
      }
    }

    if (isInternalExpressionObject(node)) {
      return evaluateInternalExpression(node, env);
    }

    const record = node as { name?: unknown; options?: { default?: unknown } };
    if (typeof record.name === 'string' && record.name.length > 0) {
      const paramName = record.name;
      const paramType = detectStaticParamType(node);
      if (paramType === 'secret') {
        return evaluateSecretParam(node, paramName, env);
      }

      const raw = readEnvValue(env, paramName);
      if (raw !== undefined) {
        if (paramType === 'string') {
          return { ok: true, value: raw, containsSecret: false };
        }
        if (paramType === 'boolean') {
          const parsed = parseBooleanEnvValue(raw);
          if (!parsed.ok) return { ok: false, reason: 'invalid', paramName };
          return { ok: true, value: parsed.value, containsSecret: false };
        }
        if (paramType === 'int') {
          const parsed = parseIntEnvValue(raw);
          if (!parsed.ok) return { ok: false, reason: 'invalid', paramName };
          return { ok: true, value: parsed.value, containsSecret: false };
        }
        if (paramType === 'float') {
          const parsed = parseFloatEnvValue(raw);
          if (!parsed.ok) return { ok: false, reason: 'invalid', paramName };
          return { ok: true, value: parsed.value, containsSecret: false };
        }
        if (paramType === 'list') {
          const parsed = parseListEnvValue(raw);
          if (!parsed.ok) return { ok: false, reason: 'invalid', paramName };
          return { ok: true, value: parsed.value, containsSecret: false };
        }
        return { ok: false, reason: 'unsupported', paramName };
      }

      const defaultOption = record.options?.default;
      if (defaultOption !== undefined && paramType !== undefined) {
        const defaultResult = evaluateNode(defaultOption, env, activeStack, depth + 1);
        if (!defaultResult.ok) return defaultResult;
        if (!matchesExpectedParamType(paramType, defaultResult.value)) {
          return { ok: false, reason: 'invalid', paramName };
        }
        return defaultResult;
      }
      return { ok: false, reason: 'missing', paramName };
    }

    return { ok: false, reason: 'unsupported' };
  } finally {
    activeStack.delete(node);
  }
}

/**
 * Evaluate a `firebase-functions/params` Expression or SecretParam against `env`.
 * Non-Expression literal values pass through unchanged.
 */
export function resolveParamExpression(
  value: unknown,
  env: ParamsEnvMap = process.env,
): ParamExpressionResolution {
  return evaluateNode(value, env, new Set<object>(), 0);
}
