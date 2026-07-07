/**
 * Ambient declarations for the DEV-only test hatches the
 * playground installs on `window`. The production code declares
 * these globals too (in `lib/auth/gis-token.ts` and
 * `lib/store/workspace.ts`), but `declare global` is scoped to the
 * declaring file's compilation — the test files don't import those
 * modules, so we re-declare here for the test program.
 */

interface PyricTestSeedInput {
  rules?: string;
  code?: string;
  appSource?: string;
  deployTarget?: {
    projectId: string;
    siteId?: string;
    firebaseConfig?: {
      apiKey: string;
      authDomain: string;
      projectId: string;
      storageBucket?: string;
      messagingSenderId?: string;
      appId?: string;
    };
  } | null;
}

declare global {
  interface Window {
    __pyricTestToken?: string;
    __pyricTestSeed?: (partial: PyricTestSeedInput) => void;
  }
}

export {};
