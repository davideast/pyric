/**
 * The variant-independent operation vocabulary and the shape every surface
 * variant renders into.
 *
 * An operation is one thing an agent can do to the sandbox. The canonical id
 * is `verb_service_object` and is the join key the audit log, the corpus, and
 * the scorer share. Rendering is a pure function from these records to a tool
 * list plus a resolver; execution never depends on the variant, because every
 * rendered tool routes back to the one handler on the record.
 */
import type { z } from 'zod';
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
}

/**
 * One authored operation record. The canonical id is the filename and is not
 * repeated inside the file; the loader stamps it, the same way the tool-family
 * records are keyed.
 */
export interface OperationRecord {
  /** The action word of the canonical id. */
  verb: string;
  /** The service the operation acts on. */
  service: string;
  /** The object the operation acts on. */
  object: string;
  /** One sentence an agent reads to choose this operation. */
  description: string;
  /** Real nested objects, at most two object levels below the root. */
  parameters: z.ZodObject<z.ZodRawShape>;
  handler(args: Record<string, unknown>, ctx: SurfaceContext): Promise<OperationResult>;
}

/** A loaded record: the authored fields plus the id read from the filename. */
export interface Operation extends OperationRecord {
  readonly id: string;
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

/** One variant's rendering: what the client sees, plus the audit resolver. */
export interface RenderedSurface {
  tools: RenderedTool[];
  resources?: RenderedResource[];
  resolve(toolName: string, args: Record<string, unknown>): ResolvedCall;
}
