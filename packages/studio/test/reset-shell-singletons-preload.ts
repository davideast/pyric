// Preloaded by packages/studio/bunfig.toml so every test starts and finishes
// with clean module-level /__pyric/health and /__pyric/init.json singletons,
// without installing any DOM/JSDOM globals on the shared test realm.
import { afterEach, beforeEach } from 'bun:test';
import { resetLiveStatusPollerForTesting } from '../src/shell/live-status.js';
import { resetServeInitForTests } from '../src/shell/serve-init.js';

beforeEach(() => {
  resetLiveStatusPollerForTesting();
  resetServeInitForTests();
});

afterEach(() => {
  resetLiveStatusPollerForTesting();
  resetServeInitForTests();
});
