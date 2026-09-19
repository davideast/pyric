import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { startHostedFixture } from './fixture.js';

test('hosted startup identifies Node execution and its persisted state file', async () => {
  const serve = await startHostedFixture();
  try {
    await expect.poll(() => serve.stderr()).toContain('the pyric sandbox executes in this Node process');
    const output = serve.stderr();
    expect(output).toContain('deployed to the Node sandbox');
    expect(serve.info).toMatchObject({ persist: true });
    expect(output).toContain(join(serve.dir, '.pyric', 'state', 'hosted', 'state.sqlite'));
    expect(output).not.toContain('data is held in Node memory and is lost when this process stops');
    expect(output).not.toContain('data lives in this browser');
    expect(output).not.toContain('the pyric sandbox runs IN the served page');
    expect(output).not.toContain('in-page sandbox');
  } finally {
    await serve.stop();
  }
});
