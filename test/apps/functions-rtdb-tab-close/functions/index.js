import { getApps, initializeApp } from 'firebase-admin/app';
import { onValueCreated } from 'firebase-functions/v2/database';

if (getApps().length === 0) initializeApp();

export const uppercaseItem = onValueCreated('/items/{id}/original', async (event) => {
  const original = String(event.data.val() ?? '');
  try {
    await event.data.ref.parent?.child('uppercase').set(original.toUpperCase());
  } catch {
    // Handler-level write errors during peer disconnect are separate from
    // envelope construction before the handler is invoked.
  }
});
