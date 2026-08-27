import { expect, it } from 'bun:test';

it('app-backed service factories expose a required .app to downstream TypeScript', () => {
  const result = Bun.spawnSync([
    process.execPath,
    'x',
    'tsc',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'ES2022',
    '--moduleResolution',
    'bundler',
    '--target',
    'ES2022',
    '--types',
    'bun-types',
    'test/app/fixtures/app-service-types.ts',
  ], {
    cwd: `${import.meta.dir}/../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(0);
}, 30_000);
