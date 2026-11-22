import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';

const CLI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITE_PLUGIN_URL = new URL('../../dist/serve/vite-plugin.js', import.meta.url).href;

const activeTmpDirs: string[] = [];

afterEach(() => {
  while (activeTmpDirs.length > 0) {
    const dir = activeTmpDirs.pop();
    if (dir !== undefined) {
      removePrivateJobTmpDir(dir);
    }
  }
});

interface SsrAppFixture {
  readonly appRoot: string;
  readonly realFirebaseAppFile: string;
  readonly realFirebaseAppCheckFile: string;
}

function createSsrProductionAiFixture(): SsrAppFixture {
  const scratchRoot = createPrivateJobTmpDir('vite-ssr-prod-ai');
  activeTmpDirs.push(scratchRoot);

  const cliPkgJson = path.join(CLI_ROOT, 'package.json');
  const pyricRoot = fileURLToPath(new URL('../../../pyric', import.meta.url));
  const pyricAdminRoot = fileURLToPath(new URL('../../../pyric-admin', import.meta.url));
  const requireFromCli = createRequire(cliPkgJson);
  const realFirebasePkgJson = requireFromCli.resolve('firebase/package.json');
  const realFirebaseRoot = path.dirname(realFirebasePkgJson);
  const requireFromFirebase = createRequire(realFirebasePkgJson);
  const realAtFirebaseAiRoot = path.dirname(
    requireFromFirebase.resolve('@firebase/ai').replace(/\/dist\/.*$/, '/package.json'),
  );
  const realAtFirebaseAppRoot = path.dirname(
    requireFromFirebase.resolve('@firebase/app').replace(/\/dist\/.*$/, '/package.json'),
  );
  const realAtFirebaseAppCheckRoot = path.dirname(
    requireFromFirebase.resolve('@firebase/app-check').replace(/\/dist\/.*$/, '/package.json'),
  );

  const appRoot = path.join(scratchRoot, 'app');
  mkdirSync(path.join(appRoot, 'src'), { recursive: true });
  mkdirSync(path.join(appRoot, 'node_modules', '@pyric'), { recursive: true });
  mkdirSync(path.join(appRoot, 'node_modules', '@firebase'), { recursive: true });

  symlinkSync(CLI_ROOT, path.join(appRoot, 'node_modules', '@pyric', 'cli'));
  symlinkSync(pyricRoot, path.join(appRoot, 'node_modules', 'pyric'));
  symlinkSync(pyricAdminRoot, path.join(appRoot, 'node_modules', 'pyric-admin'));
  symlinkSync(realFirebaseRoot, path.join(appRoot, 'node_modules', 'firebase'));
  symlinkSync(realAtFirebaseAiRoot, path.join(appRoot, 'node_modules', '@firebase', 'ai'));
  symlinkSync(realAtFirebaseAppRoot, path.join(appRoot, 'node_modules', '@firebase', 'app'));
  symlinkSync(realAtFirebaseAppCheckRoot, path.join(appRoot, 'node_modules', '@firebase', 'app-check'));

  const realFirebaseAppFile = realpathSync(requireFromCli.resolve('firebase/app'));
  const realFirebaseAppCheckFile = realpathSync(requireFromCli.resolve('firebase/app-check'));

  writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({ name: 'ssr-prod-ai-app', private: true, type: 'module' }, null, 2),
  );
  writeFileSync(
    path.join(appRoot, '.firebaserc'),
    JSON.stringify({ projects: { default: 'demo-ssr-ai' } }),
  );
  writeFileSync(path.join(appRoot, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');

  writeFileSync(
    path.join(appRoot, 'src', 'ssr-app-check-and-ai.js'),
    [
      "import { deleteApp, initializeApp } from 'firebase/app';",
      "import { CustomProvider, getToken, initializeAppCheck } from 'firebase/app-check';",
      "import { GoogleAIBackend, getAI } from 'firebase/ai';",
      '',
      'export async function runValidProductionAiAndAppCheck() {',
      '  const app = initializeApp(',
      "    { apiKey: 'demo-key', projectId: 'demo-ssr-ai', appId: '1:1:web:1' },",
      "    'ssr-prod-check',",
      '  );',
      '  try {',
      '    const appCheck = initializeAppCheck(app, {',
      '      provider: new CustomProvider({',
      "        getToken: async () => ({ token: 'ssr-minted-token', expireTimeMillis: Date.now() + 60_000 }),",
      '      }),',
      '      isTokenAutoRefreshEnabled: false,',
      '    });',
      '    const tokenResult = await getToken(appCheck);',
      '    const ai = getAI(app, { backend: new GoogleAIBackend() });',
      '    return { token: tokenResult.token, hasAi: Boolean(ai && ai.app) };',
      '  } finally {',
      '    await deleteApp(app);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    path.join(appRoot, 'src', 'ssr-direct-at-firebase-ai.js'),
    "import * as directAi from '@firebase/ai';\nexport const keys = Object.keys(directAi);\n",
  );

  writeFileSync(
    path.join(appRoot, 'src', 'ssr-abs-firebase-app.js'),
    `import * as absApp from ${JSON.stringify(realFirebaseAppFile)};\nexport const keys = Object.keys(absApp);\n`,
  );

  writeFileSync(
    path.join(appRoot, 'src', 'ssr-abs-firebase-app-check.js'),
    `import * as absCheck from ${JSON.stringify(realFirebaseAppCheckFile)};\nexport const keys = Object.keys(absCheck);\n`,
  );

  return { appRoot, realFirebaseAppFile, realFirebaseAppCheckFile };
}

const NODE_SSR_RUNNER = String.raw`
import path from 'node:path';
import { createServer } from 'vite';

const [pluginUrl, appRoot, realFirebaseAppFile, realFirebaseAppCheckFile] = process.argv.slice(1);
const { pyric } = await import(pluginUrl);

async function captureSsrStopCode(server, moduleUrl) {
  try {
    await server.ssrLoadModule(moduleUrl);
    return 'loaded';
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
      return err.code;
    }
    return err instanceof Error ? err.message : String(err);
  }
}

const server = await createServer({
  root: appRoot,
  configFile: false,
  envFile: false,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0, strictPort: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    pyric({
      ui: false,
      hosted: true,
      persist: false,
      functions: false,
      project: 'demo-ssr-ai',
      ai: { mode: 'production' },
    }),
  ],
});

try {
  await new Promise((resolveListen, rejectListen) => {
    server.httpServer.once('error', rejectListen);
    server.httpServer.listen(0, '127.0.0.1', resolveListen);
  });
  const boundPort = server.httpServer.address().port;
  server.resolvedUrls = { local: ['http://127.0.0.1:' + boundPort + '/'], network: [] };
  const directBefore = await captureSsrStopCode(server, '/src/ssr-direct-at-firebase-ai.js');
  const validMod = await server.ssrLoadModule('/src/ssr-app-check-and-ai.js');
  const validResult = await validMod.runValidProductionAiAndAppCheck();
  server.moduleGraph.invalidateAll();
  const directAfter = await captureSsrStopCode(server, '/src/ssr-direct-at-firebase-ai.js');
  const absAppSsr = await captureSsrStopCode(server, '/src/ssr-abs-firebase-app.js');
  const absAppCheckSsr = await captureSsrStopCode(server, '/src/ssr-abs-firebase-app-check.js');

  const clientImporter = path.join(appRoot, 'src', 'ssr-app-check-and-ai.js');
  const clientStops = [];
  for (const absTarget of [
    realFirebaseAppFile,
    realFirebaseAppCheckFile,
    '/@fs' + realFirebaseAppFile,
  ]) {
    const resolvedClient = await server.pluginContainer.resolveId(absTarget, clientImporter);
    const resolvedId = resolvedClient?.id ?? '';
    const loaded = resolvedId ? await server.pluginContainer.load(resolvedId) : null;
    const codeText = typeof loaded === 'string' ? loaded : loaded?.code ?? '';
    clientStops.push({
      isStopId: resolvedId.startsWith('\0pyric-stop:'),
      hasStopCode: codeText.includes('PYRIC_REAL_SDK_STOPPED'),
    });
  }

  process.stdout.write(
    'SSR_REPORT ' +
      JSON.stringify({
        directBefore,
        validResult,
        directAfter,
        absAppSsr,
        absAppCheckSsr,
        clientStops,
      }) +
      '\n',
  );
} finally {
  await server.close();
}
`;

describe('Vite SSR in PYRIC_AI_MODE=production (#1907, #1735, #1630)', () => {
  it('routes firebase/app-check, loads firebase/ai, and stops direct @firebase/ai and absolute firebase/app or firebase/app-check imports through ssrLoadModule', () => {
    const fixture = createSsrProductionAiFixture();
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_OPTIONS: undefined,
      PYRIC_SANDBOX: undefined,
    };
    const child = spawnSync(
      process.env.PYRIC_TEST_NODE ?? 'node',
      [
        '--input-type=module',
        '-e',
        NODE_SSR_RUNNER,
        VITE_PLUGIN_URL,
        fixture.appRoot,
        fixture.realFirebaseAppFile,
        fixture.realFirebaseAppCheckFile,
      ],
      {
        cwd: CLI_ROOT,
        encoding: 'utf8',
        env,
        timeout: 60_000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const reportLine = child.stdout
      .split('\n')
      .find((line) => line.startsWith('SSR_REPORT '));
    expect(reportLine, child.stdout).toBeDefined();
    const report = JSON.parse((reportLine ?? 'SSR_REPORT {}').slice('SSR_REPORT '.length)) as {
      directBefore: string;
      validResult: { token: string; hasAi: boolean };
      directAfter: string;
      absAppSsr: string;
      absAppCheckSsr: string;
      clientStops: Array<{ isStopId: boolean; hasStopCode: boolean }>;
    };

    expect(report).toEqual({
      directBefore: 'PYRIC_REAL_SDK_STOPPED',
      validResult: {
        token: 'ssr-minted-token',
        hasAi: true,
      },
      directAfter: 'PYRIC_REAL_SDK_STOPPED',
      absAppSsr: 'PYRIC_REAL_SDK_STOPPED',
      absAppCheckSsr: 'PYRIC_REAL_SDK_STOPPED',
      clientStops: [
        { isStopId: true, hasStopCode: true },
        { isStopId: true, hasStopCode: true },
        { isStopId: true, hasStopCode: true },
      ],
    });
  }, 60_000);
});
