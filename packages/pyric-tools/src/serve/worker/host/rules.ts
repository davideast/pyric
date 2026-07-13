/**
 * SharedWorker host — rules deploy + status ops.
 *
 * Firestore rules hot-reload (`setRules`/`setFirestoreRules`), RTDB rules
 * deploy (`setDatabaseRules`), and the active-rules / status reflection
 * (`getActiveRules`/`getRulesStatus`) that shared-runtime diagnostics + revert
 * read. Tracks the deployed source + last-known-good on `ctx.activeRules`.
 *
 * Routed here by the host dispatcher with the op's resolved Firestore handle
 * (`db`, used by the firestore-rules deploy). Never imports the dispatcher.
 */

import type { Firestore } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { sandbox as rtdbSandbox } from 'pyric/database/modular';

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail } from '../host-context.js';
import { ensureRtdb } from './core.js';

function normalizeDatabaseRules(source: unknown): { rules: Record<string, unknown> } | null {
  if (source === null) return null;
  if (typeof source === 'string') {
    return JSON.parse(source) as { rules: Record<string, unknown> };
  }
  if (typeof source === 'object' && source !== null) {
    return source as { rules: Record<string, unknown> };
  }
  throw new Error('RTDB rules must be a rules JSON object or JSON string.');
}

function firestoreRuleMessages(result: { warnings?: Array<{ severity?: string; message?: string }>; parseError?: { line?: number; column?: number; expected?: unknown; actual?: string } | null }) {
  const messages: Array<{ severity: 'info' | 'warn' | 'error'; text: string; line?: number; column?: number }> = [];
  if (result.parseError) {
    messages.push({
      severity: 'error',
      text: `PARSE ERROR: expected ${String(result.parseError.expected ?? 'valid rules')}`,
      line: result.parseError.line,
      column: result.parseError.column,
    });
  }
  for (const warning of result.warnings ?? []) {
    messages.push({
      severity: warning.severity === 'error' ? 'error' : warning.severity === 'warning' ? 'warn' : 'info',
      text: String(warning.message ?? warning),
    });
  }
  return messages;
}

/** The rules deploy/status op methods routed to {@link handleRulesOp}. */
const RULES_METHODS = new Set<string>([
  'setRules',
  'setFirestoreRules',
  'setDatabaseRules',
  'getActiveRules',
  'getRulesStatus',
]);

export function isRulesOp(method: OpMessage['method']): boolean {
  return RULES_METHODS.has(method);
}

export function handleRulesOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
  db: Firestore,
): void {
  switch (msg.method) {
    case 'setRules':
    case 'setFirestoreRules': {
      try {
        const result = setRules(ctx.sandbox, msg.source);
        const messages = firestoreRuleMessages(result);
        const okDeploy = !messages.some((m) => m.severity === 'error');
        ctx.activeRules ??= {};
        const previous = ctx.activeRules.firestore?.status === 'active'
          ? ctx.activeRules.firestore.source
          : ctx.activeRules.firestore?.lastKnownGood;
        ctx.activeRules.firestore = {
          source: okDeploy ? msg.source : ctx.activeRules.firestore?.source ?? msg.source,
          updatedAt: Date.now(),
          status: okDeploy ? 'active' : 'error',
          messages,
          ...(previous ? { lastKnownGood: previous } : {}),
        };
        ok(port, msg.id, { warnings: result.warnings, messages, ok: okDeploy });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'setDatabaseRules': {
      try {
        const db = ensureRtdb(ctx);
        const rules = normalizeDatabaseRules(msg.source);
        const previous = ctx.activeRules?.database?.status === 'active'
          ? ctx.activeRules.database.source
          : ctx.activeRules?.database?.lastKnownGood;
        rtdbSandbox.setRules(db, rules);
        ctx.activeRules ??= {};
        ctx.activeRules.database = {
          source: rules,
          updatedAt: Date.now(),
          status: 'active',
          messages: [],
          ...(previous ? { lastKnownGood: previous } : {}),
        };
        ok(port, msg.id, { ok: true, messages: [] });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'getActiveRules': {
      ok(port, msg.id, msg.service ? ctx.activeRules?.[msg.service] ?? null : ctx.activeRules ?? {});
      break;
    }

    case 'getRulesStatus': {
      ok(port, msg.id, msg.service ? ctx.activeRules?.[msg.service] ?? null : ctx.activeRules ?? {});
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
