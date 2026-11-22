/**
 * Install a served project's named-database Firestore rules into a sandbox
 * consistently across every served plane: SharedWorker, Node host, and the
 * in-page runtime (#1319, ADR-0021 Decisions 3 & 6).
 *
 * Mirrors `storage-rules-install.ts`:
 * - Declares each configured named database (locked when no rules file is
 *   deployed, or open when `permissive` is true, logging once per database).
 * - Deploys each configured named database's prepared rules.
 * - Registers unresolved `.firebaserc` deploy targets and resolves them once
 *   the page/worker app config names `projectId`.
 * - Applies hot-reload updates per database or pending deploy target.
 */
import type { LocalSandbox, Sandbox } from 'pyric/sandbox';
import {
  DEFAULT_FIRESTORE_DATABASE,
  declareFirestoreDatabase,
  isValidFirestoreDatabaseId,
  setRules,
} from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';
import type { HostCtx } from './worker/host.js';
import { deployFirestoreRulesToHost } from './worker/host/rules.js';
import { restoreFirestoreSubscriptions } from './worker/host/subscriptions.js';
import type {
  InitPayload,
  PendingFirestoreTargetRules,
  RulesDestination,
} from './init-payload.js';

type FirestoreDefaultPolicy = 'allow' | 'deny';

export interface FirestoreRulesUpdate {
  rules: string | null;
  rulesHash?: string | null;
  policy?: FirestoreDefaultPolicy;
  database?: string;
  target?: string;
}

export type FirestoreDeployHook = (databaseId: string, rules: string) => void;

interface PendingTargetEntry {
  entry: PendingFirestoreTargetRules;
  databases: string[] | null;
}

interface SandboxFirestoreServedState {
  policy: FirestoreDefaultPolicy;
  undeployedLogged: Set<string>;
  deployHook?: FirestoreDeployHook;
}

const stateBySandbox = new WeakMap<Sandbox, SandboxFirestoreServedState>();
const pendingTargetsBySandbox = new WeakMap<Sandbox, Map<string, PendingTargetEntry>>();
const appProjectBySandbox = new WeakMap<Sandbox, string>();

function undeployedDatabaseAccess(policy: FirestoreDefaultPolicy): string {
  if (policy === 'allow') {
    return 'are open (permissive mode)';
  }
  return 'are locked';
}

function getOrCreateState(
  sandbox: Sandbox,
  policy: FirestoreDefaultPolicy,
  deployHook?: FirestoreDeployHook,
): SandboxFirestoreServedState {
  const existing = stateBySandbox.get(sandbox);
  if (existing !== undefined) {
    existing.policy = policy;
    if (deployHook !== undefined) {
      existing.deployHook = deployHook;
    }
    return existing;
  }
  const created: SandboxFirestoreServedState = {
    policy,
    undeployedLogged: new Set(),
  };
  if (deployHook !== undefined) {
    created.deployHook = deployHook;
  }
  stateBySandbox.set(sandbox, created);
  return created;
}

function deployDatabaseRules(
  sandbox: Sandbox,
  state: SandboxFirestoreServedState,
  databaseId: string,
  rules: string | null,
  notices: string[],
): void {
  const isDefault = databaseId === DEFAULT_FIRESTORE_DATABASE;
  if (!isDefault) {
    declareFirestoreDatabase(sandbox, databaseId, { locked: state.policy !== 'allow' });
  }
  if (rules === null) {
    if (!isDefault && !state.undeployedLogged.has(databaseId)) {
      state.undeployedLogged.add(databaseId);
      notices.push(
        `Firestore database "${databaseId}" is declared in firebase.json with no rules file; client reads and writes on "${databaseId}" ${undeployedDatabaseAccess(state.policy)}.`,
      );
    }
    return;
  }
  const rejection = rulesSourceRejection(rules);
  if (rejection !== null) {
    throw new Error(`Firestore ${rejection.message}`);
  }
  if (state.deployHook !== undefined) {
    state.deployHook(databaseId, rules);
    return;
  }
  if (isDefault) {
    setRules(sandbox as LocalSandbox, rules);
  } else {
    setRules(sandbox as LocalSandbox, rules, databaseId);
  }
}

export function installServedFirestoreRules(
  sandbox: Sandbox,
  payload: Pick<InitPayload, 'firestoreDatabases' | 'firestorePendingTargets' | 'permissive'>,
  deployHook?: FirestoreDeployHook,
): string[] {
  let policy: FirestoreDefaultPolicy = 'deny';
  if (payload.permissive === true) {
    policy = 'allow';
  }
  const state = getOrCreateState(sandbox, policy, deployHook);
  const notices: string[] = [];
  const named = payload.firestoreDatabases;
  if (named !== undefined && named !== null) {
    for (const dbId of named.declared) {
      if (!isValidFirestoreDatabaseId(dbId) || dbId === DEFAULT_FIRESTORE_DATABASE) {
        continue;
      }
      const deployed = named.rules[dbId] ?? null;
      let rulesText: string | null = null;
      if (deployed !== null) {
        rulesText = deployed.rules;
      }
      deployDatabaseRules(sandbox, state, dbId, rulesText, notices);
    }
  }

  const pending = payload.firestorePendingTargets ?? [];
  if (pending.length === 0) {
    return notices;
  }
  const pendingMap = new Map<string, PendingTargetEntry>();
  for (const entry of pending) {
    pendingMap.set(entry.target, { entry: { ...entry }, databases: null });
  }
  pendingTargetsBySandbox.set(sandbox, pendingMap);
  const resolvedNotices = resolvePendingFirestoreTargets(sandbox, appProjectBySandbox.get(sandbox));
  notices.push(...resolvedNotices);
  return notices;
}

export function hasPendingFirestoreTargets(sandbox: Sandbox): boolean {
  const pending = pendingTargetsBySandbox.get(sandbox);
  if (pending === undefined) {
    return false;
  }
  for (const target of pending.values()) {
    if (target.databases === null) {
      return true;
    }
  }
  return false;
}

export function resolvePendingFirestoreTargets(
  sandbox: Sandbox,
  projectId: string | undefined,
): string[] {
  if (typeof projectId !== 'string' || projectId === '') {
    return [];
  }
  if (!appProjectBySandbox.has(sandbox)) {
    appProjectBySandbox.set(sandbox, projectId);
  }
  const pending = pendingTargetsBySandbox.get(sandbox);
  if (pending === undefined) {
    return [];
  }
  for (const target of pending.values()) {
    if (target.databases !== null) {
      return [];
    }
  }
  const state = stateBySandbox.get(sandbox) ?? getOrCreateState(sandbox, 'deny');
  const notices: string[] = [];
  for (const target of pending.values()) {
    const name = target.entry.target;
    const mapped = target.entry.databasesByProject[projectId] ?? [];
    target.databases = mapped;
    if (mapped.length === 0) {
      notices.push(
        `Firestore deploy target "${name}" has no .firebaserc mapping for the app config project "${projectId}"; its databases stay undeclared.`,
      );
      continue;
    }
    try {
      for (const dbId of mapped) {
        deployDatabaseRules(sandbox, state, dbId, target.entry.rules, notices);
      }
      notices.push(
        `Firestore deploy target "${name}" resolved with the app config project "${projectId}": its configuration now applies to ${mapped.join(', ')}.`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notices.push(
        `Firestore deploy target "${name}" rules not loaded: ${reason}`,
      );
    }
  }
  return notices;
}

function firestoreRulesUpdateFor(
  rules: string | null,
  destination: RulesDestination | undefined,
): FirestoreRulesUpdate {
  if (destination === undefined) {
    return { rules };
  }
  if (typeof destination === 'string') {
    return { rules, database: destination };
  }
  if ('target' in destination) {
    return { rules, target: destination.target };
  }
  throw new Error('A Firestore ruleset deploys to a database or deploy target, not a Storage bucket.');
}

export function applyFirestoreRulesUpdate(
  sandbox: Sandbox,
  update: FirestoreRulesUpdate,
  deployHook?: FirestoreDeployHook,
): void {
  let policy: FirestoreDefaultPolicy = 'deny';
  if (update.policy === 'allow') {
    policy = 'allow';
  }
  const state = getOrCreateState(sandbox, stateBySandbox.get(sandbox)?.policy ?? policy, deployHook);
  const ignoredNotices: string[] = [];
  if (update.target !== undefined) {
    const pending = pendingTargetsBySandbox.get(sandbox)?.get(update.target);
    if (pending === undefined) {
      return;
    }
    if (update.rules !== null) {
      const rejection = rulesSourceRejection(update.rules);
      if (rejection !== null) {
        throw new Error(`Firestore ${rejection.message}`);
      }
    }
    for (const dbId of pending.databases ?? []) {
      deployDatabaseRules(sandbox, state, dbId, update.rules, ignoredNotices);
    }
    pending.entry.rules = update.rules;
    return;
  }
  const databaseId = update.database ?? DEFAULT_FIRESTORE_DATABASE;
  if (update.rules === null) {
    return;
  }
  deployDatabaseRules(sandbox, state, databaseId, update.rules, ignoredNotices);
}

export function firestoreRulesUpdateNotice(update: FirestoreRulesUpdate): string {
  let subject = 'firestore.rules';
  if (update.target !== undefined) {
    subject = `firestore rules for deploy target "${update.target}"`;
  } else if (update.database !== undefined && update.database !== DEFAULT_FIRESTORE_DATABASE) {
    subject = `firestore rules for database "${update.database}"`;
  }
  if (update.rules === null) {
    return `${subject} removed`;
  }
  return `${subject} hot-reloaded`;
}

export function deployHostedFirestoreDestination(
  ctx: HostCtx,
  source: string,
  destination: RulesDestination,
): void {
  applyFirestoreRulesUpdate(ctx.sandbox, firestoreRulesUpdateFor(source, destination), (dbId, rules) => {
    const deployedNamed = deployFirestoreRulesToHost(ctx, rules, dbId);
    if (!deployedNamed.ok) {
      const errs = deployedNamed.messages.filter((m) => m.severity === 'error').map((m) => m.text).filter(Boolean);
      let message = 'Invalid Firestore security rules.';
      if (typeof deployedNamed.rejectionMessage === 'string') {
        message = deployedNamed.rejectionMessage;
      } else if (errs.length > 0) {
        message = errs.join('; ');
      }
      throw new Error(message);
    }
  });
  restoreFirestoreSubscriptions(ctx);
}
