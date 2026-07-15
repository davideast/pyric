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
    'fetchSignInMethodsForEmail remains a public gap despite its upstream deprecation and security disposition. Account linking, re-authentication, and email-link/action-code APIs are built. MFA, phone, reCAPTCHA, and their exported types remain public gaps and stay in the denominator.',
  captureRigs: ['oracle-run', 'admin-app'],
};
