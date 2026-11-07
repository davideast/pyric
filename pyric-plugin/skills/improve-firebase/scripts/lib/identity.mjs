import { ContractValidationError } from './contracts.mjs';

const AUTH_SESSION_STORAGE_KEY = 'pyric:serve:auth-session';
const AUTH_LENS_STORAGE_KEY = 'pyric:auth-lens';

function resolveTargetUrl(appUrl, view) {
  const base = String(appUrl || 'http://127.0.0.1').trim();
  if (!view || view === '/') {
    return base.endsWith('/') ? base : `${base}/`;
  }
  return new URL(String(view), base.endsWith('/') ? base : `${base}/`).toString();
}

async function seedBrowserAuthStorage(page, uid) {
  if (!page) return;
  const payload = uid ? JSON.stringify({ uid }) : null;

  if (typeof page.addInitScript === 'function') {
    await page.addInitScript(
      ({ sessionKey, lensKey, rawSession, actorUid }) => {
        try {
          if (rawSession) {
            window.localStorage.setItem(sessionKey, rawSession);
            window.sessionStorage.setItem(lensKey, rawSession);
            if (window.__PYRIC_AUTH__) {
              if (typeof window.__PYRIC_AUTH__.impersonate === 'function') {
                window.__PYRIC_AUTH__.impersonate(actorUid);
              } else if (typeof window.__PYRIC_AUTH__.signIn === 'function') {
                window.__PYRIC_AUTH__.signIn({ uid: actorUid });
              }
            }
          } else {
            window.localStorage.removeItem(sessionKey);
            window.sessionStorage.removeItem(lensKey);
          }
        } catch {
          // Ignore storage access errors on about:blank before origin navigation
        }
      },
      {
        sessionKey: AUTH_SESSION_STORAGE_KEY,
        lensKey: AUTH_LENS_STORAGE_KEY,
        rawSession: payload,
        actorUid: uid ?? null,
      },
    );
  }
}

async function applyInPageAuthState(page, uid, customToken = null) {
  if (!page || typeof page.evaluate !== 'function') return;
  await page.evaluate(
    async ({ sessionKey, lensKey, actorUid, token }) => {
      try {
        if (actorUid) {
          const serialized = JSON.stringify({ uid: actorUid });
          window.localStorage.setItem(sessionKey, serialized);
          window.sessionStorage.setItem(lensKey, serialized);
        } else {
          window.localStorage.removeItem(sessionKey);
          window.sessionStorage.removeItem(lensKey);
        }

        const pyricAuth = window.__PYRIC_AUTH__;
        if (pyricAuth) {
          if (!actorUid && typeof pyricAuth.signOut === 'function') {
            await pyricAuth.signOut();
          } else if (actorUid && typeof pyricAuth.impersonate === 'function') {
            await pyricAuth.impersonate(actorUid);
          } else if (token && typeof pyricAuth.signInWithCustomToken === 'function') {
            await pyricAuth.signInWithCustomToken(token);
          } else if (actorUid && typeof pyricAuth.switchUser === 'function') {
            await pyricAuth.switchUser(actorUid);
          }
        }
      } catch {
        // Ignore if page has no active origin yet
      }
    },
    {
      sessionKey: AUTH_SESSION_STORAGE_KEY,
      lensKey: AUTH_LENS_STORAGE_KEY,
      actorUid: uid ?? null,
      token: customToken,
    },
  ).catch(() => {});
}

async function signInViaEmulatorRest({ authEmulatorUrl, email, password, displayName }) {
  if (!authEmulatorUrl) return null;
  const base = String(authEmulatorUrl).replace(/\/+$/, '');
  const signUpUrl = `${base}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=pyric-sandbox`;
  const signInUrl = `${base}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=pyric-sandbox`;

  let res = await fetch(signUpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      ...(displayName ? { displayName } : {}),
      returnSecureToken: true,
    }),
  });
  let body = await res.json().catch(() => ({}));
  if (!res.ok && body?.error?.message === 'EMAIL_EXISTS') {
    res = await fetch(signInUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    });
    body = await res.json().catch(() => ({}));
  }
  return res.ok ? body : null;
}

async function tryFillVisibleEmailPasswordForm(page, email, password, waitTimeoutMs = 0) {
  if (!page || typeof page.locator !== 'function') return false;
  try {
    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[placeholder*="email" i]')
      .first();
    const passInput = page
      .locator('input[type="password"], input[name="password"]')
      .first();

    if (waitTimeoutMs > 0) {
      await passInput.waitFor({ state: 'visible', timeout: waitTimeoutMs }).catch(() => {});
    }

    const emailVisible = await emailInput.isVisible().catch(() => false);
    const passVisible = await passInput.isVisible().catch(() => false);
    if (!emailVisible || !passVisible) return false;

    await emailInput.fill(email);
    await passInput.fill(password);

    const submitBtn = page
      .locator(
        'form button[type="submit"], form button:not([type="button"]), button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Sign In")',
      )
      .first();
    const hasSubmit = await submitBtn.isVisible().catch(() => false);
    if (hasSubmit) {
      await submitBtn.click();
    } else {
      await passInput.press('Enter');
    }
    await passInput.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Signs an actor's Playwright Page into the sandbox app using the best available strategy:
 *   - `'auth-lens'`: Pyric hosted auth impersonation + session storage persistence
 *   - `'email-password'`: Sandbox/emulator user creation + credential sign-in / form fill + session persistence
 *   - `'anonymous'`: Anonymous sandbox session (clears prior user session)
 *   - `'auto'` (default): Automatically chooses `'anonymous'` when `actor.anonymous` or `!actor.uid`,
 *     otherwise uses `'auth-lens'` (or `'email-password'` when explicit credentials/strategy specified).
 *
 * @param {{
 *   page: object,
 *   sandbox?: object,
 *   actor: { uid?: string, email?: string, password?: string, displayName?: string, claims?: Record<string, unknown>, customClaims?: Record<string, unknown>, view?: string, strategy?: 'auth-lens' | 'email-password' | 'anonymous' | 'auto', anonymous?: boolean },
 *   appUrl?: string,
 *   authEmulatorUrl?: string,
 * }} options
 * @returns {Promise<{ uid: string | null, strategy: string, url: string, idToken: string | null }>}
 */
export async function signInActorPage({ page, sandbox, actor = {}, appUrl, authEmulatorUrl } = {}) {
  if (!page) {
    throw new ContractValidationError('signInActorPage requires a Playwright page instance');
  }

  const targetUrl = resolveTargetUrl(appUrl || sandbox?.url, actor.view);
  const requestedStrategy = actor.strategy || 'auto';
  const isAnon =
    requestedStrategy === 'anonymous' || actor.anonymous === true || !actor.uid;

  if (isAnon) {
    if (sandbox?.callHostedMethod) {
      await sandbox.callHostedMethod('auth.actAsAnonymous', {});
    }
    await seedBrowserAuthStorage(page, null);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await applyInPageAuthState(page, null, null);
    return {
      uid: null,
      strategy: 'anonymous',
      url: page.url?.() || targetUrl,
      idToken: null,
    };
  }

  const uid = String(actor.uid).trim();
  let email = actor.email || `${uid}@sandbox.invalid`;
  const password =
    typeof actor.password === 'string' && actor.password.length >= 6
      ? actor.password
      : `sandbox-${uid}-pw`;
  const claims = actor.customClaims || actor.claims || {};

  let idToken = null;
  if (sandbox) {
    const ensured = await sandbox.ensureUser({
      uid,
      email: actor.email,
      password,
      displayName: actor.displayName || uid,
      customClaims: claims,
    });
    if (ensured?.email) {
      email = ensured.email;
    }
    idToken = await sandbox.mintCustomToken(uid, claims);
    await sandbox.callHostedMethod('auth.impersonate', {
      uid,
      ...(Object.keys(claims).length > 0 ? { customClaims: claims } : {}),
    });
  }

  const effectiveStrategy =
    requestedStrategy !== 'auto'
      ? requestedStrategy
      : actor.password
        ? 'email-password'
        : 'auth-lens';

  if (effectiveStrategy === 'email-password' && authEmulatorUrl) {
    const restSession = await signInViaEmulatorRest({
      authEmulatorUrl,
      email,
      password,
      displayName: actor.displayName || uid,
    });
    if (restSession?.idToken) {
      idToken = restSession.idToken;
    }
  }

  await seedBrowserAuthStorage(page, uid);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(async () => {
    await page.goto(targetUrl, { waitUntil: 'commit' }).catch(() => {});
  });
  await seedBrowserAuthStorage(page, uid).catch(() => {});
  await applyInPageAuthState(page, uid, idToken);

  if (effectiveStrategy === 'email-password') {
    await tryFillVisibleEmailPasswordForm(page, email, password, 1500);
  } else {
    // If a client SDK login form rendered (e.g. Firebase Auth SDK awaiting sign-in), fill it automatically.
    const submittedForm = await tryFillVisibleEmailPasswordForm(page, email, password, 0);
    if (!submittedForm) {
      await ensureActorPageHydrated({
        page,
        uid,
        idToken,
        appUrl: targetUrl,
        actor,
        minStabilityMs: 700,
      });
    }
  }

  return {
    uid,
    strategy: effectiveStrategy,
    url: page.url?.() || targetUrl,
    idToken,
  };
}

/**
 * Verifies that an actor page remains on the sandbox origin, retains its session storage,
 * and has rendered non-empty DOM text (plus any `actor.expect.before` text). If an initial
 * auth guard bounced the tab off-origin or hydration stalled, reloads and re-applies auth
 * up to 10 attempts / 25 seconds until settled.
 *
 * @param {{
 *   page: object,
 *   uid?: string | null,
 *   idToken?: string | null,
 *   appUrl: string,
 *   actor?: object,
 *   minStabilityMs?: number,
 * }} options
 */
export async function withOffOriginNavigationGuard(page, appUrl, fn) {
  let targetOrigin = null;
  if (appUrl) {
    try {
      targetOrigin = new URL(String(appUrl)).origin;
    } catch {
      targetOrigin = null;
    }
  }

  let offOriginGuard = null;
  if (targetOrigin && page && typeof page.route === 'function') {
    offOriginGuard = async (route) => {
      const req = route.request();
      const reqUrlStr = req.url();
      let reqOrigin = null;
      try {
        reqOrigin = new URL(reqUrlStr).origin;
      } catch {
        reqOrigin = null;
      }
      const isExternalTopNav =
        typeof req.isNavigationRequest === 'function' &&
        req.isNavigationRequest() &&
        typeof req.frame === 'function' &&
        typeof page.mainFrame === 'function' &&
        req.frame() === page.mainFrame() &&
        /^https?:\/\//i.test(reqUrlStr) &&
        reqOrigin !== targetOrigin;
      if (isExternalTopNav) {
        await route.abort('aborted').catch(() => {});
        return;
      }
      await route.continue().catch(() => {});
    };
    await page.route('**/*', offOriginGuard).catch(() => {
      offOriginGuard = null;
    });
  }

  try {
    return await fn();
  } finally {
    if (offOriginGuard && page && typeof page.unroute === 'function') {
      await page.unroute('**/*', offOriginGuard).catch(() => {});
    }
  }
}

export async function ensureActorPageHydrated({
  page,
  uid = null,
  idToken = null,
  appUrl,
  actor = {},
  minStabilityMs = 700,
} = {}) {
  if (!page || typeof page.goto !== 'function') {
    return;
  }

  const targetUrl = resolveTargetUrl(appUrl, actor.view);
  let targetOrigin = null;
  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch {
    targetOrigin = null;
  }

  const rawBeforeExpect = actor?.expect?.before;
  const expectedBeforeText =
    typeof rawBeforeExpect === 'string'
      ? rawBeforeExpect
      : rawBeforeExpect && typeof rawBeforeExpect.text === 'string'
        ? rawBeforeExpect.text
        : null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadlineMs = Date.now() + 25000;
  const hasRealUrl = typeof page.url === 'function';
  const stabilityMs = hasRealUrl ? minStabilityMs : 0;

  await withOffOriginNavigationGuard(page, targetOrigin, async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const attemptEndMs = Math.min(deadlineMs, Date.now() + (hasRealUrl ? 3000 : 250));
      let hydratedAtMs = null;

      while (true) {
        const currentUrl = page.url?.() || '';
        let currentOrigin = null;
        try {
          currentOrigin = new URL(currentUrl).origin;
        } catch {
          currentOrigin = null;
        }
        const bouncedOffOrigin = Boolean(targetOrigin && currentOrigin && currentOrigin !== targetOrigin);
        if (bouncedOffOrigin) {
          hydratedAtMs = null;
          break;
        }

        const domState =
          typeof page.evaluate === 'function'
            ? await page
                .evaluate(
                  ({ sessionKey, expectedText, requireSession }) => {
                    const hasSession =
                      !requireSession ||
                      typeof window === 'undefined' ||
                      !window.localStorage ||
                      Boolean(window.localStorage.getItem(sessionKey));
                    const hasDocument = typeof document !== 'undefined' && Boolean(document.body);
                    const bodyText = hasDocument
                      ? String(document.body.innerText || document.body.textContent || '').trim()
                      : '';
                    const hasBodyText = !hasDocument || bodyText.length > 0;
                    const hasExpectedText =
                      !expectedText ||
                      !hasDocument ||
                      bodyText.toLowerCase().includes(String(expectedText).toLowerCase());
                    return {
                      hasSession,
                      hasBodyText,
                      hasExpectedText,
                    };
                  },
                  {
                    sessionKey: AUTH_SESSION_STORAGE_KEY,
                    expectedText: expectedBeforeText,
                    requireSession: Boolean(uid),
                  },
                )
                .catch(() => null)
            : true;

        let ready = false;
        if (domState === true) {
          ready = true;
        } else if (domState && typeof domState === 'object') {
          ready = Boolean(domState.hasSession && domState.hasBodyText && domState.hasExpectedText);
          if (!domState.hasSession && uid) {
            await applyInPageAuthState(page, uid, idToken).catch(() => {});
          }
        }

        if (ready) {
          if (hydratedAtMs === null) {
            hydratedAtMs = Date.now();
          }
          if (Date.now() - hydratedAtMs >= stabilityMs) {
            return;
          }
        } else {
          hydratedAtMs = null;
        }

        if (Date.now() >= attemptEndMs) {
          break;
        }
        await sleep(200);
      }

      if (Date.now() >= deadlineMs || attempt >= 9) {
        break;
      }

      await seedBrowserAuthStorage(page, uid).catch(() => {});
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(async () => {
        await page.goto(targetUrl, { waitUntil: 'commit' }).catch(() => {});
      });
      await seedBrowserAuthStorage(page, uid).catch(() => {});
      await applyInPageAuthState(page, uid, idToken).catch(() => {});
    }
  });
}
