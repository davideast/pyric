/**
 * Evaluates an observed Live-mode Cloud Storage call against a fetched
 * deployed Storage Security Rules snapshot (`#2363`), delegating request
 * construction and gap detection to `storageVerdict` so deployed and local
 * evaluations share the exact same canonical rules bindings.
 */
import { getFirestore } from 'pyric/firestore';
import type { ObservedCall } from 'pyric/sandbox';
import {
  createSandboxRoot,
  observedMethod,
  UNREAD_BUCKET,
  type LocalStorageEvaluation,
} from 'pyric/sandbox/internal';
import { getStorageSandbox, parseStorageRules } from 'pyric/storage';
import { deployStorageBucketRules } from 'pyric/storage/internal';
import type { HostCtx } from '../worker/host-context.js';
import type { Gap, Rule } from '../worker/host/observe-local-evaluation.js';
import { storageVerdict } from '../worker/host/observe-local-storage.js';
import type { DeployedStorageRulesSnapshot } from './deployed-rules.js';
import type {
  DeployedRulesEvaluationOutcome,
  DeployedRulesExplanation,
} from './deployed-rules-eval.js';

interface MutableStorageExplanation {
  source: 'deployed';
  service: 'storage';
  target: string;
  verdict: 'allow' | 'deny' | 'unevaluated';
  productionDisagrees: boolean;
  rule?: Rule;
  needs?: readonly Gap[];
  storage?: LocalStorageEvaluation;
  drift: DeployedStorageRulesSnapshot['drift'];
  releaseName: string;
  rulesetId: string;
  deployedHash: string;
}

/**
 * Evaluates a single observed Cloud Storage call against a deployed rules snapshot.
 */
export function evaluateCallAgainstDeployedStorage(
  call: ObservedCall,
  snapshot: DeployedStorageRulesSnapshot,
): DeployedRulesEvaluationOutcome {
  if (call.sdk === 'admin' || call.service !== 'storage') {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: 'Deployed Storage rules evaluation applies only to client Storage calls.',
    };
  }
  const method = observedMethod('storage', call.method);
  if (method === null || method === 'set') {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: `Storage method "${call.method}" cannot be evaluated against deployed rules.`,
    };
  }

  try {
    parseStorageRules(snapshot.source);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: 'local',
      reason: 'compile-error',
      message: `Could not parse deployed Storage rules: ${reason}`,
    };
  }

  let rawBucket = snapshot.bucket;
  if (call.bucket !== undefined && call.bucket !== UNREAD_BUCKET) {
    rawBucket = call.bucket;
  }

  const sandbox = createSandboxRoot();
  let evaluated: ReturnType<typeof storageVerdict>;
  try {
    getStorageSandbox(sandbox, { rules: snapshot.source });
    deployStorageBucketRules(sandbox, rawBucket, snapshot.source);
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'deployed-rules-storage-eval',
      subs: new Map(),
      appOptions: { storageBucket: rawBucket },
    };
    evaluated = storageVerdict(ctx, call, method);
  } finally {
    sandbox.dispose();
  }

  if (evaluated === undefined) {
    return {
      ok: false,
      source: 'local',
      reason: 'unsupported-call',
      message: `Storage method "${call.method}" cannot be evaluated against deployed rules.`,
    };
  }

  if (evaluated.result === 'unevaluated') {
    const explanation: MutableStorageExplanation = {
      source: 'deployed',
      service: 'storage',
      target: snapshot.bucket,
      verdict: 'unevaluated',
      productionDisagrees: false,
      needs: evaluated.needs,
      drift: snapshot.drift,
      releaseName: snapshot.releaseName,
      rulesetId: snapshot.rulesetId,
      deployedHash: snapshot.hash,
    };
    if (evaluated.rule !== undefined) explanation.rule = evaluated.rule;
    if (evaluated.storage !== undefined) explanation.storage = evaluated.storage;
    return { ok: true, explanation: explanation as DeployedRulesExplanation };
  }

  const explanation: MutableStorageExplanation = {
    source: 'deployed',
    service: 'storage',
    target: snapshot.bucket,
    verdict: evaluated.result,
    productionDisagrees: evaluated.drift === true,
    drift: snapshot.drift,
    releaseName: snapshot.releaseName,
    rulesetId: snapshot.rulesetId,
    deployedHash: snapshot.hash,
  };
  if (evaluated.rule !== undefined) explanation.rule = evaluated.rule;
  if (evaluated.storage !== undefined) explanation.storage = evaluated.storage;
  return { ok: true, explanation: explanation as DeployedRulesExplanation };
}
