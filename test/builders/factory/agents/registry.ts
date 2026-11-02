/**
 * The factory's agent adapters by name: what `--agent` takes. The one place
 * shared code reaches an adapter; everything else depends on `../agent.ts`.
 */
import type { AgentAdapter } from '../agent.ts';
import { codexAgent } from './codex/adapter.ts';

const ADAPTERS: readonly AgentAdapter[] = [codexAgent];

export const AGENT_NAMES: readonly string[] = ADAPTERS.map((adapter) => adapter.name);

/** The adapter `name` names, or undefined. */
export function findAgent(name: string): AgentAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.name === name);
}

/** The adapter `name` names; throws, listing the names there are, when none does. */
export function agentNamed(name: string): AgentAdapter {
  const adapter = findAgent(name);
  if (adapter === undefined) throw new Error(`no agent adapter named "${name}"; there are: ${AGENT_NAMES.join(', ')}`);
  return adapter;
}
