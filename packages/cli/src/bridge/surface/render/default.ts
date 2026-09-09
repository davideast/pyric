/**
 * The default surface, unchanged.
 *
 * When no variant is requested the server serves exactly what it serves today:
 * the forwarded tool families executed through the sandbox dispatcher and the
 * in-process families executed here, with the names, descriptions, and
 * parameter schemas the family records already pin. Nothing about this
 * rendering is variant-specific; it exists so that one function returns a
 * surface whatever the caller asked for, and so a default-surface call still
 * stamps a canonical operation on its audit event where one corresponds.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { getDefaultMcpToolSurface } from '../../server/mcp-contract.js';
import type { RenderedSurface, RenderedTool, SurfaceContext } from '../types.js';

/**
 * What each default tool name means in canonical terms. A default tool with no
 * counterpart in the operation set resolves to no operation, which is what the
 * audit event records.
 */
const CANONICAL_BY_DEFAULT_TOOL: Readonly<Record<string, string>> = {
  auth_create_user: 'create_auth_user',
  auth_get_user: 'get_auth_user',
  auth_list_users: 'list_auth_users',
  auth_update_user: 'update_auth_user',
  auth_delete_user: 'delete_auth_user',
  auth_set_claims: 'set_auth_claims',
  auth_impersonate: 'switch_auth_identity',
  firestore_get_document: 'get_firestore_document',
  firestore_list_documents: 'list_firestore_documents',
  firestore_create_document: 'write_firestore_document',
  firestore_add_document: 'add_firestore_document',
  firestore_update_document: 'update_firestore_document',
  firestore_delete_document: 'delete_firestore_document',
  firestore_batch_write: 'batch_firestore_writes',
  firestore_query_where: 'query_firestore_documents',
  firestore_lint_rules: 'lint_firestore_rules',
  firestore_simulate_rules: 'simulate_firestore_rules',
  firestore_rules_stdlib_list: 'list_rules_stdlib',
  firestore_rules_stdlib_get: 'get_rules_stdlib',
  rules_stdlib_list: 'list_rules_stdlib',
  rules_stdlib_get: 'get_rules_stdlib',
  rtdb_simulate_access: 'simulate_database_rules',
  sandbox_inspect: 'inspect_sandbox',
};

/** The minimal tool context the in-process handlers read. */
function handlerContext(): never {
  return { signal: new AbortController().signal } as never;
}

function forwardedTool(name: string, description: string, schema: Record<string, unknown>): RenderedTool {
  return {
    name,
    description,
    inputSchema: schema,
    execute: (args, ctx: SurfaceContext) => ctx.dispatch(name, args, ctx.identity.lens()),
  };
}

function inProcessTool(handler: ToolHandler): RenderedTool {
  return {
    name: handler.name,
    description: handler.description,
    inputSchema: handler.parameters as Record<string, unknown>,
    execute: async (args) => handler.execute(args, handlerContext()),
  };
}

export function render(): RenderedSurface {
  const surface = getDefaultMcpToolSurface();
  const tools = [
    ...surface.forwarded.map((tool) =>
      forwardedTool(tool.name, tool.description, tool.parameters),
    ),
    ...surface.inProcess.map(inProcessTool),
  ];
  return {
    tools,
    resolve(toolName) {
      return { operation: CANONICAL_BY_DEFAULT_TOOL[toolName] ?? null, action: null };
    },
  };
}
