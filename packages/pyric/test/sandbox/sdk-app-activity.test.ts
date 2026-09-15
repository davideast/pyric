import { expect, it } from 'bun:test';
import { initializeApp, deleteApp } from 'pyric/app';
import { getFirestore, doc, getDoc, onSnapshot } from 'pyric/firestore';
import { getDatabase, ref, get, sandbox as databaseSandbox } from 'pyric/database';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';
import { sandboxForApp } from '../../dist/app/runtime.js';
import { setRules } from 'pyric/sandbox/firestore';
import { sdkActivity, type SdkActivityEvent } from '../../src/sandbox/internal/sdk-activity.js';

it('shares app identity across services, separates apps, and records duplicate listener aborts', async () => {
  await resetAppRegistryForTests();
  const apps = ['first', 'second'].map(name => initializeApp({ projectId: 'activity-apps' }, `activity-${name}`));
  const remaining = new Set(apps);
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  const unsubscribes: Array<() => void> = [];
  try {
    for (const app of apps) {
      const sandbox = sandboxForApp(app);
      setRules(sandbox, 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /{path=**} { allow read: if true; } } }');
      const database = getDatabase(app);
      databaseSandbox.setDefaultPolicy(database, 'allow');
      await getDoc(doc(getFirestore(app), 'messages/one'));
      await get(ref(database, 'messages'));
    }
    const reads = events.filter(event => event.phase === 'start').map(event => event.record);
    expect(reads).toHaveLength(4);
    expect(reads[0].appId).toBe(reads[1].appId);
    expect(reads[2].appId).toBe(reads[3].appId);
    expect(reads[0].appId).not.toBe(reads[2].appId);
    const errors: unknown[] = [];
    const observer = { next() { expect(this).toBe(observer); }, error(error: unknown) { errors.push(error); } };
    const target = doc(getFirestore(apps[0]), 'messages/one');
    unsubscribes.push(onSnapshot(target, observer), onSnapshot(target, observer));
    await new Promise(resolve => setTimeout(resolve, 10));
    const registrations = events.filter(event => event.phase === 'start' && event.record.kind === 'subscription').map(event => event.record);
    expect(registrations).toHaveLength(2);
    expect(registrations[0].sourceId).toBe(reads[0].sourceId);
    expect(registrations[0].id).not.toBe(registrations[1].id);
    for (const registration of registrations) {
      expect(events.filter(event => event.phase === 'delivery' && event.record.id === registration.id)).toHaveLength(1);
    }
    await deleteApp(apps[0]);
    remaining.delete(apps[0]);
    expect(errors).toHaveLength(2);
    for (const registration of registrations) {
      expect(events.filter(event => event.phase === 'end' && event.record.id === registration.id).map(event => event.record.status)).toEqual(['failed']);
    }
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
    stop();
    await Promise.all([...remaining].map(app => deleteApp(app)));
  }
});
