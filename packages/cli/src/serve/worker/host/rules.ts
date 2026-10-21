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
import type { SandboxRuleSources } from 'pyric/sandbox';
import { LOCKED_DATABASE_RULES, withDatabaseRulesPreservedOnReset } from 'pyric/sandbox/internal';
import { setRules } from 'pyric/sandbox/firestore';
import {
  lintFirestoreRules,
  parseToASTOrError,
  rulesSourceRejection,
  type CompileLimitViolation,
} from 'pyric/rules/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import { sandbox as rtdbSandbox } from 'pyric/database';

import { parseRtdbRulesText } from '../../../rtdb/rules-json.js';
import type { OpMessage } from '../protocol.js';
import type { DatabaseInstanceRulesHost, DatabaseTargetDeploy } from '../../database-instance-rules-host.js';
import { type ActiveRulesState, type HostCtx, type PortLike, ok, fail, bestEffortFlush } from '../host-context.js';
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
 * Resolve the project's unresolved deploy targets with the first app port's
 * project id, and set their rules on the instances `.firebaserc` maps them
 * to. Does nothing before an app port names its project, and after the first
 * resolution.
 */
export function resolvePendingDatabaseTargets(ctx: HostCtx): void {
  const projectId = ctx.appOptions?.projectId;
  const pending = ctx.pendingDatabaseTargets;
  if (pending === undefined || typeof projectId !== 'string' || projectId.length === 0) return;
  const { deploys, notices } = pending.resolve(projectId);
  for (const notice of notices) console.info(`[pyric] ${notice}`);
  applyTargetDeploys(ctx, deploys);
}

/**
 * Replace an unresolved deploy target's rules after its rules file changed.
 * Once the target resolved, its instances take the rules; before that, they
 * are kept for resolution. Null rules return the instances to the default policy.
 */
export function setDatabaseTargetRules(ctx: HostCtx, target: string, source: unknown): DatabaseRulesDeployResult {
  const rules = normalizeDatabaseRules(source);
  const rejection = rules === null ? null : rtdbRulesSourceRejection(rules);
  if (rejection !== null) return { ok: false, messages: [{ severity: 'error', text: rejection.message }] };
  return applyTargetDeploys(ctx, ctx.pendingDatabaseTargets?.update(target, rules) ?? []);
}

function applyTargetDeploys(ctx: HostCtx, deploys: readonly DatabaseTargetDeploy[]): DatabaseRulesDeployResult {
  const messages: DatabaseRulesDeployResult['messages'] = [];
  for (const deploy of deploys) {
    const { instance, rules } = deploy;
    ctx.onDatabaseTargetDeploy?.(deploy);
    const result = setDatabaseRules(ctx, instance, rules);
    for (const message of result.messages) messages.push({ ...message, text: `database instance "${instance}": ${message.text}` });
  }
  for (const message of messages) console.error(`[pyric] ${message.text}`);
  return { ok: messages.length === 0, messages };
}

/**
 * The host's per-instance rules operations, as `connectDatabaseInstanceRules`
 * applies a project's `firebase.json` instances. Declaring instances creates
 * their stores so they are listed before first use; an instance no rules are
 * deployed to is still served, locked or, in permissive mode, open. A ruleset
 * production would refuse throws, leaving that instance's rules in force.
 */
export function databaseInstanceRulesHost(ctx: HostCtx): DatabaseInstanceRulesHost {
  return {
    declareInstances(names) {
      for (const name of names) rtdbInstance(ctx, name);
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
export function firestoreRuleMessages(result: { warnings?: Array<{ severity?: string; message?: string }> }) {
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

/** Deploy Firestore rules to the sandbox and update `ctx.activeRules.firestore`, refusing non-`cloud.firestore` services. */
export function deployFirestoreRulesToHost(ctx: HostCtx, source: string): {
  ok: boolean;
  warnings: ReturnType<typeof lintFirestoreRules>['warnings'];
  messages: ActiveRulesState['messages'];
  rejectionMessage: string | null;
} {
  const rejection = rulesSourceRejection(source);
  const parsed = rejection === null ? parseToASTOrError(source) : null;
  const wrongService = parsed !== null && parsed.ok && parsed.ast.service && parsed.ast.service.name !== 'cloud.firestore'
    ? parsed.ast.service
    : null;
  const refused = rejection !== null || wrongService !== null;
  const result = refused ? lintFirestoreRules(source) : setRules(ctx.sandbox, source);
  const wrongServiceText = wrongService !== null
    ? `Expected 'service cloud.firestore', got 'service ${wrongService.name}'.`
    : null;
  const messages = wrongService !== null
    ? [{
        severity: 'error' as const,
        text: wrongServiceText!,
        ...(wrongService.loc ? { line: wrongService.loc.line } : {}),
      }]
    : rejection === null
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
    source: !refused ? source : ctx.activeRules.firestore?.source ?? source,
    updatedAt: Date.now(),
    status: okDeploy ? 'active' : 'error',
    messages,
    ...(previous ? { lastKnownGood: previous } : {}),
  };
  const rejectionMessage = wrongServiceText !== null
    ? `Firestore rules did not compile: ${wrongServiceText}`
    : rejection !== null
      ? `Firestore ${rejection.message}`
      : null;
  return { ok: okDeploy, warnings: result.warnings, messages, rejectionMessage };
}

/** Synchronize `ctx.activeRules` and RTDB instance rules after a full-state checkpoint restore. */
export function syncHostRulesAfterCheckpointRestore(ctx: HostCtx, rules: SandboxRuleSources): void {
  if (rules.firestore.length > 0) {
    ctx.activeRules ??= {};
    ctx.activeRules.firestore = {
      source: rules.firestore,
      lastKnownGood: rules.firestore,
      updatedAt: Date.now(),
      status: 'active',
      messages: firestoreRuleMessages(lintFirestoreRules(rules.firestore)),
    };
  } else if (ctx.activeRules) {
    delete ctx.activeRules.firestore;
  }

  const defaultRtdb = rtdbInstance(ctx);
  if (rules.database !== null) {
    defaultRtdb.rules = {
      source: structuredClone(rules.database),
      lastKnownGood: structuredClone(rules.database),
      updatedAt: Date.now(),
      status: 'active',
      messages: [],
    };
  } else {
    delete defaultRtdb.rules;
  }

  for (const [, instance] of ctx.rtdbInstances?.entries() ?? []) {
    if (instance.selector === undefined) continue;
    const databaseRules = instance.rules;
    const databaseSource = databaseRules?.source;
    if (databaseSource !== undefined) {
      rtdbSandbox.setRules(instance.live, normalizeDatabaseRules(databaseSource));
    } else {
      const policy = ctx.rtdbDefaultPolicy ?? 'deny';
      rtdbSandbox.setDefaultPolicy(instance.live, policy);
      rtdbSandbox.setRules(instance.live, policy === 'allow' ? null : LOCKED_DATABASE_RULES);
    }
  }
}

/** Re-apply active host Firestore and RTDB rules onto `ctx.sandbox` after a legacy data-only snapshot import or a sandbox reset. */
export function reapplyActiveHostRulesAfterReset(ctx: HostCtx): void {
  const firestoreRules = ctx.activeRules?.firestore;
  const source = firestoreRules?.source;
  if (typeof source === 'string') setRules(ctx.sandbox, source);
  for (const [, instance] of ctx.rtdbInstances?.entries() ?? []) {
    const databaseRules = instance.rules;
    const databaseSource = databaseRules?.source;
    if (databaseSource !== undefined) {
      rtdbSandbox.setRules(instance.live, normalizeDatabaseRules(databaseSource));
    } else if (instance.selector !== undefined) {
      const policy = ctx.rtdbDefaultPolicy ?? 'deny';
      rtdbSandbox.setDefaultPolicy(instance.live, policy);
      rtdbSandbox.setRules(instance.live, policy === 'allow' ? null : LOCKED_DATABASE_RULES);
    }
  }
}

/** Helper to preserve rules while fully resetting the sandbox. */
export async function resetHostSandbox<T>(ctx: HostCtx, scope: string, doReset: () => Promise<T>): Promise<T> {
  const result = await withDatabaseRulesPreservedOnReset(ctx.sandbox, doReset);
  if (scope === 'all') {
    reapplyActiveHostRulesAfterReset(ctx);
  } else if (scope === 'firestore') {
    const firestoreRules = ctx.activeRules?.firestore;
    const source = firestoreRules?.source;
    if (typeof source === 'string') setRules(ctx.sandbox, source);
  }
  return result;
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

export async function handleRulesOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
  db: Firestore,
): Promise<void> {
  void db;
  switch (msg.method) {
    case 'setRules':
    case 'setFirestoreRules': {
      try {
        const deployed = deployFirestoreRulesToHost(ctx, msg.source);
        ok(port, msg.id, { warnings: deployed.warnings, messages: deployed.messages, ok: deployed.ok });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'setDatabaseRules': {
      try {
        const result = setDatabaseRules(ctx, msg.instance, msg.source);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
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
