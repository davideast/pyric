import { evaluateHashingMethod } from '../../rules/simulator/hashing-builtins.js';
import { Bytes } from '../../rules/simulator/wrappers/bytes.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleEvalError, RuleUnsupportedError } from './rules-evaluation-error.js';
import {
  evalArguments,
  evalValueMethod,
  type MethodCall,
  type ReceiverMethods,
} from './rules-method-calls.js';
import { describeRulesType as describeType, isRuleError as isErr } from './rules-values.js';

/** The digests the `hashing` namespace defines. */
const HASHING_FUNCTIONS = new Set(['crc32', 'crc32c', 'md5', 'sha256']);

/**
 * `hashing.md5(value)`, `hashing.sha256(value)`, `hashing.crc32(value)`, and
 * `hashing.crc32c(value)` over a string (hashed as its UTF-8 bytes) or Bytes,
 * returning Bytes. Another argument type is production's "Unsupported
 * operation error", captured for `hashing.md5(int)`.
 */
export function evalHashingNamespace(expr: MethodCall, ctx: EvalCtx): unknown {
  if (!HASHING_FUNCTIONS.has(expr.method)) {
    // A name outside the namespace is a compile-reject class: never absorbed.
    throw new RuleUnsupportedError(`unsupported method hashing.${expr.method}()`);
  }
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  if (args.length !== 1) {
    throw new RuleEvalError(`hashing.${expr.method}() expects a single string or bytes argument`);
  }
  const [input] = args;
  if (typeof input !== 'string' && !(input instanceof Bytes)) {
    throw new RuleEvalError(
      `Unsupported operation error. Received: hashing.${expr.method}(${describeType(input)}). `
        + `Expected: hashing.${expr.method}(bytes), hashing.${expr.method}(string).`,
    );
  }
  return evaluateHashingMethod(expr.method, [input]);
}

/**
 * The Bytes encodings, answered by the value itself: `toBase64()` is padded
 * base64url and `toHexString()` is uppercase hexadecimal. `size()` lives with
 * the other sized types.
 */
export const bytesMethods: ReceiverMethods = {
  toBase64: evalValueMethod,
  toHexString: evalValueMethod,
};
