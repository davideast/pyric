import { getDoc as firebaseGetDoc } from 'firebase/firestore';
import { getDoc as liveGetDoc } from '../../../src/serve/entries/live/firestore.js';

// Strict compilation proves the wrapper preserves the real SDK's generic contract.
const compatibleRead: typeof firebaseGetDoc = liveGetDoc;
void compatibleRead;
