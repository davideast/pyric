/**
 * Tool handler shapes shared by every Pyric tool factory (rules, Firestore,
 * Storage, the CLI bridge and the MCP server).
 *
 * These types carry only the fields Pyric reads or writes. They are
 * structurally assignable to the agent runtime's tool types, so a host that
 * runs an agent registry can register Pyric tools directly; Pyric itself
 * takes no dependency on that runtime.
 */

/** JSON Schema for a tool's arguments, as sent to a model or an MCP client. */
export type ToolParameters = {
  type?: string;
  description?: string;
  properties?: Record<string, ToolParameters>;
  required?: string[];
  items?: ToolParameters | ToolParameters[];
  enum?: unknown[];
  [key: string]: unknown;
};

/** Context passed to every `execute` call. */
export interface ToolContext {
  /** Cancellation signal; long-running tools observe it. */
  signal: AbortSignal;
}

/** Outcome of one tool call. */
export interface ToolResult<D = unknown> {
  ok: boolean;
  /** One-line human-readable summary of the outcome. */
  summary: string;
  data?: D;
}

/** A named tool with JSON Schema arguments and an async `execute`. */
export interface ToolHandler<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute(args: A, ctx: ToolContext): Promise<ToolResult<D>>;
}
