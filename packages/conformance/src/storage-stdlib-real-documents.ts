import { type AccessHeaders } from './storage-stdlib-real-api.ts';
import { type RequestBudget } from './storage-stdlib-real-budget.ts';

type FetchRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function deleteFirestoreDocuments(
  targets: Array<{ name: string; headers: AccessHeaders }>,
  budget: RequestBudget,
  request: FetchRequest = fetch,
): Promise<boolean> {
  for (const target of targets) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      budget.take('firestoreWrite');
      try {
        const response = await request(
          `https://firestore.googleapis.com/v1/${target.name}`,
          { method: 'DELETE', headers: target.headers.auth },
        );
        if (response.ok || response.status === 404) break;
      } catch {
        continue;
      }
    }
  }
  const absent: boolean[] = [];
  for (const target of targets) {
    let verified = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      budget.take('firestoreWrite');
      try {
        const response = await request(
          `https://firestore.googleapis.com/v1/${target.name}`,
          { headers: target.headers.auth },
        );
        if (response.status === 404) {
          verified = true;
          break;
        }
        if (response.ok) break;
      } catch {
        continue;
      }
    }
    absent.push(verified);
  }
  return absent.every(Boolean);
}
