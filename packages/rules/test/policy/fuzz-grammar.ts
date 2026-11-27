// Deterministic seeded expression & policy program generators with AST shrinking
// for multi-engine differential fuzzing (interpreter, ES module, Firestore, RTDB, Storage).
import type { SeededRng } from './fuzz-prng.js';
import { EDGE_STRINGS, SAFE_MAP_KEYS } from './fuzz-values.js';

export type ExprType = 'any' | 'bool' | 'num' | 'int' | 'str' | 'list' | 'map';

export type FuzzExpr =
  | { readonly kind: 'lit'; readonly value: number | string | boolean | null; readonly raw?: string }
  | { readonly kind: 'var'; readonly name: string }
  | { readonly kind: 'field'; readonly object: FuzzExpr; readonly prop: string }
  | { readonly kind: 'index'; readonly object: FuzzExpr; readonly index: FuzzExpr }
  | { readonly kind: 'unary'; readonly op: '!' | '-'; readonly operand: FuzzExpr }
  | { readonly kind: 'binary'; readonly op: string; readonly left: FuzzExpr; readonly right: FuzzExpr }
  | { readonly kind: 'ternary'; readonly cond: FuzzExpr; readonly yes: FuzzExpr; readonly no: FuzzExpr }
  | { readonly kind: 'is'; readonly value: FuzzExpr; readonly typeName: string }
  | { readonly kind: 'in'; readonly elem: FuzzExpr; readonly coll: FuzzExpr }
  | { readonly kind: 'method'; readonly object: FuzzExpr; readonly name: string; readonly args: readonly FuzzExpr[] }
  | { readonly kind: 'list'; readonly items: readonly FuzzExpr[] }
  | { readonly kind: 'map'; readonly entries: readonly (readonly [string, FuzzExpr])[] };

export interface FuzzLet {
  readonly name: string;
  readonly value: FuzzExpr;
}

export interface FuzzFunctionProgram {
  readonly kind: 'function';
  readonly name: string;
  readonly params: readonly string[];
  readonly lets: readonly FuzzLet[];
  readonly body: FuzzExpr;
  readonly extensions?: readonly string[];
}

export interface FuzzTransitionProgram {
  readonly kind: 'transition';
  readonly name: string;
  readonly extensions?: readonly string[];
  readonly requirements: readonly { readonly name: string; readonly expr: FuzzExpr }[];
}

const REGEX_PATTERNS: readonly string[] = [
  '^[a-z]+$',
  '^[a-z0-9_/-]+$',
  '^audio/(wav|ogg|mpeg)$',
  '^image/(png|jpeg)$',
  '^users/[a-z]+$',
  '^[0-9]+$',
];

const STANDALONE_INT_LITERALS: readonly string[] = [
  '0', '1', '2', '3', '5', '7', '10', '42',
  '9007199254740991',
  '9223372036854775807',
];

const STANDALONE_FLOAT_LITERALS: readonly string[] = [
  '0.0', '0.5', '1.0', '1.5', '2.5', '10.25',
];

export function printExpr(expr: FuzzExpr): string {
  switch (expr.kind) {
    case 'lit':
      if (expr.raw !== undefined) return expr.raw;
      if (expr.value === null) return 'null';
      if (typeof expr.value === 'string') return JSON.stringify(expr.value);
      return String(expr.value);
    case 'var':
      return expr.name;
    case 'field':
      return '(' + printExpr(expr.object) + ').' + expr.prop;
    case 'index':
      return '(' + printExpr(expr.object) + ')[' + printExpr(expr.index) + ']';
    case 'unary':
      return '(' + expr.op + '(' + printExpr(expr.operand) + '))';
    case 'binary':
      return '(' + printExpr(expr.left) + ' ' + expr.op + ' ' + printExpr(expr.right) + ')';
    case 'ternary':
      return '(' + printExpr(expr.cond) + ' ? ' + printExpr(expr.yes) + ' : ' + printExpr(expr.no) + ')';
    case 'is':
      return '(' + printExpr(expr.value) + ' is ' + expr.typeName + ')';
    case 'in':
      return '(' + printExpr(expr.elem) + ' in ' + printExpr(expr.coll) + ')';
    case 'method':
      return '(' + printExpr(expr.object) + ').' + expr.name + '(' + expr.args.map(printExpr).join(', ') + ')';
    case 'list':
      return '[' + expr.items.map(printExpr).join(', ') + ']';
    case 'map':
      return '{' + expr.entries.map(([k, v]) => JSON.stringify(k) + ': ' + printExpr(v)).join(', ') + '}';
  }
}

export function printFunction(prog: FuzzFunctionProgram): string {
  const ext = (prog.extensions ?? []).map((e) => `use extension ${e};\n`).join('');
  const lets = prog.lets.map((l) => `  let ${l.name} = ${printExpr(l.value)};\n`).join('');
  return `${ext}function ${prog.name}(${prog.params.join(', ')}) {\n${lets}  return ${printExpr(prog.body)};\n}`;
}

export function printTransition(prog: FuzzTransitionProgram): string {
  const ext = (prog.extensions ?? []).map((e) => `use extension ${e};\n`).join('');
  const reqs = prog.requirements
    .map((r) => `  require ${r.name} {\n    return ${printExpr(r.expr)};\n  }`)
    .join('\n');
  return `${ext}transition ${prog.name} {\n${reqs}\n}`;
}

// Structural AST shrinker yielding strictly smaller valid sub-expressions.
export function* shrinkExpr(expr: FuzzExpr): Generator<FuzzExpr> {
  switch (expr.kind) {
    case 'lit':
      if (typeof expr.value === 'number' && expr.value !== 0) yield { kind: 'lit', value: 0, raw: '0' };
      if (typeof expr.value === 'string' && expr.value !== '') yield { kind: 'lit', value: '' };
      return;
    case 'var':
      return;
    case 'field':
      yield expr.object;
      for (const s of shrinkExpr(expr.object)) yield { kind: 'field', object: s, prop: expr.prop };
      return;
    case 'index':
      yield expr.object;
      yield expr.index;
      for (const s of shrinkExpr(expr.object)) yield { kind: 'index', object: s, index: expr.index };
      for (const s of shrinkExpr(expr.index)) yield { kind: 'index', object: expr.object, index: s };
      return;
    case 'unary':
      yield expr.operand;
      for (const s of shrinkExpr(expr.operand)) yield { kind: 'unary', op: expr.op, operand: s };
      return;
    case 'binary':
      yield expr.left;
      yield expr.right;
      for (const s of shrinkExpr(expr.left)) yield { kind: 'binary', op: expr.op, left: s, right: expr.right };
      for (const s of shrinkExpr(expr.right)) yield { kind: 'binary', op: expr.op, left: expr.left, right: s };
      return;
    case 'ternary':
      yield expr.yes;
      yield expr.no;
      yield expr.cond;
      for (const s of shrinkExpr(expr.cond)) yield { kind: 'ternary', cond: s, yes: expr.yes, no: expr.no };
      for (const s of shrinkExpr(expr.yes)) yield { kind: 'ternary', cond: expr.cond, yes: s, no: expr.no };
      for (const s of shrinkExpr(expr.no)) yield { kind: 'ternary', cond: expr.cond, yes: expr.yes, no: s };
      return;
    case 'is':
      yield expr.value;
      for (const s of shrinkExpr(expr.value)) yield { kind: 'is', value: s, typeName: expr.typeName };
      return;
    case 'in':
      yield expr.elem;
      yield expr.coll;
      for (const s of shrinkExpr(expr.elem)) yield { kind: 'in', elem: s, coll: expr.coll };
      for (const s of shrinkExpr(expr.coll)) yield { kind: 'in', elem: expr.elem, coll: s };
      return;
    case 'method':
      yield expr.object;
      for (const s of shrinkExpr(expr.object)) yield { kind: 'method', object: s, name: expr.name, args: expr.args };
      for (let i = 0; i < expr.args.length; i++) {
        for (const s of shrinkExpr(expr.args[i]!)) {
          const nextArgs = [...expr.args];
          nextArgs[i] = s;
          yield { kind: 'method', object: expr.object, name: expr.name, args: nextArgs };
        }
      }
      return;
    case 'list':
      if (expr.items.length > 0) {
        yield { kind: 'list', items: [] };
        for (let i = 0; i < expr.items.length; i++) {
          yield { kind: 'list', items: [...expr.items.slice(0, i), ...expr.items.slice(i + 1)] };
        }
      }
      return;
    case 'map':
      if (expr.entries.length > 0) {
        yield { kind: 'map', entries: [] };
        for (let i = 0; i < expr.entries.length; i++) {
          yield { kind: 'map', entries: [...expr.entries.slice(0, i), ...expr.entries.slice(i + 1)] };
        }
      }
      return;
  }
}

export function* shrinkFunctionProgram(prog: FuzzFunctionProgram): Generator<FuzzFunctionProgram> {
  for (let i = 0; i < prog.lets.length; i++) {
    yield { ...prog, lets: [...prog.lets.slice(0, i), ...prog.lets.slice(i + 1)] };
  }
  for (const body of shrinkExpr(prog.body)) {
    yield { ...prog, body };
  }
  for (let i = 0; i < prog.lets.length; i++) {
    for (const value of shrinkExpr(prog.lets[i]!.value)) {
      const next = [...prog.lets];
      next[i] = { ...next[i]!, value };
      yield { ...prog, lets: next };
    }
  }
}

export interface GeneratorConfig {
  readonly vars: readonly string[];
  readonly maxDepth: number;
  readonly allowFloats?: boolean;
  readonly allowDiv?: boolean;
  readonly allowMod?: boolean;
  readonly allowNull?: boolean;
  readonly allowIs?: boolean;
  readonly allowIn?: boolean;
  readonly allowIndex?: boolean;
  readonly allowCollections?: boolean;
  readonly allowMethods?: boolean;
  readonly allowMatches?: boolean;
  readonly mapKeys?: readonly string[];
  readonly isTypes?: readonly string[];
}

function genLiteral(rng: SeededRng, wanted: ExprType, cfg: GeneratorConfig): FuzzExpr {
  const allowFloats = cfg.allowFloats ?? true;
  const allowNull = cfg.allowNull ?? true;
  if (wanted === 'bool') return { kind: 'lit', value: rng.bool() };
  if (wanted === 'str') return { kind: 'lit', value: rng.pick(EDGE_STRINGS) };
  if (wanted === 'int') {
    const raw = rng.bool(0.35) ? rng.pick(STANDALONE_INT_LITERALS) : String(rng.int(0, 12));
    return { kind: 'lit', value: Number(raw), raw };
  }
  if (wanted === 'num') {
    if (allowFloats && rng.bool(0.35)) {
      const raw = rng.pick(STANDALONE_FLOAT_LITERALS);
      return { kind: 'lit', value: Number(raw), raw };
    }
    const raw = rng.bool(0.3) ? rng.pick(STANDALONE_INT_LITERALS) : String(rng.int(0, 12));
    return { kind: 'lit', value: Number(raw), raw };
  }
  if (wanted === 'list' && cfg.allowCollections) {
    return { kind: 'list', items: [genLiteral(rng, 'int', cfg), genLiteral(rng, 'str', cfg)] };
  }
  if (wanted === 'map' && cfg.allowCollections) {
    const k = rng.pick(cfg.mapKeys ?? SAFE_MAP_KEYS);
    return { kind: 'map', entries: [[k, genLiteral(rng, 'int', cfg)]] };
  }
  const choice = rng.weighted([
    [3, 'num'],
    [2, 'bool'],
    [2, 'str'],
    [allowNull ? 1 : 0, 'null'],
  ]);
  if (choice === 'null') return { kind: 'lit', value: null };
  return genLiteral(rng, choice as ExprType, cfg);
}

function genLeaf(rng: SeededRng, wanted: ExprType, cfg: GeneratorConfig): FuzzExpr {
  const keys = cfg.mapKeys ?? SAFE_MAP_KEYS;
  const useVar = cfg.vars.length > 0 && rng.bool(0.6);
  if (!useVar) return genLiteral(rng, wanted, cfg);
  const v: FuzzExpr = { kind: 'var', name: rng.pick(cfg.vars) };
  if (rng.bool(0.55)) return v;
  return { kind: 'field', object: v, prop: rng.pick(keys) };
}

export function generateExpr(rng: SeededRng, wanted: ExprType, cfg: GeneratorConfig, depth = 0): FuzzExpr {
  if (depth >= cfg.maxDepth) return genLeaf(rng, wanted, cfg);
  const sub = (t: ExprType) => generateExpr(rng, t, cfg, depth + 1);
  const allowDiv = cfg.allowDiv ?? true;
  const allowMod = cfg.allowMod ?? true;
  const allowIs = cfg.allowIs ?? true;
  const allowIn = cfg.allowIn ?? true;
  const allowIndex = cfg.allowIndex ?? true;
  const allowCollections = cfg.allowCollections ?? true;
  const allowMethods = cfg.allowMethods ?? true;
  const allowMatches = cfg.allowMatches ?? false;
  const keys = cfg.mapKeys ?? SAFE_MAP_KEYS;

  if (wanted === 'bool') {
    const kind = rng.weighted([
      [2, 'leaf'],
      [4, 'logic'],
      [3, 'cmp'],
      [3, 'eq'],
      [2, 'not'],
      [2, 'ternary'],
      [allowIs ? 2 : 0, 'is'],
      [allowIn ? 2 : 0, 'in'],
      [allowMatches ? 2 : 0, 'matches'],
    ]);
    switch (kind) {
      case 'leaf':
        return genLeaf(rng, 'bool', cfg);
      case 'logic':
        return { kind: 'binary', op: rng.pick(['&&', '||']), left: sub('bool'), right: sub('bool') };
      case 'not':
        return { kind: 'unary', op: '!', operand: sub('bool') };
      case 'cmp': {
        const cmpType = rng.bool(0.75) ? 'num' : 'str';
        return { kind: 'binary', op: rng.pick(['<', '<=', '>', '>=']), left: sub(cmpType), right: sub(cmpType) };
      }
      case 'eq': {
        const eqType = rng.pick<ExprType>(['any', 'num', 'str', 'bool']);
        return { kind: 'binary', op: rng.pick(['==', '!=']), left: sub(eqType), right: sub(eqType) };
      }
      case 'ternary':
        return { kind: 'ternary', cond: sub('bool'), yes: sub('bool'), no: sub('bool') };
      case 'is': {
        const types = cfg.isTypes ?? ['int', 'float', 'number', 'string', 'bool', 'list', 'map'];
        return { kind: 'is', value: sub('any'), typeName: rng.pick(types) };
      }
      case 'in': {
        if (allowCollections && rng.bool(0.5)) {
          return { kind: 'in', elem: sub('any'), coll: { kind: 'list', items: [sub('num'), sub('str')] } };
        }
        return { kind: 'in', elem: { kind: 'lit', value: rng.pick(keys) }, coll: genLeaf(rng, 'any', cfg) };
      }
      case 'matches':
        return { kind: 'method', object: sub('str'), name: 'matches', args: [{ kind: 'lit', value: rng.pick(REGEX_PATTERNS) }] };
    }
  }

  if (wanted === 'num' || wanted === 'int') {
    const ops = ['+', '-', '*'];
    if (allowDiv) ops.push('/');
    if (allowMod) ops.push('%');
    const kind = rng.weighted([
      [3, 'leaf'],
      [4, 'arith'],
      [2, 'neg'],
      [2, 'ternary'],
      [allowMethods ? 2 : 0, 'size'],
    ]);
    switch (kind) {
      case 'leaf':
        return genLeaf(rng, wanted, cfg);
      case 'arith':
        return { kind: 'binary', op: rng.pick(ops), left: sub('num'), right: sub('num') };
      case 'neg':
        return { kind: 'unary', op: '-', operand: sub('num') };
      case 'ternary':
        return { kind: 'ternary', cond: sub('bool'), yes: sub('num'), no: sub('num') };
      case 'size':
        return { kind: 'method', object: sub('str'), name: 'size', args: [] };
    }
  }

  if (wanted === 'str') {
    const kind = rng.weighted([
      [3, 'leaf'],
      [3, 'concat'],
      [2, 'ternary'],
      [allowMethods ? 2 : 0, 'get'],
    ]);
    switch (kind) {
      case 'leaf':
        return genLeaf(rng, 'str', cfg);
      case 'concat':
        return { kind: 'binary', op: '+', left: sub('str'), right: sub('str') };
      case 'ternary':
        return { kind: 'ternary', cond: sub('bool'), yes: sub('str'), no: sub('str') };
      case 'get':
        return {
          kind: 'method',
          object: genLeaf(rng, 'any', cfg),
          name: 'get',
          args: [{ kind: 'lit', value: rng.pick(keys) }, genLiteral(rng, 'str', cfg)],
        };
    }
  }

  const kind = rng.weighted([
    [3, 'leaf'],
    [2, 'bool'],
    [2, 'num'],
    [2, 'str'],
    [allowIndex ? 2 : 0, 'index'],
    [allowCollections ? 1 : 0, 'list'],
    [allowCollections ? 1 : 0, 'map'],
  ]);
  switch (kind) {
    case 'leaf':
      return genLeaf(rng, 'any', cfg);
    case 'bool':
      return generateExpr(rng, 'bool', cfg, depth + 1);
    case 'num':
      return generateExpr(rng, 'num', cfg, depth + 1);
    case 'str':
      return generateExpr(rng, 'str', cfg, depth + 1);
    case 'index': {
      const idx: FuzzExpr = rng.bool(0.5)
        ? { kind: 'lit', value: rng.int(-1, 3), raw: String(rng.int(-1, 3)) }
        : { kind: 'lit', value: rng.pick(keys) };
      return { kind: 'index', object: genLeaf(rng, 'any', cfg), index: idx };
    }
    case 'list':
      return { kind: 'list', items: [sub('any'), sub('any')] };
    case 'map': {
      const k1 = rng.pick(keys);
      const k2 = rng.pick(keys.filter((k) => k !== k1));
      return { kind: 'map', entries: [[k1, sub('any')], [k2, sub('any')]] };
    }
  }
}

export function generateStandaloneFunction(rng: SeededRng): FuzzFunctionProgram {
  const params = ['a', 'b'];
  const letCount = rng.int(0, 2);
  const lets: FuzzLet[] = [];
  const scope = [...params];
  for (let i = 0; i < letCount; i++) {
    const name = 'v' + i;
    const value = generateExpr(rng, rng.pick<ExprType>(['any', 'num', 'bool', 'str']), {
      vars: scope,
      maxDepth: 2,
      allowMatches: true,
    });
    lets.push({ name, value });
    scope.push(name);
  }
  const body = generateExpr(rng, rng.pick<ExprType>(['bool', 'num', 'str', 'any']), {
    vars: scope,
    maxDepth: 3,
    allowMatches: true,
  });
  return { kind: 'function', name: 'fuzzFn', params, lets, body };
}

export function generateFirestoreTransition(rng: SeededRng): FuzzTransitionProgram {
  const expr = generateExpr(rng, 'bool', {
    vars: ['before', 'after', 'input'],
    maxDepth: 3,
    allowFloats: true,
    allowDiv: true,
    allowMod: true,
    allowNull: true,
    allowIs: true,
    allowIn: true,
    allowIndex: false,
    allowCollections: true,
    allowMethods: false,
    allowMatches: false,
    mapKeys: ['x', 'y', 's', 'flag', 'tag'],
    isTypes: ['int', 'float', 'number', 'string', 'bool', 'list', 'map'],
  });
  return { kind: 'transition', name: 'fuzzFirestore', requirements: [{ name: 'check', expr }] };
}

// Generate an RTDB-focused policy expression using supported leaf paths and operators.
export function generateRtdbExpr(rng: SeededRng, maxDepth = 3): FuzzExpr {
  const numLeaf = (): FuzzExpr => ({
    kind: 'field',
    object: { kind: 'var', name: rng.pick(['before', 'after']) },
    prop: rng.pick(['x', 'y']),
  });
  const strLeaf = (): FuzzExpr => ({
    kind: 'field',
    object: { kind: 'var', name: rng.pick(['before', 'after']) },
    prop: 's',
  });
  const boolLeaf = (): FuzzExpr => ({
    kind: 'field',
    object: { kind: 'var', name: rng.pick(['before', 'after']) },
    prop: 'flag',
  });

  function genNum(d: number): FuzzExpr {
    if (d >= maxDepth) {
      return rng.bool(0.65)
        ? numLeaf()
        : { kind: 'lit', value: rng.int(-10, 10), raw: String(rng.int(-10, 10)) };
    }
    const k = rng.weighted([[3, 'leaf'], [4, 'op'], [2, 'neg'], [1, 'len'], [2, 'tern']]);
    if (k === 'leaf') return genNum(maxDepth);
    if (k === 'neg') return { kind: 'unary', op: '-', operand: genNum(d + 1) };
    if (k === 'len') return { kind: 'method', object: genStr(d + 1), name: 'size', args: [] };
    if (k === 'tern') return { kind: 'ternary', cond: genBool(d + 1), yes: genNum(d + 1), no: genNum(d + 1) };
    const op = rng.pick(['+', '-', '*', '%']);
    const right = op === '%'
      ? { kind: 'lit' as const, value: rng.pick([2, 3, 5]), raw: String(rng.pick([2, 3, 5])) }
      : genNum(d + 1);
    return { kind: 'binary', op, left: genNum(d + 1), right };
  }

  function genStr(d: number): FuzzExpr {
    if (d >= maxDepth) {
      return rng.bool(0.6) ? strLeaf() : { kind: 'lit', value: rng.pick(['', 'a', 'ab', 'ok', 'hi']) };
    }
    if (rng.bool(0.45)) return { kind: 'binary', op: '+', left: genStr(d + 1), right: genStr(d + 1) };
    return genStr(maxDepth);
  }

  function genBool(d: number): FuzzExpr {
    if (d >= maxDepth) {
      return rng.bool(0.75) ? boolLeaf() : { kind: 'lit', value: rng.bool() };
    }
    const k = rng.weighted([[2, 'leaf'], [4, 'logic'], [4, 'numCmp'], [2, 'strCmp'], [2, 'not'], [2, 'tern'], [2, 'is']]);
    if (k === 'leaf') return genBool(maxDepth);
    if (k === 'logic') return { kind: 'binary', op: rng.pick(['&&', '||']), left: genBool(d + 1), right: genBool(d + 1) };
    if (k === 'not') return { kind: 'unary', op: '!', operand: genBool(d + 1) };
    if (k === 'tern') return { kind: 'ternary', cond: genBool(d + 1), yes: genBool(d + 1), no: genBool(d + 1) };
    if (k === 'numCmp') {
      return { kind: 'binary', op: rng.pick(['==', '!=', '<', '<=', '>', '>=']), left: genNum(d + 1), right: genNum(d + 1) };
    }
    if (k === 'strCmp') {
      return { kind: 'binary', op: rng.pick(['==', '!=', '<', '<=', '>', '>=']), left: genStr(d + 1), right: genStr(d + 1) };
    }
    const target = rng.pick([numLeaf(), strLeaf(), boolLeaf()]);
    return { kind: 'is', value: target, typeName: rng.pick(['int', 'number', 'string', 'bool']) };
  }

  return genBool(0);
}

export function generateRtdbTransition(rng: SeededRng): FuzzTransitionProgram {
  return {
    kind: 'transition',
    name: 'fuzzRtdb',
    requirements: [{ name: 'check', expr: generateRtdbExpr(rng, 3) }],
  };
}

// Generate a Storage Rules v2 policy transition over input.auth, after (request.resource), before (resource).
export function generateStorageTransition(rng: SeededRng, mode: 'create' | 'update' = 'create'): FuzzTransitionProgram {
  const numRef = (): FuzzExpr => {
    const root = mode === 'update' && rng.bool(0.4) ? 'before' : 'after';
    return { kind: 'field', object: { kind: 'var', name: root }, prop: 'size' };
  };
  const ctRef = (): FuzzExpr => {
    const root = mode === 'update' && rng.bool(0.4) ? 'before' : 'after';
    return { kind: 'field', object: { kind: 'var', name: root }, prop: 'contentType' };
  };
  const uidRef = (): FuzzExpr => ({
    kind: 'field',
    object: { kind: 'field', object: { kind: 'var', name: 'input' }, prop: 'auth' },
    prop: 'uid',
  });
  const metaGet = (key: string): FuzzExpr => ({
    kind: 'method',
    object: { kind: 'field', object: { kind: 'var', name: mode === 'update' && rng.bool(0.35) ? 'before' : 'after' }, prop: 'metadata' },
    name: 'get',
    args: [{ kind: 'lit', value: key }, { kind: 'lit', value: '' }],
  });

  function genAtom(): FuzzExpr {
    const choice = rng.int(0, 6);
    switch (choice) {
      case 0:
        return { kind: 'binary', op: rng.pick(['<=', '<', '>=', '>', '==']), left: numRef(), right: { kind: 'lit', value: rng.pick([0, 64, 512, 1024, 4096]), raw: String(rng.pick([0, 64, 512, 1024, 4096])) } };
      case 1:
        return { kind: 'binary', op: rng.pick(['==', '!=']), left: ctRef(), right: { kind: 'lit', value: rng.pick(['audio/wav', 'image/png', 'text/plain']) } };
      case 2:
        return { kind: 'method', object: ctRef(), name: 'matches', args: [{ kind: 'lit', value: rng.pick(['^audio/(wav|ogg)$', '^image/(png|jpeg)$', '^[a-z]+/[a-z]+$']) }] };
      case 3:
        return { kind: 'binary', op: rng.pick(['==', '!=']), left: uidRef(), right: metaGet('owner') };
      case 4:
        return { kind: 'in', elem: ctRef(), coll: { kind: 'list', items: [{ kind: 'lit', value: 'audio/wav' }, { kind: 'lit', value: 'image/png' }] } };
      case 5:
        return { kind: 'is', value: numRef(), typeName: rng.pick(['int', 'number']) };
      default:
        return { kind: 'binary', op: '!=', left: uidRef(), right: { kind: 'lit', value: '' } };
    }
  }

  function genBool(d: number): FuzzExpr {
    if (d >= 2) return genAtom();
    const k = rng.weighted([[3, 'atom'], [4, 'logic'], [2, 'not'], [2, 'tern']]);
    if (k === 'atom') return genAtom();
    if (k === 'not') return { kind: 'unary', op: '!', operand: genBool(d + 1) };
    if (k === 'tern') return { kind: 'ternary', cond: genBool(d + 1), yes: genBool(d + 1), no: genBool(d + 1) };
    return { kind: 'binary', op: rng.pick(['&&', '||']), left: genBool(d + 1), right: genBool(d + 1) };
  }

  // Always guard auth presence positively when reading input.auth.uid so Storage absent-auth is tested cleanly.
  const authGuard: FuzzExpr = {
    kind: 'binary',
    op: '!=',
    left: { kind: 'field', object: { kind: 'var', name: 'input' }, prop: 'auth' },
    right: { kind: 'lit', value: null },
  };
  const body = rng.bool(0.75) ? { kind: 'binary' as const, op: '&&', left: authGuard, right: genBool(0) } : genBool(0);
  return { kind: 'transition', name: 'fuzzStorage', requirements: [{ name: 'check', expr: body }] };
}
