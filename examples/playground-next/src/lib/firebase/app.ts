/**
 * Firebase web SDK init for the playground's own Firebase project
 * (the project that hosts the deployed site). Used for:
 *
 *   - Google sign-in (Firebase Auth's popup/redirect flow)
 *   - Holding the OAuth access token that `sessions.ts` uses against
 *     Firebase Management API + each user's own Storage bucket
 *
 * NOT used for: the sandbox simulator, the BYOK keys, or any
 * playground runtime concern. Those live elsewhere.
 *
 * Config is fetched at build time from Firebase Hosting's auto-init
 * endpoint (`/__/firebase/init.json`) by `astro.config.mjs` and
 * inlined into the client bundle as `__PYRIC_FIREBASE_CONFIG__`. No
 * `.env` file required — see `astro.config.mjs` for the fetch site
 * and the self-host override note.
 *
 * The auto-init payload includes everything Firebase Auth needs:
 * `apiKey`, `authDomain`, `projectId`, `storageBucket`,
 * `messagingSenderId`. `appId` is omitted by Hosting; Auth doesn't
 * require it.
 */
import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

const APP_NAME = 'pyric-playground';

interface PublicConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId?: string;
  appId?: string;
}

// Injected at build time by `astro.config.mjs` as a JSON string;
// parsed once on first use.
let parsedConfig: PublicConfig | null = null;
function getConfig(): PublicConfig {
  if (parsedConfig) return parsedConfig;
  const raw = (import.meta.env as Record<string, string | undefined>)
    .PUBLIC_FIREBASE_CONFIG;
  if (!raw) {
    throw new Error(
      'PUBLIC_FIREBASE_CONFIG was not injected. Check astro.config.mjs — ' +
        'the build-time fetch from /__/firebase/init.json may have failed.',
    );
  }
  parsedConfig = JSON.parse(raw) as PublicConfig;
  return parsedConfig;
}

let cached: FirebaseApp | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (cached) return cached;
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) {
    cached = existing;
    return existing;
  }
  cached = initializeApp(getConfig(), APP_NAME);
  return cached;
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}
