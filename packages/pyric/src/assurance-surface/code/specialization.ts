/**
 * Caller-context specialization, transaction-parameter staging, and
 * cross-program collector result merging.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { calleeName, FIRESTORE_OPS, RTDB_OPS, STEP_BUDGET, type OpCall, type OpSpec } from './operation-specs.js';
import type { AccessSite } from './types.js';
import { alternatives, nodeId, type AVal, type Env } from './values.js';

/** Sites whose path shape came from callers' arguments (specialization attributes them to the callers). */
export const CALLER_SHAPED = new WeakSet<AccessSite>();

/** True when an operation's own trace is incomplete or its path shape comes from its callers. */
export function needsCallerContext(generic: AccessSite[]): boolean {
  return generic.some((s) => s.resolution !== 'resolved' || CALLER_SHAPED.has(s));
}

/** Most callers one wrapper operation is specialized for. */
const MAX_SPECIALIZATIONS = 400;

export interface RecordedOp {
  op: OpCall;
  generic: AccessSite[];
  owned: boolean;
}

export interface SpecializationHost {
  readonly ev: Evaluator;
  readonly ops: RecordedOp[];
  readonly calls: readonly ts.CallExpression[];
  force(v: AVal): AVal;
  source(node: ts.Node): string;
  sitesFor(op: OpCall, env: Env | undefined, sourceNode: ts.Node, through: string | undefined): AccessSite[];
  isTransactionParam(expr: ts.Expression | undefined): boolean;
}

/** A ref or query built but not seen reaching an operation, before cross-program filtering. */
export interface UnconsumedCandidate {
  key: string;
  site: AccessSite;
  /** Construction calls this one builds on (they are not reported separately). */
  covers: string[];
  /** False for constructions that are never sites themselves (a key-only `push(ref)`). */
  report: boolean;
}

/** What one program's collector found. Keys are node ids (`file:pos:end`), stable across programs. */
export interface CollectorResult {
  generic: Map<string, AccessSite[]>;
  specialized: Map<string, AccessSite[]>;
  consumed: Set<string>;
  unconsumed: UnconsumedCandidate[];
}

interface SpecTarget {
  op: OpCall;
  helperDecl?: ts.SignatureDeclaration;
  helperArgs?: readonly ts.Expression[];
}

function bindHelperCallEnv(ev: Evaluator, target: SpecTarget, env: Env): Env {
  if (target.helperDecl && target.helperDecl.parameters.length > 0) {
    return ev.bindCall({ k: 'fn', decl: target.helperDecl, env }, target.helperArgs ?? [], env);
  }
  return env;
}

function txRefSpec(service: 'firestore' | 'rtdb', name: string): OpSpec | undefined {
  if (service === 'firestore') {
    if (name === 'set') return FIRESTORE_OPS.setDoc;
    if (name === 'update') return FIRESTORE_OPS.updateDoc;
    if (name === 'delete') return FIRESTORE_OPS.deleteDoc;
    if (name === 'get') return FIRESTORE_OPS.getDoc;
    return undefined;
  }
  if (name === 'set') return RTDB_OPS.set;
  if (name === 'update') return RTDB_OPS.update;
  if (name === 'delete') return RTDB_OPS.remove;
  if (name === 'get') return RTDB_OPS.get;
  return undefined;
}

function isTxRunnerName(name: string): boolean {
  return name === 'transaction' || name === 'withTransaction' || name === 'runTransaction';
}

/**
 * Re-evaluate operations whose trace is not resolved once per caller of
 * their enclosing named function, with the caller's arguments bound.
 */
export function specializeOperations(host: SpecializationHost): Map<OpCall, AccessSite[]> {
  const byFunction = new Map<ts.Node, SpecTarget[]>();
  const byName = new Map<string, Set<ts.Node>>();
  const registerTarget = (fn: ts.Node, name: string, target: SpecTarget): void => {
    const list = byFunction.get(fn) ?? [];
    list.push(target);
    byFunction.set(fn, list);
    const names = byName.get(name) ?? new Set<ts.Node>();
    names.add(fn);
    byName.set(name, names);
  };
  for (const { op, generic } of host.ops) {
    if (!needsCallerContext(generic)) continue;
    const fnHost = enclosingCallable(op.call);
    if (!fnHost) continue;
    registerTarget(fnHost.fn, fnHost.name, { op });
    // Propagate 1 hop from an inner helper to sibling/method callables in the same enclosing factory.
    const outerFn = ts.findAncestor(fnHost.fn.parent, ts.isFunctionLike);
    if (outerFn) {
      const helperSym = callableSymbol(fnHost.fn, host.ev);
      if (helperSym) {
        for (const id of host.ev.refs.referencesOf(helperSym)) {
          const callParent = id.parent;
          if (!ts.isCallExpression(callParent) || callParent.expression !== id) continue;
          if (ts.findAncestor(callParent, ts.isFunctionLike) === fnHost.fn) continue;
          if (callParent.getSourceFile() !== outerFn.getSourceFile() || callParent.pos < outerFn.pos || callParent.end > outerFn.end) continue;
          const callerHost = enclosingCallable(callParent);
          if (!callerHost || callerHost.fn === fnHost.fn) continue;
          registerTarget(callerHost.fn, callerHost.name, { op, helperDecl: fnHost.fn as ts.SignatureDeclaration, helperArgs: callParent.arguments });
        }
      }
    }
  }
  const out = new Map<OpCall, AccessSite[]>();
  const hasTxParamOps = host.ops.some((o) => o.op.via === 'transaction' && o.generic.length === 0);
  if (byFunction.size === 0 && !hasTxParamOps) return out;
  const newOps: RecordedOp[] = [];
  const baseOps = [...host.ops];
  for (const call of host.calls) {
    const name = calleeName(call)!;
    if (name === 'set' || name === 'update' || name === 'delete' || name === 'get' || isTxRunnerName(name)) {
      if (call.arguments.length >= 1) {
        const targetExpr = call.arguments[0];
        let shouldEvaluate = false;
        if (isTxRunnerName(name)) {
          if (ts.isIdentifier(targetExpr) || ((ts.isArrowFunction(targetExpr) || ts.isFunctionExpression(targetExpr)) && call.arguments.length > 1)) {
            shouldEvaluate = true;
          }
        } else if (ts.isPropertyAccessExpression(call.expression) && host.isTransactionParam(call.expression.expression)) {
          shouldEvaluate = true;
        }
        if (shouldEvaluate) {
          host.ev.startBudget(STEP_BUDGET);
          const targetAlt = alternatives(host.force(host.ev.eval(targetExpr)));
          for (const t of targetAlt) {
            if (t.k === 'ref') {
              if (isTxRunnerName(name)) continue;
              const spec = txRefSpec(t.service, name);
              if (spec && newOps.length < MAX_SPECIALIZATIONS) {
                const transOp: OpCall = { call, service: t.service, spec, via: 'transaction' };
                newOps.push({ op: transOp, generic: host.sitesFor(transOp, undefined, call, undefined), owned: true });
              }
            } else if (t.k === 'fn' && isTxRunnerName(name)) {
              const env = host.ev.bindCall(t, call.arguments.slice(1), undefined);
              const sf = t.decl.getSourceFile();
              const start = t.decl.pos;
              const end = t.decl.end;
              for (const { op, generic } of baseOps) {
                if (op.call.getSourceFile() === sf && op.call.pos >= start && op.call.end <= end) {
                  const transOp = { ...op, via: 'transaction' as const };
                  const rawSites = host.sitesFor(transOp, env, call, host.source(op.call));
                  const isPlaceholder = generic.length === 0 && op.via === 'transaction';
                  const sites = isPlaceholder ? rawSites.filter((s) => s.resolution !== 'unresolved') : rawSites;
                  if (sites.length > 0 && newOps.length < MAX_SPECIALIZATIONS) {
                    newOps.push({ op: transOp, generic: sites, owned: true });
                  }
                }
              }
              host.ev.clearEnv(env);
            } else if (t.k === 'obj' && !isTxRunnerName(name)) {
              const rawMethod = t.props.get(name);
              const methodAlts = rawMethod ? alternatives(host.force(rawMethod)) : [];
              for (const methodFn of methodAlts) {
                if (methodFn.k !== 'fn') continue;
                const env = host.ev.bindCall(methodFn, call.arguments.slice(1), undefined);
                for (const target of byFunction.get(methodFn.decl) ?? []) {
                  const list = out.get(target.op) ?? [];
                  if (list.length >= MAX_SPECIALIZATIONS) continue;
                  host.ev.startBudget(STEP_BUDGET);
                  const callEnv = bindHelperCallEnv(host.ev, target, env);
                  list.push(...host.sitesFor({ ...target.op, via: 'transaction' }, callEnv, call, host.source(target.op.call)));
                  if (callEnv !== env) host.ev.clearEnv(callEnv);
                  out.set(target.op, list);
                }
                host.ev.clearEnv(env);
              }
            }
          }
        }
      }
    }
    const hosts = byName.get(name);
    if (!hosts) continue;
    host.ev.startBudget(STEP_BUDGET);
    const callee = host.force(host.ev.eval(call.expression));
    for (const c of alternatives(callee)) {
      if (c.k !== 'fn' || !hosts.has(c.decl)) continue;
      const env = host.ev.bindCall(c, call.arguments, undefined);
      const inTx = isInsideTransactionCallback(call);
      for (const target of byFunction.get(c.decl)!) {
        const list = out.get(target.op) ?? [];
        if (list.length >= MAX_SPECIALIZATIONS) continue;
        host.ev.startBudget(STEP_BUDGET);
        let specializedOp = target.op;
        if (!target.op.via && inTx) specializedOp = { ...target.op, via: 'transaction' };
        const callEnv = bindHelperCallEnv(host.ev, target, env);
        list.push(...host.sitesFor(specializedOp, callEnv, call, host.source(target.op.call)));
        if (callEnv !== env) host.ev.clearEnv(callEnv);
        out.set(target.op, list);
      }
      host.ev.clearEnv(env);
    }
  }
  const coveredCallIds = new Set<string>();
  for (const { op, generic } of baseOps) {
    if (generic.length > 0 || (out.get(op)?.length ?? 0) > 0) coveredCallIds.add(nodeId(op.call));
  }
  for (const { op, generic } of newOps) {
    if (generic.length > 0) coveredCallIds.add(nodeId(op.call));
  }
  for (const { op, generic, owned } of baseOps) {
    if (!owned || generic.length > 0 || op.via !== 'transaction' || op.service !== 'firestore') continue;
    const id = nodeId(op.call);
    if (coveredCallIds.has(id)) continue;
    coveredCallIds.add(id);
    const sf = op.call.getSourceFile();
    const usesOnlyRtdb =
      baseOps.some((o) => o.generic.length > 0 && o.op.call.getSourceFile() === sf && o.op.service === 'rtdb') &&
      !baseOps.some((o) => o.generic.length > 0 && o.op.call.getSourceFile() === sf && o.op.service === 'firestore');
    let fallbackOp = op;
    if (usesOnlyRtdb) {
      const rtdbMatch = baseOps.find((o) => o.op.call === op.call && o.op.service === 'rtdb');
      if (rtdbMatch) fallbackOp = rtdbMatch.op;
    }
    newOps.push({ op: fallbackOp, generic: host.sitesFor(fallbackOp, undefined, op.call, undefined), owned: true });
  }
  host.ops.push(...newOps);
  return out;
}

export function isTransactionParameter(
  expr: ts.Expression | undefined,
  ev: Evaluator,
  cache: WeakMap<ts.Node, boolean>,
): boolean {
  if (!expr || !ts.isIdentifier(expr)) return false;
  const cached = cache.get(expr);
  if (cached !== undefined) return cached;
  let result = false;
  const sym = ev.refs.symbolOf(expr);
  const target = sym ? ev.refs.resolveAlias(sym) : undefined;
  const decl = target?.valueDeclaration ?? target?.declarations?.[0];
  if (decl !== undefined && ts.isParameter(decl)) {
    const fn = decl.parent;
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      let node: ts.Node = fn;
      while (node.parent && (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent))) {
        node = node.parent;
      }
      const parentCall = node.parent;
      if (parentCall && ts.isCallExpression(parentCall)) {
        const callName = calleeName(parentCall);
        result = callName !== undefined && isTxRunnerName(callName);
      }
    }
  }
  cache.set(expr, result);
  return result;
}

/**
 * Merge collector results: an operation specialized at any program's
 * callers is reported at those callers; otherwise where it is written.
 * Unconsumed refs are dropped when any program saw them consumed or built
 * on by another reported ref.
 */
export function mergeResults(results: CollectorResult[]): AccessSite[] {
  const specialized = new Map<string, AccessSite[]>();
  const consumed = new Set<string>();
  for (const r of results) {
    for (const [k, v] of r.specialized) specialized.set(k, [...(specialized.get(k) ?? []), ...v]);
    for (const k of r.consumed) consumed.add(k);
  }
  const out: AccessSite[] = [];
  const seen = new Set<string>();
  const add = (site: AccessSite): void => {
    const key = `${site.source}|${site.through ?? ''}|${site.op}|${site.path}|${site.resolution}|${site.multiPath ? 'm' : ''}|${site.via ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(site);
  };
  for (const r of results) {
    for (const [k, generic] of r.generic) for (const s of specialized.get(k) ?? generic) add(s);
  }
  // Specialized sites of operations no program owns as a scanned file (a shared helper outside every scan set).
  const owned = new Set(results.flatMap((r) => [...r.generic.keys()]));
  for (const [k, v] of specialized) if (!owned.has(k)) for (const s of v) add(s);
  const candidates = results.flatMap((r) => r.unconsumed).filter((c) => !consumed.has(c.key));
  const covered = new Set(candidates.flatMap((c) => c.covers));
  for (const c of candidates) if (c.report && !covered.has(c.key)) add(c.site);
  return out;
}

/** The innermost enclosing function that has a name callers can use. */
export function enclosingCallable(node: ts.Node): { fn: ts.Node; name: string } | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isFunctionLike(n)) continue;
    const name = callableName(n);
    if (name) return { fn: n, name };
  }
  return undefined;
}

/** True when a call sits inside an inline callback passed to `runTransaction`/`transaction`/`withTransaction`. */
export function isInsideTransactionCallback(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) continue;
    let host: ts.Node = n;
    while (host.parent && (ts.isParenthesizedExpression(host.parent) || ts.isAsExpression(host.parent))) host = host.parent;
    if (host.parent && ts.isCallExpression(host.parent)) {
      const callName = calleeName(host.parent);
      if (callName !== undefined && isTxRunnerName(callName)) return true;
    }
  }
  return false;
}

function callableName(fn: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) {
    return fn.name.text;
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    let host: ts.Node = fn;
    while (ts.isParenthesizedExpression(host.parent) || ts.isAsExpression(host.parent)) host = host.parent;
    const p = host.parent;
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
  }
  return undefined;
}

function callableSymbol(fn: ts.Node, ev: Evaluator): ts.Symbol | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) {
    return ev.checker.getSymbolAtLocation(fn.name);
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    let host: ts.Node = fn;
    while (ts.isParenthesizedExpression(host.parent) || ts.isAsExpression(host.parent)) host = host.parent;
    if (ts.isVariableDeclaration(host.parent) && ts.isIdentifier(host.parent.name)) {
      return ev.checker.getSymbolAtLocation(host.parent.name);
    }
  }
  return undefined;
}
