import { isRulesMap } from '../../rules/simulator/rules-type.js';
import { RulesValue } from '../../rules/simulator/wrappers/base.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  evalArguments,
  functionNotFound,
  type MethodCall,
  type ReceiverMethods,
} from './rules-method-calls.js';
import { RuleError, isRuleError as isErr } from './rules-values.js';

const PLACEHOLDER = /^(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|\$\(([A-Za-z_][A-Za-z0-9_]*)\))$/;

export class StoragePath extends RulesValue {
  readonly typeName = 'path';
  /** Names bound to segments via `.bind(map)`. */
  readonly bindings: Readonly<Record<string, string>>;
  constructor(
    readonly path: string,
    bindings: Readonly<Record<string, string>> = {},
  ) {
    super();
    this.bindings = bindings;
  }
  /** The path's segments, which `path[i]` reads. */
  get segments(): string[] {
    return this.path.split('/').filter(Boolean);
  }
  bind(bindings: Record<string, unknown>): StoragePath {
    const next: string[] = [];
    const nextBindings: Record<string, string> = { ...this.bindings };
    for (const seg of this.segments) {
      const m = PLACEHOLDER.exec(seg);
      if (!m) {
        next.push(seg);
        continue;
      }
      const name = (m[1] ?? m[2])!;
      if (Object.hasOwn(bindings, name)) {
        const v = bindings[name];
        if (v === null || v === undefined || (typeof v !== 'string' && typeof v !== 'number')) {
          throw new TypeError(`Path.bind(): binding '${name}' must not be null`);
        }
        const sv = String(v);
        next.push(sv);
        nextBindings[name] = sv;
      } else {
        next.push(seg);
      }
    }
    return new StoragePath('/' + next.join('/'), nextBindings);
  }
  valueOf(): number {
    return NaN;
  }
  toJSON(): unknown {
    return { __type: 'path', path: this.toString() };
  }
  equals(other: unknown): boolean {
    return (
      (other instanceof StoragePath || (other instanceof RulesValue && other.typeName === 'path')) &&
      String(other) === this.toString()
    );
  }
  toString(): string {
    return this.path.startsWith('/') ? this.path : `/${this.path}`;
  }
}

function evalPathBind(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!(receiver instanceof StoragePath)) throw functionNotFound('bind');
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  if (args.length !== 1) {
    throw new RuleEvalError(`Incorrect number of arguments. Received: ${args.length}. Expected: path.bind(map).`);
  }
  const [m] = args;
  if (!isRulesMap(m)) {
    return new RuleError('path.bind() requires a map argument');
  }
  try {
    return receiver.bind(m);
  } catch (err) {
    return new RuleError((err as Error).message);
  }
}

export const pathMethods: ReceiverMethods = {
  bind: evalPathBind,
};
