/**
 * The tool surface a server serves.
 *
 * `renderSurface(undefined)` is today's default surface, so a server started
 * without a variant behaves exactly as it always has. A variant id returns
 * that variant's rendering of the same operation set: the names and parameter
 * shapes differ, the handlers do not. An unknown id throws with the ids that
 * exist, because a mistyped variant would otherwise measure the wrong surface.
 */
import { OPERATIONS } from './operations/index.js';
import { render as renderDefault } from './render/default.js';
import { render as renderDiscriminator } from './render/discriminator.js';
import { render as renderNounPrefixed } from './render/noun-prefixed.js';
import { render as renderSdkService } from './render/sdk-service.js';
import { render as renderVerbPrefixed } from './render/verb-prefixed.js';
import { render as renderVerbSuffixed } from './render/verb-suffixed.js';
import type { Operation, RenderedSurface } from './types.js';

type Renderer = (operations: readonly Operation[]) => RenderedSurface;

const RENDERERS: Readonly<Record<string, Renderer>> = {
  discriminator: renderDiscriminator,
  'verb-prefixed': renderVerbPrefixed,
  'noun-prefixed': renderNounPrefixed,
  'verb-suffixed': renderVerbSuffixed,
  'sdk-service': renderSdkService,
};

/** The variant ids a server accepts. */
export const SURFACE_VARIANT_IDS: readonly string[] = Object.keys(RENDERERS);

/** Render one surface. No id renders the default surface. */
export function renderSurface(surfaceId: string | undefined): RenderedSurface {
  if (surfaceId === undefined) return renderDefault();
  const renderer = RENDERERS[surfaceId];
  if (renderer === undefined) {
    throw new Error(
      `unknown tool surface '${surfaceId}'; known surfaces: ${SURFACE_VARIANT_IDS.join(', ')}`,
    );
  }
  return renderer(OPERATIONS);
}

export { createSurfaceContext } from './context.js';
export { OPERATIONS, OPERATIONS_BY_ID, operationById } from './operations/index.js';
export type {
  Operation,
  OperationRecord,
  OperationResult,
  RenderedResource,
  RenderedSurface,
  RenderedTool,
  ResolvedCall,
  SurfaceContext,
} from './types.js';
