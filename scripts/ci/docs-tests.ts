#!/usr/bin/env bun
import { DOCS_CONTENT_READER_TESTS } from './check-set.ts';
import { REPO_ROOT } from '../lib/quarantine/entries.ts';
import { runBunTest, type BunTestRun } from '../lib/quarantine/run-bun-test.ts';

export async function runDocsContentTests(
  runner: (options: BunTestRun) => Promise<number> = runBunTest,
): Promise<number> {
  return runner({
    cwd: REPO_ROOT,
    args: [...DOCS_CONTENT_READER_TESTS],
    suite: 'docs-tests',
  });
}

if (import.meta.main) {
  process.exit(await runDocsContentTests());
}
