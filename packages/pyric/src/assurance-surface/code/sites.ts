/**
 * Site discovery: walks every call in the scanned files, recognises SDK
 * operations from registered {@link SdkServiceModel} tables, evaluates ref
 * and payload arguments, and turns each into one access site per traced path.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import {
  buildOperationIndex,
  calleeName,
  STEP_BUDGET,
  type OpCall,
  type OperationIndex,
  type OpSpec,
} from './operation-specs.js';
import { expressionName, functionName, hole, partsToSegmentAlternatives, renderPath } from './paths.js';
import { payloadShape } from './payload.js';
import { posixRelative } from './posix-path.js';
import {
  CALLER_SHAPED,
  isTransactionParameter,
  mergeResults,
  specializeOperations,
  type CollectorResult,
  type RecordedOp,
  type UnconsumedCandidate,
} from './specialization.js';
import type { AccessService, AccessSite, PayloadShape, QueryConstraint } from './types.js';
import { attachSiteUsage, collectProgramUsage, mergeSiteUsage } from './usage-records.js';
import {
  alternatives,
  literalText,
  nodeId,
  ownRecordValue,
  renderParts,
  union,
  unknown,
  type AVal,
  type Env,
  type Segment,
} from './values.js';

export interface RecordedConstruction {
  readonly call: ts.CallExpression;
  readonly service: AccessService;
  readonly name: string;
  readonly isQuery: boolean;
  readonly reportUnconsumed: boolean;
}

/**
 * Collects sites over a set of files with one evaluator.
 */
export class SiteCollector {
  readonly sites: AccessSite[] = [];
  private readonly opIndex: OperationIndex;
  private readonly consumed = new Set<string>();
  private readonly constructions: RecordedConstruction[] = [];
  private readonly seenSites = new Map<string, AccessSite>();
  private readonly ops: RecordedOp[] = [];
  private readonly calls: ts.CallExpression[] = [];
  private readonly txParamCache = new WeakMap<ts.Node, boolean>();

  constructor(
    private readonly ev: Evaluator,
    private readonly root: string,
    private readonly includeReads: boolean,
  ) {
    this.opIndex = buildOperationIndex(ev.sdk.serviceModels());
  }

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
    const txCandidates = this.opIndex.transactionMethods.get(name);
    if (
      txCandidates !== undefined
      && ts.isPropertyAccessExpression(call.expression)
      && isTransactionParameter(call.expression.expression, this.ev, this.txParamCache)
    ) {
      for (const candidate of txCandidates) {
        this.ops.push({
          op: { call, service: candidate.service, spec: candidate.spec, via: 'transaction' },
          generic: [],
          owned,
        });
      }
    }
    if (ts.isIdentifier(call.expression) || this.opIndex.apiNames.has(name)) {
      const callee = this.force(this.ev.eval(call.expression));
      for (const c of alternatives(callee)) {
        if (c.k !== 'api') continue;
        const model = this.ev.sdk.serviceModel(c.module);
        if (!model) continue;
        const spec = ownRecordValue(model.operations, c.name);
        if (spec) {
          if (spec.minArgs !== undefined && call.arguments.length < spec.minArgs) {
            const refSpec = ownRecordValue(model.refConstructors, c.name);
            if (owned && refSpec) {
              this.constructions.push({
                call,
                service: model.service,
                name: c.name,
                isQuery: false,
                reportUnconsumed: refSpec.reportUnconsumed !== false,
              });
            }
          } else {
            this.record({ call, service: model.service, spec }, owned);
          }
        } else if (owned) {
          const refSpec = ownRecordValue(model.refConstructors, c.name);
          if (refSpec) {
            this.constructions.push({
              call,
              service: model.service,
              name: c.name,
              isQuery: false,
              reportUnconsumed: refSpec.reportUnconsumed !== false,
            });
          } else if (model.queryBuilder === c.name) {
            this.constructions.push({
              call,
              service: model.service,
              name: c.name,
              isQuery: true,
              reportUnconsumed: true,
            });
          }
        }
      }
    }
    if (ts.isPropertyAccessExpression(call.expression) && this.opIndex.methodNames.has(name)) {
      const receiverExpr = call.expression.expression;
      const receiver = this.force(this.ev.eval(receiverExpr));
      for (const r of alternatives(receiver)) {
        if (r.k !== 'receiver') continue;
        const receiverTable = ownRecordValue(
          this.ev.sdk.serviceModel(r.service)?.receiverMethods,
          r.receiverKind,
        );
        const methodSpec = ownRecordValue(receiverTable, name);
        if (!methodSpec) continue;
        let boundReceiver: ts.Expression | undefined;
        if (methodSpec.usesReceiverRef) boundReceiver = receiverExpr;
        this.record(
          { call, service: r.service, spec: methodSpec, via: methodSpec.via, receiverExpr: boundReceiver },
          owned,
        );
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
    return `${posixRelative(this.root, sf.fileName)}:${line + 1}`;
  }

  private push(site: AccessSite): void {
    const key = `${site.source}|${site.through ?? ''}|${site.op}|${site.path}|${site.resolution}|${site.multiPath ? 'm' : ''}|${site.via ?? ''}`;
    const existing = this.seenSites.get(key);
    if (existing) {
      mergeSiteUsage(existing, site);
      return;
    }
    this.seenSites.set(key, site);
    this.sites.push(site);
  }

  private refValueOf(op: OpCall, env: Env | undefined): AVal {
    if (op.receiverExpr) {
      const receiver = this.force(this.ev.eval(op.receiverExpr, env));
      const refs = alternatives(receiver)
        .filter((r): r is Extract<AVal, { k: 'receiver' }> => r.k === 'receiver' && r.ref !== undefined)
        .map((r) => r.ref!);
      if (refs.length === 0) return unknown(`${op.spec.op}() receiver not traced`);
      return union(refs);
    }
    const refExpr = op.call.arguments[0];
    if (!refExpr) return unknown('the operation has no ref argument');
    return this.ev.eval(refExpr, env);
  }

  private sitesFor(op: OpCall, env: Env | undefined, sourceNode: ts.Node, through: string | undefined): AccessSite[] {
    const { service, spec, call } = op;
    const refExpr = op.receiverExpr ?? call.arguments[0];
    const alts = alternatives(this.force(this.refValueOf(op, env)));
    const refs = alts.filter((a): a is Extract<AVal, { k: 'ref' }> => a.k === 'ref' && a.service === service);
    if (spec.readKind && !this.includeReads) {
      for (const ref of refs) for (const b of ref.built) this.consumed.add(nodeId(b));
      return [];
    }
    const untraced = alts
      .filter((a) => !(a.k === 'ref' && a.service === service) && a.k !== 'null' && a.k !== 'undefined')
      .map((v) => describeValue(v, service));
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
    const fieldSep = this.ev.sdk.serviceModel(service)?.nestedFieldSeparator ?? '.';
    let payload: { shape: PayloadShape; value: AVal } | undefined;
    if (spec.data !== undefined) payload = evaluateCallPayload(this.ev, this.force, call, spec, fieldSep, env);
    for (const ref of refs) {
      for (const b of ref.built) this.consumed.add(nodeId(b));
      const segments: Segment[] = spec.append ? [...ref.segments, [hole(spec.append)]] : ref.segments;
      const opName = readOpName(spec, ref);
      const notes = [...ref.notes];
      if (untraced.length > 0) notes.push(`other values of '${expressionName(refExpr)}' were not traced: ${untraced.slice(0, 2).join('; ')}`);
      if (spec.expectedRefKind && ref.refKind !== spec.expectedRefKind) {
        notes.push(`${opName} on a ${ref.refKind} ref`);
      }
      const { path, variables } = renderPath(service, segments, this.force);
      const resolution = notes.length > 0 ? 'partial' : 'resolved';
      const site: AccessSite = { ...base, op: opName, path, resolution };
      if (ref.fromCallers) CALLER_SHAPED.add(site);
      if (notes.length > 0) site.reason = notes.join('; ');
      if (variables.length > 0) site.pathVariables = variables;
      if (ref.constraints?.length) site.query = ref.constraints.map(toConstraint);
      if (payload && spec.multiPathUpdate) {
        for (const expanded of expandMultiPathSites(this.force, service, fieldSep, site, segments, payload.value)) {
          attachSiteUsage(expanded, ref, refs, refExpr, sourceNode, through, this.ev, this.force, (n) => this.source(n));
          out.push(expanded);
        }
        const multiKeys = multiPathKeys(this.force(payload.value));
        const isMultiPathField = (name: string): boolean => [...multiKeys].some((k) => name === k || name.startsWith(`${k}/`));
        const plain = payload.shape.fields.filter((f) => !isMultiPathField(f.name));
        if (plain.length > 0 || payload.shape.fields.length === 0) {
          site.payload = { ...payload.shape, fields: plain };
          attachSiteUsage(site, ref, refs, refExpr, sourceNode, through, this.ev, this.force, (n) => this.source(n));
          out.push(site);
        }
        continue;
      }
      if (payload) site.payload = payload.shape;
      attachSiteUsage(site, ref, refs, refExpr, sourceNode, through, this.ev, this.force, (n) => this.source(n));
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
    result.usage = collectProgramUsage(this.constructions, this.ev, this.force, (n) => this.source(n));
    this.sites.length = 0;
    this.seenSites.clear();
    for (const s of mergeResults([result])) this.push(s);
    return result;
  }

  private unconsumedCandidates(): UnconsumedCandidate[] {
    const out: UnconsumedCandidate[] = [];
    for (const c of this.constructions) {
      if (this.consumed.has(nodeId(c.call))) continue;
      if (c.isQuery && !this.includeReads) continue;
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
        op: c.isQuery ? 'query' : 'ref',
        source: this.source(c.call),
        resolution: 'unresolved',
        reason: `${c.name}() result never reaches a recognised read or write in the project${consumerHint(c.call)}`,
      };
      if (ref?.constraints?.length) site.query = ref.constraints.map(toConstraint);
      out.push({ key: nodeId(c.call), site, covers, report: c.reportUnconsumed });
    }
    return out;
  }
}

function readOpName(spec: OpSpec, ref: Extract<AVal, { k: 'ref' }>): string {
  if (!spec.readKind) return spec.op;
  if (ref.constraints?.length || ref.refKind === 'collection' || ref.refKind === 'collectionGroup') {
    return 'query';
  }
  return 'get';
}

function evaluateCallPayload(
  ev: Evaluator,
  force: (v: AVal) => AVal,
  call: ts.CallExpression,
  spec: OpSpec,
  fieldSeparator: '.' | '/',
  env: Env | undefined,
): { shape: PayloadShape; value: AVal } | undefined {
  const dataExpr = call.arguments[spec.data!];
  if (!dataExpr) return undefined;
  let value = ev.eval(dataExpr, env);
  const isVariadicUpdate = Boolean(spec.variadicFieldPairs) && (call.arguments.length >= 3 || literalText(force(value)) !== null);
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
  const shape = payloadShape(value, force, fieldSeparator);
  if (spec.options !== undefined && call.arguments[spec.options]) {
    if (hasMergeOption(force(ev.eval(call.arguments[spec.options], env)), force)) shape.merge = true;
  }
  return { shape, value };
}

function expandMultiPathSites(
  force: (v: AVal) => AVal,
  service: AccessService,
  fieldSeparator: '.' | '/',
  site: AccessSite,
  baseSegments: Segment[],
  value: AVal,
): AccessSite[] {
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
        const { path, variables } = renderPath(service, [...baseSegments, ...segs], force);
        const sub: AccessSite = { ...site, path, multiPath: true, payload: payloadShape(e.value, force, fieldSeparator) };
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

function describeValue(v: AVal, expectedService: AccessService): string {
  switch (v.k) {
    case 'unknown':
      return v.reason;
    case 'ref':
      return `a ${v.service} ref where a ${expectedService} ref was expected`;
    default:
      return `a ${v.k} value`;
  }
}

export function consumerHint(call: ts.CallExpression): string {
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
