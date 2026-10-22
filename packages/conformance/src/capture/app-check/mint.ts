/**
 * Admin createToken with a bounded retry. Production intermittently answers a
 * burst of exchangeCustomToken calls with "App attestation failed."; a later
 * call for the same app succeeds. The retry count is logged, never the token.
 */
import type { AppCheck, AppCheckTokenOptions, AppCheckToken } from 'firebase-admin/app-check';

const ATTEMPTS = 8;
const SPACING_MS = 20_000;

export async function mintWithRetry(appCheck: AppCheck, appId: string, options?: AppCheckTokenOptions): Promise<AppCheckToken> {
  for (let attempt = 1; ; attempt++) {
    try {
      const token = await appCheck.createToken(appId, options);
      if (attempt > 1) console.log(`createToken succeeded on attempt ${attempt}`);
      return token;
    } catch (error) {
      const attestationFailed = String((error as Error).message).includes('App attestation failed');
      if (!attestationFailed || attempt >= ATTEMPTS) throw error;
      console.log(`createToken attempt ${attempt} answered "App attestation failed."; retrying in ${SPACING_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
    }
  }
}
