import type { Page } from '@playwright/test';

const runtimeModes = {
  hosted: 'hosted',
  sharedworker: 'shared-worker',
  inpage: 'in-page',
} as const;

/** Select the runtime before application imports, and name the expected public diagnostic. */
export async function prepareRuntimeFixture(page: Page, mode: keyof typeof runtimeModes) {
  const flags = ['--no-capture'];
  const isHosted = mode === 'hosted';
  if (isHosted) flags.push('--hosted');
  const isInpage = mode === 'inpage';
  if (isInpage) {
    await page.addInitScript(() => {
      Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
    });
  }
  const expectedMode = runtimeModes[mode];
  return { flags, expectedMode };
}
