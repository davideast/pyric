import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const hostPort = process.argv[2];
const appPort = process.argv[3];
const sandboxPidFile = process.argv[4];
const childPidFile = process.argv[5];

const cliBin = join(process.cwd(), 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');
const child = spawn(
  process.execPath,
  [
    cliBin,
    'sandbox',
    '--hosted',
    '--no-open',
    '--no-ui',
    '--host',
    '127.0.0.1',
    '--port',
    String(hostPort),
    '--',
    process.execPath,
    'server.mjs',
    String(appPort),
    String(childPidFile),
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  },
);

if (typeof sandboxPidFile === 'string' && sandboxPidFile.length > 0 && child.pid !== undefined) {
  writeFileSync(sandboxPidFile, `${child.pid}\n`);
}

// Hold open the pipe read ends until the scenario kills this launcher.
setInterval(() => {}, 1_000);
