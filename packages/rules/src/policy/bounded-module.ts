// Standalone-only opt-in. Functions inherit Rules expression syntax, with a
// checked integer/string/list/record value profile and bounded collection lambdas.
import * as ohm from 'ohm-js';
import { firestoreGrammar, firestoreSemantics } from '../grammar/FirestoreParser.js';
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { boundSourceNesting } from '../grammar/source-nesting-bound.js';
import { boundedRuntime } from './bounded-runtime.js';

const grammar = ohm.grammar(
  `BoundedPolicy <: FirestoreRules {
  Module = "use" "extension" "bounded" ";" FunctionDef+
  Primary += Traversal
  Traversal = "bounded." operation "(" Expr "," ident "=>" Expr "," digit+ ")"
  operation = "flatMap" | "map" | "select" | "any"
}`,
  { FirestoreRules: firestoreGrammar },
);
interface Traversal {
  type: 'traversal';
  op: string;
  list: Expression;
  item: string;
  body: Expression;
  limit: number;
}
const semantics = grammar.extendSemantics(firestoreSemantics);
semantics.extendOperation<Traversal | FunctionDef[]>('toAST', {
  Module(_use, _extension, _bounded, _semi, fns) {
    return fns.children.map((fn) => fn.toAST());
  },
  Traversal(_bounded, op, _open, list, _comma, item, _arrow, body, _comma2, limit, _close): Traversal {
    return {
      type: 'traversal',
      op: op.sourceString,
      list: list.toAST(),
      item: item.sourceString,
      body: body.toAST(),
      limit: Number(limit.sourceString),
    };
  },
});
const arities = new Map(
  Object.entries({
    size: 1,
    replaceAt: 3,
    range: 1,
    locate: 2,
    sorted: 1,
    chain: 2,
    omit: 2,
    fail: 1,
    abs: 1,
    sign: 1,
    kind: 1,
  }),
);
const reservedExport = new Set(['default', 'await', 'yield', 'eval', 'arguments']);
function reject(message: string): never {
  throw new Error(message);
}

export function compileBoundedModule(source: string): {
  target: 'standalone';
  moduleSource: string;
  exports: string[];
} {
  if (source.length > 32768) reject('Module exceeds 32768 characters');
  const nesting = boundSourceNesting(source);
  if ('offset' in nesting || nesting.elided?.length) reject('Module exceeds parser nesting limit');
  const matched = grammar.match(source, 'Module');
  if (matched.failed()) reject(matched.message ?? 'Invalid bounded module');
  const definitions: FunctionDef[] = semantics(matched).toAST();
  const names = new Map<string, { id: number; fn: FunctionDef }>();
  for (const fn of definitions) {
    if (names.has(fn.name) || arities.has(fn.name)) reject('Duplicate function ' + fn.name);
    if (reservedExport.has(fn.name)) reject('Reserved function name ' + fn.name);
    names.set(fn.name, { id: names.size, fn });
  }

  const calls = new Map<string, Set<string>>();
  const code: string[] = [boundedRuntime];
  const exported: string[] = [];
  for (const [name, { id, fn }] of names) {
    const deps = new Set<string>();
    calls.set(name, deps);
    const scope = new Map<string, string>();
    let nextId = 0;
    const bind = (label: string) => {
      if (scope.has(label)) reject('Duplicate binding ' + label);
      const js = 'v' + nextId++;
      scope.set(label, js);
      return js;
    };
    const args = fn.parameters.map(bind);
    let cost = 1;
    function emit(e: Expression | Traversal, bindings = scope): string {
      cost++;
      const child = (v: Expression) => emit(v, bindings);
      switch (e.type) {
        case 'literal':
          if (e.value instanceof Uint8Array || (typeof e.value === 'number' && !Number.isSafeInteger(e.value)))
            reject('Expected a scalar literal or safe integer');
          return JSON.stringify(e.value);
        case 'identifier':
          return bindings.get(e.name) ?? reject('Undeclared binding ' + e.name);
        case 'memberAccess':
          return `$.index(${child(e.object)},${JSON.stringify(e.property)})`;
        case 'bracketAccess':
          return `$.index(${child(e.object)},${child(e.index)})`;
        case 'listLiteral':
          return '$.makeList([' + e.elements.map(child).join(', ') + '])';
        case 'mapLiteral': {
          const keys = new Set<string>();
          const entries = e.entries.map(({ key, value }) => {
            const k =
              key.type === 'identifier'
                ? key.name
                : key.type === 'literal' && typeof key.value === 'string'
                  ? key.value
                  : reject('Expected a static record key');
            if (keys.has(k)) reject('Duplicate record key ' + k);
            keys.add(k);
            return '[' + JSON.stringify(k) + ']:' + child(value);
          });
          return '$.makeRecord({' + entries.join(', ') + '})';
        }
        case 'unaryOp':
          return (e.op === '!' ? '$.not(' : '$.neg(') + child(e.operand) + ')';
        case 'binaryOp': {
          const a = child(e.left),
            b = child(e.right);
          if (e.op === '&&' || e.op === '||') {
            return `$.logical(${e.op === '||'},() => ${a},() => ${b})`;
          }
          return `$.binary(${JSON.stringify(e.op)},${a},${b})`;
        }
        case 'ternary':
          return `$.choose(${child(e.condition)},() => ${child(e.consequent)},() => ${child(e.alternate)})`;
        case 'functionCall': {
          const argc = e.args.length;
          const callee = names.get(e.name);
          if (callee) {
            if (argc !== callee.fn.parameters.length) reject('Invalid arity for ' + e.name);
            deps.add(e.name);
            return 'p' + callee.id + '($' + e.args.map((a) => ', ' + child(a)).join('') + ')';
          }
          if (arities.get(e.name) !== argc) reject('Unknown function or invalid arity for ' + e.name);
          return '$.' + e.name + '(' + e.args.map(child).join(', ') + ')';
        }
        case 'traversal': {
          if (!Number.isInteger(e.limit) || e.limit < 1 || e.limit > 4096) reject('Invalid traversal bound');
          const variable = 'v' + nextId++;
          const local = new Map(bindings).set(e.item, variable);
          return `$.traverse(${JSON.stringify(e.op)},${child(e.list)},${variable} => ${emit(e.body, local)},${e.limit})`;
        }
        default:
          return reject('Unsupported standalone expression ' + e.type);
      }
    }
    const body = [];
    for (const letBinding of fn.lets) {
      const value = emit(letBinding.value);
      body.push('  const ' + bind(letBinding.name) + ' = ' + value + ';');
    }
    body.push('  return ' + emit(fn.body) + ';');
    body.unshift('  $.tick(' + cost + ');');
    code.push(`// ${name}\nfunction p${id}($${args.map((a) => ', ' + a).join('')}) {\n${body.join('\n')}\n}`);
    if (fn.exported) {
      exported.push(name);
      // An alias allows Rules identifiers such as "class" and "with".
      code.push(
        `function entry${id}(...args) { if(args.length !== ${args.length}) throw new Error("Invalid argument count"); const $ = runtime(); return $.read(p${id}($, ...args.map(v => $.data(v)))); }\nexport { entry${id} as ${name} };`,
      );
    }
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(name: string) {
    if (active.has(name)) reject('Recursive calls are unsupported at ' + name);
    if (visited.has(name)) return;
    active.add(name);
    for (const dep of calls.get(name)!) visit(dep);
    active.delete(name);
    visited.add(name);
  }
  for (const name of names.keys()) visit(name);
  if (!exported.length) reject('Bounded module needs a public function');
  return { target: 'standalone', moduleSource: code.join('\n\n') + '\n', exports: exported };
}
