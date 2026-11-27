/**
 * Shared endpoint manifest option resolvers backed by `params-resolver.ts`.
 * Every trigger discovery module uses these helpers so dynamic
 * `firebase-functions/params` expressions for `region`, `timeoutSeconds`,
 * `invoker`, strings, and booleans resolve consistently across all families.
 */
import { isResetValueObject } from './endpoints.js';
import {
  isParamExpression,
  resolveParamExpression,
  type ParamsEnvMap,
} from './params-resolver.js';

export type ResolvedRegionsOption =
  | { ok: true; regions: string[]; location?: string; explicit: boolean }
  | { ok: false; kind: 'dynamic' | 'invalid' };

export type ResolvedTimeoutOption =
  | { ok: true; timeoutSeconds?: number; reset?: boolean }
  | { ok: false; kind: 'dynamic' | 'invalid' };

export type ResolvedStringOption =
  | { ok: true; value: string; containsSecret: boolean }
  | { ok: false; kind: 'dynamic' | 'invalid' };

export type ResolvedInvokerOption =
  | { ok: true; invoker?: string[] }
  | { ok: false; kind: 'dynamic' | 'invalid' };

/**
 * Resolve an endpoint `region` manifest field (string, string[], Expression, or
 * array containing Expressions) against `env`.
 */
export function resolveEndpointRegionsOption(
  rawRegion: unknown,
  defaultRegion: string,
  env: ParamsEnvMap = process.env,
): ResolvedRegionsOption {
  if (rawRegion === undefined || rawRegion === null || isResetValueObject(rawRegion)) {
    return { ok: true, regions: [defaultRegion], explicit: false };
  }
  if (isParamExpression(rawRegion)) {
    const resolved = resolveParamExpression(rawRegion, env);
    if (!resolved.ok) {
      return { ok: false, kind: 'dynamic' };
    }
    if (isParamExpression(resolved.value)) {
      return { ok: false, kind: 'invalid' };
    }
    return resolveEndpointRegionsOption(resolved.value, defaultRegion, env);
  }
  if (typeof rawRegion === 'string') {
    if (rawRegion.length === 0) {
      return { ok: false, kind: 'invalid' };
    }
    return { ok: true, regions: [rawRegion], location: rawRegion, explicit: true };
  }
  if (Array.isArray(rawRegion)) {
    if (rawRegion.length === 0) {
      return { ok: true, regions: [defaultRegion], explicit: false };
    }
    const regions: string[] = [];
    for (const item of rawRegion) {
      if (typeof item === 'string') {
        if (item.length === 0) return { ok: false, kind: 'invalid' };
        regions.push(item);
        continue;
      }
      if (isParamExpression(item)) {
        const resolved = resolveParamExpression(item, env);
        if (!resolved.ok) return { ok: false, kind: 'dynamic' };
        if (typeof resolved.value === 'string') {
          if (resolved.value.length === 0) return { ok: false, kind: 'invalid' };
          regions.push(resolved.value);
          continue;
        }
        if (
          Array.isArray(resolved.value) &&
          resolved.value.every((entry) => typeof entry === 'string' && entry.length > 0)
        ) {
          regions.push(...(resolved.value as string[]));
          continue;
        }
        return { ok: false, kind: 'invalid' };
      }
      return { ok: false, kind: 'dynamic' };
    }
    if (regions.length === 0) {
      return { ok: true, regions: [defaultRegion], explicit: false };
    }
    const first = regions[0];
    if (typeof first === 'string') {
      return { ok: true, regions, location: first, explicit: true };
    }
    return { ok: true, regions: [defaultRegion], explicit: false };
  }
  return { ok: false, kind: 'dynamic' };
}

/**
 * Resolve a positive finite `timeoutSeconds` manifest option (number,
 * `RESET_VALUE`, or Expression<number>) against `env`.
 */
export function resolveTimeoutSecondsOption(
  rawTimeout: unknown,
  env: ParamsEnvMap = process.env,
  options: { allowZero?: boolean; maxSeconds?: number } = {},
): ResolvedTimeoutOption {
  if (rawTimeout === undefined) {
    return { ok: true };
  }
  if (rawTimeout === null || isResetValueObject(rawTimeout)) {
    return { ok: true, reset: true };
  }
  let candidate: unknown = rawTimeout;
  if (isParamExpression(rawTimeout)) {
    const resolved = resolveParamExpression(rawTimeout, env);
    if (!resolved.ok) {
      return { ok: false, kind: 'dynamic' };
    }
    candidate = resolved.value;
    if (candidate === undefined) {
      return { ok: true };
    }
    if (candidate === null || isResetValueObject(candidate)) {
      return { ok: true, reset: true };
    }
  } else if (typeof rawTimeout === 'object') {
    return { ok: false, kind: 'dynamic' };
  }

  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    return { ok: false, kind: 'invalid' };
  }
  if (candidate === 0) {
    if (options.allowZero === true) {
      return { ok: true };
    }
    return { ok: false, kind: 'invalid' };
  }
  if (candidate < 0) {
    return { ok: false, kind: 'invalid' };
  }
  if (options.maxSeconds !== undefined && candidate > options.maxSeconds) {
    return { ok: false, kind: 'invalid' };
  }
  return { ok: true, timeoutSeconds: candidate };
}

/**
 * Resolve a string manifest field (literal string or Expression<string>)
 * against `env`.
 */
export function resolveStringOption(
  rawValue: unknown,
  env: ParamsEnvMap = process.env,
): ResolvedStringOption {
  if (typeof rawValue === 'string') {
    return { ok: true, value: rawValue, containsSecret: false };
  }
  if (isParamExpression(rawValue)) {
    const resolved = resolveParamExpression(rawValue, env);
    if (!resolved.ok) {
      return { ok: false, kind: 'dynamic' };
    }
    if (typeof resolved.value !== 'string') {
      return { ok: false, kind: 'invalid' };
    }
    return {
      ok: true,
      value: resolved.value,
      containsSecret: resolved.containsSecret,
    };
  }
  return { ok: false, kind: 'dynamic' };
}

/**
 * Resolve a boolean manifest field (boolean, `undefined`/`null`/`RESET_VALUE`,
 * or Expression<boolean>) against `env`.
 */
export function resolveBooleanOption(
  rawValue: unknown,
  env: ParamsEnvMap = process.env,
): { ok: true; value: boolean } | { ok: false } {
  if (rawValue === true) return { ok: true, value: true };
  if (
    rawValue === undefined ||
    rawValue === null ||
    rawValue === false ||
    isResetValueObject(rawValue)
  ) {
    return { ok: true, value: false };
  }
  if (isParamExpression(rawValue)) {
    const resolved = resolveParamExpression(rawValue, env);
    if (!resolved.ok) {
      return { ok: false };
    }
    if (resolved.value === true) return { ok: true, value: true };
    if (
      resolved.value === undefined ||
      resolved.value === null ||
      resolved.value === false ||
      isResetValueObject(resolved.value)
    ) {
      return { ok: true, value: false };
    }
    return { ok: false };
  }
  return { ok: false };
}

/**
 * Resolve an `invoker` option (string, string[], Expression, or array of
 * Expressions) against `env`.
 */
export function resolveInvokerOption(
  rawInvoker: unknown,
  env: ParamsEnvMap = process.env,
): ResolvedInvokerOption {
  if (rawInvoker === undefined || rawInvoker === null || isResetValueObject(rawInvoker)) {
    return { ok: true };
  }
  if (isParamExpression(rawInvoker)) {
    const resolved = resolveParamExpression(rawInvoker, env);
    if (!resolved.ok) {
      return { ok: false, kind: 'dynamic' };
    }
    if (isParamExpression(resolved.value)) {
      return { ok: false, kind: 'invalid' };
    }
    return resolveInvokerOption(resolved.value, env);
  }
  if (typeof rawInvoker === 'string') {
    if (rawInvoker.length === 0) return { ok: false, kind: 'invalid' };
    return { ok: true, invoker: [rawInvoker] };
  }
  if (Array.isArray(rawInvoker)) {
    const values: string[] = [];
    for (const entry of rawInvoker) {
      if (typeof entry === 'string') {
        if (entry.length === 0) return { ok: false, kind: 'invalid' };
        values.push(entry);
        continue;
      }
      if (isParamExpression(entry)) {
        const resolved = resolveParamExpression(entry, env);
        if (!resolved.ok) return { ok: false, kind: 'dynamic' };
        if (typeof resolved.value === 'string' && resolved.value.length > 0) {
          values.push(resolved.value);
          continue;
        }
        if (
          Array.isArray(resolved.value) &&
          resolved.value.every((item) => typeof item === 'string' && item.length > 0)
        ) {
          values.push(...(resolved.value as string[]));
          continue;
        }
        return { ok: false, kind: 'invalid' };
      }
      if (typeof entry === 'object' && entry !== null) {
        return { ok: false, kind: 'dynamic' };
      }
      return { ok: false, kind: 'invalid' };
    }
    return { ok: true, invoker: values };
  }
  if (typeof rawInvoker === 'object') {
    return { ok: false, kind: 'dynamic' };
  }
  return { ok: false, kind: 'invalid' };
}
