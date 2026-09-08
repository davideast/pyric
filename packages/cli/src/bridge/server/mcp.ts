/**
 * MCP server assembly. Constructs an `@modelcontextprotocol/sdk`
 * `McpServer` whose tools and resources dispatch into the supplied bridge.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolHandler } from '@inbrowser/agent';
import type { Bridge, BridgeToolResult } from './bridge.js';
import type { ToolMetadata } from './tool-metadata.js';
import { jsonSchemaToZodShape } from './json-schema-to-zod.js';
import { MCP_RESOURCE_CONTRACTS } from '../contract/index.js';

import {
  listSessions,
  readCallerIdentity,
  setCallerIdentity,
  setSessionIdentity,
} from '../../auth/identity.js';
import type { AuthLens } from 'pyric/sandbox';

export interface RegisterToolsOptions {
  /** Metadata for tools whose dispatch goes to the bridge peer. */
  forwarded: ToolMetadata[];
  /** Live handlers for tools that execute in-process on the bridge. */
  inProcess: ToolHandler[];
}

function toMcpResult(result: BridgeToolResult, project: string) {
  const body = {
    ...result,
    _pyric: { mode: 'sandbox', project },
  };
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(body, null, 2),
      },
    ],
    isError: !result.ok,
  };
}

function toAuthLens(args: Record<string, unknown>): AuthLens {
  const mode = args.mode;
  if (mode === 'admin') return { mode: 'admin' };
  if (mode === 'anonymous') return { mode: 'anon' };
  if (mode === 'app-session') return { mode: 'app-session' };
  if (mode === 'uid' && typeof args.uid === 'string') {
    const token =
      typeof args.claimsJson === 'string' && args.claimsJson.trim().length > 0
        ? (JSON.parse(args.claimsJson) as Record<string, unknown>)
        : undefined;
    return {
      mode: 'as',
      uid: args.uid,
      ...(typeof args.tenant === 'string' ? { tenant: args.tenant } : {}),
      ...(token !== undefined ? { token } : {}),
    };
  }
  return { mode: 'app-session' };
}

/**
 * Build an MCP server seeded with the supplied tool surface and all 7 pyric:// resources.
 */
export function buildMcpServer(
  bridge: Bridge,
  options: RegisterToolsOptions
): McpServer {
  const server = new McpServer({
    name: 'pyric',
    version: bridge.version,
  });

  // Forwarded tools: bridge.dispatch handles the wire round-trip.
  for (const meta of options.forwarded) {
    const shape = jsonSchemaToZodShape(meta.parameters as never);
    (server.tool as unknown as Function)(
      meta.name,
      meta.description,
      shape,
      async (args: Record<string, unknown>) => {
        if (meta.name === 'inspect_auth_flow') {
          if (args.action === 'list_sessions') {
            return toMcpResult(listSessions(bridge.consumers), bridge.project);
          }
          if (args.action === 'whoami') {
            return toMcpResult(readCallerIdentity(bridge.callerIdentity), bridge.project);
          }
        }
        if (meta.name === 'switch_auth_identity') {
          const lens = toAuthLens(args);
          if (typeof args.target === 'string' && args.target.length > 0) {
            const res = setSessionIdentity(
              bridge.consumers,
              args.target,
              lens,
              'switch_auth_identity'
            );
            return toMcpResult(res, bridge.project);
          }
          const res = setCallerIdentity(bridge.callerIdentity, lens);
          if (!bridge.isSandboxConnected()) {
            return toMcpResult(res, bridge.project);
          }
          const sandboxResult = await bridge.dispatch(meta.name, args ?? {});
          return toMcpResult(
            {
              ok: sandboxResult.ok && res.ok,
              summary: res.summary,
              data: sandboxResult.data ?? res.data,
            },
            bridge.project
          );
        }
        const result = await bridge.dispatch(meta.name, args ?? {});
        return toMcpResult(result, bridge.project);
      }
    );
  }

  // In-process tools
  for (const handler of options.inProcess) {
    const shape = jsonSchemaToZodShape(handler.parameters as never);
    (server.tool as unknown as Function)(
      handler.name,
      handler.description,
      shape,
      async (args: Record<string, unknown>) => {
        const startedAtMs = Date.now();
        try {
          const ctx = {
            signal: new AbortController().signal,
          } as never;
          const result = await handler.execute(args ?? {}, ctx);
          const normalised = {
            ok: result.ok,
            summary: result.summary,
            data: result.data,
          };
          bridge.recordToolEvent({
            timestamp: new Date(startedAtMs).toISOString(),
            mode: 'sandbox',
            project: bridge.project,
            tool: handler.name,
            args: args ?? {},
            result: normalised,
            durationMs: Date.now() - startedAtMs,
          });
          return toMcpResult(normalised, bridge.project);
        } catch (err) {
          const result = {
            ok: false,
            summary: err instanceof Error ? err.message : String(err),
          };
          bridge.recordToolEvent({
            timestamp: new Date(startedAtMs).toISOString(),
            mode: 'sandbox',
            project: bridge.project,
            tool: handler.name,
            args: args ?? {},
            result,
            durationMs: Date.now() - startedAtMs,
          });
          return toMcpResult(result, bridge.project);
        }
      }
    );
  }

  // Register all 7 pyric:// MCP Resource URI Templates
  for (const resourceContract of MCP_RESOURCE_CONTRACTS) {
    const isTemplate = resourceContract.uriTemplate.includes('{');
    const target = isTemplate
      ? new ResourceTemplate(resourceContract.uriTemplate, { list: undefined })
      : resourceContract.uriTemplate;

    (server.resource as unknown as Function)(
      resourceContract.name,
      target,
      { description: resourceContract.description, mimeType: resourceContract.mimeType },
      async (uri: URL) => {
        const res = await bridge.dispatch('__pyric_resource_read__', { uri: uri.href });
        const payload = res.ok && res.data !== undefined ? res.data : { error: res.summary };
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: resourceContract.mimeType,
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      }
    );
  }

  return server;
}
