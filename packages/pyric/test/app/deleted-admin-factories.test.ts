import { beforeEach, expect, test } from 'bun:test';
import { deleteApp, initializeApp } from 'pyric/app';
import { getAdminDatabase } from 'pyric/database';
import { getAdminFirestore } from 'pyric/firestore';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';

beforeEach(() => resetAppRegistryForTests());

test('rules-bypass admin factories reject a deleted FirebaseApp', async () => {
  const app = initializeApp({ projectId: 'deleted-admin-factories' });
  await deleteApp(app);

  expect(() => getAdminFirestore(app)).toThrow(
    expect.objectContaining({ code: 'app/app-deleted' }),
  );
  expect(() => getAdminDatabase(app)).toThrow(
    expect.objectContaining({ code: 'app/app-deleted' }),
  );
});
