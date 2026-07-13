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

// Slice 2: the stable nested command generates a local Rules Test API artifact
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

// Slice 3: replay the anonymous write through the local assurance engine. No
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
