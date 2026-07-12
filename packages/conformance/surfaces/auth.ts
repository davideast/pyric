import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 2,
  kind: 'mirror',
  registry: 'auth',
  censusSurface: 'auth',
  upstream: 'firebase/auth',
  mirrors: ['pyric/auth'],
  // `admin-app-` observations are Phase-A bootstrap captures of firebase-admin's
  // in-process app registry; they have no matrix rows yet (each is listed in
  // exceptions/) and reuse the auth registry, so auth owns the prefix.
  observationPrefixes: ['auth-', 'admin-app-'],
  coverage: true,
  scopeNote:
    'out of scope: fetchSignInMethodsForEmail only — deprecated upstream as a security retraction (it returns an empty list wherever Email Enumeration Protection is on, which is the default), so mirroring it would make the sandbox more capable than production and silently mislead code that branches on the result. Account linking, re-authentication, and the email-link / action-code family were DEFERRED and are now BUILT, through the same resolver/mock seam OAuth sign-in uses; the sandbox is the mail server, and sandbox.takeAuthMail hands the program the real out-of-band code a human would have clicked. Remaining deferred: MFA / phone / reCAPTCHA, buildable via the same seam.',
  captureRigs: ['oracle-run', 'admin-app'],
};
