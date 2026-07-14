/** Downstream consumer contract: app-backed service factories expose `.app`. */
import { getAI } from 'pyric/ai';
import { getAuth } from 'pyric/auth';
import { getDatabase } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { getStorage } from 'pyric/storage';

export function appServiceNamesCompile(): string[] {
  return [
    getAuth().app.name,
    getFirestore().app.name,
    getDatabase().app.name,
    getStorage().app.name,
    getAI().app.name,
  ];
}
