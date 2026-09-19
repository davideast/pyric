import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../soak/harness.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /proofs/{document} {
      allow read: if request.auth != null && request.auth.uid == resource.data.ownerId;
    }
  }
}`;

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => {
    const hasError = error !== undefined;
    if (hasError) reject(error);
    else resolve();
  }));
  const hasTcpAddress = address !== null && typeof address !== 'string';
  if (hasTcpAddress) return address.port;
  throw new Error('The emulator test did not receive a TCP port.');
}

/** Real Firebase emulators, with one disposable project and no production services. */
export async function startLiveEmulators() {
  const projectId = `demo-pyric-live-${randomUUID().slice(0, 8)}`;
  const dir = mkdtempSync(join(tmpdir(), 'pyric-live-backend-'));
  const authPort = await unusedPort();
  const firestorePort = await unusedPort();
  const hubPort = await unusedPort();
  const loggingPort = await unusedPort();
  writeFileSync(join(dir, 'firestore.rules'), RULES);
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({
    firestore: { rules: 'firestore.rules' },
    emulators: {
      auth: { host: '127.0.0.1', port: authPort },
      firestore: { host: '127.0.0.1', port: firestorePort },
      hub: { host: '127.0.0.1', port: hubPort },
      logging: { host: '127.0.0.1', port: loggingPort },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  }));
  const child = spawn('firebase', [
    'emulators:start', '--only', 'auth,firestore', '--project', projectId, '--non-interactive',
  ], { cwd: dir, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  const exited = new Promise<void>((resolve) => child.once('close', resolve));

  async function stop(): Promise<void> {
    const isRunning = child.exitCode === null && child.signalCode === null && spawnError === undefined;
    if (isRunning) child.kill('SIGINT');
    const killDeadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(killDeadline);
    rmSync(dir, { recursive: true, force: true });
  }

  try {
    await waitFor('Firebase demo emulators ready', () => {
      const failedToSpawn = spawnError !== undefined;
      if (failedToSpawn) throw spawnError;
      const hasExited = child.exitCode !== null || child.signalCode !== null;
      if (hasExited) throw new Error(`Firebase emulators exited: ${output.slice(-4000)}`);
      return output.includes('All emulators ready');
    }, { timeoutMs: 40_000 });

    const email = 'owner@example.test';
    const password = 'isolated-test-password';
    const authUrl = `http://127.0.0.1:${authPort}`;
    const authResponse = await fetch(`${authUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const authFailed = !authResponse.ok;
    if (authFailed) throw new Error(`Emulator account setup failed: ${await authResponse.text()}`);
    const account: { localId: string } = await authResponse.json();
    const documentUrl = `http://127.0.0.1:${firestorePort}/v1/projects/${projectId}/databases/(default)/documents/proofs/identity`;
    const seedResponse = await fetch(documentUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({ fields: {
        message: { stringValue: 'Read by real Firebase' },
        ownerId: { stringValue: account.localId },
      } }),
    });
    const seedFailed = !seedResponse.ok;
    if (seedFailed) throw new Error(`Emulator document setup failed: ${await seedResponse.text()}`);
    return { projectId, authUrl, authPort, firestorePort, email, password, uid: account.localId, rules: RULES, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
