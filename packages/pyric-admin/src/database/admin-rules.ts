/**
 * `Database#getRules()`, `Database#getRulesJSON()`, and `Database#setRules(source)`
 * implementation shared across the local in-process and remote worker-relay arms.
 */

import type { RemoteSandboxChannel } from 'pyric/sandbox';
import { jsonEqual } from 'pyric/database/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import { toStrictRulesJson } from 'pyric/sandbox/database';
import type { AdminServiceLifecycle } from '../app/lifecycle.js';
import { FirebaseDatabaseError } from './error.js';
import { emitAdminDatabaseLog } from './logging.js';
import { assertActivePromise } from './tree-store.js';

export interface DatabaseRulesControls {
  getRules(): Promise<string>;
  getRulesJSON(): Promise<object>;
  setRules(source: string | object | Buffer): Promise<void>;
}

export interface LocalRulesBackend {
  getActiveRules(): { rules: Record<string, unknown> } | null;
  setRules(rules: { rules: Record<string, unknown> } | null): void;
}

interface ValidatedRulesPayload {
  readonly rawText: string;
  readonly parsed: { rules: Record<string, unknown> };
}

interface CachedRawRules {
  readonly rulesJson: { rules: Record<string, unknown> } | null;
  readonly rawText: string;
}

interface RemoteActiveRulesView {
  readonly source?: unknown;
  readonly rawText?: unknown;
}

interface RemoteRulesDeployReply {
  readonly ok?: boolean;
  readonly messages?: ReadonlyArray<{ text?: string }>;
}

const DEFAULT_FALLBACK_RULES: { rules: Record<string, unknown> } = {
  rules: {
    '.read': false,
    '.write': false,
  },
};

const rawRulesByBackend = new WeakMap<LocalRulesBackend, CachedRawRules>();

function invalidRulesSourceError(): FirebaseDatabaseError {
  return new FirebaseDatabaseError({
    code: 'invalid-argument',
    message: 'Source must be a non-empty string, Buffer or an object.',
  });
}

function securityRulesAccessError(detail: string): FirebaseDatabaseError {
  return new FirebaseDatabaseError({
    code: 'internal-error',
    message: `Error while accessing security rules: ${detail}`,
  });
}

function isPlainRulesSourceObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractRawSourceText(source: unknown): string | null {
  if (typeof source === 'string') {
    if (source.length === 0) {
      return null;
    }
    return source;
  }
  if (Buffer.isBuffer(source)) {
    return source.toString('utf8');
  }
  if (isPlainRulesSourceObject(source)) {
    return JSON.stringify(source, null, 2);
  }
  return null;
}

function parseAndValidateRulesSource(source: unknown): ValidatedRulesPayload {
  const rawText = extractRawSourceText(source);
  if (rawText === null) {
    throw invalidRulesSourceError();
  }
  let parsedUnknown: unknown;
  try {
    const strictJson = toStrictRulesJson(rawText);
    parsedUnknown = JSON.parse(strictJson);
  } catch (err) {
    let detail = String(err);
    if (err instanceof Error) {
      detail = err.message;
    }
    throw securityRulesAccessError(detail);
  }
  const rejection = rtdbRulesSourceRejection(parsedUnknown);
  if (rejection !== null) {
    throw securityRulesAccessError(rejection.message);
  }
  return {
    rawText,
    parsed: parsedUnknown as { rules: Record<string, unknown> },
  };
}

export function localDatabaseRulesControls(
  backend: LocalRulesBackend,
  lifecycle: AdminServiceLifecycle,
  onRulesUpdated?: () => void,
): DatabaseRulesControls {
  return {
    async getRules(): Promise<string> {
      lifecycle.assertActive();
      emitAdminDatabaseLog('getRules');
      const active = backend.getActiveRules();
      const cached = rawRulesByBackend.get(backend);
      if (
        cached !== undefined
        && active !== null
        && cached.rulesJson !== null
        && jsonEqual(cached.rulesJson as never, active as never)
      ) {
        return cached.rawText;
      }
      if (active !== null) {
        return JSON.stringify(active, null, 2);
      }
      return JSON.stringify(DEFAULT_FALLBACK_RULES, null, 2);
    },
    async getRulesJSON(): Promise<object> {
      lifecycle.assertActive();
      emitAdminDatabaseLog('getRulesJSON');
      const active = backend.getActiveRules();
      if (active !== null) {
        return structuredClone(active);
      }
      return structuredClone(DEFAULT_FALLBACK_RULES);
    },
    async setRules(source: string | object | Buffer): Promise<void> {
      lifecycle.assertActive();
      emitAdminDatabaseLog('setRules');
      const validated = parseAndValidateRulesSource(source);
      backend.setRules(validated.parsed);
      rawRulesByBackend.set(backend, {
        rulesJson: backend.getActiveRules(),
        rawText: validated.rawText,
      });
      onRulesUpdated?.();
    },
  };
}

export function remoteDatabaseRulesControls(
  channel: RemoteSandboxChannel,
  instance: string | undefined,
  lifecycle: AdminServiceLifecycle,
  onRulesUpdated?: () => void,
): DatabaseRulesControls {
  return {
    async getRules(): Promise<string> {
      const deleted = assertActivePromise(lifecycle);
      if (deleted !== null) {
        await deleted;
      }
      emitAdminDatabaseLog('getRules');
      const view = (await channel.op({
        method: 'getActiveRules',
        service: 'database',
        instance,
      })) as RemoteActiveRulesView | null;
      if (view !== null && typeof view === 'object' && typeof view.rawText === 'string') {
        return view.rawText;
      }
      if (view !== null && typeof view === 'object' && isPlainRulesSourceObject(view.source)) {
        return JSON.stringify(view.source, null, 2);
      }
      return JSON.stringify(DEFAULT_FALLBACK_RULES, null, 2);
    },
    async getRulesJSON(): Promise<object> {
      const deleted = assertActivePromise(lifecycle);
      if (deleted !== null) {
        await deleted;
      }
      emitAdminDatabaseLog('getRulesJSON');
      const view = (await channel.op({
        method: 'getActiveRules',
        service: 'database',
        instance,
      })) as RemoteActiveRulesView | null;
      if (view !== null && typeof view === 'object' && isPlainRulesSourceObject(view.source)) {
        return structuredClone(view.source);
      }
      return structuredClone(DEFAULT_FALLBACK_RULES);
    },
    async setRules(source: string | object | Buffer): Promise<void> {
      const deleted = assertActivePromise(lifecycle);
      if (deleted !== null) {
        await deleted;
      }
      emitAdminDatabaseLog('setRules');
      const validated = parseAndValidateRulesSource(source);
      const reply = (await channel.op({
        method: 'setDatabaseRules',
        instance,
        source: validated.rawText,
      })) as RemoteRulesDeployReply;
      if (reply.ok === false) {
        let reason = 'Realtime Database rules deploy rejected.';
        if (Array.isArray(reply.messages) && reply.messages.length > 0) {
          const texts: string[] = [];
          for (const msg of reply.messages) {
            if (typeof msg.text === 'string') {
              texts.push(msg.text);
            }
          }
          if (texts.length > 0) {
            reason = texts.join('; ');
          }
        }
        throw securityRulesAccessError(reason);
      }
      onRulesUpdated?.();
    },
  };
}
