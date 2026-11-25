/**
 * Backend configuration classes for `pyric/ai`, mirroring `@firebase/ai@3.1.0`:
 * an abstract {@link Backend} carrying `backendType`, with
 * {@link GoogleAIBackend} as the default backend.
 *
 * In the sandbox mirror the backend is a pure configuration marker; the
 * broker answers in-process either way. Production imports load Firebase's
 * own backend classes before this package enters the graph.
 */

/** Identifies which backend service the SDK communicates with. */
export const BackendType = {
  AGENT_PLATFORM: 'AGENT_PLATFORM',
  GOOGLE_AI: 'GOOGLE_AI',
} as const;
export type BackendType = (typeof BackendType)[keyof typeof BackendType];

/**
 * Abstract base class representing the configuration for an AI service
 * backend. Do not instantiate directly -- use {@link GoogleAIBackend}.
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
