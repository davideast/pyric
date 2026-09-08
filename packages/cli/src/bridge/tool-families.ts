/**
 * Tool family contract backed by the Typed-Service Contract Foundation (`./contract/index.js`).
 */
import { MCP_TOOL_CONTRACTS } from './contract/index.js';

export type ToolTransport = 'forwarded' | 'in-process';

export interface ToolFamilyRecord {
  readonly transport: ToolTransport;
  readonly order: number;
  readonly tools: readonly string[];
}

export interface ToolFamily extends ToolFamilyRecord {
  readonly key: string;
}

const TYPED_CONTRACT_FAMILIES: readonly ToolFamily[] = [
  {
    key: 'typed-contract',
    transport: 'forwarded',
    order: 10,
    tools: MCP_TOOL_CONTRACTS.map((c) => c.name),
  },
] as const;

export type ForwardedFamilyKey = 'typed-contract';
export type InProcessFamilyKey = never;

export function toolFamilies<T extends ToolTransport>(
  transport: T
): readonly ToolFamily[] {
  return TYPED_CONTRACT_FAMILIES.filter((family) => family.transport === transport);
}

/**
 * Fail closed when a factory yields a different name set from the contract.
 */
export function assertExactToolNames(
  label: string,
  actual: readonly string[],
  expected: readonly string[]
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
        `actual:   ${actual.join(', ')}`
    );
  }
}
