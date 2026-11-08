/**
 * Site discovery: walks every call in the scanned files, recognises SDK
 * operations (direct calls, batch and transaction methods, onDisconnect
 * methods), evaluates their ref and payload arguments, and turns each into
 * one access site per traced path.
 */
import ts from 'typescript';
import { relative, sep } from 'node:path';
import type { Evaluator } from './evaluator.js';
import { API_NAMES, BATCH_METHODS, calleeName, CONSTRUCTIONS, DISCONNECT_METHODS, FIRESTORE_OPS, isDocWrite, METHOD_NAMES, RTDB_OPS, STEP_BUDGET, TX_METHODS, txMethodSpecs, type OpCall, type OpSpec } from './operation-specs.js';
import { expressionName, functionName, hole, partsToSegmentAlternatives, renderPath } from './paths.js';
import { payloadShape } from './payload.js';
import { CALLER_SHAPED, isTransactionParameter, mergeResults, specializeOperations, type CollectorResult, type RecordedOp, type UnconsumedCandidate } from './specialization.js';
import type { AccessService, AccessSite, PayloadShape, QueryConstraint } from './types.js';
import { alternatives, literalText, nodeId, renderParts, union, unknown, type AVal, type Env, type Segment } from './values.js';

/**
 * Collects sites over a set of files with one evaluator.
 */
export class SiteCollector {
  readonly sites: AccessSite[] = [];
  private readonly consumed = new Set<string>();
  private readonly constructions: { call: ts.CallExpression; service: AccessService; name: string }[] = [];
  private readonly seenSites = new Set<string>();
  private readonly ops: RecordedOp[] = [];
  private readonly calls: ts.CallExpression[] = [];
  private readonly txParamCache = new WeakMap<ts.Node, boolean>();

  constructor(
    private readonly ev: Evaluator,
    private readonly root: string,
    private readonly includeReads: boolean,
  ) {}

  private force = (v: AVal): AVal => this.ev.force(v);

  /**
   * Scan a file. An owned file contributes its own sites and its calls as
   * callers; a file another program owns contributes only operations, so
   * calls from this program's files can specialize them.
   */
  scanFile(sf: ts.SourceFile, owned = true): void {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        if (owned && calleeName(n) !== undefined) this.calls.push(n);
        this.scanCall(n, owned);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  private scanCall(call: ts.CallExpression, owned: boolean): void {
    this.ev.startBudget(STEP_BUDGET);
    if (ts.isIdentifier(call.expression) && !this.isImportedName(call.expression)) return;
    const name = calleeName(call);
    if (name === undefined) return;
    // Identifiers are checked whatever their local name (`ref as dbRef`); member calls only by SDK name.
    if (name === 'set' || name === 'update' || name === 'delete' || name === 'get') {
      if (ts.isPropertyAccessExpression(call.expression) && isTransactionParameter(call.expression.expression, this.ev, this.txParamCache)) {
        const specs = txMethodSpecs(name);
        this.ops.push({ op: { call, service: 'firestore', spec: specs.firestore, via: 'transaction' }, generic: [], owned });
        this.ops.push({ op: { call, service: 'rtdb', spec: specs.rtdb, via: 'transaction' }, generic: [], owned });
      }
    }
    if (ts.isIdentifier(call.expression) || API_NAMES.has(name)) {
      const callee = this.force(this.ev.eval(call.expression));
      for (const c of alternatives(callee)) {
        if (c.k !== 'api' || (c.module !== 'firestore' && c.module !== 'rtdb')) continue;
        const specTable = c.module === 'firestore' ? FIRESTORE_OPS : RTDB_OPS;
        const spec = specTable[c.name];
        if (spec) {
          if (spec.minArgs !== undefined && call.arguments.length < spec.minArgs) {
            if (owned) this.constructions.push({ call, service: c.module, name: c.name });
          } else {
            this.record({ call, service: c.module, spec }, owned);
          }
        } else if (owned && CONSTRUCTIONS[c.module].has(c.name)) {
          this.constructions.push({ call, service: c.module, name: c.name });
        }
      }
    }
    if (ts.isPropertyAccessExpression(call.expression) && METHOD_NAMES.has(name)) {
      const receiverExpr = call.expression.expression;
      const receiver = this.force(this.ev.eval(receiverExpr));
      for (const r of alternatives(receiver)) {
        if (r.k === 'batch' && BATCH_METHODS[name]) this.record({ call, service: 'firestore', spec: BATCH_METHODS[name], via: 'batch' }, owned);
        else if (r.k === 'tx' && TX_METHODS[name]) this.record({ call, service: 'firestore', spec: TX_METHODS[name], via: 'transaction' }, owned);
        else if (r.k === 'onDisconnect' && DISCONNECT_METHODS[name]) {
          this.record({ call, service: 'rtdb', spec: DISCONNECT_METHODS[name], disconnectReceiver: receiverExpr }, owned);
        }
      }
    }
  }

  private record(op: OpCall, owned: boolean, env?: Env): void {
    this.ops.push({ op, generic: this.sitesFor(op, env, op.call, undefined), owned });
  }

  private isImportedName(id: ts.Identifier): boolean {
    const sym = this.ev.refs.symbolOf(id);
    return sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0;
  }

  private source(node: ts.Node): string {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return `${relative(this.root, sf.fileName).split(sep).join('/')}:${line + 1}`;
  }

  private push(site: AccessSite): void {
    const key = `${site.source}|${site.through ?? ''}|${site.op}|${site.path}|${site.resolution}|${site.multiPath ? 'm' : ''}|${site.via ?? ''}`;
    if (this.seenSites.has(key)) return;
    this.seenSites.add(key);
    this.sites.push(site);
  }

  private refValueOf(op: OpCall, env: Env | undefined): AVal {
    if (op.disconnectReceiver) {
      const receiver = this.force(this.ev.eval(op.disconnectReceiver, env));
      const refs = alternatives(receiver).filter((r): r is Extract<AVal, { k: 'onDisconnect' }> => r.k === 'onDisconnect').map((r) => r.ref);
      if (refs.length === 0) return unknown('onDisconnect() receiver not traced');
      return union(refs);
    }
    const refExpr = op.call.arguments[0];
    if (!refExpr) return unknown('the operation has no ref argument');
    return this.ev.eval(refExpr, env);
  }

  private sitesFor(op: OpCall, env: Env | undefined, sourceNode: ts.Node, through: string | undefined): AccessSite[] {
    const { service, spec, call } = op;
    const refExpr = op.disconnectReceiver ?? call.arguments[0];
    const alts = alternatives(this.force(this.refValueOf(op, env)));
    const refs = alts.filter((a): a is Extract<AVal, { k: 'ref' }> => a.k === 'ref' && a.service === service);
    if (spec.readKind && !this.includeReads) {
      for (const ref of refs) for (const b of ref.built) this.consumed.add(nodeId(b));
      return [];
    }
    const untraced = alts.filter((a) => !(a.k === 'ref' && a.service === service) && a.k !== 'null' && a.k !== 'undefined').map(describe);
    const base: Omit<AccessSite, 'path' | 'resolution'> = { service, op: spec.op, source: this.source(sourceNode) };
    if (through) base.through = through;
    if (op.via) base.via = op.via;
    if (spec.listen) base.listen = true;

    if (refs.length === 0) {
      let reason = 'no value reaches the ref argument';
      if (untraced.length > 0) reason = untraced.slice(0, 3).join('; ');
      return [{ ...base, path: '', resolution: 'unresolved', reason: `ref argument '${expressionName(refExpr)}' was not traced: ${reason}` }];
    }
    const out: AccessSite[] = [];
    let payload: { shape: PayloadShape; value: AVal } | undefined;
    if (spec.data !== undefined) payload = evaluateCallPayload(this.ev, this.force, call, spec, service, env);
    for (const ref of refs) {
      for (const b of ref.built) this.consumed.add(nodeId(b));
      const segments: Segment[] = spec.append ? [...ref.segments, [hole(spec.append)]] : ref.segments;
      const opName = readOpName(spec, ref);
      const notes = [...ref.notes];
      if (untraced.length > 0) notes.push(`other values of '${expressionName(refExpr)}' were not traced: ${untraced.slice(0, 2).join('; ')}`);
      if (service === 'firestore' && isDocWrite(opName) && ref.refKind !== 'doc') notes.push(`${opName} on a ${ref.refKind} ref`);
      const { path, variables } = renderPath(service, segments, this.force);
      const resolution = notes.length > 0 ? 'partial' : 'resolved';
      const site: AccessSite = { ...base, op: opName, path, resolution };
      if (ref.fromCallers) CALLER_SHAPED.add(site);
      if (notes.length > 0) site.reason = notes.join('; ');
      if (variables.length > 0) site.pathVariables = variables;
      if (ref.constraints?.length) site.query = ref.constraints.map(toConstraint);
      if (payload && service === 'rtdb' && spec.op === 'update') {
        out.push(...expandMultiPathSites(this.force, site, segments, payload.value));
        const multiKeys = multiPathKeys(this.force(payload.value));
        const isMultiPathField = (name: string): boolean => [...multiKeys].some((k) => name === k || name.startsWith(`${k}/`));
        const plain = payload.shape.fields.filter((f) => !isMultiPathField(f.name));
        if (plain.length > 0 || payload.shape.fields.length === 0) {
          site.payload = { ...payload.shape, fields: plain };
          out.push(site);
        }
        continue;
      }
      if (payload) site.payload = payload.shape;
      out.push(site);
    }
    return out;
  }

  finish(): CollectorResult {
    const specializedByOp = specializeOperations({
      ev: this.ev,
      ops: this.ops,
      calls: this.calls,
      force: this.force,
      source: (node) => this.source(node),
      sitesFor: (op, env, sourceNode, through) => this.sitesFor(op, env, sourceNode, through),
      isTransactionParam: (expr) => isTransactionParameter(expr, this.ev, this.txParamCache),
    });
    const result: CollectorResult = { generic: new Map(), specialized: new Map(), consumed: this.consumed, unconsumed: [] };
    for (const { op, generic, owned } of this.ops) {
      const key = nodeId(op.call);
      if (owned) result.generic.set(key, [...(result.generic.get(key) ?? []), ...generic]);
      const viaCallers = specializedByOp.get(op);
      if (viaCallers && viaCallers.length > 0) result.specialized.set(key, [...(result.specialized.get(key) ?? []), ...viaCallers]);
    }
    result.unconsumed = this.unconsumedCandidates();
    this.sites.length = 0;
    this.seenSites.clear();
    for (const s of mergeResults([result])) this.push(s);
    return result;
  }

  private unconsumedCandidates(): UnconsumedCandidate[] {
    const out: UnconsumedCandidate[] = [];
    for (const c of this.constructions) {
      if (this.consumed.has(nodeId(c.call))) continue;
      const isQuery = c.name === 'query';
      if (isQuery && !this.includeReads) continue;
      this.ev.startBudget(STEP_BUDGET);
      const v = this.force(this.ev.eval(c.call));
      const covers: string[] = [];
      for (const a of alternatives(v)) {
        if (a.k !== 'ref') continue;
        for (const b of a.built) if (b !== c.call) covers.push(nodeId(b));
      }
      const ref = alternatives(v).find((a): a is Extract<AVal, { k: 'ref' }> => a.k === 'ref');
      let sitePath = '';
      if (ref) sitePath = renderPath(c.service, ref.segments).path;
      const site: AccessSite = {
        path: sitePath,
        service: c.service,
        op: isQuery ? 'query' : 'ref',
        source: this.source(c.call),
        resolution: 'unresolved',
        reason: `${c.name}() result never reaches a recognised read or write in the project${consumerHint(c.call)}`,
      };
      if (ref?.constraints?.length) site.query = ref.constraints.map(toConstraint);
      out.push({ key: nodeId(c.call), site, covers, report: c.name !== 'push' });
    }
    return out;
  }
}

function readOpName(spec: OpSpec, ref: Extract<AVal, { k: 'ref' }>): string {
  if (!spec.readKind) return spec.op;
  if (ref.constraints?.length) return 'query';
  if (ref.service === 'firestore') return ref.refKind === 'doc' ? 'get' : 'query';
  return 'get';
}

function evaluateCallPayload(ev: Evaluator, force: (v: AVal) => AVal, call: ts.CallExpression, spec: OpSpec, service: AccessService, env: Env | undefined): { shape: PayloadShape; value: AVal } | undefined {
  const dataExpr = call.arguments[spec.data!];
  if (!dataExpr) return undefined;
  let value = ev.eval(dataExpr, env);
  const isVariadicUpdate = service === 'firestore' && spec.op === 'updateDoc' && (call.arguments.length >= 3 || literalText(force(value)) !== null);
  if (isVariadicUpdate) {
    const props = new Map<string, AVal>();
    let open = false;
    for (let i = spec.data!; i < call.arguments.length; i += 2) {
      const keyArg = call.arguments[i];
      const valArg = call.arguments[i + 1];
      if (ts.isSpreadElement(keyArg) || !valArg || ts.isSpreadElement(valArg)) {
        open = true;
        continue;
      }
      const key = literalText(force(ev.eval(keyArg, env)));
      if (key !== null) props.set(key, ev.eval(valArg, env));
      else open = true;
    }
    value = { k: 'obj', props, computed: [], open, optional: new Set() };
  }
  const shape = payloadShape(value, force, service === 'firestore' ? '.' : '/');
  if (spec.options !== undefined && call.arguments[spec.options]) {
    if (hasMergeOption(force(ev.eval(call.arguments[spec.options], env)), force)) shape.merge = true;
  }
  return { shape, value };
}

function expandMultiPathSites(force: (v: AVal) => AVal, site: AccessSite, baseSegments: Segment[], value: AVal): AccessSite[] {
  const out: AccessSite[] = [];
  for (const alt of alternatives(force(value))) {
    if (alt.k !== 'obj') continue;
    const entries: { key: AVal; value: AVal }[] = [];
    for (const [k, v] of alt.props.entries()) {
      if (k.includes('/')) entries.push({ key: { k: 'str', parts: [{ kind: 'lit', text: k }] }, value: v });
    }
    entries.push(...alt.computed);
    for (const e of entries) {
      const key = force(e.key);
      if (key.k !== 'str') continue;
      for (const segs of partsToSegmentAlternatives(key.parts, force)) {
        const { path, variables } = renderPath('rtdb', [...baseSegments, ...segs], force);
        const sub: AccessSite = { ...site, path, multiPath: true, payload: payloadShape(e.value, force, '/') };
        if (variables.length > 0) sub.pathVariables = variables;
        else delete sub.pathVariables;
        out.push(sub);
      }
    }
  }
  return out;
}

function multiPathKeys(v: AVal): Set<string> {
  const out = new Set<string>();
  for (const alt of alternatives(v)) {
    if (alt.k !== 'obj') continue;
    for (const k of alt.props.keys()) if (k.includes('/')) out.add(k);
    for (const c of alt.computed) if (c.key.k === 'str') out.add(renderParts(c.key.parts));
  }
  return out;
}

function hasMergeOption(opts: AVal, force: (v: AVal) => AVal): boolean {
  for (const alt of alternatives(opts)) {
    if (alt.k !== 'obj') continue;
    if (alt.props.has('mergeFields')) {
      const mf = force(alt.props.get('mergeFields')!);
      if (mf.k !== 'undefined') return true;
    }
    if (alt.props.has('merge')) {
      const mv = force(alt.props.get('merge')!);
      if (mv.k !== 'undefined' && !(mv.k === 'bool' && mv.value === false)) return true;
    }
  }
  return false;
}

function toConstraint(c: { kind: string; field?: string; op?: string; direction?: 'asc' | 'desc' }): QueryConstraint {
  const out: QueryConstraint = { kind: c.kind };
  if (c.field !== undefined) out.field = c.field;
  if (c.op !== undefined) out.op = c.op;
  if (c.direction !== undefined) out.direction = c.direction;
  return out;
}

function describe(v: AVal): string {
  switch (v.k) {
    case 'unknown':
      return v.reason;
    case 'ref': {
      const expected = v.service === 'rtdb' ? 'Firestore' : 'database';
      return `a ${v.service} ref where a ${expected} ref was expected`;
    }
    default:
      return `a ${v.k} value`;
  }
}

function consumerHint(call: ts.CallExpression): string {
  let node: ts.Node = call;
  while (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isNonNullExpression(node.parent)) node = node.parent;
  const p = node.parent;
  if (ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression)) return `; it is passed to ${p.expression.getText()}()`;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return `; it is stored in '${p.name.text}'`;
  if (ts.isReturnStatement(p) || ts.isArrowFunction(p)) {
    const fn = ts.findAncestor(p, ts.isFunctionLike);
    if (fn) return `; it is returned from ${functionName(fn as ts.SignatureDeclaration)}`;
  }
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return `; it is stored in property '${p.name.text}'`;
  return '';
}
