import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resetAppRegistryForTests } from '../../src/app/registry.js';
import { deleteApp, initializeApp } from '../../src/app/index.js';
import { getDatabase, off, onValue, ref } from '../../src/database/index.js';
import { sdkActivity, type SdkActivityRecord } from '../../src/sandbox/internal/sdk-activity.js';

beforeEach(() => resetAppRegistryForTests());
afterEach(() => resetAppRegistryForTests());

for (const path of ['.info', '.info/connected']) {
  for (const termination of ['unsubscribe', 'off', 'onlyOnce', 'deleteApp']) {
    test(`${path} closes its activity exactly once through ${termination}`, async () => {
      const app = initializeApp({ projectId: 'connection-activity' }, crypto.randomUUID());
      const target = ref(getDatabase(app), path);
      const ended: SdkActivityRecord[] = [];
      let deleted = false;
      const stopJournal = sdkActivity.subscribe(event => {
        const isTargetActivity = event.record.service === 'database' && event.record.target === `/${path}`;
        const isTermination = event.phase === 'end';
        if (isTargetActivity && isTermination) ended.push(event.record);
      });
      const callback = () => {};
      const onlyOnce = termination === 'onlyOnce';
      const unsubscribe = onValue(target, callback, { onlyOnce });
      try {
        switch (termination) {
          case 'unsubscribe': unsubscribe(); break;
          case 'off': off(target, 'value', callback); break;
          case 'onlyOnce': await Promise.resolve(); break;
          case 'deleteApp': await deleteApp(app); deleted = true; break;
        }
        expect(ended).toHaveLength(1);
        expect(ended[0]).toMatchObject({ status: 'closed', deliveryCount: 1 });
        unsubscribe();
        expect(ended).toHaveLength(1);
      } finally {
        unsubscribe();
        stopJournal();
        if (!deleted) await deleteApp(app);
      }
    });
  }
}
