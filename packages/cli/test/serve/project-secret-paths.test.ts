/** Which peers count as loopback, and which project paths the workspace and Vite planes never serve. */
import { describe, expect, it } from 'bun:test';
import { isLoopbackAddress } from '../../src/serve/server.js';
import { isProjectSecretPath, isPyricStateOrEnvPath } from '../../src/serve/project-secret-paths.js';

describe('isLoopbackAddress', () => {
  const loopback = ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1', '::FFFF:127.0.0.9'];
  const remote = ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', 'fe80::1', '0.0.0.0', '128.0.0.1', '', undefined, '127.0.0.1.example'];

  for (const address of loopback) {
    it(`counts ${address} as loopback`, () => expect(isLoopbackAddress(address)).toBe(true));
  }
  for (const address of remote) {
    it(`does not count ${String(address)} as loopback`, () => expect(isLoopbackAddress(address)).toBe(false));
  }
});

describe('isProjectSecretPath', () => {
  const secret = [
    '.pyric',
    '.pyric/state/hosted/state.sqlite',
    'web/.pyric/state/state.json',
    '.PYRIC/state',
    '.pyric./state',
    '.env',
    '.env.local',
    '.envrc',
    'functions/.env.production',
    '.ENV',
    'node_modules',
    'node_modules/pkg/index.js',
    'web/Node_Modules/x.js',
    'a\\.pyric\\state',
  ];
  const plain = ['', '.', 'src/app.tsx', 'firestore.rules', 'environment.ts', 'env/.keep', 'pyric/state', 'my.pyric/x', 'modules/node_modules.md'];

  for (const path of secret) {
    it(`refuses ${path}`, () => expect(isProjectSecretPath(path)).toBe(true));
  }
  for (const path of plain) {
    it(`allows ${JSON.stringify(path)}`, () => expect(isProjectSecretPath(path)).toBe(false));
  }
});

describe('isPyricStateOrEnvPath', () => {
  it('refuses .pyric and .env paths but leaves dependencies to Vite', () => {
    expect(isPyricStateOrEnvPath('.pyric/state/hosted/state.sqlite')).toBe(true);
    expect(isPyricStateOrEnvPath('.env.local')).toBe(true);
    expect(isPyricStateOrEnvPath('.envrc')).toBe(true);
    expect(isPyricStateOrEnvPath('node_modules/.vite/deps/firebase.js')).toBe(false);
    expect(isPyricStateOrEnvPath('src/main.js')).toBe(false);
  });
});
