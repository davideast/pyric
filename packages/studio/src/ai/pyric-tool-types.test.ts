/**
 * Pyric defines its own tool handler types so its published packages carry no
 * agent runtime dependency. Studio hosts the agent, so this file holds the
 * compile-time proof that Pyric tools register with the agent registry
 * without casts. `bun x tsc` checks the type assertions; `bun test` runs the
 * registration.
 */
import { describe, expect, test } from 'bun:test';
import {
  createDispatch,
  createToolRegistry,
  type ToolContext as AgentToolContext,
  type ToolHandler as AgentToolHandler,
  type ToolResult as AgentToolResult,
} from '@inbrowser/agent';
import { createFirestoreRulesStdlibTools } from 'pyric/rules/internal';
import type { ToolContext, ToolHandler, ToolResult } from 'pyric/sandbox/internal';

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

export type PyricToolTypeAssertions = [
  Assert<Assignable<ToolHandler, AgentToolHandler>>,
  Assert<Assignable<ToolHandler<{ path: string }, { count: number }>, AgentToolHandler>>,
  Assert<Assignable<ToolHandler<{ path: string }, { count: number }>, AgentToolHandler<{ path: string }, { count: number }>>>,
  Assert<Assignable<ToolResult<{ count: number }>, AgentToolResult<{ count: number }>>>,
  // The agent passes its own context to `execute`; Pyric handlers accept it.
  Assert<Assignable<AgentToolContext, ToolContext>>,
];

describe('Pyric tool handlers in the agent registry', () => {
  test('register and dispatch without casts', async () => {
    const tools: ToolHandler[] = createFirestoreRulesStdlibTools();
    const registry = createToolRegistry();
    for (const tool of tools) registry.register(tool);
    expect(registry.list().map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));

    const result = await createDispatch(registry).execute(
      { id: 'call-1', name: tools[0]!.name, args: {} },
      { signal: new AbortController().signal },
    );
    expect(result.ok).toBe(true);
  });
});
