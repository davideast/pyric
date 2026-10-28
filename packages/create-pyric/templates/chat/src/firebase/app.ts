import { getAI } from 'firebase/ai';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

import { firebaseApp, firebaseConfig } from './config';

export { firebaseApp, firebaseConfig };

// AI Logic requires App Check from November 2, 2026, and getAI reads App
// Check when it starts, so App Check is initialized first.
// In development the debug provider stands in for reCAPTCHA: in production AI
// mode the SDK prints a debug token to the console, which you register under
// App Check > Apps > Manage debug tokens in the Firebase console.
const isDevelopment = import.meta.env.DEV;
if (isDevelopment) {
  const scope = self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string };
  scope.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}
// Replace with your reCAPTCHA v3 site key: Firebase console > App Check > Apps.
const RECAPTCHA_SITE_KEY = 'your-recaptcha-v3-site-key';
initializeAppCheck(firebaseApp, {
  provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});

export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const rtdb = getDatabase(firebaseApp);
export const storage = getStorage(firebaseApp);
export const ai = getAI(firebaseApp, { useLimitedUseAppCheckTokens: true });
