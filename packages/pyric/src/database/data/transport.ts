import type { UserAuth } from '../types.js';

/**
 * Transport used by the production-facing RTDB tools.
 *
 * The interface deliberately exposes RTDB operations rather than Firebase
 * SDK handles. Pyric owns tool result and error semantics; callers provide an
 * adapter for the environment that actually performs the data operation.
 */
export interface RtdbDataTransport {
  get(path: string, auth?: UserAuth): Promise<unknown>;
  set(path: string, value: unknown, auth?: UserAuth): Promise<void>;
  update(
    path: string,
    values: Record<string, unknown>,
    auth?: UserAuth,
  ): Promise<void>;
  push(
    path: string,
    value: unknown,
    auth?: UserAuth,
  ): Promise<{ key: string | null }>;
  remove(path: string, auth?: UserAuth): Promise<void>;
}
