#!/usr/bin/env bun
/**
 * Ship the repository-owned Playground with the Firebase CLI.
 *
 * The function goes first because Hosting validates its rewrite target
 * while finalizing a release. The direct function endpoint is written
 * into the already-built client before Hosting uploads it; the browser
 * uses that endpoint for streaming and keeps the Hosting rewrite as a
 * same-origin fallback.
 *
 * Authentication belongs to firebase-tools. The CLI can use a Firebase
 * login, Application Default Credentials, or GOOGLE_APPLICATION_CREDENTIALS.
 * DEPLOY_SA_PATH remains a convenience for this repository because the
 * same service-account file is bundled for the inference relay's RTDB
 * token minting.
 */
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDeployPlan,
  functionEndpointUrl,
  PLAYGROUND_PROJECT_ID,
} from './deploy-plan';
import { createFirebaseRunner, FirebaseCommandFailed } from './firebase-runner';

const here = dirname(fileURLToPath(import.meta.url));
const playgroundRoot = resolve(here, '..');
const clientDir = resolve(playgroundRoot, 'dist', 'client');
const functionDir = resolve(playgroundRoot, 'functions', 'inference-api');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function findServiceAccount(): string {
  if (process.env.DEPLOY_SA_PATH) return resolve(process.env.DEPLOY_SA_PATH);

  let dir = playgroundRoot;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'ignored', 'digame-mas-service-account.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return fail(
    'Could not find the digame-mas service account.\n' +
      'Set DEPLOY_SA_PATH or place it at ignored/digame-mas-service-account.json.',
  );
}

function firebaseEnvironment(serviceAccountPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // An explicit DEPLOY_SA_PATH opts the Firebase CLI into that service
  // account. Otherwise leave credential selection entirely to the CLI
  // (firebase login, ADC, or an existing GOOGLE_APPLICATION_CREDENTIALS).
  if (process.env.DEPLOY_SA_PATH && !env.GOOGLE_APPLICATION_CREDENTIALS) {
    env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
  }
  return env;
}

async function main(): Promise<void> {
  if (!existsSync(clientDir)) {
    fail(`No dist/client/ at ${clientDir}. Run "bun run build" first.`);
  }
  if (!existsSync(resolve(functionDir, 'lib', 'index.js'))) {
    fail(`No built function at ${functionDir}/lib/index.js. Run "bun run build" first.`);
  }

  const serviceAccountPath = findServiceAccount();
  copyFileSync(serviceAccountPath, resolve(functionDir, 'sa.json'));

  console.log(`\n  project:  ${PLAYGROUND_PROJECT_ID}`);
  console.log('  bundled service account → functions/inference-api/sa.json');

  const runFirebase = createFirebaseRunner({
    cwd: playgroundRoot,
    environment: firebaseEnvironment(serviceAccountPath),
    spawn(command, options) {
      if (options.stdout === 'pipe') {
        const child = Bun.spawn([...command], { ...options, stdout: 'pipe' });
        return { exited: child.exited, stdout: child.stdout };
      }
      const child = Bun.spawn([...command], { ...options, stdout: 'inherit' });
      return { exited: child.exited, stdout: null };
    },
  });

  for (const step of createDeployPlan(PLAYGROUND_PROJECT_ID)) {
    const metadata = await runFirebase(step);
    if (step.kind === 'deploy') continue;
    const endpoint = functionEndpointUrl(metadata);
    writeFileSync(
      resolve(clientDir, 'inference-endpoint.json'),
      `${JSON.stringify({ url: endpoint })}\n`,
    );
    console.log(`  inference endpoint → ${endpoint}`);
  }

  console.log(`\n  ✓ live at: https://${PLAYGROUND_PROJECT_ID}.web.app\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof FirebaseCommandFailed) process.exit(error.exitCode);
    fail(error instanceof Error ? error.message : String(error));
  }
}
