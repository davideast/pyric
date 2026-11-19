import {
  observeEmptyPasswordSignInSemantics,
  type EmptyPasswordSignInProbeContext,
} from '../probes/auth/auth-signin-empty-password-error.ts';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';

export interface AuthEmptyPasswordReplaySession {
  readonly context: EmptyPasswordSignInProbeContext;
  cleanup(): Promise<void>;
}

export async function replayAuthSignInEmptyPasswordError(
  session: AuthEmptyPasswordReplaySession,
): Promise<Behavior> {
  try {
    return await observeEmptyPasswordSignInSemantics(session.context);
  } finally {
    await session.cleanup();
  }
}
