/**
 * Tool family contract shared by both sides of the bridge.
 *
 * A family is authored as one record under `tool-family-records/`: its
 * transport, its position in the default `tools/list` order, and the exact
 * tool names its factory yields. `scripts/generate-tool-family-registry.ts`
 * aggregates the records into `tool-families.generated.ts`. This module reads
 * only that aggregate, so the browser bundle and the MCP process share one
 * manifest without either importing the other's factories.
 *
 * Factories live in `server/tool-family-factories.ts` (Node) and
 * `client/tool-family-factories.ts` (browser). Each map is typed against the
 * family keys derived here, so a record without a factory, or a factory
 * without a record, fails to compile.
 */
import { TOOL_FAMILIES } from './tool-families.generated.js';

export type ToolTransport = 'forwarded' | 'in-process';

/** Authored in one record file per family. The key is the filename without `.ts`; the generator adds it. */
export interface ToolFamilyRecord {
  /** `forwarded`: executed by the browser sandbox peer. `in-process`: executed in the MCP process. */
  readonly transport: ToolTransport;
  /** Stable position in the default `tools/list` order. Unique across all records; authored with gaps of 10. */
  readonly order: number;
  /** Exact names the family factory yields for the default surface, in factory order. */
  readonly tools: readonly string[];
}

export interface ToolFamily extends ToolFamilyRecord {
  readonly key: string;
}

type RegisteredFamily = (typeof TOOL_FAMILIES)[number];
export type ForwardedFamilyKey = Extract<RegisteredFamily, { transport: 'forwarded' }>['key'];
export type InProcessFamilyKey = Extract<RegisteredFamily, { transport: 'in-process' }>['key'];

function assertUnique(label: string, values: readonly (string | number)[]): void {
  const seen = new Set<string | number>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate tool family ${label} '${value}'`);
    seen.add(value);
  }
}

function validateFamilies(families: readonly RegisteredFamily[]): readonly RegisteredFamily[] {
  assertUnique('key', families.map((family) => family.key));
  assertUnique('order', families.map((family) => family.order));
  assertUnique('tool name', families.flatMap((family) => family.tools));
  return [...families].sort((a, b) => a.order - b.order);
}

const FAMILIES_BY_ORDER = validateFamilies(TOOL_FAMILIES);

/** Families of one transport, sorted by `order`. Validates once at load: duplicate key, order, or tool name throws. */
export function toolFamilies<T extends ToolTransport>(
  transport: T,
): readonly Extract<RegisteredFamily, { transport: T }>[] {
  return FAMILIES_BY_ORDER.filter(
    (family): family is Extract<RegisteredFamily, { transport: T }> =>
      family.transport === transport,
  );
}

/**
 * Fail closed when a factory yields a different name set from the records.
 * Both sides call this with the same message so drift reads the same
 * wherever it surfaces.
 */
export function assertExactToolNames(
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
