/**
 * Backend configuration classes for `pyric/ai`, mirroring the installed
 * `@firebase/ai@2.12.0`: an abstract {@link Backend} carrying
 * `backendType`, with {@link GoogleAIBackend} (the default) and
 * {@link VertexAIBackend} (location defaults to `us-central1`).
 *
 * On sandbox targets the backend is a pure configuration marker (the broker
 * answers in-process either way); on prod targets it is translated to the
 * installed SDK's equivalent class (see prod-backend.ts).
 */

const DEFAULT_LOCATION = 'us-central1';

/** Identifies which backend service the SDK communicates with. */
export const BackendType = {
  VERTEX_AI: 'VERTEX_AI',
  GOOGLE_AI: 'GOOGLE_AI',
} as const;
export type BackendType = (typeof BackendType)[keyof typeof BackendType];

/**
 * Abstract base class representing the configuration for an AI service
 * backend. Do not instantiate directly — use {@link GoogleAIBackend} or
 * {@link VertexAIBackend}.
 */
export abstract class Backend {
  readonly backendType: BackendType;

  protected constructor(type: BackendType) {
    this.backendType = type;
  }
}

/** Configuration class for the Gemini Developer API backend (the default). */
export class GoogleAIBackend extends Backend {
  constructor() {
    super(BackendType.GOOGLE_AI);
  }
}

/** Configuration class for the Vertex AI Gemini API backend. */
export class VertexAIBackend extends Backend {
  readonly location: string;

  constructor(location: string = DEFAULT_LOCATION) {
    super(BackendType.VERTEX_AI);
    this.location = location || DEFAULT_LOCATION;
  }
}
