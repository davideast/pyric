/**
 * Browser-side upstream `firebase/auth` popup client for `auth-google-oauth` (#1814).
 *
 * Bundled by `browser-bridge.ts` via `Bun.build` and served on `localhost` so
 * the operator clicks two real `signInWithPopup(auth, GoogleAuthProvider)`
 * buttons (first `@gmail.com`, then non-`@gmail.com`) and posts the result back
 * to the local loopback session server.
 */
import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAdditionalUserInfo,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth';

declare const __FIREBASE_CONFIG__: Record<string, string>;
declare const __SESSION_TOKEN__: string;

interface StepDescriptor {
  readonly step: 'gmail' | 'non-gmail';
  readonly expectedEmail: string;
}

function decodeJwtEmail(jwt: string | null | undefined): string | null {
  if (!jwt) {
    return null;
  }
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const payloadSegment = parts[1];
  if (!payloadSegment) {
    return null;
  }
  try {
    const padded = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(padded)) as { email?: unknown };
    if (typeof decoded.email === 'string' && decoded.email.trim() !== '') {
      return decoded.email;
    }
  } catch {
    return null;
  }
  return null;
}

function extractResolvedEmail(
  userEmail: string | null,
  providerEmails: readonly (string | null)[],
  profileEmail: unknown,
  idToken: string | null | undefined,
): string | null {
  if (typeof userEmail === 'string' && userEmail.trim() !== '') {
    return userEmail;
  }
  for (const item of providerEmails) {
    if (typeof item === 'string' && item.trim() !== '') {
      return item;
    }
  }
  if (typeof profileEmail === 'string' && profileEmail.trim() !== '') {
    return profileEmail;
  }
  return decodeJwtEmail(idToken);
}

function extractRejectedEmail(err: unknown): {
  email: string | null;
  errorCode: string;
  credentialPresent: boolean;
} {
  let errorCode = 'auth/unknown';
  let customEmail: string | null = null;
  let tokenResponseEmail: string | null = null;

  if (typeof err === 'object' && err !== null) {
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      errorCode = rawCode;
    }
    const customData = (err as { customData?: Record<string, unknown> }).customData;
    if (customData && typeof customData === 'object') {
      if (typeof customData.email === 'string' && customData.email.trim() !== '') {
        customEmail = customData.email;
      }
      const tokenResp = customData._tokenResponse as { email?: unknown } | undefined;
      if (tokenResp && typeof tokenResp.email === 'string' && tokenResp.email.trim() !== '') {
        tokenResponseEmail = tokenResp.email;
      }
    }
  }

  let credentialPresent = false;
  let jwtEmail: string | null = null;
  if (typeof err === 'object' && err !== null) {
    const cred = GoogleAuthProvider.credentialFromError(err as never);
    if (cred !== null) {
      credentialPresent = true;
      jwtEmail = decodeJwtEmail(cred.idToken);
    }
  }

  const email = customEmail ?? tokenResponseEmail ?? jwtEmail;
  return { email, errorCode, credentialPresent };
}

const app = initializeApp(__FIREBASE_CONFIG__);
const auth = getAuth(app);
await setPersistence(auth, inMemoryPersistence);

const statusEl = document.getElementById('status');
const buttonEl = document.getElementById('run-step') as HTMLButtonElement | null;
const detailEl = document.getElementById('step-detail');

function setBanner(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

let currentStep: StepDescriptor | null = null;

async function pollNextStep(): Promise<void> {
  for (;;) {
    const resp = await fetch('/api/next-step', {
      headers: { 'x-pyric-oauth-token': __SESSION_TOKEN__ },
    });
    const body = (await resp.json()) as
      | { state: 'waiting' }
      | { state: 'done'; message: string }
      | { state: 'ready'; step: 'gmail' | 'non-gmail'; expectedEmail: string };

    if (body.state === 'done') {
      currentStep = null;
      if (buttonEl) {
        buttonEl.disabled = true;
      }
      if (detailEl) {
        detailEl.textContent = '';
      }
      setBanner(body.message);
      return;
    }

    if (body.state === 'ready') {
      currentStep = { step: body.step, expectedEmail: body.expectedEmail };
      if (detailEl) {
        detailEl.textContent = `Target account: ${body.expectedEmail}`;
      }
      if (buttonEl) {
        buttonEl.disabled = false;
        let stepNum = '2';
        let stepLabel = '2 (non-@gmail.com)';
        if (body.step === 'gmail') {
          stepNum = '1';
          stepLabel = '1 (@gmail.com)';
        }
        buttonEl.textContent = `Step ${stepNum}: Sign in with Google (${body.step})`;
        setBanner(`Ready for Step ${stepLabel}. Click the button below.`);
      } else {
        setBanner('Ready for Google sign-in step.');
      }
      return;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

buttonEl?.addEventListener('click', async () => {
  if (!currentStep || !buttonEl) {
    return;
  }
  const active = currentStep;
  buttonEl.disabled = true;
  setBanner(`Opening Google sign-in popup for ${active.expectedEmail}...`);

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    login_hint: active.expectedEmail,
    prompt: 'select_account',
  });

  let payload: Record<string, unknown>;
  try {
    const cred = await signInWithPopup(auth, provider);
    const idTokenResult = await cred.user.getIdTokenResult();
    const oauthCred = GoogleAuthProvider.credentialFromResult(cred);
    const additional = getAdditionalUserInfo(cred);
    const profileEmail = (additional?.profile as { email?: unknown } | null | undefined)?.email;
    const observedEmail = extractResolvedEmail(
      cred.user.email,
      cred.user.providerData.map((p) => p.email),
      profileEmail,
      oauthCred?.idToken,
    );

    const sensitiveValues: string[] = [cred.user.uid];
    if (cred.user.displayName) {
      sensitiveValues.push(cred.user.displayName);
    }
    if (cred.user.photoURL) {
      sensitiveValues.push(cred.user.photoURL);
    }

    payload = {
      step: active.step,
      result: {
        outcome: 'resolved',
        observedEmail,
        resolvedUid: cred.user.uid,
        userEmailVerified: cred.user.emailVerified,
        userProviderIds: cred.user.providerData.map((p) => p.providerId),
        tokenEmailVerifiedClaim: idTokenResult.claims.email_verified === true,
        tokenSignInProvider: idTokenResult.signInProvider ?? null,
        credentialFromResultPresent: oauthCred !== null,
        sensitiveValues,
      },
    };
  } catch (err: unknown) {
    const extracted = extractRejectedEmail(err);
    payload = {
      step: active.step,
      result: {
        outcome: 'rejected',
        observedEmail: extracted.email,
        errorCode: extracted.errorCode,
        credentialFromErrorPresent: extracted.credentialPresent,
      },
    };
  } finally {
    await signOut(auth).catch(() => {});
  }

  await fetch('/api/step-result', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pyric-oauth-token': __SESSION_TOKEN__,
    },
    body: JSON.stringify(payload),
  });

  setBanner('Step submitted to local capture harness; waiting for next step...');
  await pollNextStep();
});

void pollNextStep();
