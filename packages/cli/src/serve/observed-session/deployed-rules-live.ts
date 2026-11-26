/**
 * Host-side opt-in wiring helpers for deployed Security Rules evaluation in
 * Live mode (`#2363`):
 * - `AsyncLocalStorage<boolean>` opt-in scope for `pyricLive({ deployedRules: true })`
 * - `WeakMap` session registry linking `LiveHostState.sessionData` to `createHostedRuntime`
 * - Bounded local rules file reader (`statSync`, regular file, `<= 1 MiB`)
 * - Compact, credential-free event summary and terminal line formatters
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ObservedCall } from 'pyric/sandbox';
import { productionVerdict, readObservedCall, UNREAD_BUCKET } from 'pyric/sandbox/internal';
import { isPathInside } from '../path-inside.js';
import {
  explainLiveCallWithDeployedRules,
  type DeployedRulesEvaluationOutcome,
  type ExplainLiveCallWithDeployedRulesInput,
} from './deployed-rules-eval.js';

type LocalRulesTextMap = NonNullable<ExplainLiveCallWithDeployedRulesInput['localRules']>;
import type { DeployedRulesStore } from './deployed-rules-store.js';
import type {
  DeployedRulesEventDetail,
  DeployedRulesEventDrift,
  DeployedRulesEventRule,
} from './deployed-rules-wire.js';
import type { ObservedSessionDataStore } from './store.js';

const MAX_LOCAL_RULES_FILE_BYTES = 1024 * 1024;
const RULES_SERVICES: ReadonlySet<string> = new Set(['firestore', 'rtdb', 'storage']);

const deployedRulesOptInStorage = new AsyncLocalStorage<boolean>();
const deployedEventDetailStorage = new AsyncLocalStorage<{ detail: DeployedRulesEventDetail | undefined }>();
const sessionContextRegistry = new WeakMap<ObservedSessionDataStore, DeployedRulesLiveContext>();

export interface LiveRulesFilePaths {
  readonly firestore: readonly string[];
  readonly rtdb: readonly string[];
  readonly storage: readonly string[];
}

export interface DeployedRulesLiveContext {
  readonly store: DeployedRulesStore;
  readLocalRules(): LocalRulesTextMap;
}

/**
 * Runs `fn` inside an async context where live host state creation inherits
 * the explicit `deployedRules` opt-in (`pyricLive({ deployedRules: true })`).
 */
export function withDeployedRulesOptIn<T>(enabled: boolean, fn: () => T): T {
  return deployedRulesOptInStorage.run(enabled === true, fn);
}

/** Whether the current async call tree explicitly opted into deployed rules reading. */
export function isDeployedRulesOptInActive(): boolean {
  return deployedRulesOptInStorage.getStore() === true;
}

/** Runs `fn` with a single-use deployed-rules detail scoped to the current async context. */
export function runWithDeployedRulesEventDetail<T>(detail: DeployedRulesEventDetail, fn: () => T): T {
  return deployedEventDetailStorage.run({ detail }, fn);
}

/** Consumes the scoped deployed-rules detail once for the emitted operation event. */
export function takeDeployedRulesEventDetail(): DeployedRulesEventDetail | undefined {
  const slot = deployedEventDetailStorage.getStore();
  if (slot === undefined || slot.detail === undefined) return undefined;
  const current = slot.detail;
  slot.detail = undefined;
  return current;
}

/** Associates an opted-in deployed-rules context with a live host's session store. */
export function registerDeployedRulesLiveContext(
  sessionData: ObservedSessionDataStore,
  context: DeployedRulesLiveContext,
): void {
  sessionContextRegistry.set(sessionData, context);
}

/** Reads the opted-in deployed-rules context for `sessionData`, or `undefined` when off. */
export function getDeployedRulesLiveContext(
  sessionData: ObservedSessionDataStore | undefined,
): DeployedRulesLiveContext | undefined {
  if (sessionData === undefined) return undefined;
  return sessionContextRegistry.get(sessionData);
}

/** Whether `call` is a client Firebase call denied by production Security Rules. */
export function isRulesDenialCall(call: ObservedCall): boolean {
  const isClientRulesCall = call.sdk === undefined && RULES_SERVICES.has(call.service);
  return isClientRulesCall && productionVerdict(call.outcome) === 'denied';
}

function readBoundedLocalRulesFile(projectDir: string, relativePath: string | undefined): string | undefined {
  if (relativePath === undefined || relativePath.trim() === '') return undefined;
  const resolvedRoot = path.resolve(projectDir);
  const resolvedFile = path.resolve(resolvedRoot, relativePath);
  if (!isPathInside(resolvedRoot, resolvedFile)) return undefined;
  try {
    const realRoot = realpathSync(resolvedRoot);
    const realFile = realpathSync(resolvedFile);
    if (!isPathInside(realRoot, realFile)) return undefined;
    const info = statSync(realFile);
    if (!info.isFile() || info.size > MAX_LOCAL_RULES_FILE_BYTES) return undefined;
    return readFileSync(realFile, 'utf8');
  } catch (_error: unknown) {
    return undefined;
  }
}

/**
 * Reads the primary local rules text per service from `projectDir` with strict
 * root containment and a 1 MiB regular-file bound. Never throws.
 */
export function readLocalRulesTexts(
  files: LiveRulesFilePaths,
  projectDir: string | undefined,
): LocalRulesTextMap {
  if (projectDir === undefined || projectDir === '') return {};
  const firestore = readBoundedLocalRulesFile(projectDir, files.firestore[0]);
  const rtdb = readBoundedLocalRulesFile(projectDir, files.rtdb[0]);
  const storage = readBoundedLocalRulesFile(projectDir, files.storage[0]);
  const result: { firestore?: string; rtdb?: string; storage?: string } = {};
  if (firestore !== undefined) result.firestore = firestore;
  if (rtdb !== undefined) result.rtdb = rtdb;
  if (storage !== undefined) result.storage = storage;
  return result;
}

/**
 * Fills `call.document` for a Cloud Storage call from observed session metadata
 * when the call itself did not carry stored object metadata.
 */
function withObservedStorageMetadata(
  call: ObservedCall,
  sessionData: ObservedSessionDataStore | undefined,
): ObservedCall {
  if (call.service !== 'storage' || call.document !== undefined || call.path === undefined || sessionData === undefined) {
    return call;
  }
  const snapshot = sessionData.snapshot();
  const storage = snapshot.storage;
  if (storage === undefined) return call;
  let bucket = call.bucket;
  if (bucket === undefined || bucket === UNREAD_BUCKET) {
    bucket = snapshot.defaultStorageBucket ?? undefined;
  }
  if (bucket === undefined) return call;
  const bucketEntry = Object.hasOwn(storage, bucket) ? storage[bucket] : undefined;
  if (bucketEntry === undefined) return call;
  const normalizedPath = call.path.startsWith('/') ? call.path.slice(1) : call.path;
  let stored = undefined;
  if (Object.hasOwn(bucketEntry.objects, normalizedPath)) {
    stored = bucketEntry.objects[normalizedPath];
  }
  if (stored === undefined) return call;
  const doc: Record<string, unknown> = {
    bucket: stored.bucket,
    fullPath: stored.fullPath,
    name: stored.name,
  };
  if (stored.size !== undefined) doc.size = stored.size;
  if (stored.contentType !== undefined) doc.contentType = stored.contentType;
  if (stored.cacheControl !== undefined) doc.cacheControl = stored.cacheControl;
  if (stored.contentDisposition !== undefined) doc.contentDisposition = stored.contentDisposition;
  if (stored.contentEncoding !== undefined) doc.contentEncoding = stored.contentEncoding;
  if (stored.contentLanguage !== undefined) doc.contentLanguage = stored.contentLanguage;
  if (stored.md5Hash !== undefined) doc.md5Hash = stored.md5Hash;
  if (stored.generation !== undefined) doc.generation = stored.generation;
  if (stored.metageneration !== undefined) doc.metageneration = stored.metageneration;
  if (stored.timeCreated !== undefined) doc.timeCreated = stored.timeCreated;
  if (stored.updated !== undefined) doc.updated = stored.updated;
  if (stored.customMetadata !== undefined) doc.customMetadata = { ...stored.customMetadata };
  return { ...call, document: doc };
}

/** Evaluates a denied client call against the opted-in deployed rules context. */
export async function evaluateDeniedCallWithLiveContext(
  call: ObservedCall,
  context: DeployedRulesLiveContext,
  sessionData: ObservedSessionDataStore | undefined,
): Promise<DeployedRulesEvaluationOutcome | undefined> {
  if (!context.store.enabled || !isRulesDenialCall(call)) return undefined;
  const enrichedCall = withObservedStorageMetadata(call, sessionData);
  try {
    return await explainLiveCallWithDeployedRules({
      call: enrichedCall,
      store: context.store,
      localRules: context.readLocalRules(),
      sessionData,
    });
  } catch (_error: unknown) {
    return {
      ok: false,
      source: 'local',
      reason: 'network-error',
      message: 'Deployed rules evaluation failed unexpectedly.',
    };
  }
}

/** Converts a `DeployedRulesEvaluationOutcome` into a compact, credential-free event summary. */
function toDeployedRulesEventDetail(
  outcome: DeployedRulesEvaluationOutcome,
): DeployedRulesEventDetail {
  if (!outcome.ok) {
    return {
      source: 'local',
      fallbackReason: outcome.reason,
      fallbackMessage: outcome.message,
    };
  }
  const exp = outcome.explanation;
  const drift: {
    status: DeployedRulesEventDrift['status'];
    drifted: boolean;
    firstDiffLine?: number;
    rtdbChangeCount?: number;
    summary: string;
  } = {
    status: exp.drift.status,
    drifted: exp.drift.drifted,
    summary: exp.drift.summary,
  };
  if (exp.drift.firstDiffLine !== undefined) drift.firstDiffLine = exp.drift.firstDiffLine;
  if (exp.drift.rtdbChanges !== undefined) drift.rtdbChangeCount = exp.drift.rtdbChanges.length;

  let rule: DeployedRulesEventRule | undefined;
  if (exp.rule !== undefined) {
    const built: { path?: string; line?: number; expression?: string } = {};
    if (exp.rule.path !== undefined) built.path = exp.rule.path;
    if (exp.rule.line !== undefined) built.line = exp.rule.line;
    if (exp.rule.expression !== undefined) built.expression = exp.rule.expression;
    if (built.path !== undefined || built.line !== undefined || built.expression !== undefined) {
      rule = built;
    }
  }

  const out: {
    source: 'deployed';
    service: 'firestore' | 'rtdb' | 'storage';
    target: string;
    verdict: 'allow' | 'deny' | 'unevaluated';
    productionDisagrees: boolean;
    rule?: DeployedRulesEventRule;
    needs?: readonly string[];
    drift: DeployedRulesEventDrift;
    releaseName?: string;
    rulesetId?: string;
    deployedHash: string;
  } = {
    source: 'deployed',
    service: exp.service,
    target: exp.target,
    verdict: exp.verdict,
    productionDisagrees: exp.productionDisagrees,
    drift,
    deployedHash: exp.deployedHash,
  };
  if (rule !== undefined) out.rule = rule;
  if (exp.needs !== undefined && exp.needs.length > 0) out.needs = [...exp.needs];
  if (exp.releaseName !== undefined) out.releaseName = exp.releaseName;
  if (exp.rulesetId !== undefined) out.rulesetId = exp.rulesetId;
  return out;
}

/**
 * Evaluates a raw inbound `observe` frame payload when opted in and denied by
 * production rules, returning the credential-free `event.detail.deployedRules`.
 */
export async function evaluateDeployedRulesDetailForObserve(
  rawCall: unknown,
  context: DeployedRulesLiveContext | undefined,
  sessionData: ObservedSessionDataStore | undefined,
): Promise<DeployedRulesEventDetail | undefined> {
  if (context === undefined || !context.store.enabled) return undefined;
  let call: ObservedCall;
  try {
    call = readObservedCall(rawCall);
  } catch (_error: unknown) {
    return undefined;
  }
  const outcome = await evaluateDeniedCallWithLiveContext(call, context, sessionData);
  if (outcome === undefined) return undefined;
  return toDeployedRulesEventDetail(outcome);
}

/** Formats sanitized terminal detail lines for an opted-in deployed rules outcome. */
export function formatDeployedRulesTerminalLines(
  outcome: DeployedRulesEvaluationOutcome,
  localFiles: readonly string[],
  sanitize: (value: string) => string,
): string[] {
  if (!outcome.ok) {
    const lines = [
      `      rules source: local fallback (${sanitize(outcome.reason)}: ${sanitize(outcome.message)})`,
    ];
    if (localFiles.length > 0) {
      lines.push(`      production decided this with its deployed rules, not your local ${localFiles.join(', ')}`);
    }
    return lines;
  }
  const exp = outcome.explanation;
  let targetLabel = sanitize(exp.target);
  if (exp.rulesetId !== undefined) {
    targetLabel = `${targetLabel}, ruleset ${sanitize(exp.rulesetId)}`;
  }
  const lines = [`      rules source: deployed (${targetLabel})`];
  if (exp.verdict === 'unevaluated') {
    const needs = exp.needs === undefined || exp.needs.length === 0 ? 'more context' : exp.needs.map(sanitize).join(', ');
    lines.push(`      deployed rules: unevaluated (needs ${needs})`);
  } else if (exp.rule !== undefined) {
    const parts: string[] = [];
    if (exp.rule.line !== undefined) parts.push(`line ${exp.rule.line}`);
    if (exp.rule.path !== undefined) parts.push(sanitize(exp.rule.path));
    if (exp.rule.expression !== undefined) parts.push(sanitize(exp.rule.expression));
    if (parts.length > 0) {
      lines.push(`      deployed rule: ${parts.join(' ')}`);
    }
  }
  if (exp.productionDisagrees) {
    lines.push(`      note: deployed rules evaluation (${exp.verdict}) disagrees with production denial`);
  }
  if (exp.drift.drifted) {
    const localSuffix = localFiles.length > 0 ? `local ${localFiles.join(', ')}: ` : '';
    lines.push(`      drift: ${localSuffix}${sanitize(exp.drift.summary)}`);
  } else if (exp.drift.status === 'match' && localFiles.length > 0) {
    lines.push(`      drift: deployed rules match local ${localFiles.join(', ')}`);
  } else if (exp.drift.status === 'no-local-rules') {
    lines.push('      drift: no local rules file loaded for comparison');
  }
  return lines;
}
