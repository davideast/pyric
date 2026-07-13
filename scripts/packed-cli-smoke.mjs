#!/usr/bin/env node

/**
 * Exercise the public `pyric` binary after a caller has installed the real
 * @pyric/cli tarball into a clean consumer.
 *
 * This script deliberately does not pack or install anything. The packaging
 * gate and install matrix already own those expensive, package-manager-specific
 * steps; keeping this runner focused lets both gates reuse the same behavioral
 * proof without introducing another publishing path.
 *
 * Usage: node scripts/packed-cli-smoke.mjs <absolute-pyric-bin> <work-dir>
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const [binArg, workArg] = process.argv.slice(2);
if (!binArg || !workArg) {
  process.stderr.write(
    'usage: node scripts/packed-cli-smoke.mjs <absolute-pyric-bin> <work-dir>\n',
  );
  process.exit(2);
}

const bin = isAbsolute(binArg) ? binArg : resolve(binArg);
const workDir = isAbsolute(workArg) ? workArg : resolve(workArg);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const childEnv = { ...process.env, CI: '1', HOME: workDir, USERPROFILE: workDir };
for (const name of [
  'FIREBASE_SA_BASE64',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'PYRIC_REFRESH_TOKEN',
  'PYRIC_SA_PATH',
]) {
  delete childEnv[name];
}

function run(args) {
  const result = spawnSync(bin, args, {
    cwd: workDir,
    encoding: 'utf8',
    env: childEnv,
    shell: process.platform === 'win32',
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`pyric ${args.join(' ')} could not start: ${result.error.message}`);
  }
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function expect(condition, message, result) {
  if (condition) return;
  const detail = result
    ? `\nexit: ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    : '';
  throw new Error(`${message}${detail}`);
}

function parseJson(result, command) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${command} did not print JSON: ${error instanceof Error ? error.message : String(error)}` +
        `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

// Slice 1: the installed bin starts, dispatches a global flag, and reports the
// package identity plus its conformance target.
const version = run(['--version']);
expect(version.code === 0, 'pyric --version must exit 0', version);
expect(version.stderr === '', 'pyric --version must not write stderr', version);
expect(version.stdout.includes('@pyric/cli '), 'pyric --version must name @pyric/cli', version);
expect(version.stdout.includes('Firebase '), 'pyric --version must report its Firebase target', version);
process.stdout.write('  ✓ packed pyric starts and reports its package + Firebase versions\n');

// Slice 1b: the packed artifact must not resurrect the retired production
// deployment surface through generated help or stale dispatch code.
const help = run(['--help']);
expect(help.code === 0, 'pyric --help must exit 0', help);
expect(!help.stdout.includes('pyric deploy'), 'pyric --help must not advertise production deployment', help);
expect(!help.stdout.includes('hosting:channel:deploy'), 'pyric --help must not advertise Hosting deployment', help);
for (const command of [
  'login',
  'logout',
  'whoami',
  'auth:configure-provider',
  'auth:manage-domains',
  'firestore:discover',
]) {
  expect(
    !new RegExp(`^\\s+(?:pyric )?${command}\\b`, 'm').test(help.stdout),
    `pyric --help must not advertise ${command}`,
    help,
  );
  const removed = run([command]);
  expect(removed.code === 1, `pyric ${command} must be rejected`, removed);
  expect(
    removed.stderr.includes(`unknown command '${command}'`),
    `pyric ${command} must fail without a compatibility path`,
    removed,
  );
}
expect(!help.stdout.includes('--mode'), 'pyric bridge help must not advertise backend selection', help);
expect(!help.stdout.includes('PROD-MODE'), 'pyric bridge help must not advertise production policy controls', help);
for (const command of [
  'firestore rules lint',
  'firestore rules validate',
  'firestore rules simulate',
  'firestore rules resolve',
  'firestore indexes generate',
  'storage rules lint',
  'storage rules simulate',
  'database rules lint',
  'database rules validate',
  'database rules simulate',
  'database rules generate',
]) {
  expect(
    help.stdout.includes(`pyric ${command}`),
    `pyric --help must advertise ${command}`,
    help,
  );
}
const removedDeploy = run(['deploy', 'rules']);
expect(removedDeploy.code === 1, 'pyric deploy must be rejected as an unknown command', removedDeploy);
expect(removedDeploy.stderr.includes("unknown command 'deploy'"), 'pyric deploy must fail without a compatibility path', removedDeploy);
const removedHostingDeploy = run(['hosting:channel:deploy']);
expect(removedHostingDeploy.code === 1, 'pyric hosting:channel:deploy must be rejected as an unknown command', removedHostingDeploy);
expect(
  removedHostingDeploy.stderr.includes("unknown command 'hosting:channel:deploy'"),
  'pyric hosting:channel:deploy must fail without a compatibility path',
  removedHostingDeploy,
);
const removedColonCommand = run(['rules:lint']);
expect(
  removedColonCommand.code === 1,
  'pyric rules:lint must be rejected as an unknown command',
  removedColonCommand,
);
expect(
  removedColonCommand.stderr.includes("unknown command 'rules:lint'"),
  'pyric rules:lint must fail without a compatibility alias',
  removedColonCommand,
);
const removedBridgeMode = run(['bridge', '--mode', 'prod']);
expect(
  removedBridgeMode.code === 1,
  'pyric bridge --mode prod must be rejected before a server starts',
  removedBridgeMode,
);
expect(
  removedBridgeMode.stderr.includes("unknown option '--mode' for pyric bridge"),
  'pyric bridge must not retain a backend-selection compatibility path',
  removedBridgeMode,
);
process.stdout.write('  ✓ packed pyric exposes no production or credential-management commands\n');

// The one fixture shared by both retained `verify` commands captures an
// anonymous request and its committed write. Keeping auth null is intentional:
// the packed smoke must never require Firebase, gcloud, or service-account
// credentials.
const allowAnonymous = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow create: if request.auth == null;
    }
  }
}`;
writeFileSync(resolve(workDir, 'firestore.rules'), `${allowAnonymous}\n`);

// Slice 2: service-namespaced local tooling executes from the installed
// artifact. These commands are credential-free by contract.
const firestoreLint = run(['firestore', 'rules', 'lint', 'firestore.rules']);
expect(firestoreLint.code === 0, 'pyric firestore rules lint must exit 0', firestoreLint);
expect(
  Array.isArray(parseJson(firestoreLint, 'pyric firestore rules lint').warnings),
  'pyric firestore rules lint must return warnings JSON',
  firestoreLint,
);

const storageRules = `service firebase.storage {
  match /b/{bucket}/o {
    match /{object=**} { allow read, write: if false; }
  }
}`;
writeFileSync(resolve(workDir, 'storage.rules'), `${storageRules}\n`);
const storageLint = run(['storage', 'rules', 'lint', 'storage.rules']);
expect(storageLint.code === 0, 'pyric storage rules lint must exit 0', storageLint);
expect(
  Array.isArray(parseJson(storageLint, 'pyric storage rules lint').warnings),
  'pyric storage rules lint must return warnings JSON',
  storageLint,
);

writeFileSync(
  resolve(workDir, 'database.rules.json'),
  `${JSON.stringify({ rules: { '.read': true, '.write': false } }, null, 2)}\n`,
);
const databaseLint = run(['database', 'rules', 'lint', 'database.rules.json']);
expect(databaseLint.code === 0, 'pyric database rules lint must exit 0', databaseLint);
expect(
  Array.isArray(parseJson(databaseLint, 'pyric database rules lint').warnings),
  'pyric database rules lint must return warnings JSON',
  databaseLint,
);

const moduleRules = `import { isAuthenticated } from 'auth';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} { allow read: if isAuthenticated(); }
  }
}`;
writeFileSync(resolve(workDir, 'firestore.modules.rules'), `${moduleRules}\n`);
const resolvedRules = run(['firestore', 'rules', 'resolve', 'firestore.modules.rules']);
expect(resolvedRules.code === 0, 'pyric firestore rules resolve must exit 0', resolvedRules);
expect(
  resolvedRules.stdout.includes("rules_version = '2';") &&
    resolvedRules.stdout.includes('function isAuthenticated()'),
  'pyric firestore rules resolve must inline the referenced module',
  resolvedRules,
);

const querySource = `import { collection, orderBy, query, where } from 'firebase/firestore';
export function openOrders(db) {
  const q = query(
    collection(db, 'orders'),
    where('status', '==', 'open'),
    orderBy('createdAt', 'desc'),
  );
  return q;
}`;
writeFileSync(resolve(workDir, 'queries.js'), `${querySource}\n`);
const indexes = run([
  'firestore',
  'indexes',
  'generate',
  'queries.js',
  '--out',
  'firestore.indexes.json',
]);
expect(indexes.code === 0, 'pyric firestore indexes generate must exit 0', indexes);
expect(
  Array.isArray(
    JSON.parse(readFileSync(resolve(workDir, 'firestore.indexes.json'), 'utf8')).indexes,
  ),
  'pyric firestore indexes generate must write an indexes artifact',
  indexes,
);
process.stdout.write('  ✓ packed pyric executes local tooling across all three services\n');

const fixture = {
  schema: 'pyric.verify.fixture.v1',
  description: 'anonymous note creation from a packed CLI smoke',
  events: [
    {
      kind: 'request',
      id: 'request-1',
      at: 1,
      evalMs: 0,
      method: 'create',
      path: 'notes/welcome',
      auth: null,
      result: 'allow',
      reasons: ['Rule #0 (create) → ALLOW'],
      origin: 'user',
      request: { resourceData: { title: 'Welcome' } },
      resourceBefore: { data: null, exists: false },
      resourceAfter: { data: { title: 'Welcome' }, exists: true },
    },
    {
      kind: 'write',
      id: 'write-1',
      at: 1,
      method: 'create',
      path: 'notes/welcome',
      auth: null,
      data: { title: 'Welcome' },
      priorState: null,
      nextState: { title: 'Welcome' },
      requestTime: { seconds: 1, nanoseconds: 0 },
    },
  ],
  services: {
    firestore: {
      rules: { format: 'firestore.rules', source: allowAnonymous },
      state: { documents: { 'notes/welcome': { title: 'Welcome' } } },
    },
  },
};
writeFileSync(resolve(workDir, 'session.json'), `${JSON.stringify(fixture, null, 2)}\n`);

// Slice 3: the stable nested command generates a local Rules Test API artifact
// through the packed binary, proving argument routing and output-file handling.
const cases = run([
  'verify',
  'cases',
  'session.json',
  '--service',
  'firestore',
  '--out',
  'derived-cases.json',
]);
expect(cases.code === 0, 'pyric verify cases must exit 0 for a supported fixture', cases);
expect(cases.stderr === '', 'pyric verify cases must not write stderr on success', cases);
const derivedCases = JSON.parse(readFileSync(resolve(workDir, 'derived-cases.json'), 'utf8'));
expect(derivedCases.ok === true, 'pyric verify cases artifact must report ok: true', cases);
expect(
  derivedCases.testCases?.length === 1 &&
    derivedCases.testCases[0]?.method === 'create' &&
    derivedCases.testCases[0]?.auth === null,
  'pyric verify cases must derive the captured anonymous create',
  cases,
);
process.stdout.write('  ✓ packed pyric verify cases writes the expected local artifact\n');

// Slice 4: replay the anonymous write through the local assurance engine. No
// credential source is available in this process. Re-running against deny-all
// rules proves the command preserves its regression exit code rather than
// merely loading the fixture.

const verifyArgs = [
  'verify',
  'session.json',
  '--engine',
  'sandbox',
  '--rules',
  'firestore=firestore.rules',
  '--json',
];
const verified = run(verifyArgs);
expect(verified.code === 0, 'pyric verify must exit 0 for an unchanged anonymous write', verified);
expect(verified.stderr === '', 'successful pyric verify must not write stderr', verified);
const verifiedResult = parseJson(verified, 'pyric verify');
expect(verifiedResult.ok === true, 'pyric verify JSON must report ok: true', verified);
expect(
  verifiedResult.results?.[0]?.services?.firestore?.checkedEvents === 1,
  'pyric verify must replay the captured anonymous write',
  verified,
);

const denyAll = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;
writeFileSync(resolve(workDir, 'firestore.rules'), `${denyAll}\n`);
const regressed = run(verifyArgs);
expect(regressed.code === 1, 'pyric verify must exit 1 when candidate rules regress', regressed);
const regressedResult = parseJson(regressed, 'regressing pyric verify');
expect(regressedResult.ok === false, 'regressing pyric verify JSON must report ok: false', regressed);
process.stdout.write('  ✓ packed pyric verify replays locally without auth and preserves exit 0/1\n');

process.stdout.write('✓ packed CLI smoke PASS\n');
