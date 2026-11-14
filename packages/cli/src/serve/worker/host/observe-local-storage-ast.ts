import type {
  compiledStorageRulesForBucket,
  StorageEvaluationObservation,
} from 'pyric/storage/internal';
import type { ObservedMethod } from 'pyric/sandbox/internal';

export type StorageMethod = Exclude<ObservedMethod, 'set'>;
export type CompiledRules = NonNullable<ReturnType<typeof compiledStorageRulesForBucket>>;
type StorageMatchBlock = CompiledRules['_root'];
type StorageFunctionDef = StorageMatchBlock['functions'][number];
type StorageFunctionMap = NonNullable<StorageMatchBlock['visibleFuncs']>;
type StorageExpr = StorageFunctionDef['body'];
type StoragePathSegment = StorageMatchBlock['segments'][number];
type StorageGrantVerb = StorageMatchBlock['allows'][number]['verbs'][number];

export type StorageBindingTarget = 'resource' | 'request.resource';

type TrackedBinding =
  | { readonly kind: 'target' }
  | { readonly kind: 'request' }
  | { readonly kind: 'map'; readonly entries: ReadonlyMap<string, TrackedBinding> }
  | {
      readonly kind: 'list';
      readonly items: readonly TrackedBinding[];
      readonly dynamicElement?: TrackedBinding;
    }
  | { readonly kind: 'union'; readonly options: readonly TrackedBinding[] }
  | { readonly kind: 'none' };

const NONE_BINDING: TrackedBinding = { kind: 'none' };
const TARGET_BINDING: TrackedBinding = { kind: 'target' };
const REQUEST_BINDING: TrackedBinding = { kind: 'request' };
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

function literalOf(expr: StorageExpr | undefined): unknown {
  if (expr?.kind === 'literal') return expr.value;
  return undefined;
}

function minRecursiveSegments(rulesVersion: string): number {
  if (rulesVersion === '2' || rulesVersion === '2+modules') return 0;
  return 1;
}

function makeListBinding(
  items: readonly TrackedBinding[],
  dynamicElement?: TrackedBinding,
): TrackedBinding {
  if (dynamicElement !== undefined && dynamicElement.kind !== 'none') {
    return { kind: 'list', items, dynamicElement };
  }
  return { kind: 'list', items };
}

function flattenOptions(binding: TrackedBinding): readonly TrackedBinding[] {
  if (binding.kind === 'none') return [];
  if (binding.kind === 'union') return binding.options;
  return [binding];
}

function unionBindings(items: readonly TrackedBinding[]): TrackedBinding {
  const flat: TrackedBinding[] = [];
  for (const item of items) {
    for (const opt of flattenOptions(item)) {
      flat.push(opt);
    }
  }
  if (flat.length === 0) return NONE_BINDING;
  if (flat.length === 1) return flat[0]!;
  return { kind: 'union', options: flat };
}

function containsSensitiveBinding(binding: TrackedBinding): boolean {
  switch (binding.kind) {
    case 'target':
    case 'request':
      return true;
    case 'map':
      for (const val of binding.entries.values()) {
        if (containsSensitiveBinding(val)) return true;
      }
      return false;
    case 'list':
      if (binding.dynamicElement !== undefined && containsSensitiveBinding(binding.dynamicElement)) {
        return true;
      }
      return binding.items.some(containsSensitiveBinding);
    case 'union':
      return binding.options.some(containsSensitiveBinding);
    case 'none':
      return false;
  }
}

function sliceBinding(base: TrackedBinding, startLit: unknown, endLit: unknown): TrackedBinding {
  const hasStart = typeof startLit === 'number' || typeof startLit === 'bigint';
  const hasEnd = typeof endLit === 'number' || typeof endLit === 'bigint';
  const results: TrackedBinding[] = [];
  for (const opt of flattenOptions(base)) {
    if (opt.kind !== 'list') {
      results.push(opt);
      continue;
    }
    if (hasStart && hasEnd) {
      results.push(
        makeListBinding(opt.items.slice(Number(startLit), Number(endLit)), opt.dynamicElement),
      );
    } else {
      const merged = [...opt.items];
      if (opt.dynamicElement !== undefined) merged.push(opt.dynamicElement);
      results.push(makeListBinding([], unionBindings(merged)));
    }
  }
  return unionBindings(results);
}

function concatListBinding(
  left: Extract<TrackedBinding, { kind: 'list' }>,
  rightArg: TrackedBinding | undefined,
): TrackedBinding {
  const leftPool = [...left.items];
  if (left.dynamicElement !== undefined) leftPool.push(left.dynamicElement);
  if (rightArg === undefined) return makeListBinding([], unionBindings(leftPool));
  const results: TrackedBinding[] = [];
  for (const rightOpt of flattenOptions(rightArg)) {
    if (rightOpt.kind === 'list') {
      if (left.dynamicElement === undefined && rightOpt.dynamicElement === undefined) {
        results.push(makeListBinding([...left.items, ...rightOpt.items]));
      } else {
        const merged = [...leftPool, ...rightOpt.items];
        if (rightOpt.dynamicElement !== undefined) merged.push(rightOpt.dynamicElement);
        results.push(makeListBinding([], unionBindings(merged)));
      }
    } else {
      results.push(makeListBinding([], unionBindings([...leftPool, rightOpt])));
    }
  }
  if (results.length === 0) return makeListBinding(left.items, left.dynamicElement);
  return unionBindings(results);
}

function isDirectNullCheckTarget(binding: TrackedBinding): boolean {
  const opts = flattenOptions(binding);
  return opts.length > 0 && opts.every((opt) => opt.kind === 'target' || opt.kind === 'request');
}

function isNullLiteral(expr: StorageExpr): boolean {
  return expr.kind === 'literal' && expr.value === null;
}

function exprMayReadMissingBindingProps(
  rootExpr: StorageExpr,
  targetKind: StorageBindingTarget,
  missingProps: ReadonlySet<string>,
  captures: ReadonlySet<string>,
  rootFuncs: StorageFunctionMap,
): boolean {
  if (missingProps.size === 0) return false;
  let foundRead = false;

  function stepMapGetKey(base: TrackedBinding, keyPart: string): TrackedBinding {
    const out: TrackedBinding[] = [];
    for (const opt of flattenOptions(base)) {
      if (opt.kind === 'target') {
        if (missingProps.has(keyPart)) foundRead = true;
      } else if (opt.kind === 'request') {
        if (keyPart === 'resource') out.push(TARGET_BINDING);
      } else if (opt.kind === 'map') {
        const entry = opt.entries.get(keyPart);
        if (entry !== undefined) out.push(entry);
      }
    }
    return unionBindings(out);
  }

  function inspectExpr(
    expr: StorageExpr,
    locals: ReadonlyMap<string, TrackedBinding>,
    shadowed: ReadonlySet<string>,
    funcs: StorageFunctionMap,
    activeFns: ReadonlySet<StorageFunctionDef>,
  ): TrackedBinding {
    if (foundRead) return NONE_BINDING;
    const walk = (node: StorageExpr): TrackedBinding =>
      inspectExpr(node, locals, shadowed, funcs, activeFns);

    switch (expr.kind) {
      case 'literal':
        return NONE_BINDING;
      case 'ident': {
        const local = locals.get(expr.name);
        if (local !== undefined) return local;
        if (shadowed.has(expr.name)) return NONE_BINDING;
        if (targetKind === 'resource' && expr.name === 'resource') return TARGET_BINDING;
        if (targetKind === 'request.resource' && expr.name === 'request') return REQUEST_BINDING;
        return NONE_BINDING;
      }
      case 'member': {
        const base = walk(expr.target);
        const results: TrackedBinding[] = [];
        for (const opt of flattenOptions(base)) {
          if (opt.kind === 'target') {
            if (missingProps.has(expr.name)) foundRead = true;
          } else if (opt.kind === 'request' && expr.name === 'resource') {
            results.push(TARGET_BINDING);
          } else if (opt.kind === 'map') {
            const entry = opt.entries.get(expr.name);
            if (entry !== undefined) results.push(entry);
          }
        }
        return unionBindings(results);
      }
      case 'index': {
        const base = walk(expr.target);
        walk(expr.index);
        const literalKey = literalOf(expr.index);
        const results: TrackedBinding[] = [];
        for (const opt of flattenOptions(base)) {
          if (opt.kind === 'target') {
            if (typeof literalKey !== 'string' || missingProps.has(literalKey)) foundRead = true;
          } else if (opt.kind === 'request') {
            if (literalKey === 'resource') results.push(TARGET_BINDING);
            else if (typeof literalKey !== 'string') foundRead = true;
          } else if (opt.kind === 'map') {
            if (typeof literalKey === 'string') {
              const entry = opt.entries.get(literalKey);
              if (entry !== undefined) results.push(entry);
            } else {
              results.push(...opt.entries.values());
            }
          } else if (opt.kind === 'list') {
            if (typeof literalKey === 'number' || typeof literalKey === 'bigint') {
              const item = opt.items[Number(literalKey)];
              if (item !== undefined) results.push(item);
            } else {
              results.push(...opt.items);
            }
            if (opt.dynamicElement !== undefined) results.push(opt.dynamicElement);
          }
        }
        return unionBindings(results);
      }
      case 'in': {
        const el = walk(expr.element);
        const coll = walk(expr.collection);
        if (containsSensitiveBinding(el)) {
          foundRead = true;
          return NONE_BINDING;
        }
        const literalEl = literalOf(expr.element);
        for (const opt of flattenOptions(coll)) {
          if (opt.kind === 'target') {
            if (typeof literalEl !== 'string' || missingProps.has(literalEl)) foundRead = true;
          } else if (containsSensitiveBinding(opt)) {
            foundRead = true;
          }
        }
        return NONE_BINDING;
      }
      case 'methodcall': {
        const recv = walk(expr.target);
        const argBindings = expr.args.map(walk);
        if (expr.method === 'get') {
          if (argBindings[0] !== undefined && containsSensitiveBinding(argBindings[0])) {
            foundRead = true;
          }
          const keyArg = expr.args[0];
          const results: TrackedBinding[] = [];
          if (argBindings[1] !== undefined) results.push(argBindings[1]);
          if (keyArg?.kind === 'literal' && typeof keyArg.value === 'string') {
            results.push(stepMapGetKey(recv, keyArg.value));
          } else if (keyArg?.kind === 'list' && keyArg.elements.length > 0) {
            let current = recv;
            for (const el of keyArg.elements) {
              if (el.kind === 'literal' && typeof el.value === 'string') {
                current = stepMapGetKey(current, el.value);
              } else {
                if (containsSensitiveBinding(current)) foundRead = true;
                current = NONE_BINDING;
                break;
              }
            }
            results.push(current);
          } else {
            for (const opt of flattenOptions(recv)) {
              if (opt.kind === 'map') results.push(...opt.entries.values());
              else if (containsSensitiveBinding(opt)) foundRead = true;
            }
          }
          return unionBindings(results);
        }
        if (expr.method !== 'concat' && argBindings.some(containsSensitiveBinding)) {
          foundRead = true;
        }
        const results: TrackedBinding[] = [];
        for (const opt of flattenOptions(recv)) {
          if (opt.kind === 'target') {
            foundRead = true;
          } else if (opt.kind === 'request') {
            if (expr.method !== 'keys' && expr.method !== 'size') foundRead = true;
          } else if (opt.kind === 'map') {
            if (expr.method === 'values') {
              results.push(makeListBinding([...opt.entries.values()]));
            } else if (expr.method !== 'keys' && expr.method !== 'size' && containsSensitiveBinding(opt)) {
              foundRead = true;
            }
          } else if (opt.kind === 'list') {
            if (expr.method === 'concat') {
              results.push(concatListBinding(opt, argBindings[0]));
            } else if (expr.method !== 'size') {
              if (containsSensitiveBinding(opt)) foundRead = true;
              const pool = [...opt.items];
              if (opt.dynamicElement !== undefined) pool.push(opt.dynamicElement);
              results.push(makeListBinding([], unionBindings(pool)));
            }
          }
        }
        return unionBindings(results);
      }
      case 'call': {
        const argBindings = expr.args.map(walk);
        const fn = funcs.get(expr.name);
        if (fn === undefined || activeFns.has(fn)) {
          if (argBindings.some(containsSensitiveBinding)) foundRead = true;
          return NONE_BINDING;
        }
        const fnLocals = new Map<string, TrackedBinding>();
        const fnShadowed = new Set<string>(fn.declCaptures ?? []);
        if (fn.scopeKind === 'global') {
          fnShadowed.add('resource');
          fnShadowed.add('request');
        }
        for (let i = 0; i < fn.params.length; i++) {
          const paramName = fn.params[i]!;
          const argBinding = argBindings[i] ?? NONE_BINDING;
          fnLocals.set(paramName, argBinding);
          fnShadowed.add(paramName);
        }
        const fnScope = fn.declScope ?? funcs;
        const nextActive = new Set(activeFns);
        nextActive.add(fn);
        for (const binding of fn.lets) {
          const boundValue = inspectExpr(binding.value, fnLocals, fnShadowed, fnScope, nextActive);
          fnLocals.set(binding.name, boundValue);
          fnShadowed.add(binding.name);
          if (foundRead) return NONE_BINDING;
        }
        return inspectExpr(fn.body, fnLocals, fnShadowed, fnScope, nextActive);
      }
      case 'list':
        return { kind: 'list', items: expr.elements.map(walk) };
      case 'map': {
        const entries = new Map<string, TrackedBinding>();
        for (const entry of expr.entries) {
          walk(entry.key);
          const val = walk(entry.value);
          if (entry.key.kind === 'literal' && typeof entry.key.value === 'string') {
            entries.set(entry.key.value, val);
          } else if (containsSensitiveBinding(val)) {
            foundRead = true;
          }
        }
        return { kind: 'map', entries };
      }
      case 'ternary': {
        const cond = walk(expr.cond);
        if (containsSensitiveBinding(cond)) foundRead = true;
        const left = walk(expr.then);
        const right = walk(expr.else);
        return unionBindings([left, right]);
      }
      case 'slice': {
        const base = walk(expr.target);
        walk(expr.start);
        walk(expr.end);
        return sliceBinding(base, literalOf(expr.start), literalOf(expr.end));
      }
      case 'unary': {
        const inner = walk(expr.arg);
        if (containsSensitiveBinding(inner)) foundRead = true;
        return NONE_BINDING;
      }
      case 'is': {
        const inner = walk(expr.value);
        if (!isDirectNullCheckTarget(inner) && containsSensitiveBinding(inner)) {
          foundRead = true;
        }
        return NONE_BINDING;
      }
      case 'binary': {
        if (expr.op === '==' || expr.op === '!=') {
          if (isNullLiteral(expr.right)) {
            const left = walk(expr.left);
            if (!isDirectNullCheckTarget(left) && containsSensitiveBinding(left)) {
              foundRead = true;
            }
            return NONE_BINDING;
          }
          if (isNullLiteral(expr.left)) {
            const right = walk(expr.right);
            if (!isDirectNullCheckTarget(right) && containsSensitiveBinding(right)) {
              foundRead = true;
            }
            return NONE_BINDING;
          }
        }
        const left = walk(expr.left);
        const right = walk(expr.right);
        if (containsSensitiveBinding(left) || containsSensitiveBinding(right)) {
          foundRead = true;
        }
        return NONE_BINDING;
      }
      case 'path':
        for (const seg of expr.segments) {
          if (seg.kind === 'interp') {
            const inner = walk(seg.expr);
            if (containsSensitiveBinding(inner)) foundRead = true;
          }
        }
        return NONE_BINDING;
    }
  }

  const rootResult = inspectExpr(rootExpr, new Map(), captures, rootFuncs, new Set());
  if (containsSensitiveBinding(rootResult)) foundRead = true;
  return foundRead;
}

function grantCoversVerb(verbs: readonly StorageGrantVerb[], method: StorageMethod): boolean {
  for (const verb of verbs) {
    if (verb === method) return true;
    if (verb === 'read' && (method === 'get' || method === 'list')) return true;
    if (verb === 'write' && (method === 'create' || method === 'update' || method === 'delete')) return true;
  }
  return false;
}

function formatStorageSegments(segments: readonly StoragePathSegment[]): string {
  return (
    '/' +
    segments
      .map((s) => {
        if (s.kind === 'literal') return s.value;
        if (s.kind === 'param') return `{${s.name}}`;
        return `{${s.name}=**}`;
      })
      .join('/')
  );
}

function matchStorageSegments(
  segments: readonly StoragePathSegment[],
  remaining: readonly string[],
  rulesVersion: string,
): string[] | null {
  let index = 0;
  const minimum = minRecursiveSegments(rulesVersion);
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    if (seg.kind === 'wildcard') {
      const trailing = segments.length - 1 - s;
      const length = remaining.length - index - trailing;
      if (length < minimum) return null;
      index += length;
      continue;
    }
    if (index >= remaining.length) return null;
    if (seg.kind === 'literal' && remaining[index] !== seg.value) return null;
    index += 1;
  }
  return remaining.slice(index);
}

export function evaluationMayReadMissingBindingProps(
  rules: CompiledRules,
  requestPath: string,
  method: StorageMethod,
  allowed: boolean,
  observation: StorageEvaluationObservation,
  targetKind: StorageBindingTarget,
  missingProps: ReadonlySet<string>,
): boolean {
  if (missingProps.size === 0) return false;

  if (observation.evaluatedAllows !== undefined && observation.evaluatedAllows.length > 0) {
    for (const evaluatedAllow of observation.evaluatedAllows) {
      if (
        evaluatedAllow.condition !== null &&
        exprMayReadMissingBindingProps(
          evaluatedAllow.condition,
          targetKind,
          missingProps,
          evaluatedAllow.captures,
          evaluatedAllow.funcs,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  const pathSegments = requestPath.split('/').filter((s) => s.length > 0);
  const minimum = minRecursiveSegments(rules._version);
  const candidateAllows: Array<{
    blockPath: string;
    line: number | undefined;
    condition: StorageExpr | null;
    captures: ReadonlySet<string>;
    funcs: StorageFunctionMap;
  }> = [];

  const collect = (
    block: StorageMatchBlock,
    remaining: readonly string[],
    inheritedCaptures: ReadonlySet<string>,
  ): void => {
    const left = matchStorageSegments(block.segments, remaining, rules._version);
    if (left === null) return;
    const captures = new Set(inheritedCaptures);
    for (const seg of block.segments) {
      if (seg.kind !== 'literal') captures.add(seg.name);
    }
    if (left.length === 0) {
      const blockPath = `match ${formatStorageSegments(block.segments)}`;
      const funcs: StorageFunctionMap = block.visibleFuncs ?? new Map();
      for (const allow of block.allows) {
        if (!grantCoversVerb(allow.verbs, method)) continue;
        candidateAllows.push({
          blockPath,
          line: allow.line,
          condition: allow.condition,
          captures,
          funcs,
        });
      }
    }
    const lastSeg = block.segments[block.segments.length - 1];
    if (block.children.length > 0 && lastSeg !== undefined && lastSeg.kind === 'wildcard') {
      const prefixLeft = matchStorageSegments(block.segments.slice(0, -1), remaining, rules._version);
      if (prefixLeft !== null) {
        for (let splitLen = prefixLeft.length; splitLen >= minimum; splitLen--) {
          const childLeft = prefixLeft.slice(splitLen);
          for (const child of block.children) {
            collect(child, childLeft, captures);
          }
        }
        return;
      }
    }
    for (const child of block.children) {
      collect(child, left, captures);
    }
  };

  collect(rules._root, pathSegments, EMPTY_STRING_SET);

  const matchedRule = observation.matchedRule;
  let stopAfterIndex = candidateAllows.length - 1;
  if (allowed && matchedRule !== undefined) {
    for (let i = candidateAllows.length - 1; i >= 0; i--) {
      const candidate = candidateAllows[i]!;
      if (candidate.blockPath === matchedRule.path && candidate.line === matchedRule.line) {
        stopAfterIndex = i;
        break;
      }
    }
  }

  for (let i = 0; i <= stopAfterIndex; i++) {
    const candidate = candidateAllows[i]!;
    if (
      candidate.condition !== null &&
      exprMayReadMissingBindingProps(
        candidate.condition,
        targetKind,
        missingProps,
        candidate.captures,
        candidate.funcs,
      )
    ) {
      return true;
    }
  }
  return false;
}
