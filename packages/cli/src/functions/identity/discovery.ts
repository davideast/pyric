/**
 * Discovery and manifest validation for `firebase-functions/v2/identity`
 * Auth blocking triggers (`providers/cloud.auth/eventTypes/user.*`).
 */
import {
  endpointTriggerLabel,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from '../endpoints.js';
import type { FunctionsTriggerFamily, UnsupportedFunctionsTrigger } from '../unsupported.js';

export const BEFORE_CREATE_EVENT_TYPE = 'providers/cloud.auth/eventTypes/user.beforeCreate';
export const BEFORE_SIGN_IN_EVENT_TYPE = 'providers/cloud.auth/eventTypes/user.beforeSignIn';
export const BEFORE_SEND_EMAIL_EVENT_TYPE =
  'providers/cloud.auth/eventTypes/user.beforeSendEmail';
export const BEFORE_SEND_SMS_EVENT_TYPE = 'providers/cloud.auth/eventTypes/user.beforeSendSms';

export const IDENTITY_BLOCKING_EVENT_TYPES = [
  BEFORE_CREATE_EVENT_TYPE,
  BEFORE_SIGN_IN_EVENT_TYPE,
  BEFORE_SEND_EMAIL_EVENT_TYPE,
  BEFORE_SEND_SMS_EVENT_TYPE,
] as const;

export type IdentityBlockingEventType = (typeof IDENTITY_BLOCKING_EVENT_TYPES)[number];

export type IdentityShortEventType =
  | 'beforeCreate'
  | 'beforeSignIn'
  | 'beforeSendEmail'
  | 'beforeSendSms';

/**
 * All four `firebase-functions/v2/identity` blocking event types wired for live
 * execution (`beforeCreate`, `beforeSignIn`, `beforeSendEmail`, `beforeSendSms`).
 */
export const ACTIVE_IDENTITY_EVENT_TYPES: ReadonlySet<IdentityBlockingEventType> = new Set([
  BEFORE_CREATE_EVENT_TYPE,
  BEFORE_SIGN_IN_EVENT_TYPE,
  BEFORE_SEND_EMAIL_EVENT_TYPE,
  BEFORE_SEND_SMS_EVENT_TYPE,
]);

const SHORT_EVENT_BY_CANONICAL: Readonly<
  Record<IdentityBlockingEventType, IdentityShortEventType>
> = {
  [BEFORE_CREATE_EVENT_TYPE]: 'beforeCreate',
  [BEFORE_SIGN_IN_EVENT_TYPE]: 'beforeSignIn',
  [BEFORE_SEND_EMAIL_EVENT_TYPE]: 'beforeSendEmail',
  [BEFORE_SEND_SMS_EVENT_TYPE]: 'beforeSendSms',
};

const IDENTITY_EVENT_TYPE_SET: ReadonlySet<string> = new Set(IDENTITY_BLOCKING_EVENT_TYPES);

export interface IdentityBlockingOptions {
  idToken: boolean;
  accessToken: boolean;
  refreshToken: boolean;
}

type IdentityTriggerCallable = ((...args: unknown[]) => unknown) & {
  run?: (event: Record<string, unknown>) => unknown | Promise<unknown>;
};

export interface DiscoveredIdentityTrigger {
  exportName: string;
  eventType: IdentityBlockingEventType;
  shortEventType: IdentityShortEventType;
  options: IdentityBlockingOptions;
  location?: string;
  timeoutSeconds?: number;
  callable: IdentityTriggerCallable;
}

export interface IdentityTriggerInspection {
  triggers: DiscoveredIdentityTrigger[];
  unsupported: UnsupportedFunctionsTrigger[];
}

export interface InspectIdentityTriggersOptions {
  activeEventTypes?: ReadonlySet<IdentityBlockingEventType>;
  defaultTimeoutSeconds?: number;
}

export function isIdentityBlockingEventType(
  value: unknown,
): value is IdentityBlockingEventType {
  return typeof value === 'string' && IDENTITY_EVENT_TYPE_SET.has(value);
}

export function shortIdentityEventType(
  eventType: IdentityBlockingEventType,
): IdentityShortEventType {
  return SHORT_EVENT_BY_CANONICAL[eventType];
}

function isBlockingEndpoint(endpoint: FirebaseEndpoint): boolean {
  const trigger = endpoint.blockingTrigger;
  return typeof trigger === 'object' && trigger !== null;
}

function isResetValueObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { toJSON?: unknown };
  if (typeof candidate.toJSON !== 'function') return false;
  try {
    return (candidate.toJSON as () => unknown)() === null;
  } catch {
    // Non-ResetValue objects with custom toJSON are dynamic expressions.
    return false;
  }
}

function parseEndpointLocation(
  region: unknown,
): { ok: true; location?: string } | { ok: false } {
  if (region === undefined || region === null || isResetValueObject(region)) {
    return { ok: true };
  }
  if (typeof region === 'string') {
    if (region.length === 0) return { ok: false };
    return { ok: true, location: region };
  }
  if (Array.isArray(region)) {
    if (region.length === 0) return { ok: true };
    const allStrings = region.every((item) => typeof item === 'string' && item.length > 0);
    if (!allStrings) return { ok: false };
    const first = region[0];
    if (typeof first === 'string') {
      return { ok: true, location: first };
    }
    return { ok: true };
  }
  return { ok: false };
}

function parseEndpointTimeout(
  timeoutSeconds: unknown,
): { ok: true; timeoutSeconds?: number; reset?: boolean } | { ok: false } {
  if (timeoutSeconds === undefined) {
    return { ok: true };
  }
  if (timeoutSeconds === null || isResetValueObject(timeoutSeconds)) {
    return { ok: true, reset: true };
  }
  if (typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return { ok: true, timeoutSeconds };
  }
  return { ok: false };
}

function parseBlockingOptions(
  rawOptions: Record<string, unknown> | undefined,
): { ok: true; options: IdentityBlockingOptions } | { ok: false } {
  if (rawOptions === undefined) {
    return {
      ok: true,
      options: { idToken: false, accessToken: false, refreshToken: false },
    };
  }
  for (const flag of ['idToken', 'accessToken', 'refreshToken'] as const) {
    const rawValue = rawOptions[flag];
    if (rawValue !== undefined && typeof rawValue !== 'boolean') {
      return { ok: false };
    }
  }
  return {
    ok: true,
    options: {
      idToken: rawOptions.idToken === true,
      accessToken: rawOptions.accessToken === true,
      refreshToken: rawOptions.refreshToken === true,
    },
  };
}

/**
 * Inspect exported functions for `firebase-functions/v2/identity` blocking
 * triggers. Honors `omit: true`, validates static manifest options, and
 * resolves duplicate registrations of the same blocking event type
 * deterministically (last non-omitted export overrides earlier ones, matching
 * Firebase Emulator Suite `blockingFunctions.triggers[eventType]` updates,
 * while surfacing superseded exports in `unsupported`).
 */
export function inspectIdentityTriggers(
  exported: Record<string, unknown>,
  options: InspectIdentityTriggersOptions = {},
): IdentityTriggerInspection {
  const candidates: DiscoveredIdentityTrigger[] = [];
  const unsupported: UnsupportedFunctionsTrigger[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints<IdentityTriggerCallable>(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint || !isBlockingEndpoint(endpoint)) continue;

    const label = endpointTriggerLabel(endpoint);
    if (endpoint.omit === true) {
      unsupported.push({
        exportName,
        eventType: `${label} (omitted from emulation)`,
      });
      continue;
    }
    if (endpoint.omit !== undefined && endpoint.omit !== false) {
      unsupported.push({
        exportName,
        eventType: `${label} (unsupported dynamic omit option)`,
      });
      continue;
    }

    const rawEventType = endpoint.blockingTrigger?.eventType;
    if (!isIdentityBlockingEventType(rawEventType)) {
      unsupported.push({
        exportName,
        eventType: label,
      });
      continue;
    }

    const parsedRegion = parseEndpointLocation(endpoint.region);
    if (!parsedRegion.ok) {
      unsupported.push({
        exportName,
        eventType: `${rawEventType} (unsupported dynamic region option)`,
      });
      continue;
    }

    const parsedTimeout = parseEndpointTimeout(endpoint.timeoutSeconds);
    if (!parsedTimeout.ok) {
      unsupported.push({
        exportName,
        eventType: `${rawEventType} (unsupported dynamic timeoutSeconds option)`,
      });
      continue;
    }

    const parsedBlockingOptions = parseBlockingOptions(endpoint.blockingTrigger?.options);
    if (!parsedBlockingOptions.ok) {
      unsupported.push({
        exportName,
        eventType: `${rawEventType} (unsupported dynamic blocking option)`,
      });
      continue;
    }

    if (options.activeEventTypes !== undefined && !options.activeEventTypes.has(rawEventType)) {
      unsupported.push({
        exportName,
        eventType: rawEventType,
      });
      continue;
    }

    const discovered: DiscoveredIdentityTrigger = {
      exportName,
      eventType: rawEventType,
      shortEventType: shortIdentityEventType(rawEventType),
      options: parsedBlockingOptions.options,
      callable,
    };
    if (parsedRegion.location !== undefined) {
      discovered.location = parsedRegion.location;
    }
    let resolvedTimeoutSeconds = parsedTimeout.timeoutSeconds;
    if (
      !parsedTimeout.reset &&
      resolvedTimeoutSeconds === undefined &&
      typeof options.defaultTimeoutSeconds === 'number' &&
      Number.isFinite(options.defaultTimeoutSeconds) &&
      options.defaultTimeoutSeconds > 0
    ) {
      resolvedTimeoutSeconds = options.defaultTimeoutSeconds;
    }
    if (resolvedTimeoutSeconds !== undefined) {
      discovered.timeoutSeconds = resolvedTimeoutSeconds;
    }
    candidates.push(discovered);
  }

  const winningExportByEvent = new Map<IdentityBlockingEventType, string>();
  for (const candidate of candidates) {
    winningExportByEvent.set(candidate.eventType, candidate.exportName);
  }

  const triggers: DiscoveredIdentityTrigger[] = [];
  for (const candidate of candidates) {
    const winner = winningExportByEvent.get(candidate.eventType);
    if (winner !== candidate.exportName) {
      unsupported.push({
        exportName: candidate.exportName,
        eventType: `${candidate.eventType} (superseded by ${String(winner)})`,
      });
      continue;
    }
    triggers.push(candidate);
  }

  return { triggers, unsupported };
}

/** Discover active Identity blocking triggers ready for runtime execution. */
export function discoverIdentityTriggers(
  exported: Record<string, unknown>,
  options: InspectIdentityTriggersOptions = {},
): DiscoveredIdentityTrigger[] {
  const activeEventTypes = options.activeEventTypes ?? ACTIVE_IDENTITY_EVENT_TYPES;
  const inspectOpts: InspectIdentityTriggersOptions = { activeEventTypes };
  if (options.defaultTimeoutSeconds !== undefined) {
    inspectOpts.defaultTimeoutSeconds = options.defaultTimeoutSeconds;
  }
  return inspectIdentityTriggers(exported, inspectOpts).triggers;
}

/** The v2 Identity Platform blocking trigger family (`providers/cloud.auth/eventTypes/user.*`). */
export const identityBlockingFamily: FunctionsTriggerFamily = {
  claims: isBlockingEndpoint,
  unsupported: (exported: Record<string, unknown>) =>
    inspectIdentityTriggers(exported, { activeEventTypes: ACTIVE_IDENTITY_EVENT_TYPES }).unsupported,
};
