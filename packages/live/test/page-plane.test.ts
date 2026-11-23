/**
 * The page plane's parts that run without a browser: the records a page
 * sends to the host, the modules it serves for the live rows, and the
 * refusal of every other served specifier. `test/e2e` drives them in a page.
 */
import { describe, expect, test } from 'bun:test';
import { OBSERVER_MODULE_ID, ROW_MODULE_IDS, SDK_MODULES, type ObservedCall, type ObservedSessionDelta, type ServedFirebaseSpecifier } from '@pyric/cli/vite/internal/supplied-rows';
import { attachSessionData, LIVE_ROWS, replacedExports, type LiveCallRecord } from '../src/index.js';
import { observedCallOf, pageObserver } from '../src/page-observer.js';
import { liveModuleSource, serveHostProject } from '../src/page-modules.js';

const rowId = (specifier: ServedFirebaseSpecifier): string => ROW_MODULE_IDS.get(specifier) ?? `\0pyric-live:${specifier}`;
import { LIVE_REFUSED, liveRefusal } from '../src/refusal.js';

const AT = 1_762_000_000_000;

describe('the records a page sends to the host', () => {
  test("carry production's answer for each Firestore and Auth outcome", () => {
    const record = (outcome: LiveCallRecord['outcome'], code?: string): LiveCallRecord =>
      ({ module: 'firebase/firestore', name: 'getDoc', outcome, ...(code === undefined ? {} : { code }) });
    expect(observedCallOf(record('resolved'), AT)).toEqual({ service: 'firestore', method: 'getDoc', at: AT, outcome: { status: 'ok' } });
    expect(observedCallOf(record('delivered'), AT)?.outcome).toEqual({ status: 'ok' });
    expect(observedCallOf(record('rejected', 'permission-denied'), AT)?.outcome).toEqual({ status: 'error', code: 'permission-denied' });
    expect(observedCallOf(record('listener-error', 'unavailable'), AT)?.outcome).toEqual({ status: 'error', code: 'unavailable' });
    expect(observedCallOf(record('threw', 'invalid-argument'), AT)?.outcome).toEqual({ status: 'error', code: 'invalid-argument' });
    const auth: LiveCallRecord = { module: 'firebase/auth', name: 'signInAnonymously', outcome: 'rejected', code: 'auth/network-request-failed' };
    expect(observedCallOf(auth, AT)).toEqual({
      service: 'auth', method: 'signInAnonymously', at: AT, outcome: { status: 'error', code: 'auth/network-request-failed' },
    });
  });

  test('leave out a synchronous return, and every firebase/app and firebase/app-check record', () => {
    expect(observedCallOf({ module: 'firebase/firestore', name: 'onSnapshot', outcome: 'returned' }, AT)).toBeNull();
    expect(observedCallOf({ module: 'firebase/firestore', name: 'getDoc', outcome: 'resolved', projectId: 'prod' }, AT))
      .toEqual({ service: 'firestore', method: 'getDoc', at: AT, outcome: { status: 'ok' }, projectId: 'prod' });
    expect(observedCallOf({ module: 'firebase/app', name: 'initializeApp', outcome: 'returned' }, AT)).toBeNull();
    expect(observedCallOf({ module: 'firebase/app-check', name: 'getToken', outcome: 'resolved' }, AT)).toBeNull();
  });

  test('name the account a call ran as: its uid and claim names, as a copy', () => {
    const claimNames = ['admin', 'sub'];
    const record: LiveCallRecord = { module: 'firebase/firestore', name: 'getDoc', outcome: 'resolved', account: { uid: 'alice', claimNames } };
    const call = observedCallOf(record, AT);
    expect(call).toEqual({ service: 'firestore', method: 'getDoc', at: AT, outcome: { status: 'ok' }, account: { uid: 'alice', claimNames: ['admin', 'sub'] } });
    expect(call?.account?.claimNames).not.toBe(claimNames);
    const uidOnly: LiveCallRecord = { module: 'firebase/auth', name: 'signOut', outcome: 'resolved', account: { uid: 'bob' } };
    expect(observedCallOf(uidOnly, AT)?.account).toEqual({ uid: 'bob' });
  });

  test('are sent once each, with the time they were made, forwarding sessionData for ok client and Admin calls only', async () => {
    const sent: Array<{ call: ObservedCall; sessionData: ObservedSessionDelta | undefined }> = [];
    const observer = pageObserver(async (call, sessionData) => {
      sent.push({ call, sessionData });
    }, () => AT);
    await observer({ module: 'firebase/auth', name: 'signOut', outcome: 'resolved' });
    expect(observer({ module: 'firebase/app', name: 'getApp', outcome: 'returned' })).toBeUndefined();

    const adminOk: LiveCallRecord = {
      module: '@google-cloud/firestore',
      name: 'DocumentReference.set',
      outcome: 'resolved',
      path: 'items/i1',
    };
    const delta: ObservedSessionDelta = { firestore: [{ kind: 'set', path: 'items/i1', data: { ok: true } }] };
    attachSessionData(adminOk, delta);
    await observer(adminOk);

    const adminFailed: LiveCallRecord = {
      module: '@google-cloud/firestore',
      name: 'DocumentReference.set',
      outcome: 'rejected',
      code: 'unavailable',
      path: 'items/i2',
    };
    attachSessionData(adminFailed, delta);
    await observer(adminFailed);

    expect(sent).toEqual([
      { call: { service: 'auth', method: 'signOut', at: AT, outcome: { status: 'ok' } }, sessionData: undefined },
      {
        call: {
          service: 'firestore',
          sdk: 'admin',
          method: 'DocumentReference.set',
          at: AT,
          outcome: { status: 'ok' },
          path: 'items/i1',
        },
        sessionData: delta,
      },
      {
        call: {
          service: 'firestore',
          sdk: 'admin',
          method: 'DocumentReference.set',
          at: AT,
          outcome: { status: 'error', code: 'unavailable' },
          path: 'items/i2',
        },
        sessionData: undefined,
      },
    ]);
  });

  test('carry the documents a listener delivery was billed for, zero for a metadata-only one, and forward listenerId', () => {
    const delivery = (billedDocuments: number, listenerId?: string): LiveCallRecord => ({
      module: 'firebase/firestore',
      name: 'onSnapshot',
      outcome: 'delivered',
      billedDocuments,
      ...(listenerId === undefined ? {} : { listenerId }),
    });
    expect(observedCallOf(delivery(2, 'l-1234abcd-1'), AT)).toEqual({
      service: 'firestore',
      method: 'onSnapshot',
      at: AT,
      outcome: { status: 'ok' },
      billedDocuments: 2,
      listenerId: 'l-1234abcd-1',
    });
    expect(observedCallOf(delivery(0), AT)?.billedDocuments).toBe(0);
    expect(
      observedCallOf(
        {
          module: 'firebase/database',
          name: 'onValue',
          outcome: 'delivered',
          instance: 'demo-default-rtdb',
          path: '/rooms/r1',
          listenerId: 'l-1234abcd-2',
        },
        AT,
      ),
    ).toEqual({
      service: 'rtdb',
      method: 'onValue',
      at: AT,
      outcome: { status: 'ok' },
      instance: 'demo-default-rtdb',
      path: '/rooms/r1',
      listenerId: 'l-1234abcd-2',
    });
  });
});

describe('the modules a page gets for the live rows', () => {
  test("import the installed module, re-export all of it, and export each observed name from the row's wrapper", () => {
    for (const [specifier, key] of LIVE_ROWS) {
      const source = liveModuleSource(rowId(specifier), '/cli/observed-call-sender.js') as string;
      const quoted = JSON.stringify(specifier);
      expect(source).toContain(`import * as __pyricReal from ${quoted};`);
      expect(source).toContain(`export * from ${quoted};`);
      expect(source).toContain(`liveModuleFor(${quoted}, __pyricReal, { observer, sdkVersion: SDK_VERSION, client: "page", apps: __pyricGetApps })`);
      for (const name of replacedExports(key)) {
        expect(source).toContain(`export const ${name} = __pyricLive.${name};`);
      }
    }
  });

  test('share one observer that sends through the sender beside the page runtime', () => {
    const source = liveModuleSource(OBSERVER_MODULE_ID, '/cli/dist/serve/entries/observed-call-sender.js') as string;
    expect(source).toContain('import { sendObservedCall } from "/@fs/cli/dist/serve/entries/observed-call-sender.js";');
    expect(source).toContain('pageObserver(sendObservedCall)');
  });

  test("hand every row the project the plugin resolved and the page client, on the one observer", () => {
    serveHostProject('live-a');
    const source = liveModuleSource(OBSERVER_MODULE_ID, '/cli/observed-call-sender.js') as string;
    expect(source).toContain('{ journal: journalLiveListener, hostProjectId: "live-a", client: "page" }');
  });

  test('isolates hostProjectId per pyricLive plugin instance and never injects sandboxStorageFetch into service workers', async () => {
    const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { tmpdir } = await import('node:os');
    const { dirname, join, resolve } = await import('node:path');
    const { pyricLive } = await import('../src/vite.js');
    const repoRoot = resolve(import.meta.dir, '../../..');
    const realFirebaseDir = dirname(createRequire(join(repoRoot, 'package.json')).resolve('firebase/package.json'));
    const dirA = mkdtempSync(join(tmpdir(), 'pyric-live-iso-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'pyric-live-iso-b-'));
    try {
      for (const dir of [dirA, dirB]) {
        mkdirSync(join(dir, 'node_modules'), { recursive: true });
        symlinkSync(realFirebaseDir, join(dir, 'node_modules', 'firebase'), 'dir');
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
        writeFileSync(join(dir, 'sw.js'), "self.addEventListener('install', () => {});\n");
      }
      const logger = { info: () => {}, warn: () => {}, error: () => {} };
      const pluginA = pyricLive({ project: 'org-alpha', ...({ serviceWorker: './sw.js' } as Record<string, unknown>) });
      const pluginB = pyricLive({ project: 'org-beta' });
      (pluginA.config as ((...args: unknown[]) => unknown) | undefined)?.(
        { root: dirA },
        { command: 'serve', mode: 'development' },
      );
      (pluginB.config as ((...args: unknown[]) => unknown) | undefined)?.(
        { root: dirB },
        { command: 'serve', mode: 'development' },
      );
      await (pluginA.configResolved as (cfg: unknown) => Promise<void>)({ root: dirA, command: 'serve', logger, server: { fs: { allow: [] } } });
      await (pluginB.configResolved as (cfg: unknown) => Promise<void>)({ root: dirB, command: 'serve', logger, server: { fs: { allow: [] } } });

      const obsA = await (pluginA.load as (id: string) => Promise<string | null>)(OBSERVER_MODULE_ID);
      const obsB = await (pluginB.load as (id: string) => Promise<string | null>)(OBSERVER_MODULE_ID);
      expect(obsA).toContain('hostProjectId: "org-alpha"');
      expect(obsA).not.toContain('hostProjectId: "org-beta"');
      expect(obsB).toContain('hostProjectId: "org-beta"');

      const swTransformed = await (pluginA.transform as (code: string, id: string) => unknown)?.(
        "self.addEventListener('install', () => {});\n",
        join(dirA, 'sw.js'),
      );
      expect(String(swTransformed ?? '')).not.toContain('sandboxStorageFetch');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('exist only for the live rows', () => {
    expect(liveModuleSource(rowId('firebase/functions'), '/sender.js')).toBeNull();
    expect(liveModuleSource('/src/main.ts', '/sender.js')).toBeNull();
  });
});

describe('the refusal of a served specifier with no live row', () => {
  test('names live mode and the service, for every such specifier', () => {
    const refused = SDK_MODULES.filter((specifier) => !LIVE_ROWS.has(specifier));
    for (const specifier of refused) {
      const error = liveRefusal(specifier, 'page') as Error & { code?: string };
      expect(error.code).toBe(LIVE_REFUSED);
      expect(error.message).toContain(`${specifier} (`);
      expect(error.message).toContain('refused in live mode');
      expect(error.message).toContain('not served from the Pyric sandbox');
    }
    expect(liveRefusal('firebase/functions', 'page').message).toContain('(Cloud Functions)');
    expect(liveRefusal('firebase-admin/app', 'server').message).toContain('(the Admin SDK)');
    expect(liveRefusal('firebase-admin/app', 'server').message).toContain('server code the dev server runs');
  });

  test('refuses non-canonical /@fs/ and WHATWG fetch(//@fs...) requests for installed Firebase SDK files in pyricLive()', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { tmpdir } = await import('node:os');
    const { dirname, join, resolve } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    const repoRoot = resolve(import.meta.dir, '../../..');
    const liveRequire = createRequire(join(repoRoot, 'packages/live/package.json'));
    const cliRequire = createRequire(join(repoRoot, 'packages/cli/package.json'));
    const viteDir = dirname(liveRequire.resolve('vite/package.json'));
    const viteEntryUrl = pathToFileURL(join(viteDir, 'dist/node/index.js')).href;
    const liveViteUrl = pathToFileURL(join(repoRoot, 'packages/live/dist/vite.js')).href;
    const installedPkg = cliRequire.resolve('firebase/package.json');
    const installedDir = dirname(installedPkg);
    const fbRequire = createRequire(installedPkg);
    const atFirebaseDir = dirname(dirname(fbRequire.resolve('@firebase/app/package.json')));
    const firebaseAppEsm = realpathSync(join(installedDir, 'app/dist/esm/index.esm.js'));

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-rawfs-')));
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      symlinkSync(installedDir, join(root, 'node_modules', 'firebase'));
      symlinkSync(atFirebaseDir, join(root, 'node_modules', '@firebase'));
      const targetFile = realpathSync(join(installedDir, 'firebase-app.js'));
      const publicDir = join(root, 'public');
      mkdirSync(publicDir, { recursive: true });
      symlinkSync(firebaseAppEsm, join(publicDir, 'sdk-link.js'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'items-app', type: 'module' }));
      writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>');
      writeFileSync(join(root, 'entry.js'), "import { initializeApp } from 'firebase/app';\nexport { initializeApp };\n");
      writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));

      const probePath = join(root, 'probe-live-rawfs.mjs');
      writeFileSync(
        probePath,
        [
          "import { request } from 'node:http';",
          `const { createServer } = await import(${JSON.stringify(viteEntryUrl)});`,
          `const { pyricLive } = await import(${JSON.stringify(liveViteUrl)});`,
          `const root = ${JSON.stringify(root)};`,
          `const targetFile = ${JSON.stringify(targetFile)};`,
          'const rawGet = (port, reqPath) => new Promise((resP, rejP) => {',
          "  const req = request({ hostname: '127.0.0.1', port, path: reqPath, headers: { accept: 'text/javascript', connection: 'close' } }, (res) => {",
          "    let body = '';",
          "    res.setEncoding('utf8');",
          "    res.on('data', (chunk) => { body += chunk; });",
          "    res.on('end', () => resP({ status: res.statusCode ?? 0, body }));",
          '  });',
          "  req.on('error', rejP);",
          '  req.end();',
          '});',
          "const { createServer: createNetServer } = await import('node:net');",
          "const freePort = await new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });",
          'const server = await createServer({',
          '  root, configFile: false, logLevel: "silent",',
          "  server: { host: '127.0.0.1', port: freePort, strictPort: false, ws: false },",
          '  optimizeDeps: { noDiscovery: true, include: [] },',
          "  plugins: [pyricLive({ project: 'demo-project' })],",
          '});',
          'try {',
          '  await server.listen();',
          '  const address = server.httpServer?.address();',
          "  if (!address || typeof address === 'string') throw new Error('no port');",
          '  const targets = [',
          '    `/@fs${targetFile}`,',
          '    `/./@fs${targetFile}`,',
          '    `//@fs${targetFile}`,',
          '    `/items/../@fs${targetFile}`,',
          '    `/%2e/@fs${targetFile}`,',
          '    `/%40fs${targetFile}`,',
          '  ];',
          '  const answers = [];',
          '  for (const target of targets) {',
          '    const answer = await rawGet(address.port, target);',
          "    answers.push({ target, status: answer.status, refused: answer.body.startsWith('throw Object.assign(new Error(') && answer.body.includes('PYRIC_LIVE_REFUSED'), leaked: answer.body.includes('FirebaseAppImpl') });",
          '  }',
          '  const fetched = await fetch(`http://127.0.0.1:${address.port}//@fs${targetFile}`);',
          '  const fetchBody = await fetched.text();',
          "  answers.push({ target: 'fetch://@fs', status: fetched.status, refused: fetchBody.startsWith('throw Object.assign(new Error(') && fetchBody.includes('PYRIC_LIVE_REFUSED'), leaked: fetchBody.includes('FirebaseAppImpl') });",
          "  const entryRes = await rawGet(address.port, '/entry.js');",
          '  const rowMatch = /"(\\/@id\\/[^"]+)"/.exec(entryRes.body);',
          "  if (!rowMatch) throw new Error('missing live row import');",
          '  await rawGet(address.port, rowMatch[1]);',
          '  for (const pubTarget of ["/sdk-link.js", "//sdk-link.js"]) {',
          '    const pubAns = await rawGet(address.port, pubTarget);',
          "    answers.push({ target: pubTarget, status: pubAns.status, refused: pubAns.body.startsWith('throw Object.assign(new Error(') && pubAns.body.includes('PYRIC_LIVE_REFUSED') && pubAns.body.includes('second copy'), leaked: pubAns.body.includes('FirebaseAppImpl') });",
          '  }',
          '  console.log(JSON.stringify(answers));',
          '} finally {',
          '  await server.close();',
          '}',
          'process.exit(0);',
        ].join('\n'),
      );

      const run = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [probePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (run.status !== 0) {
        throw new Error(`live probe failed (${String(run.status)}): ${run.stderr}`);
      }
      const lastLine = run.stdout.trim().split('\n').pop() ?? '[]';
      const answers = JSON.parse(lastLine) as Array<{
        target: string;
        status: number;
        refused: boolean;
        leaked: boolean;
      }>;
      expect(answers.length).toBe(9);
      for (const entry of answers) {
        expect(entry.status).toBe(200);
        expect(entry.refused).toBe(true);
        expect(entry.leaked).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
