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
    '.git',
    '.git/config',
    '.git/hooks/post-checkout',
    '.git/hooks/pre-commit',
    'nested/.git/HEAD',
    '.GIT/config',
    '.git./hooks/post-merge',
    'a\\.git\\hooks\\pre-push',
    '.npmrc',
    'packages/app/.npmrc',
    '.NPMRC',
    '.npmrc.',
    '.npmrc.local',
    '.yarnrc',
    '.yarnrc.yml',
    '.yarnrc.yaml',
    'web/.YARNRC.YML.',
    '.ssh',
    '.ssh/id_rsa',
    '.ssh/config',
    'home/.SSH/authorized_keys',
    '.aws',
    '.aws/credentials',
    '.aws/config',
    '.netrc',
    '.pypirc',
    'application_default_credentials.json',
    'certs/server.pem',
    'certs/SERVER.PEM.',
    'keys/tls.key',
    'keys/TLS.KEY ',
    'certs/bundle.p12',
    'certs/cert.pfx',
    'android/release.keystore',
    'android/upload.jks',
    'ssh/deploy.ppk',
    'keys/id_rsa',
    'keys/id_ed25519',
    'service-account.json',
    'keys/prod-service-account-123.json',
    'keys/prod_service_account.json',
    'keys/demo-firebase-adminsdk-abc12-deadbeef.json',
    'KEYS/MY-SERVICE-ACCOUNT.JSON.',
    'node_modules',
    'node_modules/pkg/index.js',
    'web/Node_Modules/x.js',
    'a\\.pyric\\state',
  ];
  const plain = [
    '',
    '.',
    'src/app.tsx',
    'firestore.rules',
    'environment.ts',
    'env/.keep',
    'pyric/state',
    'my.pyric/x',
    'modules/node_modules.md',
    'src/.environment.js',
    '.envoy.yaml',
    '.gitignore',
    '.gitattributes',
    '.gitkeep',
    'src/git-status.ts',
    'src/keyboard.ts',
    'src/key-format.ts',
    'src/service-account-view.tsx',
    'package.json',
    'firebase.json',
    'yarn.lock',
  ];

  for (const path of secret) {
    it(`refuses ${path}`, () => expect(isProjectSecretPath(path)).toBe(true));
  }
  for (const path of plain) {
    it(`allows ${JSON.stringify(path)}`, () => expect(isProjectSecretPath(path)).toBe(false));
  }
});

describe('isPyricStateOrEnvPath', () => {
  it('refuses secret/control paths but leaves dependencies and ordinary files to Vite', () => {
    expect(isPyricStateOrEnvPath('.pyric/state/hosted/state.sqlite')).toBe(true);
    expect(isPyricStateOrEnvPath('.env.local')).toBe(true);
    expect(isPyricStateOrEnvPath('.envrc')).toBe(true);
    expect(isPyricStateOrEnvPath('.git/config')).toBe(true);
    expect(isPyricStateOrEnvPath('.git/hooks/post-checkout')).toBe(true);
    expect(isPyricStateOrEnvPath('.npmrc')).toBe(true);
    expect(isPyricStateOrEnvPath('.yarnrc.yml')).toBe(true);
    expect(isPyricStateOrEnvPath('.ssh/id_rsa')).toBe(true);
    expect(isPyricStateOrEnvPath('.aws/credentials')).toBe(true);
    expect(isPyricStateOrEnvPath('certs/server.pem')).toBe(true);
    expect(isPyricStateOrEnvPath('certs/private.key')).toBe(true);
    expect(isPyricStateOrEnvPath('keys/prod-service-account.json')).toBe(true);
    expect(isPyricStateOrEnvPath('node_modules/.vite/deps/firebase.js')).toBe(false);
    expect(isPyricStateOrEnvPath('src/main.js')).toBe(false);
    expect(isPyricStateOrEnvPath('src/.environment.js')).toBe(false);
    expect(isPyricStateOrEnvPath('.gitignore')).toBe(false);
  });
});
