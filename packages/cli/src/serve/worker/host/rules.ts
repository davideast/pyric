/**
 * SharedWorker host — rules deploy + status ops.
 *
 * Firestore rules hot-reload (`setRules`/`setFirestoreRules`), RTDB rules
 * deploy (`setDatabaseRules`), and the active-rules / status reflection
 * (`getActiveRules`/`getRulesStatus`) that shared-runtime diagnostics + revert
 * read. Tracks the deployed Firestore source + last-known-good on
 * `ctx.activeRules`, and each RTDB instance's on its host instance entry.
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
import type { DatabaseInstanceRulesHost } from '../../database-instance-rules-host.js';
import { type ActiveRulesState, type HostCtx, type PortLike, ok, fail } from '../host-context.js';
import { rtdbInstance, rtdbInstanceKey, rtdbInstances } from './rtdb-instances.js';

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

/** The outcome of an RTDB rules deploy, as the `setDatabaseRules` op answers it. */
export interface DatabaseRulesDeployResult {
  ok: boolean;
  messages: ActiveRulesState['messages'];
}

/**
 * Deploy `source` as the rules of one RTDB instance, as production deploys a
 * ruleset to one database instance. Other instances keep their rules.
 *
 * `instance` is the instance name (the namespace of its URL, or the
 * `instance` of a `firebase.json` `database` entry); `undefined` is the
 * default instance, and so is `<projectId>-default-rtdb` once the host knows
 * the project id. `source` is a rules object, rules JSON text, or `null` to
 * remove the instance's rules. A ruleset production would refuse leaves the
 * instance's rules in force and answers `ok: false` with the reason.
 *
 * Throws for an invalid instance name, and for an instance the project's
 * declared instances leave out.
 */
export function setDatabaseRules(
  ctx: HostCtx,
  instance: string | undefined,
  source: unknown,
): DatabaseRulesDeployResult {
  const entry = rtdbInstance(ctx, instance);
  const rules = normalizeDatabaseRules(source);
  const previous = entry.rules?.status === 'active' ? entry.rules.source : entry.rules?.lastKnownGood;
  const lastKnownGood = previous === undefined ? {} : { lastKnownGood: previous };
  // Production refuses a ruleset its deploy would reject. The sandbox keeps
  // the active ruleset, and the status carries the reason.
  const rejection = rules === null ? null : rtdbRulesSourceRejection(rules);
  if (rejection !== null) {
    const messages = [{ severity: 'error' as const, text: rejection.message }];
    entry.rules = { source: entry.rules?.source ?? rules, updatedAt: Date.now(), status: 'error', messages, ...lastKnownGood };
    return { ok: false, messages };
  }
  rtdbSandbox.setRules(entry.live, rules);
  entry.rules = { source: rules, updatedAt: Date.now(), status: 'active', messages: [], ...lastKnownGood };
  return { ok: true, messages: [] };
}

/**
 * The host's per-instance rules operations, as `connectDatabaseInstanceRules`
 * applies a project's `firebase.json` instances: declaring instances limits
 * the host to them and the default instance, and a ruleset production would
 * refuse throws, leaving that instance's rules in force.
 */
export function databaseInstanceRulesHost(ctx: HostCtx): DatabaseInstanceRulesHost {
  return {
    // A `firebase.json` `database` object deploys only the default instance's
    // rules and declares no other instance, so other instances stay on demand.
    // A declaration that names another instance limits the host to the
    // declared instances.
    declareInstances(names) {
      const defaultName = ctx.defaultRtdbInstance;
      const namesOtherInstance = [...names].some((name) => name !== defaultName);
      if (namesOtherInstance) ctx.declaredRtdbInstances = names;
      else delete ctx.declaredRtdbInstances;
    },
    setDatabaseRules(instance, rules) {
      const result = setDatabaseRules(ctx, instance, rules);
      if (!result.ok) throw new Error(result.messages.map((message) => message.text).join('; '));
    },
  };
}

/**
 * The active rules the `getActiveRules` and `getRulesStatus` ops report:
 * one service's state, or both services' with the default RTDB instance's
 * state under `database`. `instance` selects the RTDB instance.
 */
function activeRulesView(
  ctx: HostCtx,
  service: 'firestore' | 'database' | undefined,
  instance: string | undefined,
): unknown {
  if (service === 'firestore') return ctx.activeRules?.firestore ?? null;
  const databaseRules = rtdbInstances(ctx).get(rtdbInstanceKey(ctx, instance))?.rules;
  if (service === 'database') return databaseRules ?? null;
  return {
    ...(ctx.activeRules?.firestore ? { firestore: ctx.activeRules.firestore } : {}),
    ...(databaseRules ? { database: databaseRules } : {}),
  };
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
        ok(port, msg.id, setDatabaseRules(ctx, msg.instance, msg.source));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'getActiveRules':
    case 'getRulesStatus': {
      try {
        ok(port, msg.id, activeRulesView(ctx, msg.service, msg.instance));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }


    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
