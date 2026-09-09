/**
 * The method record: one Firebase SDK method on one service tool, and the one
 * place its name, signature, schema, semantic rules, and implementation live.
 *
 * A record is authored as `methods/<tool>/<method>.ts`. The directory is the
 * tool and the filename is the method, so neither is repeated inside the file
 * except as the two fields the loader checks the path against. Every rendering
 * the project serves is derived from these records: the service tools an MCP
 * client sees, the generated tool descriptions, the canonical-operation tools
 * the evaluation variants serve, and the `pyric <tool> <method>` command line.
 */
import type { z } from 'zod';
import type { OperationResult, SurfaceContext } from './types.js';

/** Arguments as they arrive from a client. */
export type Args = Record<string, unknown>;

/**
 * Where a method's name comes from: the modular client SDK, the Admin SDK, or
 * pyric's own vocabulary for a capability neither SDK has a method for. The
 * vocabulary invariant checks a `firebase-js` or `firebase-admin` name against
 * a generated list of that SDK's real exports, and a `pyric` name against
 * pyric's own export list, so an invented name fails instead of shipping.
 */
export type SdkOrigin = 'firebase-js' | 'firebase-admin' | 'pyric';

/**
 * What a call does to the world.
 *
 * - `read`: no state change.
 * - `write`: changes sandbox state; reversible by checkpoint.
 * - `destructive`: replaces or discards state.
 * - `production`: touches Google infrastructure or real credentials.
 *
 * The class is carried on every record and shown in the generated description.
 * Refusing a `destructive` call without `confirm`, and withholding `production`
 * methods from a server that was not started for them, are enforcement rather
 * than declaration and land separately.
 */
export type MethodEffect = 'read' | 'write' | 'destructive' | 'production';

/** The failure a rejected call returns, in the operation result shape. */
export interface InvalidArguments {
  ok: false;
  summary: string;
  data: {
    code: 'invalid_arguments';
    tool: string;
    method: string;
    field?: string;
    fix: string;
  };
}

/** Build one rejection for a known tool and method. */
export type Fail = (body: string, fix: string, field?: string) => InvalidArguments;

/** What a record's `validate` is given besides the arguments. */
export interface MethodValidationContext {
  /** Build the rejection this method returns, already bound to tool and method. */
  fail: Fail;
}

/**
 * The canonical operation a call reaches: the join key the audit log, the
 * evaluation corpus, and the scorer share.
 *
 * Most methods reach one operation and name it as a string. A method whose
 * arguments choose between operations, such as a rules call that names its
 * service, declares the ids it can reach and how the arguments pick one.
 */
export type CanonicalOperation =
  | string
  | {
      /** Every canonical id this method can reach. */
      readonly ids: readonly string[];
      /** The id these arguments reach. */
      select(args: Args): string;
    };

/**
 * One authored method record. The tool and the method are also the record's
 * path, and the loader refuses a record whose fields disagree with it.
 */
export interface MethodRecord {
  /** The service tool this method belongs to, which is its directory. */
  tool: string;
  /** The method name, which is its filename. */
  method: string;
  sdkOrigin: SdkOrigin;
  effect: MethodEffect;
  /** The SDK call signature, with every enum value spelled out. */
  signature: string;
  /** One sentence an agent reads to choose this method. */
  description: string;
  /** The arguments, under the SDK's own names. */
  args: z.ZodObject<z.ZodRawShape>;
  /** The canonical operation, or the choice among operations, this call reaches. */
  operation: CanonicalOperation;
  /** Argument names from a neighbouring API, mapped to this SDK's name. */
  renames?: Readonly<Record<string, string>>;
  /**
   * Argument names this method refuses in its own words rather than by naming
   * a replacement. A rename and a near-miss both read as "you meant this one",
   * which is wrong for a name that asks for the opposite of what the method
   * already does: pointing `includePasswords` at `excludePasswords` inverts the
   * call. Each entry states the rule the caller broke and the edit that fixes
   * it, and is checked before any rename or spelling guess.
   */
  refusals?: Readonly<Record<string, { rule: string; fix: string }>>;
  /** One example `args` object, shown by `describe`. */
  example: Args;
  /** Rules a schema cannot state. Returns a rejection or null. */
  validate?(args: Args, ctx: MethodValidationContext): InvalidArguments | null;
  /** The one implementation. */
  handler(args: Args, ctx: SurfaceContext): Promise<OperationResult>;
}

/** A loaded record: the authored fields plus the key read from the path. */
export interface Method extends MethodRecord {
  /** `<tool>.<method>`, the key every derived surface joins on. */
  readonly key: string;
}

/** One service tool, authored as `tools/<tool>.ts`. */
export interface ToolRecord {
  /** The opening sentence of the generated description, before the signatures. */
  intro: string;
  /** Stable position in `tools/list`. Unique across the tool records. */
  order: number;
}

/** A loaded tool record: the authored fields plus the name read from the filename. */
export interface Tool extends ToolRecord {
  readonly name: string;
  readonly methods: readonly Method[];
}

/** Every canonical id one record can reach. */
export function operationIds(record: MethodRecord): readonly string[] {
  if (typeof record.operation === 'string') return [record.operation];
  return record.operation.ids;
}

/** The canonical id one call reaches, or null when the arguments do not pick one. */
export function selectOperation(record: MethodRecord, args: Args): string | null {
  if (typeof record.operation === 'string') return record.operation;
  let selected: string;
  try {
    selected = record.operation.select(args);
  } catch {
    return null;
  }
  return record.operation.ids.includes(selected) ? selected : null;
}
