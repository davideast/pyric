/**
 * The tool surface a server serves.
 *
 * `renderSurface(undefined)` is the product surface: the six service tools of
 * `sdk-service`, rendered from the method records. A surface id returns another
 * rendering of the same records, which is what the surface evaluation compares:
 * the names and parameter shapes differ, the handlers do not. An unknown id
 * throws with the ids that exist, because a mistyped id would otherwise measure
 * the wrong surface.
 */
import { render as renderDiscriminator } from './render/discriminator.js';
import { render as renderNounPrefixed } from './render/noun-prefixed.js';
import { render as renderSdkService, type RenderOptions } from './render/sdk-service.js';
import { render as renderVerbPrefixed } from './render/verb-prefixed.js';
import { render as renderVerbSuffixed } from './render/verb-suffixed.js';
import type { RenderedSurface } from './types.js';

export type { RenderOptions };

type Renderer = (options?: RenderOptions) => RenderedSurface;

/** The surface every server serves unless a caller names another. */
export const DEFAULT_SURFACE_ID = 'sdk-service';

const RENDERERS: Readonly<Record<string, Renderer>> = {
  'sdk-service': renderSdkService,
  discriminator: renderDiscriminator,
  'verb-prefixed': renderVerbPrefixed,
  'noun-prefixed': renderNounPrefixed,
  'verb-suffixed': renderVerbSuffixed,
};

/** The surface ids a server accepts. */
export const SURFACE_VARIANT_IDS: readonly string[] = Object.keys(RENDERERS);

/**
 * Render one surface. No id renders the product surface. `options.allowProduction`
 * mounts `production` methods; only `sdk-service`, the product surface, reads
 * it, since the evaluation variants never run with production access.
 */
export function renderSurface(
  surfaceId: string | undefined,
  options?: RenderOptions,
): RenderedSurface {
  const requested = surfaceId ?? DEFAULT_SURFACE_ID;
  const renderer = RENDERERS[requested];
  if (renderer === undefined) {
    throw new Error(
      `unknown tool surface '${requested}'; known surfaces: ${SURFACE_VARIANT_IDS.join(', ')}`,
    );
  }
  return renderer(options);
}

export { createSurfaceContext } from './context.js';
export { ALLOW_PRODUCTION_FLAG } from './method-effects.js';
export { CANONICAL_OPERATIONS, METHODS, METHODS_BY_KEY, TOOLS } from './methods/index.js';
export type {
  Args,
  Method,
  MethodEffect,
  MethodRecord,
  SdkOrigin,
  Tool,
  ToolRecord,
} from './method-types.js';
export type {
  OperationResult,
  RenderedResource,
  RenderedSurface,
  RenderedTool,
  ResolvedCall,
  SurfaceContext,
} from './types.js';
