// Isomorphic Web-standard host boundary middleware (`createPolicyGuard`).
// Uses WinterCG Web APIs only (Request, Response, URL, TextEncoder, Uint8Array, crypto.subtle)
// with zero Node-only imports, supporting Fetch / Next.js Route Handlers, Cloud Functions HTTP
// handlers, and client-side optimistic checks.
import type { StandaloneModuleResult } from './bounded-module.js';
import { FirestoreSet } from '../simulator/firestore-set.js';
import { isRulesMap } from '../simulator/rules-type.js';
import { Bytes } from '../simulator/wrappers/bytes.js';
import { Duration } from '../simulator/wrappers/duration.js';
import { RulesFloat } from '../simulator/wrappers/float.js';
import { Timestamp } from '../simulator/wrappers/timestamp.js';
import { toDiagnosticJsonValue, type PolicyFailureTrace } from './diagnostics.js';
import type { FirestoreBindings } from './firestore.js';
import {
  compilePolicy, evaluateCheckedTransition, type CompiledPolicy, type Transition, type Verdict,
} from './index.js';
import { instantiateStandaloneModule, type StorageSimMethod } from './prove-helpers.js';
import type { RtdbBindings } from './rtdb.js';
import {
  classifyVerdictOrThrow, createSplitTargetHarness, type PolicyTargetName,
  type SplitCaseOutcome, type SplitTargetHarness, type SplitTargetPlan,
} from './split-proof.js';
import type { StorageBindings } from './storage.js';

export type DeniedVerdict = Extract<Verdict, { ok: false }>;

export class PolicyDeniedError extends Error {
  readonly verdict: DeniedVerdict;
  readonly requirement: string;
  readonly location: string;
  readonly fatal: boolean;
  readonly trace?: PolicyFailureTrace;

  constructor(verdict: DeniedVerdict) {
    super(`Policy denied at ${verdict.requirement} (${verdict.location}): ${verdict.reason}`);
    this.name = 'PolicyDeniedError';
    this.verdict = verdict;
    this.requirement = verdict.requirement;
    this.location = verdict.location;
    this.fatal = Boolean(verdict.fatal);
    this.trace = verdict.trace;
  }
}

export class PolicyPayloadTooLargeError extends Error {
  readonly maxBodyBytes: number;
  constructor(maxBodyBytes: number) {
    super(`Request body exceeds ${maxBodyBytes} bytes`);
    this.name = 'PolicyPayloadTooLargeError';
    this.maxBodyBytes = maxBodyBytes;
  }
}

export interface PolicyGuardOptions<TContext = unknown> {
  expressionLimit?: number;
  engine?: 'interpreter' | 'standalone';
  includeTrace?: boolean;
  includeTraceInResponse?: boolean;
  denyStatus?: number;
  fatalStatus?: number;
  badRequestStatus?: number;
  payloadTooLargeStatus?: number;
  attachDigestHeader?: boolean;
  onDeny?: (verdict: DeniedVerdict, req: Request, context?: TContext) => Response | Promise<Response>;
  firestore?: FirestoreBindings;
  rtdb?: RtdbBindings;
  storage?: StorageBindings;
  storageMethod?: StorageSimMethod;
  enforcement?: 'full' | 'residual';
  residualTarget?: PolicyTargetName;
}

export interface PolicyGuardTargetPlacement<TRow> {
  plan: SplitTargetPlan;
  requirements: TRow[];
}

export interface PolicyGuardPlacement {
  firestore?: PolicyGuardTargetPlacement<ReturnType<CompiledPolicy['firestore']>[number]>;
  rtdb?: PolicyGuardTargetPlacement<ReturnType<CompiledPolicy['rtdb']>[number]>;
  storage?: PolicyGuardTargetPlacement<ReturnType<CompiledPolicy['storage']>[number]>;
}

export interface VerifiedTransition<TContext = unknown> {
  transition: Transition;
  verdict: { ok: true };
  derived?: Record<string, unknown>;
  context?: TContext;
  policyDigest?: string;
}

export type RequestTransitionExtractor<TContext = unknown> = (
  req: Request,
  context?: TContext,
) => Transition | Promise<Transition>;

/** Duck-typed Cloud Functions / Express-compatible HTTP request (zero Node imports). */
export interface HttpLikeRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** Duck-typed Cloud Functions / Express-compatible HTTP response (zero Node imports). */
export interface HttpLikeResponse {
  status(code: number): HttpLikeResponse;
  setHeader?(name: string, value: string): void;
  set?(name: string, value: string): unknown;
  json?(body: unknown): unknown;
  send?(body: unknown): unknown;
  end?(body?: unknown): unknown;
}

export interface PolicyGuard<TContext = unknown> {
  readonly name: string;
  readonly engine: 'interpreter' | 'standalone';
  readonly enforcement: 'full' | 'residual';
  readonly residualTarget?: PolicyTargetName;
  check(transition: Transition): Verdict;
  assert(transition: Transition): void;
  derive(start: Pick<Transition, 'before' | 'input'>): Record<string, unknown>;
  digest(): Promise<string>;
  standaloneModule(): StandaloneModuleResult;
  placement(): PolicyGuardPlacement;
  residualModule(target?: PolicyTargetName): StandaloneModuleResult;
  firestore(bindings?: FirestoreBindings, mode?: 'complete' | 'mixed'): ReturnType<CompiledPolicy['firestore']>;
  rtdb(bindings?: RtdbBindings, mode?: 'complete' | 'mixed'): ReturnType<CompiledPolicy['rtdb']>;
  storage(bindings?: StorageBindings, mode?: 'complete' | 'mixed'): ReturnType<CompiledPolicy['storage']>;
  firestoreModule(bindings?: FirestoreBindings): string;
  storageModule(bindings?: StorageBindings): string;
  verifySplit(transition: Transition, target?: PolicyTargetName): SplitCaseOutcome;
  wrapFetch<TLocalContext = TContext>(
    extract: RequestTransitionExtractor<TLocalContext>,
    handler: (req: Request, verified: VerifiedTransition<TLocalContext>) => Response | Promise<Response>,
  ): (req: Request, context?: TLocalContext) => Promise<Response>;
  wrapHttpHandler(
    extract: (req: HttpLikeRequest) => Transition | Promise<Transition>,
    handler: (req: HttpLikeRequest, res: HttpLikeResponse, verified: VerifiedTransition<HttpLikeRequest>) => unknown | Promise<unknown>,
  ): (req: HttpLikeRequest, res: HttpLikeResponse) => Promise<void>;
}

const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >>> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(hashBuffer));
}

function jsonResponse(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function rejectForbiddenJsonKeys(value: unknown, depth = 0, st = { nodes: 0 }): void {
  if (++st.nodes > 16384 || depth > 32) throw new Error('Request JSON depth or node limit exceeded');
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) rejectForbiddenJsonKeys(value[i], depth + 1, st);
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_JSON_KEYS.has(key)) throw new Error('Forbidden key in request body: ' + key);
    rejectForbiddenJsonKeys((value as Record<string, unknown>)[key], depth + 1, st);
  }
}

async function readBoundedText(req: Request, maxBodyBytes: number): Promise<string> {
  const rawCl = req.headers.get('content-length');
  if (rawCl !== null) {
    const declared = Number(rawCl);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      throw new PolicyPayloadTooLargeError(maxBodyBytes);
    }
  }
  const cloned = req.clone();
  if (cloned.body && typeof cloned.body.getReader === 'function') {
    const reader = cloned.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBodyBytes) {
            void reader.cancel().catch(() => {});
            throw new PolicyPayloadTooLargeError(maxBodyBytes);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }
  const text = await cloned.text();
  if (new TextEncoder().encode(text).length > maxBodyBytes) {
    throw new PolicyPayloadTooLargeError(maxBodyBytes);
  }
  return text;
}

/**
 * Default Fetch `Request` extractor reading a JSON body of `{ before, after, input }`.
 * Enforces `maxBodyBytes` while streaming before `JSON.parse` and rejects forbidden prototype keys.
 * Merges URL search parameters under `input.query` only when `includeQuery` is enabled.
 */
export function jsonBodyExtractor(
  options: { includeQuery?: boolean; maxBodyBytes?: number } = {},
): RequestTransitionExtractor {
  const maxBodyBytes = options.maxBodyBytes ?? 262144;
  return async (req: Request): Promise<Transition> => {
    const text = await readBoundedText(req, maxBodyBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Request body must be valid JSON');
    }
    if (!isPlainRecord(parsed)) {
      throw new Error('Request body must be a JSON object');
    }
    rejectForbiddenJsonKeys(parsed);
    const before = Object.hasOwn(parsed, 'before') ? parsed.before : {};
    const after = Object.hasOwn(parsed, 'after') ? parsed.after : {};
    let input = Object.hasOwn(parsed, 'input') ? parsed.input : {};
    if (options.includeQuery && req.url) {
      const url = new URL(req.url, 'https://policy.invalid');
      const query: Record<string, string> = Object.create(null);
      url.searchParams.forEach((v, k) => {
        if (!FORBIDDEN_JSON_KEYS.has(k)) query[k] = v;
      });
      if (isPlainRecord(input)) {
        input = { ...input, query };
      }
    }
    return { before, after, input };
  };
}

function sendHttpJson(
  res: HttpLikeResponse,
  status: number,
  body: unknown,
  digestHeader?: string,
): void {
  const target = res.status(status);
  const setHeader = (k: string, v: string) => {
    if (typeof target.setHeader === 'function') target.setHeader(k, v);
    else if (typeof target.set === 'function') target.set(k, v);
  };
  setHeader('content-type', 'application/json; charset=utf-8');
  if (digestHeader) setHeader('x-policy-digest', digestHeader);
  if (typeof target.json === 'function') {
    target.json(body);
  } else if (typeof target.send === 'function') {
    target.send(JSON.stringify(body));
  } else if (typeof target.end === 'function') {
    target.end(JSON.stringify(body));
  }
}

function isFatalLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.constructor.name;
  return name === 'ResourceLimitError' || name === 'ExpressionLimitError';
}

function buildDenyPayload(verdict: DeniedVerdict, includeTrace: boolean): Record<string, unknown> {
  return {
    error: verdict.fatal ? 'POLICY_LIMIT_EXCEEDED' : 'POLICY_DENIED',
    requirement: verdict.requirement,
    location: verdict.location,
    reason: verdict.reason,
    ...(verdict.fatal ? { fatal: true } : {}),
    ...(includeTrace && verdict.trace ? { trace: toDiagnosticJsonValue(verdict.trace) } : {}),
  };
}

/**
 * Create an isomorphic policy guard for Fetch/Next.js/Cloud Functions handlers
 * and browser/client-side optimistic validation.
 */
export function createPolicyGuard<TContext = unknown>(
  source: string,
  options: PolicyGuardOptions<TContext> = {},
): PolicyGuard<TContext> {
  const expressionLimit = options.expressionLimit ?? 8192;
  const engine = options.engine ?? 'interpreter';
  const includeTrace = options.includeTraceInResponse ?? options.includeTrace ?? false;
  const denyStatus = options.denyStatus ?? 403;
  const fatalStatus = options.fatalStatus ?? denyStatus;
  const badRequestStatus = options.badRequestStatus ?? 400;
  const payloadTooLargeStatus = options.payloadTooLargeStatus ?? 413;
  const attachDigest = options.attachDigestHeader ?? false;

  const compiled = compilePolicy(source, { expressionLimit });
  const transitionName = compiled.ir.program.transition!.name;
  const hasDerive = Boolean(compiled.ir.program.transition?.derivation);
  const enforcement = options.enforcement ?? 'full';
  const configuredTargets: PolicyTargetName[] = [];
  const harnesses = new Map<PolicyTargetName, SplitTargetHarness>();
  const placementSnapshot: PolicyGuardPlacement = {};
  const register = (
    target: PolicyTargetName,
    rows: readonly { requirement: string; predicate?: string; completeReason?: string }[],
    bindings: FirestoreBindings | RtdbBindings | StorageBindings,
  ): SplitTargetHarness => {
    const h = createSplitTargetHarness({
      target, checked: compiled.ir, rows, bindings, storageMethod: options.storageMethod,
      instantiate: instantiateStandaloneModule,
    });
    configuredTargets.push(target);
    harnesses.set(target, h);
    return h;
  };
  if (options.firestore) {
    const requirements = compiled.firestore(options.firestore, 'mixed');
    placementSnapshot.firestore = { plan: register('firestore', requirements, options.firestore).plan, requirements };
  }
  if (options.rtdb) {
    const requirements = compiled.rtdb(options.rtdb, 'mixed');
    placementSnapshot.rtdb = { plan: register('rtdb', requirements, options.rtdb).plan, requirements };
  }
  if (options.storage) {
    const requirements = compiled.storage(options.storage, 'mixed');
    placementSnapshot.storage = { plan: register('storage', requirements, options.storage).plan, requirements };
  }

  const resolveTarget = (explicit?: PolicyTargetName): PolicyTargetName => {
    const chosen = explicit ?? options.residualTarget ?? (configuredTargets.length === 1 ? configuredTargets[0] : undefined);
    if (!chosen) {
      throw new Error(
        configuredTargets.length === 0
          ? 'No target bindings configured on policy guard'
          : `Multiple target bindings configured (${configuredTargets.join(', ')}); specify residualTarget`,
      );
    }
    if (!harnesses.has(chosen)) throw new Error(`Target '${chosen}' is not configured on policy guard`);
    return chosen;
  };
  const requireBindings = <T>(value: T | undefined, label: string): T => {
    if (!value) throw new Error(`${label} bindings not configured on policy guard`);
    return value;
  };

  let activeResidualTarget: PolicyTargetName | undefined;
  let activeResidualHarness: SplitTargetHarness | undefined;
  if (enforcement === 'residual') {
    activeResidualTarget = resolveTarget();
    activeResidualHarness = harnesses.get(activeResidualTarget)!;
  } else if (options.residualTarget) {
    activeResidualTarget = resolveTarget(options.residualTarget);
  }

  const emitted = engine === 'standalone' ? compiled.standaloneModule() : undefined;
  let cachedStandalone = emitted ? instantiateStandaloneModule(emitted.moduleSource) : undefined;
  let cachedDigest: Promise<string> | undefined;

  const getStandalone = () => {
    cachedStandalone ??= instantiateStandaloneModule((emitted ?? compiled.standaloneModule()).moduleSource);
    return cachedStandalone;
  };

  const getDigest = (): Promise<string> => {
    cachedDigest ??= sha256Hex(source);
    return cachedDigest;
  };

  const check = (transition: Transition): Verdict => {
    if (activeResidualHarness) {
      if (engine === 'standalone') return activeResidualHarness.judgeResidual(transition);
      return evaluateCheckedTransition(compiled.ir, transition, activeResidualHarness.residualRequirementSet);
    }
    if (cachedStandalone?.judge && engine === 'standalone') {
      return cachedStandalone.judge(transition) as Verdict;
    }
    return compiled.judge(transition);
  };

function unwrapDerivedValue(value: unknown, depth = 0, st: { nodes: number } = { nodes: 0 }): unknown {
  if (++st.nodes > 16384 || depth > 64) throw new Error('Derived output depth or node bound exceeded');
  if (typeof value === 'bigint') {
    return value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value;
  }
  if (value instanceof RulesFloat) return value.value;
  if (value instanceof Bytes) return new Uint8Array(value.data);
  if (value instanceof Timestamp) return { __type: 'timestamp', seconds: value.seconds, nanos: value.nanos };
  if (value instanceof Duration) return { __type: 'duration', seconds: value.seconds, nanos: value.nanos };
  if (value instanceof FirestoreSet) return value.toArray().map((v) => unwrapDerivedValue(v, depth + 1, st));
  if (Array.isArray(value)) return value.map((v) => unwrapDerivedValue(v, depth + 1, st));
  if (isRulesMap(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: unwrapDerivedValue(value[key], depth + 1, st),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

  const derive = (start: Pick<Transition, 'before' | 'input'>): Record<string, unknown> => {
    if (engine === 'standalone' && cachedStandalone?.derive) return cachedStandalone.derive(start) as Record<string, unknown>;
    return unwrapDerivedValue(compiled.derive(start)) as Record<string, unknown>;
  };

  const assertTransition = (transition: Transition): void => {
    const verdict = check(transition);
    if (!verdict.ok) throw new PolicyDeniedError(verdict);
  };

  return {
    name: transitionName,
    engine,
    enforcement,
    ...(activeResidualTarget ? { residualTarget: activeResidualTarget } : {}),
    check,
    assert: assertTransition,
    derive,
    digest: getDigest,
    standaloneModule: () => emitted ?? compiled.standaloneModule(),
    placement: () => ({ ...placementSnapshot }),
    residualModule: (target?: PolicyTargetName) => harnesses.get(resolveTarget(target))!.residualModule,
    firestore: (bindings = options.firestore, mode = 'mixed') => compiled.firestore(requireBindings(bindings, 'Firestore'), mode),
    rtdb: (bindings = options.rtdb, mode = 'mixed') => compiled.rtdb(requireBindings(bindings, 'RTDB'), mode),
    storage: (bindings = options.storage, mode = 'mixed') => compiled.storage(requireBindings(bindings, 'Storage'), mode),
    firestoreModule: (bindings = options.firestore) => compiled.firestoreModule(requireBindings(bindings, 'Firestore')),
    storageModule: (bindings = options.storage) => compiled.storageModule(requireBindings(bindings, 'Storage')),
    verifySplit: (transition: Transition, target?: PolicyTargetName) => {
      const h = harnesses.get(resolveTarget(target))!;
      const fullMod = getStandalone();
      return h.evaluate(transition, classifyVerdictOrThrow(() => fullMod.judge!(transition) as Verdict));
    },

    wrapFetch<TLocalContext = TContext>(
      extract: RequestTransitionExtractor<TLocalContext>,
      handler: (req: Request, verified: VerifiedTransition<TLocalContext>) => Response | Promise<Response>,
    ) {
      return async (req: Request, context?: TLocalContext): Promise<Response> => {
        const digestHeader = attachDigest ? await getDigest() : undefined;
        const extraHeaders = digestHeader ? { 'x-policy-digest': digestHeader } : undefined;
        let transition: Transition;
        try {
          transition = await extract(req, context);
        } catch (error) {
          const isTooLarge = error instanceof PolicyPayloadTooLargeError;
          return jsonResponse(
            {
              error: isTooLarge ? 'POLICY_PAYLOAD_TOO_LARGE' : 'POLICY_BAD_REQUEST',
              reason: error instanceof Error ? error.message : String(error),
            },
            isTooLarge ? payloadTooLargeStatus : badRequestStatus,
            extraHeaders,
          );
        }
        let verdict: Verdict;
        try {
          verdict = check(transition);
        } catch (error) {
          return jsonResponse(
            {
              error: 'POLICY_BAD_REQUEST',
              reason: error instanceof Error ? error.message : String(error),
            },
            badRequestStatus,
            extraHeaders,
          );
        }
        if (!verdict.ok) {
          if (options.onDeny) {
            return await options.onDeny(verdict, req, context as unknown as TContext);
          }
          const status = verdict.fatal ? fatalStatus : denyStatus;
          return jsonResponse(buildDenyPayload(verdict, includeTrace), status, extraHeaders);
        }
        let derived: Record<string, unknown> | undefined;
        if (hasDerive) {
          try { derived = derive({ before: transition.before, input: transition.input }); } catch (err) {
            if (isFatalLimitError(err)) {
              const fv: DeniedVerdict = { ok: false, requirement: transitionName, location: 'derive', reason: (err as Error).message, fatal: true };
              if (options.onDeny) return await options.onDeny(fv, req, context as unknown as TContext);
              return jsonResponse(buildDenyPayload(fv, includeTrace), fatalStatus, extraHeaders);
            }
          }
        }
        const response = await handler(req, {
          transition, verdict,
          ...(derived !== undefined ? { derived } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(digestHeader !== undefined ? { policyDigest: digestHeader } : {}),
        });
        if (!digestHeader) return response;
        const headers = new Headers(response.headers);
        headers.set('x-policy-digest', digestHeader);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      };
    },

    wrapHttpHandler(extract, handler) {
      return async (req: HttpLikeRequest, res: HttpLikeResponse): Promise<void> => {
        const digestHeader = attachDigest ? await getDigest() : undefined;
        let transition: Transition;
        try { transition = await extract(req); } catch (error) {
          const isTooLarge = error instanceof PolicyPayloadTooLargeError;
          sendHttpJson(res, isTooLarge ? payloadTooLargeStatus : badRequestStatus, {
            error: isTooLarge ? 'POLICY_PAYLOAD_TOO_LARGE' : 'POLICY_BAD_REQUEST',
            reason: error instanceof Error ? error.message : String(error),
          }, digestHeader);
          return;
        }
        let verdict: Verdict;
        try { verdict = check(transition); } catch (error) {
          sendHttpJson(res, badRequestStatus, {
            error: 'POLICY_BAD_REQUEST', reason: error instanceof Error ? error.message : String(error),
          }, digestHeader);
          return;
        }
        if (!verdict.ok) {
          sendHttpJson(res, verdict.fatal ? fatalStatus : denyStatus, buildDenyPayload(verdict, includeTrace), digestHeader);
          return;
        }
        let derived: Record<string, unknown> | undefined;
        if (hasDerive) {
          try { derived = derive({ before: transition.before, input: transition.input }); } catch (err) {
            if (isFatalLimitError(err)) {
              const fv: DeniedVerdict = { ok: false, requirement: transitionName, location: 'derive', reason: (err as Error).message, fatal: true };
              sendHttpJson(res, fatalStatus, buildDenyPayload(fv, includeTrace), digestHeader);
              return;
            }
          }
        }
        if (digestHeader) {
          if (typeof res.setHeader === 'function') res.setHeader('x-policy-digest', digestHeader);
          else if (typeof res.set === 'function') res.set('x-policy-digest', digestHeader);
        }
        await handler(req, res, {
          transition, verdict, context: req,
          ...(derived !== undefined ? { derived } : {}),
          ...(digestHeader !== undefined ? { policyDigest: digestHeader } : {}),
        });
      };
    },
  };
}
