/**
 * Tool record contract shared by both sides of the bridge.
 *
 * One MCP tool is authored as one record under `tool-records/`: its name,
 * its position in the default `tools/list` order, its description, and its
 * operations. Each operation names its transport, the factory that produces
 * its handler, and the handler by name; the operation's input schema is the
 * handler's schema minus any `fixed` fields the record pins.
 *
 * `scripts/generate-tool-registry.ts` aggregates the records into
 * `tool-records.generated.ts`. This module reads only that aggregate, so the
 * browser bundle and the MCP process share one manifest without either
 * importing the other's factories.
 *
 * Factories live in `server/tool-factories.ts` (Node) and
 * `client/tool-factories.ts` (browser). Each map is typed against the factory
 * keys derived here, so an operation naming a factory without an entry, or a
 * factory entry no operation names, fails to compile.
 */
import { TOOL_RECORDS } from './tool-records.generated.js';

export type ToolTransport = 'forwarded' | 'in-process';

/** Closed set of leading service words a tool name may use. */
export const TOOL_SERVICE_WORDS = [
  'firestore',
  'database',
  'storage',
  'auth',
  'rules',
  'sandbox',
  'pyric',
] as const;

/** One operation of a tool, authored inside its record. */
export interface OpRecord {
  /** `forwarded`: executed by the browser sandbox peer. `in-process`: executed in the MCP process. */
  readonly transport: ToolTransport;
  /** Key of the factory whose handler implements this operation. */
  readonly factory: string;
  /** Exact `name` of the handler the factory yields. */
  readonly handler: string;
  /**
   * Arguments the operation pins before the handler runs. Pinned fields are
   * removed from the operation's input schema and injected on every call.
   */
  readonly fixed?: Readonly<Record<string, unknown>>;
  /** Overrides the handler's description in the tool description. */
  readonly description?: string;
}

/** Authored in one record file per tool. The key is the filename without `.ts`; the generator adds it. */
export interface ToolRecord {
  /** MCP tool name: a service word, optionally followed by one artifact word. */
  readonly name: string;
  /** Stable position in the default `tools/list` order. Unique across all records; authored with gaps of 10. */
  readonly order: number;
  /** Opening sentence of the tool description. The operation list is appended from the ops. */
  readonly description: string;
  /** Operations keyed by `op` value, in the order they are listed. */
  readonly ops: Readonly<Record<string, OpRecord>>;
}

export interface RegisteredToolRecord extends ToolRecord {
  readonly key: string;
}

type Registered = (typeof TOOL_RECORDS)[number];
type OpsOf<R> = R extends { ops: infer O } ? O[keyof O] : never;
type RegisteredOp = OpsOf<Registered>;

export type ToolName = Registered['name'];
export type ForwardedFactoryKey = Extract<RegisteredOp, { transport: 'forwarded' }>['factory'];
export type InProcessFactoryKey = Extract<RegisteredOp, { transport: 'in-process' }>['factory'];

/** One operation flattened with its tool, in `tools/list` order then op order. */
export interface ToolOp extends OpRecord {
  readonly tool: string;
  readonly op: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)?$/;
const OP_PATTERN = /^[a-z][a-z0-9_]*$/;

function assertUnique(label: string, values: readonly (string | number)[]): void {
  const seen = new Set<string | number>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate tool record ${label} '${value}'`);
    seen.add(value);
  }
}

function validateRecord(record: RegisteredToolRecord): void {
  if (!NAME_PATTERN.test(record.name)) {
    throw new Error(`tool record '${record.key}' has an invalid tool name '${record.name}'`);
  }
  const service = record.name.split('_')[0]!;
  if (!(TOOL_SERVICE_WORDS as readonly string[]).includes(service)) {
    throw new Error(
      `tool record '${record.key}' names service '${service}'; expected one of ${TOOL_SERVICE_WORDS.join(', ')}`,
    );
  }
  if (record.key.replace(/-/g, '_') !== record.name) {
    throw new Error(
      `tool record '${record.key}' must be named '${record.key.replace(/-/g, '_')}', not '${record.name}'`,
    );
  }
  const ops = Object.keys(record.ops);
  if (ops.length === 0) throw new Error(`tool record '${record.key}' declares no operations`);
  for (const op of ops) {
    if (!OP_PATTERN.test(op)) {
      throw new Error(`tool record '${record.key}' has an invalid op name '${op}'`);
    }
    if ('op' in (record.ops[op]!.fixed ?? {})) {
      throw new Error(`tool record '${record.key}' op '${op}' pins the reserved field 'op'`);
    }
  }
}

function validateRecords(records: readonly Registered[]): readonly Registered[] {
  assertUnique('key', records.map((record) => record.key));
  assertUnique('order', records.map((record) => record.order));
  assertUnique('name', records.map((record) => record.name));
  for (const record of records) validateRecord(record);
  return [...records].sort((a, b) => a.order - b.order);
}

const RECORDS_BY_ORDER = validateRecords(TOOL_RECORDS);

/** Every tool record, sorted by `order`. Validates once at load: duplicate key, order, or name throws. */
export function toolRecords(): readonly Registered[] {
  return RECORDS_BY_ORDER;
}

/** The wire key of one operation: `tool.op`. */
export function opKey(tool: string, op: string): string {
  return `${tool}.${op}`;
}

/** Every operation, flattened, in `tools/list` order then op order; optionally one transport. */
export function toolOps(transport?: ToolTransport): readonly ToolOp[] {
  const ops: ToolOp[] = [];
  for (const record of RECORDS_BY_ORDER) {
    for (const [op, spec] of Object.entries(record.ops)) {
      if (transport && spec.transport !== transport) continue;
      ops.push({ tool: record.name, op, ...spec });
    }
  }
  return ops;
}

/**
 * Resolve the handler behind each operation from factory output, keyed by
 * `tool.op`. `produce` is called once per distinct factory key. Fails closed
 * when a record names a handler its factory does not yield.
 */
export function resolveOpHandlers<H extends { name: string }>(
  ops: readonly ToolOp[],
  produce: (spec: ToolOp) => readonly H[],
): Map<string, { spec: ToolOp; handler: H }> {
  const byFactory = new Map<string, Map<string, H>>();
  const resolved = new Map<string, { spec: ToolOp; handler: H }>();
  for (const spec of ops) {
    let handlers = byFactory.get(spec.factory);
    if (!handlers) {
      handlers = new Map(produce(spec).map((handler) => [handler.name, handler]));
      byFactory.set(spec.factory, handlers);
    }
    const handler = handlers.get(spec.handler);
    if (!handler) {
      throw new Error(
        `tool record ${opKey(spec.tool, spec.op)} names handler '${spec.handler}', which factory '${spec.factory}' does not yield (it yields: ${[...handlers.keys()].join(', ')})`,
      );
    }
    resolved.set(opKey(spec.tool, spec.op), { spec, handler });
  }
  return resolved;
}

/** Arguments a handler receives for one operation: the caller's fields plus the record's pinned ones. */
export function bindOpArgs(
  op: Pick<OpRecord, 'fixed'>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return op.fixed ? { ...args, ...op.fixed } : args;
}

/**
 * Fail closed when a composed side yields a different `tool.op` set from the
 * records. Both sides call this with the same message so drift reads the same
 * wherever it surfaces.
 */
export function assertExactOpKeys(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((name, index) => name !== expectedSorted[index])
  ) {
    throw new Error(
      `${label} drifted from the default MCP contract\n` +
        `expected: ${expected.join(', ')}\n` +
        `actual:   ${actual.join(', ')}`,
    );
  }
}
