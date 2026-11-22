/**
 * Verifies that `pyric sandbox` and `pyric run` install `@pyric/cli/register`
 * ahead of the developer's own `--require` (#1588) and `--import` (#1619)
 * preloads, so `firebase-admin` imports inside a user preload resolve to the
 * sandbox mirror rather than loading the real package before the hooks exist.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, type App } from '../driver.ts';

interface PreloadReport {
  readonly kind: 'require' | 'import';
  readonly swapped: boolean;
  readonly registerActive: boolean;
}

interface MainReport {
  readonly tag: string;
  readonly swapped: boolean;
  readonly registerActive: boolean;
  readonly label: string | null;
}

function parsePrefixedJson<T>(output: string, prefix: string): T {
  const devPrefix = `[dev] ${prefix}`;
  const line = output
    .split('\n')
    .map((raw) => raw.trim())
    .find((entry) => entry.startsWith(devPrefix));
  assert.ok(line !== undefined, `missing "${devPrefix}" line in output:\n${output}`);
  return JSON.parse(line.slice(devPrefix.length)) as T;
}

async function runSandboxPreloadCase(
  app: App,
  input: {
    readonly stepTitle: string;
    readonly tag: string;
    readonly expectedKind: 'require' | 'import';
    readonly childArgs: readonly string[];
    readonly nodeOptions?: string;
    readonly emptyGcloud: string;
  },
): Promise<void> {
  await app.step(input.stepTitle, async () => {
    const port = await app.freePort();
    const env: Record<string, string> = { CLOUDSDK_CONFIG: input.emptyGcloud };
    if (input.nodeOptions !== undefined) {
      env.NODE_OPTIONS = input.nodeOptions;
    }
    const child = app.pyricProcess(
      ['sandbox', '--hosted', '--no-open', '--port', String(port), '--', ...input.childArgs],
      { env },
    );
    try {
      await child.waitForLog(/MAIN_REPORT /, { timeoutMs: 60_000 });
    } finally {
      await child.stop();
    }
    const preload = parsePrefixedJson<PreloadReport>(child.output, 'PRELOAD_REPORT ');
    const main = parsePrefixedJson<MainReport>(child.output, 'MAIN_REPORT ');
    assert.deepEqual(
      preload,
      { kind: input.expectedKind, swapped: true, registerActive: true },
      child.output,
    );
    assert.deepEqual(
      main,
      {
        tag: input.tag,
        swapped: true,
        registerActive: true,
        label: `written-${input.tag}`,
      },
      child.output,
    );
  });
}

export default scenario(async (app) => {
  const emptyGcloud = join(app.dir, '.empty-gcloud');
  mkdirSync(emptyGcloud, { recursive: true });

  await runSandboxPreloadCase(app, {
    stepTitle: 'pyric sandbox swaps firebase-admin in a CLI --require preload (#1588)',
    tag: 'cli-require',
    expectedKind: 'require',
    childArgs: ['node', '--require', './pre.cjs', 'main.mjs', 'cli-require'],
    emptyGcloud,
  });

  await runSandboxPreloadCase(app, {
    stepTitle: 'pyric sandbox swaps firebase-admin in a NODE_OPTIONS --require preload (#1588)',
    tag: 'env-require',
    expectedKind: 'require',
    childArgs: ['node', 'main.mjs', 'env-require'],
    nodeOptions: '--require ./pre.cjs',
    emptyGcloud,
  });

  await runSandboxPreloadCase(app, {
    stepTitle: 'pyric sandbox swaps firebase-admin in a NODE_OPTIONS --import preload (#1619)',
    tag: 'env-import',
    expectedKind: 'import',
    childArgs: ['node', 'main.mjs', 'env-import'],
    nodeOptions: '--import ./pre.mjs',
    emptyGcloud,
  });

  await app.step(
    'pyric run swaps firebase-admin in both --require and NODE_OPTIONS --import preloads',
    async () => {
      const hostPort = await app.freePort();
      const hostUrl = `http://127.0.0.1:${hostPort}`;
      const host = app.pyricProcess(
        ['sandbox', '--hosted', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(hostPort)],
        { env: { CLOUDSDK_CONFIG: emptyGcloud } },
      );
      try {
        await host.waitForLog(/Local server:/, { timeoutMs: 60_000 });

        const reqRun = await app.pyric(
          ['run', '--sandbox', hostUrl, '--', 'node', '--require', './pre.cjs', 'main.mjs', 'run-require'],
          { env: { CLOUDSDK_CONFIG: emptyGcloud }, timeoutMs: 30_000 },
        );
        assert.equal(reqRun.code, 0, reqRun.output);
        assert.deepEqual(
          parsePrefixedJson<PreloadReport>(reqRun.output, 'PRELOAD_REPORT '),
          { kind: 'require', swapped: true, registerActive: true },
          reqRun.output,
        );
        assert.deepEqual(
          parsePrefixedJson<MainReport>(reqRun.output, 'MAIN_REPORT '),
          { tag: 'run-require', swapped: true, registerActive: true, label: 'written-run-require' },
          reqRun.output,
        );

        const impRun = await app.pyric(
          ['run', '--sandbox', hostUrl, '--', 'node', 'main.mjs', 'run-import'],
          {
            env: { CLOUDSDK_CONFIG: emptyGcloud, NODE_OPTIONS: '--import ./pre.mjs' },
            timeoutMs: 30_000,
          },
        );
        assert.equal(impRun.code, 0, impRun.output);
        assert.deepEqual(
          parsePrefixedJson<PreloadReport>(impRun.output, 'PRELOAD_REPORT '),
          { kind: 'import', swapped: true, registerActive: true },
          impRun.output,
        );
        assert.deepEqual(
          parsePrefixedJson<MainReport>(impRun.output, 'MAIN_REPORT '),
          { tag: 'run-import', swapped: true, registerActive: true, label: 'written-run-import' },
          impRun.output,
        );
      } finally {
        await host.stop();
      }
    },
  );
});
