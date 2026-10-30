import { afterEach, describe, expect, it } from 'bun:test';
import * as upstreamApp from 'firebase/app';
import * as upstreamAppCheck from 'firebase/app-check';
import { initializeApp, getApps, deleteApp } from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/registry.js';
import * as appCheck from '../../src/app-check/index.js';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-check-twice', appId: '1:0:web:0' };
const FLAGS = [undefined, false, true] as const;
type Flag = (typeof FLAGS)[number];

interface Outcome { threw: boolean; code?: string; returnsSameInstance?: boolean }

function withFlag<T extends object>(base: T, flag: Flag): T & { isTokenAutoRefreshEnabled?: boolean } {
  return flag === undefined ? base : { ...base, isTokenAutoRefreshEnabled: flag };
}

function outcomeOf(first: unknown, second: () => unknown): Outcome {
  try {
    return { threw: false, returnsSameInstance: second() === first };
  } catch (error) {
    return { threw: true, code: (error as { code?: string }).code };
  }
}

function token() {
  return Promise.resolve({ token: 'fake-token', expireTimeMillis: Date.now() + 3_600_000 });
}

/** What the installed firebase/app-check does for two calls with these flags. */
function upstreamOutcome(firstFlag: Flag, secondFlag: Flag, name: string): Outcome {
  const app = upstreamApp.initializeApp(OPTS, name);
  const provider = new upstreamAppCheck.CustomProvider({ getToken: token });
  const first = upstreamAppCheck.initializeAppCheck(app, withFlag({ provider }, firstFlag));
  return outcomeOf(first, () => upstreamAppCheck.initializeAppCheck(app, withFlag({ provider }, secondFlag)));
}

function pyricOutcome(firstFlag: Flag, secondFlag: Flag, name: string): Outcome {
  const app = initializeApp(OPTS, name);
  const provider = new appCheck.CustomProvider({ getToken: token });
  const first = appCheck.initializeAppCheck(app, withFlag({ provider }, firstFlag));
  return outcomeOf(first, () => appCheck.initializeAppCheck(app, withFlag({ provider }, secondFlag)));
}

describe('app-check/initializeAppCheck called twice, against the installed firebase', () => {
  afterEach(async () => {
    for (const app of getApps()) await deleteApp(app);
    resetAppRegistryForTests();
    for (const app of upstreamApp.getApps()) await upstreamApp.deleteApp(app);
  });

  for (const firstFlag of FLAGS) {
    for (const secondFlag of FLAGS) {
      it(`isTokenAutoRefreshEnabled ${String(firstFlag)} then ${String(secondFlag)}`, () => {
        const name = `twice-${String(firstFlag)}-${String(secondFlag)}`;
        expect(pyricOutcome(firstFlag, secondFlag, name)).toEqual(upstreamOutcome(firstFlag, secondFlag, name));
      });
    }
  }
});
