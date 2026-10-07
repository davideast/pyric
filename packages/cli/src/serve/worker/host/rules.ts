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
import {
  lintFirestoreRules,
  rulesSourceRejection,
  type CompileLimitViolation,
} from 'pyric/rules/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import { sandbox as rtdbSandbox } from 'pyric/database';

import { parseRtdbRulesText } from '../../../rtdb/rules-json.js';
import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail } from '../host-context.js';
import { ensureRtdb } from './core.js';

export function normalizeDatabaseRules(source: unknown): { rules: Record<string, unknown> } | null {
  if (source === null) return null;
  if (typeof source === 'string') {
    return parseRtdbRulesText(source, (reason) => new Error(`RTDB rules did not parse: ${reason.message}.`));
  }
  if (typeof source === 'object' && source !== null) {
    return source as { rules: Record<string, unknown> };
  }
  throw new Error('RTDB rules must be a rules JSON object or JSON string.');
}

/** The lint findings of an installed ruleset, one message each. */
function firestoreRuleMessages(result: { warnings?: Array<{ severity?: string; message?: string }> }) {
  const messages: Array<{ severity: 'info' | 'warn' | 'error'; text: string; line?: number; column?: number }> = [];
  for (const warning of result.warnings ?? []) {
    messages.push({
      severity: warning.severity === 'error' ? 'error' : warning.severity === 'warning' ? 'warn' : 'info',
      text: String(warning.message ?? warning),
    });
  }
  return messages;
}

/** Production's compile rejections, one error message each, at the line and column production reports. */
function compileLimitMessages(violations: readonly CompileLimitViolation[]) {
  return violations.map((violation) => ({
    severity: 'error' as const,
    text: violation.message,
    ...(violation.line === undefined ? {} : { line: violation.line }),
    ...(violation.column === undefined ? {} : { column: violation.column }),
  }));
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
        // Production rejects a ruleset that does not parse, or is past its
        // compile limits, before it evaluates any request. The sandbox keeps
        // the active ruleset, and the status carries the reason every CLI
        // rules load path refuses with (the parse failure at its position,
        // or production's compile messages).
        const rejection = rulesSourceRejection(msg.source);
        const result = rejection !== null ? lintFirestoreRules(msg.source) : setRules(ctx.sandbox, msg.source);
        const messages = rejection === null
          ? firestoreRuleMessages(result)
          : rejection.kind === 'parse'
            ? [{ severity: 'error' as const, text: `Firestore ${rejection.message}`, line: rejection.line, column: rejection.column }]
            : compileLimitMessages(rejection.violations);
        const okDeploy = !messages.some((m) => m.severity === 'error');
        ctx.activeRules ??= {};
        const previous = ctx.activeRules.firestore?.status === 'active'
          ? ctx.activeRules.firestore.source
          : ctx.activeRules.firestore?.lastKnownGood;
        ctx.activeRules.firestore = {
          // The source the sandbox enforces: the new one when it was installed,
          // even with lint errors, and the active one when it was refused.
          source: rejection === null ? msg.source : ctx.activeRules.firestore?.source ?? msg.source,
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
        // Production refuses a ruleset its deploy would reject. The sandbox
        // keeps the active ruleset, and the status carries the reason.
        const rejection = rules === null ? null : rtdbRulesSourceRejection(rules);
        if (rejection !== null) {
          ctx.activeRules ??= {};
          const current = ctx.activeRules.database;
          const messages = [{ severity: 'error' as const, text: rejection.message }];
          ctx.activeRules.database = {
            source: current?.source ?? rules,
            updatedAt: Date.now(),
            status: 'error',
            messages,
            ...(previous ? { lastKnownGood: previous } : {}),
          };
          ok(port, msg.id, { ok: false, messages });
          break;
        }
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
