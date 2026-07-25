import { getAI } from 'firebase/ai';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

import { firebaseApp, firebaseConfig } from './config';

export { firebaseApp, firebaseConfig };

const appWithContainer = firebaseApp as { container?: unknown };
const hasContainer = appWithContainer.container !== undefined;
if (hasContainer) {
  const isWindowDefined = typeof window !== 'undefined';
  if (isWindowDefined) {
    const win = window as unknown as Record<string, unknown>;
    win.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  import('firebase/app-check')
    .then(({ initializeAppCheck, ReCaptchaV3Provider }) => {
      const isAvailable = typeof initializeAppCheck === 'function';
      if (isAvailable) {
        initializeAppCheck(firebaseApp, {
          provider: new ReCaptchaV3Provider('6Ld_unused_test_key_for_debug'),
          isTokenAutoRefreshEnabled: true,
        });
      }
    })
    .catch((err) => {
      console.warn('App Check initialization failed:', err);
    });
}

export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const rtdb = getDatabase(firebaseApp);
export const storage = getStorage(firebaseApp);
export const ai = getAI(firebaseApp, { useLimitedUseAppCheckTokens: true });
