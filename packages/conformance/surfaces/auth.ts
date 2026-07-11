import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 2,
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
    'out of scope: none (internal plumbing only) — every remaining gap (linking, reauth, MFA/phone/reCAPTCHA, email-link) is deferred, buildable via the resolver/mock pattern already proven for OAuth sign-in.',
  captureRigs: ['oracle-run', 'admin-app'],
};
