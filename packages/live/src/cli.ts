#!/usr/bin/env node
/**
 * `pyric-live`: starts the Node host in live mode, in the Firebase project
 * root: the nearest folder from the working directory up that holds
 * `.firebaserc` or `firebase.json`, as the Vite plugin and the register find it.
 *
 *   npx pyric-live [--port 3473] [--host localhost] [--no-open] [--project <id>] [--pass-through <specifier>]
 *
 * The host is the one `pyric sandbox --hosted` runs, reached through
 * `@pyric/cli`'s internal seam (`@pyric/cli/serve/internal/live-host`), with
 * its project reported as live: the chip and Studio show its project name,
 * and every row is production's. A Node process under
 * `@pyric/live/register` reports its calls to it. The pages it serves from
 * Hosting get no Firebase SDK: a page gets the installed SDK through Vite
 * and `@pyric/live/vite`, whose dev server is the host itself.
 *
 * Before the host starts, the start checks run (`start-checks.ts`), and the
 * start line names the project, from the app's own Firebase config.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_HOST_ENTRY, parseLiveHostArgs } from './host-args.js';
import { liveStartLine, passThroughLines } from './start-line.js';
import { liveStartRefusal } from './start-checks.js';

const ENTRY = LIVE_HOST_ENTRY;

/** This package's folder, so a command installed beside the app opens with its own package. */
const LIVE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const USAGE = `Usage: pyric-live [options]
       pyric-live run [--host <url>] [--wait[=<seconds>]] -- <command> [args...]

Starts the pyric Node host in live mode for the Firebase project in this
folder, or in the nearest folder above it with .firebaserc or firebase.json.
Your app talks to its real Firebase project, and the chip and Studio show each
call with production's answer.

Subcommands:
  run               Run a Node command under @pyric/live/register against a
                    running live host (see \`pyric-live run --help\`).

Options:
  --port <port>              Port to serve on. Default 3473.
  --host <host>              Host to bind. Default localhost.
  --project <id>             Firebase project. Default: the one .firebaserc or firebase use names.
  --pass-through <specifier> Firebase import to pass through unwrapped and unobserved
                             (repeatable or comma-separated, e.g. firebase/functions).
  --deployed-rules           Opt in to read-only inspection of deployed Security Rules via
                             your local Firebase CLI or ADC login (off by default; zero stored
                             credentials).
  --allow-remote-live        Second explicit gate to allow non-loopback peers in live mode.
  --no-open                  Do not open a browser.
  --help                     Show this help.
`;

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'run') {
    const { runLiveRun } = await import('./run.js');
    return runLiveRun(argv.slice(1));
  }
  const parsed = parseLiveHostArgs(argv);
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n`);
    return 1;
  }
  const {
    liveHostProject,
    liveHostProjectRoot,
    livePassThroughLine,
    runLiveHost,
  } = await import('@pyric/cli/serve/internal/live-host');
  const projectRoot = liveHostProjectRoot(process.cwd());
  const refusal = liveStartRefusal(projectRoot, process.cwd());
  if (refusal !== null) {
    process.stderr.write(`${ENTRY}: ${refusal}\n`);
    return 1;
  }
  const projectId = liveHostProject(parsed.hostArgv, projectRoot);
  const startLines = [
    liveStartLine(ENTRY, projectId),
    ...passThroughLines(ENTRY, parsed.passThrough, livePassThroughLine),
  ];
  if (parsed.deployedRules) {
    startLines.push(
      `${ENTRY}: deployed Security Rules inspection enabled (read-only via local CLI/ADC login; no credentials stored).`,
    );
  }
  process.stdout.write(`${startLines.join('\n')}\n`);
  return runLiveHost(parsed.hostArgv, {
    liveRoot: LIVE_ROOT,
    allowRemotePeers: parsed.allowRemotePeers,
    deployedRules: parsed.deployedRules,
    passThrough: parsed.passThrough,
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const prefixed = message.startsWith(`${ENTRY}: `) ? message : `${ENTRY}: ${message}`;
    process.stderr.write(`${prefixed}\n`);
    process.exit(1);
  },
);
