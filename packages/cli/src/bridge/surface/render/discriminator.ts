/**
 * The `discriminator` variant: twelve intent tools carrying an `action` field,
 * plus seven resource templates for the reads.
 *
 * The tools keep the names, descriptions, action enums, and JSON-encoded
 * string parameters of the typed service contract they were authored on. This
 * renderer is what makes them executable against the canonical operation set:
 * a route picks the operation for the arguments in hand, translates the
 * JSON-encoded strings into that operation's objects, and calls its one
 * handler, so the same code runs here as under every other variant.
 */
import { toJsonSchema } from '../json-schema.js';
import type {
  OperationResult,
  RenderedResource,
  RenderedSurface,
  RenderedTool,
  ResolvedCall,
  SurfaceContext,
} from '../types.js';
import { CANONICAL_OPERATION_IDS, runCanonicalOperation } from './canonical-dispatch.js';
import {
  DISCRIMINATOR_RESOURCES,
  RESOURCE_ROUTES,
  matchResourceUri,
} from './discriminator-resources.js';
import { DISCRIMINATOR_ROUTES, DISCRIMINATOR_TOOLS } from './discriminator-routes.js';

type Args = Record<string, unknown>;

/** The per-call auth override the data tools carry, as an identity switch. */
interface CallIdentity {
  mode: 'admin' | 'uid' | 'anonymous';
  uid?: string;
  tenant?: string;
  claims?: Record<string, unknown>;
}

function callIdentity(args: Args): CallIdentity | null {
  const override = args.auth;
  if (override === null || override === undefined || typeof override !== 'object') return null;
  const fields = override as Args;
  if (typeof fields.mode !== 'string') return null;
  const identity: CallIdentity = { mode: fields.mode as CallIdentity['mode'] };
  if (typeof fields.uid === 'string') identity.uid = fields.uid;
  if (typeof fields.tenant === 'string') identity.tenant = fields.tenant;
  if (typeof fields.claimsJson === 'string') {
    identity.claims = JSON.parse(fields.claimsJson) as Record<string, unknown>;
  }
  return identity;
}

/** Run one operation, under a per-call identity override when the arguments carry one. */
async function runUnderCallIdentity(
  operation: string,
  translated: Args,
  args: Args,
  ctx: SurfaceContext,
): Promise<OperationResult> {
  const override = callIdentity(args);
  if (override === null) return runCanonicalOperation(operation, translated, ctx);
  const held = ctx.identity.describe();
  ctx.identity.switchTo(override);
  try {
    return await runCanonicalOperation(operation, translated, ctx);
  } finally {
    ctx.identity.switchTo(held);
  }
}

function routeFor(toolName: string, args: Args) {
  return DISCRIMINATOR_ROUTES.find((route) => route.tool === toolName && route.selects(args));
}

/**
 * The operation a read of one resource template runs, or null when the name is
 * not a resource of this variant. Reads arrive at the audit log under the
 * resource name rather than a tool name, and the parameters a read resolves on
 * are the template variables, plus the `uri` the server records alongside them.
 */
function resourceOperationFor(resourceName: string, args: Args): string | null {
  const resource = DISCRIMINATOR_RESOURCES.find((candidate) => candidate.name === resourceName);
  if (resource === undefined) return null;
  const uri = typeof args.uri === 'string' ? args.uri : null;
  const fromUri = uri === null ? null : matchResourceUri(resource.uriTemplate, uri);
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(fromUri ?? args)) {
    if (typeof value === 'string') params[key] = value;
  }
  const route = RESOURCE_ROUTES.find(
    (candidate) => candidate.uriTemplate === resource.uriTemplate && candidate.selects(params),
  );
  return route?.operation ?? null;
}

function renderTool(name: string, description: string, parameters: RenderedTool['inputSchema']) {
  return { name, description, inputSchema: parameters };
}

function buildTools(): RenderedTool[] {
  return DISCRIMINATOR_TOOLS.map((tool) => ({
    ...renderTool(tool.name, tool.description, toJsonSchema(tool.parameters)),
    async execute(args: Args, ctx: SurfaceContext) {
      const route = routeFor(tool.name, args);
      if (route === undefined) {
        return {
          ok: false,
          summary: `${tool.name}: this combination is not available in this build.`,
        };
      }
      return runUnderCallIdentity(route.operation, route.translate(args), args, ctx);
    },
  }));
}

function buildResources(): RenderedResource[] {
  return DISCRIMINATOR_RESOURCES.map((resource) => ({
    uriTemplate: resource.uriTemplate,
    name: resource.name,
    description: resource.description,
    async read(uri: string, ctx: SurfaceContext) {
      const params = matchResourceUri(resource.uriTemplate, uri);
      if (params === null) {
        return { ok: false, summary: `${uri} does not match ${resource.uriTemplate}.` };
      }
      const route = RESOURCE_ROUTES.find(
        (candidate) => candidate.uriTemplate === resource.uriTemplate && candidate.selects(params),
      );
      if (route === undefined) {
        return { ok: false, summary: `${resource.name} is not available in this build.` };
      }
      return runCanonicalOperation(route.operation, route.translate(params), ctx);
    },
  }));
}

export function render(): RenderedSurface {
  const known = new Set(CANONICAL_OPERATION_IDS);
  for (const route of DISCRIMINATOR_ROUTES) {
    if (!known.has(route.operation)) {
      throw new Error(`discriminator route names unknown operation '${route.operation}'`);
    }
  }

  return {
    tools: buildTools(),
    resources: buildResources(),
    resolve(toolName: string, args: Args): ResolvedCall {
      const route = routeFor(toolName, args);
      if (route !== undefined) return { operation: route.operation, action: route.action };
      const resourceOperation = resourceOperationFor(toolName, args);
      if (resourceOperation !== null) return { operation: resourceOperation, action: null };
      const action = typeof args.action === 'string' ? args.action : null;
      return { operation: null, action };
    },
  };
}
