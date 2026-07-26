import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  getAuth,
  RecaptchaVerifier,
  initializeRecaptchaConfig,
} from '../../src/auth/index.js';

describe('reCAPTCHA inert verifier token (CDD)', () => {
  test('RecaptchaVerifier satisfies instanceof checks and resolves verification token', async () => {
    const app = initializeSandbox({ projectId: 'test-recaptcha' });
    const auth = getAuth(app);

    let callbackFired = false;
    const verifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
      size: 'invisible',
      callback: (token) => {
        callbackFired = true;
        expect(token).toBe('test-recaptcha-token-mock-0000');
      },
    });

    expect(verifier instanceof RecaptchaVerifier).toBe(true);
    expect(await verifier.render()).toBe(0);

    const token = await verifier.verify();
    expect(token).toBe('test-recaptcha-token-mock-0000');
    expect(callbackFired).toBe(true);

    verifier.clear();
  });

  test('initializeRecaptchaConfig resolves cleanly', async () => {
    const app = initializeSandbox({ projectId: 'test-recaptcha-config' });
    const auth = getAuth(app);
    await expect(initializeRecaptchaConfig(auth)).resolves.toBeUndefined();
  });
});
