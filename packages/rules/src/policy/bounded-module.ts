// Standalone zero-dependency ES module compiler built on the unified Policy IR.
// Emits portable JavaScript modules with Rules-v2-faithful values, static acyclicity,
// bounded iteration, prototype/accessor hardening, and non-absorbable tick budgets.
import { isNegatedLiteral } from '../grammar/compile-limits.js';
import { boundedRuntime } from './bounded-runtime.js';
import {
  checkPolicyIR,
  RULES_CONVERSION_ARITIES,
  RULES_NAMESPACE_METHODS,
  STANDALONE_HELPER_ARITIES,
  type CheckOptions,
  type CheckedFunction,
  type CheckedPolicyIR,
} from './check.js';
import { isPureRulesExpr, parsePolicyIR, type IRExpr, type IRLetBinding } from './ir.js';

export interface StandaloneModuleResult {
  target: 'standalone';
  moduleSource: string;
  exports: string[];
}

function reject(message: string): never {
  throw new Error(message);
}

function emitLiteral(expr: Extract<IRExpr, { type: 'literal' }>): string {
  if (expr.value instanceof Uint8Array) {
    return `$.bytes([${Array.from(expr.value).join(',')}])`;
  }
  if (typeof expr.value === 'number') {
    if (expr.raw.includes('.') || !/^\d+$/.test(expr.raw)) {
      const num = Object.is(expr.value, -0) ? '-0' : JSON.stringify(expr.value);
      return `$.flt(${num})`;
    }
    return `${expr.raw}n`;
  }
  return JSON.stringify(expr.value);
}

interface EmitState {
  fnMap: ReadonlyMap<string, CheckedFunction>;
  nextId: number;
  cost: number;
}

function emitExpr(e: IRExpr, bindings: ReadonlyMap<string, string>, state: EmitState): string {
  state.cost++;
  const child = (v: IRExpr, scope = bindings) => emitExpr(v, scope, state);

  switch (e.type) {
    case 'literal':
      return emitLiteral(e);
    case 'identifier':
      return bindings.get(e.name) ?? reject('Undeclared binding ' + e.name);
    case 'memberAccess':
      return `$.member(${child(e.object)},${JSON.stringify(e.property)})`;
    case 'bracketAccess':
      return `$.indexAt(${child(e.index)},${child(e.object)})`;
    case 'sliceAccess':
      return `$.slice(${child(e.object)},${child(e.start)},${child(e.end)})`;
    case 'listLiteral':
      return '$.makeList([' + e.elements.map((el) => child(el)).join(', ') + '])';
    case 'mapLiteral': {
      const pairs = e.entries.map(({ key, value }) => {
        const kExpr =
          key.type === 'identifier'
            ? JSON.stringify(key.name)
            : key.type === 'literal' && typeof key.value === 'string'
              ? JSON.stringify(key.value)
              : child(key);
        return `[${kExpr},${child(value)}]`;
      });
      return '$.makeRecord([' + pairs.join(', ') + '])';
    }
    case 'unaryOp': {
      if (e.op === '!') return `$.not(${child(e.operand)})`;
      if (
        e.op === '-' &&
        e.operand.type === 'literal' &&
        typeof e.operand.value === 'number' &&
        /^\d+$/.test(e.operand.raw) &&
        isPureRulesExpr(e) &&
        isNegatedLiteral(e, true)
      ) {
        return `(-${e.operand.raw}n)`;
      }
      return `$.neg(${child(e.operand)})`;
    }
    case 'binaryOp': {
      const a = child(e.left);
      const b = child(e.right);
      if (e.op === '&&' || e.op === '||') {
        return `$.logical(${e.op === '||'},() => ${a},() => ${b})`;
      }
      return `$.binary(${JSON.stringify(e.op)},${a},${b})`;
    }
    case 'inExpr':
      return `$.inOp(${child(e.collection)},${child(e.element)})`;
    case 'isExpr':
      return `$.isOp(${child(e.value)},${JSON.stringify(e.typeName)})`;
    case 'ternary':
      return `$.choose(${child(e.condition)},() => ${child(e.consequent)},() => ${child(e.alternate)})`;
    case 'methodCall': {
      if (
        e.object.type === 'identifier' &&
        !bindings.has(e.object.name) &&
        Object.hasOwn(RULES_NAMESPACE_METHODS, e.object.name)
      ) {
        const args = e.args.map((a) => ', ' + child(a)).join('');
        return `$.ns(${JSON.stringify(e.object.name)},${JSON.stringify(e.method)}${args})`;
      }
      const args = e.args.map((a) => ', ' + child(a)).join('');
      return `$.method(${child(e.object)},${JSON.stringify(e.method)}${args})`;
    }
    case 'functionCall': {
      const callee = state.fnMap.get(e.name);
      if (callee) {
        return 'p' + callee.id + '($' + e.args.map((a) => ', ' + child(a)).join('') + ')';
      }
      if (RULES_CONVERSION_ARITIES.has(e.name)) {
        return `$.conv(${JSON.stringify(e.name)},${child(e.args[0]!)})`;
      }
      if (STANDALONE_HELPER_ARITIES.has(e.name)) {
        return '$.' + e.name + '(' + e.args.map((a) => child(a)).join(', ') + ')';
      }
      return reject('Unknown function ' + e.name);
    }
    case 'boundedOp': {
      if (e.op === 'append') {
        return `$.append(${child(e.list)},${child(e.suffix)},${e.limit})`;
      }
      if (e.op === 'fold') {
        const accVar = 'v' + state.nextId++;
        const itemVar = 'v' + state.nextId++;
        const local = new Map(bindings);
        local.set(e.accumulator, accVar);
        local.set(e.item, itemVar);
        const stmts: string[] = [];
        for (const letBinding of e.lets) {
          const valCode = emitExpr(letBinding.value, local, state);
          const v = 'v' + state.nextId++;
          local.set(letBinding.name, v);
          stmts.push(`const ${v} = ${valCode};`);
        }
        const retCode = emitExpr(e.body, local, state);
        const bodyCode = stmts.length ? `{ ${stmts.join(' ')} return ${retCode}; }` : retCode;
        return `$.fold(${child(e.list)},${child(e.initial)},(${accVar}, ${itemVar}) => ${bodyCode},${e.limit})`;
      }
      const itemVar = 'v' + state.nextId++;
      const local = new Map(bindings).set(e.item, itemVar);
      return `$.traverse(${JSON.stringify(e.op)},${child(e.list)},${itemVar} => ${emitExpr(e.body, local, state)},${e.limit})`;
    }
    default:
      return reject('Unsupported standalone expression ' + e.type);
  }
}

function emitLets(
  lets: readonly IRLetBinding[],
  scope: Map<string, string>,
  state: EmitState,
  mutableNames?: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];
  for (const letBinding of lets) {
    const val = emitExpr(letBinding.value, scope, state);
    const v = 'v' + state.nextId++;
    scope.set(letBinding.name, v);
    const decl = mutableNames?.has(letBinding.name) ? 'let' : 'const';
    lines.push(`  ${decl} ${v} = ${val};`);
  }
  return lines;
}

function emitFunction(
  checked: CheckedFunction,
  fnMap: ReadonlyMap<string, CheckedFunction>,
  forceExport: boolean,
  budget: number,
): { code: string[]; exportName?: string } {
  const { id, fn, loop } = checked;
  const scope = new Map<string, string>();
  const state: EmitState = { fnMap, nextId: 0, cost: 1 };
  const args = fn.parameters.map((param) => {
    const v = 'v' + state.nextId++;
    scope.set(param, v);
    return v;
  });
  const mutable = new Set<string>();
  if (loop && loop.step.kind === 'update') mutable.add(loop.step.target);

  const body = emitLets(fn.lets, scope, state, mutable);
  if (loop) {
    const itemsVar = 'v' + state.nextId++;
    const itemVar = 'v' + state.nextId++;
    const idxVar = 'v' + state.nextId++;
    body.push(`  const ${itemsVar} = $.read($.loopList(${emitExpr(loop.input, scope, state)}, ${loop.limit}));`);
    const innerScope = new Map(scope).set(loop.item, itemVar);
    body.push(`  for (let ${idxVar} = 0; ${idxVar} < ${itemsVar}.length; ${idxVar}++) {`);
    body.push('    $.tick();');
    body.push(`    const ${itemVar} = ${itemsVar}[${idxVar}];`);
    if (loop.step.kind === 'guards') {
      for (const guard of loop.step.guards) {
        body.push(`    if ($.read($.bool(${emitExpr(guard.condition, innerScope, state)}))) return ${emitExpr(guard.result, innerScope, state)};`);
      }
    } else {
      const targetVar = scope.get(loop.step.target)!;
      body.push(`    ${targetVar} = $.read(${emitExpr(loop.step.value, innerScope, state)});`);
    }
    body.push('  }');
  }
  body.push('  return ' + emitExpr(fn.body, scope, state) + ';');
  body.unshift('  $.tick(' + state.cost + ');');

  const lines: string[] = [];
  const fnBody = loop
    ? `  try {\n${body.join('\n')}\n  } catch (e) {\n    if (e instanceof Error && e.constructor.name === 'RuleError') return e;\n    throw e;\n  }`
    : body.join('\n');
  lines.push(`// ${fn.name}\nfunction p${id}($${args.map((a) => ', ' + a).join('')}) {\n${fnBody}\n}`);
  const shouldExport = forceExport || fn.exported;
  if (shouldExport) {
    lines.push(
      `function entry${id}(...args) { if(args.length !== ${args.length}) throw new Error("Invalid argument count"); const $ = runtime(${budget}); return $.exportVal($.read(p${id}($, ...args.map(v => $.data(v))))); }\nexport { entry${id} as ${fn.name} };`,
    );
    return { code: lines, exportName: fn.name };
  }
  return { code: lines };
}

function emitTransitionExports(checked: CheckedPolicyIR): { code: string[]; exports: string[] } {
  const transition = checked.program.transition!;
  const budget = checked.expressionLimit;
  const code: string[] = [];
  const exports: string[] = [];

  if (transition.derivation) {
    const state: EmitState = { fnMap: checked.functions, nextId: 0, cost: 1 };
    const scope = new Map<string, string>([
      ['before', 'before'],
      ['input', 'input'],
    ]);
    const lines = emitLets(transition.derivation.lets, scope, state);
    const traceRecs = transition.derivation.lets.map((l) => {
      const v = scope.get(l.name)!;
      const spanPart = l.loc
        ? `, span: { line: ${l.loc.line}, col: ${l.loc.col}, location: ${JSON.stringify(`${l.loc.line}:${l.loc.col}`)} }`
        : '';
      return `  if (traceBindings) traceBindings.push({ name: ${JSON.stringify(l.name)}, scope: "derive", ...( ${v} instanceof Error ? { error: ${v}.message } : { value: safeTrace(${v}) })${spanPart} });`;
    });
    lines.push(...traceRecs);
    lines.push(`  return ${emitExpr(transition.derivation.expr, scope, state)};`);
    lines.unshift(`  $.tick(${state.cost});`);
    code.push(`function deriveImpl($, before, input, traceBindings, safeTrace) {\n${lines.join('\n')}\n}`);
    code.push(
      `export function derive(start) { const $ = runtime(${budget}); const before = $.data(start.before); const input = start.input === undefined ? Object.create(null) : $.data(start.input); return $.exportVal($.read(deriveImpl($, before, input))); }`,
    );
    exports.push('derive');
  }

  const ruleBlocks: string[] = [];
  for (const rule of transition.requirements) {
    const state: EmitState = { fnMap: checked.functions, nextId: 0, cost: 1 };
    const scope = new Map<string, string>([
      ['before', 'before'],
      ['after', 'after'],
      ['input', 'input'],
    ]);
    const spanObj = rule.loc
      ? `{ line: ${rule.loc.line}, col: ${rule.loc.col}, location: ${JSON.stringify(rule.location)} }`
      : `{ line: 1, col: 1, location: ${JSON.stringify(rule.location)} }`;
    const stmts: string[] = [];
    if (checked.usesDerived.has(rule.name)) {
      scope.set('derived', 'derivedVal');
      stmts.push('      if (!hasDerived) { hasDerived = true; derivedVal = deriveImpl($, before, input, deriveBindings, safeTrace); }');
    }
    for (const line of emitLets(rule.lets, scope, state)) stmts.push('    ' + line);
    for (const l of rule.lets) {
      const v = scope.get(l.name)!;
      const loc = l.loc ? `span: { line: ${l.loc.line}, col: ${l.loc.col}, location: ${JSON.stringify(`${l.loc.line}:${l.loc.col}`)} }, ` : '';
      stmts.push(`      reqBindings.push({ name: ${JSON.stringify(l.name)}, scope: "require", ${loc}...( ${v} instanceof Error ? { error: ${v}.message } : { value: safeTrace(${v}) }) });`);
    }
    const deriveSpread = checked.usesDerived.has(rule.name) ? '...deriveBindings, ' : '';
    const mkTrace = (outcome: string, fatal: boolean, errExpr: string) =>
      `{ requirement: ${JSON.stringify(rule.name)}, span: ${spanObj}, source: ${JSON.stringify(rule.source)}, outcome: ${JSON.stringify(outcome)}, fatal: ${fatal}, bindings: [${deriveSpread}...reqBindings], failingSubExpression: { source: ${JSON.stringify(rule.source)}, kind: ${JSON.stringify(rule.condition.type)}, ${errExpr} }, expressionUnitsUsed: $.used(), expressionLimit: ${budget} }`;
    const condCode = emitExpr(rule.condition, scope, state);
    stmts.unshift(`      $.tick(${state.cost});`);
    stmts.push(`      const ok = $.read(${condCode});`);
    stmts.push(
      `      if (ok !== true) return { ok: false, requirement: ${JSON.stringify(rule.name)}, location: ${JSON.stringify(rule.location)}, reason: ${JSON.stringify('Requirement failed: ' + rule.source)}, trace: ${mkTrace('false', false, 'value: false')} };`,
    );
    ruleBlocks.push(
      `  {\n    const reqBindings = [];\n    try {\n${stmts.join('\n')}\n    } catch (err) {\n      if (err instanceof Error && err.constructor.name === 'RuleError') return { ok: false, requirement: ${JSON.stringify(rule.name)}, location: ${JSON.stringify(rule.location)}, reason: err.message, trace: ${mkTrace('eval-error', false, 'error: err.message')} };\n      if (err instanceof Error && err.constructor.name === 'ResourceLimitError') return { ok: false, requirement: ${JSON.stringify(rule.name)}, location: ${JSON.stringify(rule.location)}, reason: err.message, fatal: true, trace: ${mkTrace('resource-limit', true, 'error: err.message')} };\n      throw err;\n    }\n  }`,
    );
  }

  const safeTraceDef =
    `  const safeTrace = (x, d = 0, st = { n: 0 }) => ++st.n > 512 ? { $truncated: 'max-nodes' } : d > 12 ? { $truncated: 'max-depth' } : typeof x === 'bigint' ? (x >= -9007199254740991n && x <= 9007199254740991n ? Number(x) : { $int64: String(x) }) : typeof x === 'string' ? (x.length > 512 ? x.slice(0, 512) + '...(truncated)' : x) : typeof x === 'number' ? (Object.is(x, -0) ? { $float: '-0' } : Number.isFinite(x) ? x : { $float: String(x) }) : x && x.constructor && x.constructor.name === 'FloatVal' ? safeTrace(x.v, d + 1, st) : x && x.constructor && x.constructor.name === 'BytesVal' ? { $bytes: Array.from(x.d.slice(0, 64)), size: x.d.length } : x && x.constructor && x.constructor.name === 'TimestampVal' ? { $timestamp: { seconds: x.s, nanos: x.n } } : x && x.constructor && x.constructor.name === 'DurationVal' ? { $duration: { seconds: x.s, nanos: x.n } } : x && x.constructor && x.constructor.name === 'SetVal' ? { $set: x.items.slice(0, 64).map((v) => safeTrace(v, d + 1, st)) } : Array.isArray(x) ? x.slice(0, 64).map((v) => safeTrace(v, d + 1, st)) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).slice(0, 64).map((k) => [k, safeTrace(x[k], d + 1, st)])) : x === undefined ? null : x;`;
  const header = transition.derivation ? '  let hasDerived = false, derivedVal; const deriveBindings = [];' : '';
  code.push(
    `export function judge(transition) {\n  const $ = runtime(${budget});\n${safeTraceDef}\n  const before = $.data(transition.before);\n  const after = $.data(transition.after);\n  const input = transition.input === undefined ? Object.create(null) : $.data(transition.input);\n${header}\n${ruleBlocks.join('\n')}\n  return { ok: true };\n}`,
  );
  exports.push('judge');
  return { code, exports };
}

/** Emit a zero-dependency standalone ES module from any checked Policy IR. */
export function emitStandaloneModule(checked: CheckedPolicyIR): StandaloneModuleResult {
  const code: string[] = [boundedRuntime];
  const exports: string[] = [];
  const forceExport = checked.program.kind === 'function';
  const budget = checked.expressionLimit;

  for (const fn of checked.functions.values()) {
    const emitted = emitFunction(fn, checked.functions, forceExport, budget);
    code.push(...emitted.code);
    if (emitted.exportName) exports.push(emitted.exportName);
  }
  if (checked.program.transition) {
    const emitted = emitTransitionExports(checked);
    code.push(...emitted.code);
    exports.push(...emitted.exports);
  }
  return {
    target: 'standalone',
    moduleSource: code.join('\n\n') + '\n',
    exports,
  };
}

/** Compile a `use extension bounded;` policy module into a standalone ES module. */
export function compileBoundedModule(source: string, options?: CheckOptions): StandaloneModuleResult {
  const ir = parsePolicyIR(source, 'module');
  const checked = checkPolicyIR(ir, options);
  return emitStandaloneModule(checked);
}
