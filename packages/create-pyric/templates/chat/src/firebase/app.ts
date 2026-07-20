import { getAI } from 'firebase/ai';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

import { firebaseApp, firebaseConfig } from './config';

export { firebaseApp, firebaseConfig };

export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const rtdb = getDatabase(firebaseApp);
export const storage = getStorage(firebaseApp);
export const ai = getAI(firebaseApp, { useLimitedUseAppCheckTokens: true });
