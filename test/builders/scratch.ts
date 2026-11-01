/**
 * Where a builder run lives, and what every process in it is given. Runs are
 * scratch: `/home/david/pyric-builders/<kind>/<stamp>/` (or under
 * PYRIC_BUILDERS_DIR), never inside the repo, and the harness never removes
 * one. Clearing that directory clears every run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Node layer of the recorder, loaded into every process a run starts. */
export const RECORDER_PRELOAD = fileURLToPath(new URL('./recorder/node-egress.mjs', import.meta.url));

/** The environment variable naming the run's network record. */
export const NETWORK_LOG_ENV = 'PYRIC_BUILDER_NETWORK_LOG';

export function buildersRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PYRIC_BUILDERS_DIR ?? join(homedir(), 'pyric-builders');
}

/** A sortable stamp with no characters a path or a project id would mind. */
export function runStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** The directories and files of one run. */
export interface RunDirs {
  root: string;
  app: string;
  /** The run's HOME: no gh, gcloud, firebase or npm login, and no browser. */
  home: string;
  logs: string;
  /** Every recorder layer writes here: the Node preload, the namespace resolver, and the NetLog once read. */
  networkLog: string;
  /** Chromium's NetLog, read into `networkLog` when the browser stops. */
  netLog: string;
}

/** The paths of the run at `root`, created or not. */
export function runDirsAt(root: string): RunDirs {
  return {
    root,
    app: join(root, 'app'),
    home: join(root, 'home'),
    logs: join(root, 'logs'),
    networkLog: join(root, 'network.jsonl'),
    netLog: join(root, 'chromium-netlog.json'),
  };
}

export function createRunDirs(root: string): RunDirs {
  const dirs = runDirsAt(root);
  for (const dir of [dirs.app, dirs.home, dirs.logs]) mkdirSync(dir, { recursive: true });
  writeFileSync(dirs.networkLog, '');
  return dirs;
}

/** What a run adds to the scrubbed app environment so its processes are recorded. */
export function recorderEnvironment(networkLog: string): Record<string, string> {
  return { NODE_OPTIONS: `--import ${RECORDER_PRELOAD}`, [NETWORK_LOG_ENV]: networkLog };
}

/** A Firebase project id that production rejects: `demo-` and at most 30 characters. */
export function demoProjectId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `demo-${slug}`.slice(0, 30).replace(/-+$/, '');
}

/** A web app config with a fake API key. No field names a real project or credential. */
export function fakeFirebaseConfig(projectId: string): Record<string, string> {
  return {
    apiKey: 'demo-api-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: `${projectId}.appspot.com`,
    databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
    appId: '1:000000000000:web:0000000000000000000000',
  };
}

/** Writes the fake config as `firebase-config.js` and selects the project in `.firebaserc`. */
export function writeFakeFirebaseConfig(appDir: string, projectId: string): void {
  const config = JSON.stringify(fakeFirebaseConfig(projectId), null, 2);
  writeFileSync(join(appDir, 'firebase-config.js'), `// Fake: a demo- project production rejects, and no real key.\nexport default ${config};\n`);
  writeFileSync(join(appDir, '.firebaserc'), `${JSON.stringify({ projects: { default: projectId } }, null, 2)}\n`);
}
