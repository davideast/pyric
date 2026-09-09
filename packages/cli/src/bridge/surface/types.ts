/**
 * The shape every surface renders into, and the context every handler is given.
 *
 * Rendering is a pure function from the method records to a tool list plus a
 * resolver; execution never depends on which surface is served, because every
 * rendered tool routes back to the one handler on the record. The resolver
 * reports the canonical operation a call reached, which is the join key the
 * audit log, the evaluation corpus, and the scorer share.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import type { SandboxDispatch } from '../client/dispatch.js';
import type { SurfaceIdentity } from './identity.js';

/** What one operation returns. Mirrors the dispatcher's result shape. */
export interface OperationResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** Everything a handler is given: the sandbox, the shared dispatcher, and the caller identity. */
export interface SurfaceContext {
  sandbox: LocalSandbox;
  dispatch: SandboxDispatch;
  identity: SurfaceIdentity;
  /** Where checkpoint and fixture files read and write. Defaults to the process's own working directory. */
  projectDir: string;
}

/** One tool as an MCP client sees it. */
export interface RenderedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: SurfaceContext): Promise<OperationResult>;
}

/** One resource template as an MCP client sees it. */
export interface RenderedResource {
  uriTemplate: string;
  name: string;
  description: string;
  read(uri: string, ctx: SurfaceContext): Promise<OperationResult>;
}

/** What a rendered tool call resolves to in the audit log. */
export interface ResolvedCall {
  operation: string | null;
  action: string | null;
}

/** Rendering options every renderer accepts. */
export interface RenderOptions {
  /** Mount `production` methods. Defaults to false, the safe default. */
  allowProduction?: boolean;
}

/** One variant's rendering: what the client sees, plus the audit resolver. */
export interface RenderedSurface {
  tools: RenderedTool[];
  resources?: RenderedResource[];
  resolve(toolName: string, args: Record<string, unknown>): ResolvedCall;
}
