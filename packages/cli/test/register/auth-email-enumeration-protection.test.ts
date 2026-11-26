import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryBackend } from 'pyric/sandbox';
import { useTempDirs } from '../use-temp-dirs.js';
import { startInMemoryRemoteHost } from './remote-host-test-support.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerUrl = pathToFileURL(join(cliRoot, 'dist/register/index.js')).href;
const pyricAuthUrl = pathToFileURL(join(repoRoot, 'packages/pyric/dist/auth/index.js')).href;

const makeTempDir = useTempDirs('pyric-reg-auth-eep-');

function runRegisteredNodeScript(
  cwd: string,
  scriptPath: string,
  envOverrides: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn('node', ['--import', registerUrl, scriptPath], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ...envOverrides,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectChild);
    child.on('close', (status) => {
      resolveChild({ status, stdout, stderr });
    });
  });
}

describe('@pyric/cli/register Auth emailEnumerationProtection parity (#1689)', () => {
  it('enforces default-on and protection-off Auth codes across registered Node local and remote host planes', async () => {
    const projectDir = makeTempDir();
    const backend = createMemoryBackend();
    const scriptPath = join(projectDir, 'check-eep.mjs');

    writeFileSync(
      scriptPath,
      `import assert from 'node:assert/strict';
import { initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAuth,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { sandbox as authSandbox } from ${JSON.stringify(pyricAuthUrl)};

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err && typeof err.code === 'string' ? err.code : 'unknown';
  }
}

const app = initializeApp({ projectId: 'demo-reg-remote', apiKey: 'fake-key' });
const auth = getAuth(app);

await createUserWithEmailAndPassword(auth, 'node-user@example.com', 'correct-pw-123');
await signOut(auth);

assert.equal(await codeOf(signInWithEmailAndPassword(auth, 'missing@example.com', 'correct-pw-123')), 'auth/invalid-credential');
assert.equal(await codeOf(signInWithEmailAndPassword(auth, 'node-user@example.com', 'wrong-pw-999')), 'auth/invalid-credential');
assert.equal(await codeOf(sendPasswordResetEmail(auth, 'missing@example.com')), null);

authSandbox.setEmailEnumerationProtection(auth, false);
await new Promise((r) => setTimeout(r, 30));

assert.equal(await codeOf(signInWithEmailAndPassword(auth, 'missing@example.com', 'correct-pw-123')), 'auth/user-not-found');
assert.equal(await codeOf(signInWithEmailAndPassword(auth, 'node-user@example.com', 'wrong-pw-999')), 'auth/wrong-password');
assert.equal(await codeOf(signInWithCredential(auth, EmailAuthProvider.credential('missing@example.com', 'correct-pw-123'))), 'auth/user-not-found');
assert.equal(await codeOf(signInWithCredential(auth, EmailAuthProvider.credential('node-user@example.com', 'wrong-pw-999'))), 'auth/wrong-password');
assert.equal(await codeOf(sendPasswordResetEmail(auth, 'missing@example.com')), 'auth/user-not-found');

const signedIn = await signInWithEmailAndPassword(auth, 'node-user@example.com', 'correct-pw-123');
assert.equal(
  await codeOf(reauthenticateWithCredential(signedIn.user, EmailAuthProvider.credential('node-user@example.com', 'wrong-pw-999'))),
  'auth/wrong-password',
);

console.log('EEP_REGISTER_OK');
process.exit(0);
`,
    );

    const localRes = await runRegisteredNodeScript(projectDir, scriptPath, {
      PYRIC_SANDBOX: 'local',
    });
    if (localRes.status !== 0) {
      throw new Error(`local register script failed (${localRes.status}): ${localRes.stderr}\n${localRes.stdout}`);
    }
    expect(localRes.stdout).toContain('EEP_REGISTER_OK');

    const host = await startInMemoryRemoteHost({
      projectKey: projectDir,
      backend,
      writePointerInDir: projectDir,
    });
    try {
      const remoteRes = await runRegisteredNodeScript(projectDir, scriptPath, {
        PYRIC_SANDBOX: `remote:${host.origin}`,
        PYRIC_SANDBOX_INSTANCE: host.instanceId,
      });
      if (remoteRes.status !== 0) {
        throw new Error(`remote register script failed (${remoteRes.status}): ${remoteRes.stderr}\n${remoteRes.stdout}`);
      }
      expect(remoteRes.stdout).toContain('EEP_REGISTER_OK');
    } finally {
      await host.stop();
    }
  }, 25_000);
});
