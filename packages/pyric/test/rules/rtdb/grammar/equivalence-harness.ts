/**
 * Evaluation-equivalence harness: evaluates two RTDB rule expressions through
 * the real simulator over many generated request contexts and reports the
 * first context where they decide differently.
 *
 * Contexts vary what the rewrites depend on: signed out or signed in with
 * several uids and token claims, path variable bindings, and data that is
 * present, missing, or of the wrong type at every path either expression
 * reads (paths are resolved from the expressions' own `child()` chains, so a
 * glued or mis-split path is reachable), plus random noise.
 */
import {
  DataSnapshot,
  RtdbRuleRuntimeError,
  evaluateRtdbExpression,
  type EvalContext,
} from '../../../../src/rules/rtdb/grammar/simulator.js';
import {
  parseRtdbExpressionTree,
  printRtdbExpressionTree,
  type RtdbExpressionTree,
} from '../../../../src/rules/rtdb/grammar/expression-tree.js';

/** What an evaluation decided: a value, a rule runtime error, or a construct the simulator does not evaluate. */
export type Outcome = { kind: 'value'; value: string } | { kind: 'rule-error' } | { kind: 'unsupported' };

function describeValue(value: unknown): string {
  if (value instanceof DataSnapshot) return `snapshot(${JSON.stringify(value.val())})`;
  if (value instanceof RegExp) return `regex(${String(value)})`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return JSON.stringify(value);
}

export function outcomeOf(raw: string, ctx: EvalContext): Outcome {
  try {
    return { kind: 'value', value: describeValue(evaluateRtdbExpression(raw, ctx)) };
  } catch (error) {
    return error instanceof RtdbRuleRuntimeError ? { kind: 'rule-error' } : { kind: 'unsupported' };
  }
}

/** Seeded PRNG (mulberry32), so a failing case reproduces. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

function walk(tree: RtdbExpressionTree, visit: (node: RtdbExpressionTree) => void): void {
  visit(tree);
  switch (tree.type) {
    case 'ternary': walk(tree.test, visit); walk(tree.consequent, visit); walk(tree.alternate, visit); break;
    case 'binary': walk(tree.left, visit); walk(tree.right, visit); break;
    case 'unary': walk(tree.argument, visit); break;
    case 'call': walk(tree.receiver, visit); tree.args.forEach((a) => walk(a, visit)); break;
    case 'member': walk(tree.object, visit); break;
    case 'index': walk(tree.object, visit); walk(tree.index, visit); break;
    case 'array': tree.elements.forEach((e) => walk(e, visit)); break;
    default: break;
  }
}

/** A `child()` chain: its base snapshot identifier and the argument trees, outermost last. */
function childChain(tree: RtdbExpressionTree): { base: string; args: RtdbExpressionTree[] } | undefined {
  if (tree.type === 'identifier' && ['root', 'data', 'newData'].includes(tree.name)) return { base: tree.name, args: [] };
  if (tree.type === 'call' && tree.method === 'child' && tree.args.length === 1) {
    const inner = childChain(tree.receiver);
    return inner && { base: inner.base, args: [...inner.args, tree.args[0]!] };
  }
  return undefined;
}

interface ExpressionFacts {
  variables: Set<string>;
  strings: Set<string>;
  chains: Array<{ base: string; args: string[] }>;
}

function factsOf(raws: readonly string[]): ExpressionFacts {
  const facts: ExpressionFacts = { variables: new Set(), strings: new Set(), chains: [] };
  for (const raw of raws) {
    const parsed = parseRtdbExpressionTree(raw);
    if (!parsed.ok) throw new Error(`fixture expression does not parse: ${raw}: ${parsed.message}`);
    walk(parsed.tree, (node) => {
      if (node.type === 'identifier' && node.name.startsWith('$')) facts.variables.add(node.name);
      if (node.type === 'string') facts.strings.add(node.value);
      const chain = childChain(node);
      if (chain && chain.args.length > 0) facts.chains.push({ base: chain.base, args: chain.args.map(printRtdbExpressionTree) });
    });
  }
  return facts;
}

/** Set `value` at `segments` inside `tree`, creating objects (and replacing leaves) on the way. */
function setAt(tree: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let node = tree;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
}

export interface GenerateOptions {
  seed?: number;
  count?: number;
  uids?: readonly string[];
  bindingValues?: readonly string[];
}

/** Generated contexts for a set of expressions (all of them inform which paths and values are interesting). */
export function* generateContexts(raws: readonly string[], options: GenerateOptions = {}): Generator<EvalContext> {
  const random = rng(options.seed ?? 1);
  const facts = factsOf(raws);
  const uids = options.uids ?? ['u1', 'u2', 'admin', 's1'];
  const bindingValues = options.bindingValues ?? ['s1', 's2', 'u1', 'u2', 'admin', 't1'];
  const leaves: unknown[] = [
    true, false, null, 0, 1, 'true', 'admin', 'member', {}, ['x'],
    ...facts.strings, ...uids, ...bindingValues,
  ];
  const randomLeaf = (): unknown => {
    const leaf = pick(random, leaves);
    if (random() < 0.15) return { removed: pick(random, [true, false, 'true', null]), role: pick(random, ['admin', 'member', 1]) };
    return leaf;
  };

  for (let i = 0; i < (options.count ?? 200); i++) {
    const pathVariableBindings: Record<string, string> = {};
    for (const name of facts.variables) pathVariableBindings[name] = pick(random, bindingValues);
    const auth = random() < 0.25 ? null : {
      uid: pick(random, uids),
      token: random() < 0.5 ? {} : { admin: pick(random, [true, false, 'yes']), email: 'a@b.c' },
    };
    const values: Record<string, Record<string, unknown>> = { root: {}, data: {}, newData: {} };
    const resolveContext: EvalContext = {
      auth, now: 1_700_000_000_000, pathVariableBindings,
      data: new DataSnapshot(null), newData: new DataSnapshot(null), root: new DataSnapshot(null),
    };
    for (const chain of facts.chains) {
      if (random() < 0.3) continue;
      const segments: string[] = [];
      let resolvable = true;
      for (const arg of chain.args) {
        try {
          const value = evaluateRtdbExpression(arg, resolveContext);
          if (typeof value !== 'string') { resolvable = false; break; }
          segments.push(...value.split('/').filter((s) => s.length > 0));
        } catch {
          resolvable = false;
          break;
        }
      }
      if (!resolvable || segments.length === 0) continue;
      // Sometimes stop short, so a prefix holds a leaf and the full path is missing or a wrong type.
      const depth = random() < 0.2 ? Math.max(1, Math.floor(random() * segments.length)) : segments.length;
      setAt(values[chain.base]!, segments.slice(0, depth), randomLeaf());
    }
    // Noise at random paths built from the expressions' own strings.
    for (let n = Math.floor(random() * 3); n > 0; n--) {
      const base = pick(random, ['root', 'data', 'newData']);
      setAt(values[base]!, [pick(random, [...facts.strings, 'x']).replace(/\//g, '_') || 'x'], randomLeaf());
    }
    const dataPath = '/spaces_app/spaces/s1/data/x';
    const rootValue = values.root!;
    const dataValue = random() < 0.2 ? randomLeaf() : values.data;
    const newDataValue = random() < 0.2 ? randomLeaf() : values.newData;
    yield {
      auth,
      now: 1_700_000_000_000,
      pathVariableBindings,
      root: new DataSnapshot(rootValue, '/', rootValue),
      data: new DataSnapshot(dataValue, dataPath, rootValue),
      newData: new DataSnapshot(newDataValue, dataPath, rootValue),
      query: null,
    };
  }
}

export interface Counterexample {
  context: EvalContext;
  a: Outcome;
  b: Outcome;
}

/** The first generated context where `a` and `b` decide differently, if any. */
export function findCounterexample(a: string, b: string, options: GenerateOptions = {}): Counterexample | undefined {
  for (const context of generateContexts([a, b], options)) {
    const oa = outcomeOf(a, context);
    const ob = outcomeOf(b, context);
    if (JSON.stringify(oa) !== JSON.stringify(ob)) return { context, a: oa, b: ob };
  }
  return undefined;
}

/** How many generated contexts produced each outcome kind for `raw`: evidence the generator reaches every branch. */
export function outcomeSpread(raw: string, options: GenerateOptions = {}): Record<string, number> {
  const spread: Record<string, number> = {};
  for (const context of generateContexts([raw], options)) {
    const o = outcomeOf(raw, context);
    const key = o.kind === 'value' ? o.value : o.kind;
    spread[key] = (spread[key] ?? 0) + 1;
  }
  return spread;
}
