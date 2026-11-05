#!/usr/bin/env node
/**
 * `pyric-live`: starts the Node host in live mode, in the working directory.
 *
 *   npx pyric-live [--port 3473] [--host localhost] [--no-open] [--project <id>]
 *
 * The host is the one `pyric sandbox --hosted` runs, reached through
 * `@pyric/cli`'s internal seam (`@pyric/cli/serve/internal/live-host`), with
 * its project reported as live: the chip and Studio show
 * "Live: <project-id>", and every row is production's. A Node process under
 * `@pyric/live/register` reports its calls to it. The pages it serves from
 * Hosting get no Firebase SDK: a page gets the installed SDK through Vite
 * and `@pyric/live/vite`, whose dev server is the host itself.
 *
 * Before the host starts, the start checks run (`start-checks.ts`), and the
 * start line names the project, from the app's own Firebase config.
 */
import { liveHostProject, runLiveHost } from '@pyric/cli/serve/internal/live-host';
import { liveStartLine } from './start-line.js';
import { liveStartRefusal } from './start-checks.js';

const ENTRY = 'pyric-live';

const USAGE = `Usage: pyric-live [options]

Starts the pyric Node host in live mode for the project in this folder. Your
app talks to its real Firebase project, and the chip and Studio show each call
with production's answer.

Options:
  --port <port>     Port to serve on. Default 3473.
  --host <host>     Host to bind. Default localhost.
  --project <id>    Firebase project. Default: the one .firebaserc or firebase use names.
  --no-open         Do not open a browser.
  --help            Show this help.
`;

async function main(argv: readonly string[]): Promise<number> {
  const asksForHelp = argv.includes('--help') || argv.includes('-h');
  if (asksForHelp) {
    process.stdout.write(USAGE);
    return 0;
  }
  const projectRoot = process.cwd();
  const refusal = liveStartRefusal(projectRoot, process.cwd());
  if (refusal !== null) {
    process.stderr.write(`${ENTRY}: ${refusal}\n`);
    return 1;
  }
  const projectId = liveHostProject(argv, projectRoot);
  process.stdout.write(`${liveStartLine(ENTRY, projectId)}\n`);
  return runLiveHost(argv);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${ENTRY}: ${message}\n`);
    process.exit(1);
  },
);
