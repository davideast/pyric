export const HOSTED_RUNTIME_HUNT_PART_B = /* ts */ `
  async 'sw-hst-8'() {
    const dirA = realpathSync(makeTempDir('sw-hst-8a-'));
    const harnessA = createHarness(dirA, { permissive: true });
    const hostA = await harnessA.start();

    try {
      assert.equal((await hostA.sendOp('presence-1', { method: 'rtdb.onDisconnectSet', path: 'presence/alice', value: 'offline' })).ok, true);
      hostA.runtime.receive({ type: 'worker-client-disconnect', clientSessionId: 'presence-1' });

      assert.equal((await hostA.sendOp('presence-2', { method: 'rtdb.onDisconnectSet', path: 'presence/bob', value: 'interrupted' })).ok, true);
      hostA.runtime.receive({ type: 'worker-client-interrupted', clientSessionId: 'presence-2' });

      assert.equal((await hostA.sendOp('observer', { method: 'rtdb.get', path: 'presence/alice' })).value.value, 'offline');
      assert.equal((await hostA.sendOp('observer', { method: 'rtdb.get', path: 'presence/bob' })).value.value, 'interrupted');

      const reproA = await hostA.runtime.captureRepro(dirA);
      const reportA = await replayRepro(reproA);
      assert.equal(reportA.ok, true, JSON.stringify(reportA));
      assert.deepEqual(reportA.planeDifferences, []);
    } finally {
      await hostA.runtime.close();
    }

    const dirB = realpathSync(makeTempDir('sw-hst-8b-'));
    let serverUrl = 'http://127.0.0.1:0';
    const harnessB = createHarness(
      dirB,
      {
        storageRules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }",
        permissive: true,
      },
      { baseUrl: () => serverUrl },
    );
    const hostB = await harnessB.start();

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', serverUrl);
      const handled = await hostB.runtime.storageHttp(req, res, url);
      if (!handled) res.writeHead(404).end();
    });
    httpServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    serverUrl = \`http://127.0.0.1:\${server.address().port}\`;

    try {
      const begin = await hostB.sendOp('uploader', { method: 'storage.beginUpload', path: 'docs/hello.txt', size: 5 });
      assert.equal(begin.ok, true);
      const { uploadId, uploadUrl } = begin.value;
      const putRes = await fetch(new URL(uploadUrl, serverUrl), {
        method: 'PUT',
        body: new TextEncoder().encode('hello'),
      });
      assert.equal(putRes.status, 200);

      const finish = await hostB.sendOp('uploader', { method: 'storage.finishUpload', uploadId });
      assert.equal(finish.ok, true);

      const reproB = await hostB.runtime.captureRepro(dirB);
      const reportB = await replayRepro(reproB);
      assert.equal(reportB.ok, true, JSON.stringify(reportB));
      assert.equal(reportB.planes.node?.ok, true);
      assert.equal(reportB.planes.worker?.ok, true);
      assert.deepEqual(reportB.planeDifferences, []);
    } finally {
      await hostB.runtime.close();
    }
  },

  async 'sw-hst-9'() {
    const dir = realpathSync(makeTempDir('sw-hst-9-'));
    const customProviderRules = \`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /customOnly/{docId} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.sign_in_provider == 'custom'
        && request.auth.token.role == 'service';
    }
    match /noop/{docId} {
      allow read: if true;
    }
  }
}\`;
    const harness = createHarness(dir, { rules: customProviderRules }, { reproWindow: 4 });
    const { runtime, sendOp } = await harness.start();

    try {
      assert.equal((await sendOp('tab-custom', {
        method: 'auth.adminCreateUser',
        request: { uid: 'carol', email: 'carol@example.com', customClaims: { role: 'service' } },
      })).ok, true);

      const minted = await runtime.runMethod({ instanceId: runtime.instanceId, projectDir: dir, allowProduction: false,
        key: 'auth.createCustomToken', args: { uid: 'carol', developerClaims: { role: 'service' } } }, {});
      assert.equal((await sendOp('tab-custom', {
        method: 'auth.signInWithCustomToken',
        customToken: (minted.data as { token: string }).token,
      })).ok, true);

      for (let i = 0; i < 6; i++) {
        await sendOp('tab-custom', { method: 'getDoc', path: 'noop/doc' });
      }

      assert.equal((await sendOp('tab-custom', {
        method: 'setDoc',
        path: 'customOnly/item1',
        data: { ok: true },
      })).ok, true);

      const repro = await runtime.captureRepro(dir);
      assert.equal(repro.truncated, true);
      assert.equal(repro.base.sessions['tab-custom']?.signInProvider, 'custom');

      const report = await replayRepro(repro);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(report.planes.node?.ok, true);
      assert.equal(report.planes.worker?.ok, true);
      assert.deepEqual(report.planeDifferences, []);
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-10'() {
    const base = makeTempDir('sw-hst-10-');
    const realDir = join(base, 'real-project');
    const linkDir = join(base, 'symlink-project');
    const otherDir = join(base, 'other-project');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    symlinkSync(realDir, linkDir, 'dir');

    const harness = createHarness(linkDir);
    const { runtime } = await harness.start();

    try {
      assert.equal((await runtime.runMethod(
        { instanceId: runtime.instanceId, projectDir: linkDir, key: 'firestore.getDoc', args: { path: 'items/a' }, allowProduction: false },
        {},
      )).ok, true);

      assert.equal((await runtime.runMethod(
        { instanceId: runtime.instanceId, projectDir: realDir, key: 'firestore.getDoc', args: { path: 'items/a' }, allowProduction: false },
        {},
      )).ok, true);

      const viaOther = await runtime.runMethod(
        { instanceId: runtime.instanceId, projectDir: otherDir, key: 'firestore.getDoc', args: { path: 'items/a' }, allowProduction: false },
        {},
      );
      assert.equal(viaOther.ok, false);
      assert.match(viaOther.summary, /belongs to another project/);

      assert.equal((await runtime.captureRepro(linkDir)).schema, 'pyric.repro.v1');
      assert.equal((await runtime.captureRepro(realDir)).schema, 'pyric.repro.v1');
      await assert.rejects(runtime.captureRepro(otherDir), /belongs to another project/);

      assert.equal(mcpProjectError(encodeURIComponent(linkDir), linkDir), null);
      assert.equal(mcpProjectError(encodeURIComponent(linkDir), realDir), null);
      assert.equal(mcpProjectError(encodeURIComponent(realDir), linkDir), null);
      assert.equal(mcpProjectError(encodeURIComponent(otherDir), linkDir), 'The selected sandbox belongs to another project.');
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-11'() {
    const dir = realpathSync(makeTempDir('sw-hst-11-'));
    let activeRuntime = null;
    let serverUrl = '';
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', serverUrl);
      const handled = await activeRuntime.storageHttp(req, res, url);
      if (!handled) res.writeHead(404).end();
    });
    httpServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    serverUrl = \`http://127.0.0.1:\${server.address().port}\`;

    const harness = createHarness(
      dir,
      { appOptions: { projectId: 'digchatapp' } },
      { baseUrl: () => serverUrl },
    );

    const host1 = await harness.start();
    activeRuntime = host1.runtime;
    try {
      const begin = await host1.sendOp('admin-uploader', {
        method: 'storage.beginUpload',
        bucket: 'digchatapp.firebasestorage.app',
        defaultBucket: 'digchatapp.firebasestorage.app',
        path: 'spaces/s1/pixel.bin',
        size: 5,
        downloadTokens: 'tok-persist-1',
        actAs: { mode: 'admin' },
      });
      assert.equal(begin.ok, true);
      const putRes = await fetch(new URL(begin.value.uploadUrl, serverUrl), {
        method: 'PUT',
        body: new TextEncoder().encode('hello'),
      });
      assert.equal(putRes.status, 200);
      const finish = await host1.sendOp('admin-uploader', {
        method: 'storage.finishUpload',
        uploadId: begin.value.uploadId,
        actAs: { mode: 'admin' },
      });
      assert.equal(finish.ok, true);
    } finally {
      await host1.runtime.close();
    }

    const host2 = await harness.start();
    activeRuntime = host2.runtime;
    try {
      const okRes = await fetch(\`\${serverUrl}/__pyric/storage/v0/b/digchatapp.firebasestorage.app/o/spaces%2Fs1%2Fpixel.bin?alt=media&token=tok-persist-1\`);
      assert.equal(okRes.status, 200);
      assert.equal(await okRes.text(), 'hello');

      const badTokenRes = await fetch(\`\${serverUrl}/__pyric/storage/v0/b/digchatapp.firebasestorage.app/o/spaces%2Fs1%2Fpixel.bin?alt=media&token=wrong\`);
      assert.equal(badTokenRes.status, 403);

      const otherBucketRes = await fetch(\`\${serverUrl}/__pyric/storage/v0/b/unrelated-secondary-bucket/o/spaces%2Fs1%2Fpixel.bin?alt=media&token=tok-persist-1\`);
      assert.equal(otherBucketRes.status, 403);
    } finally {
      await host2.runtime.close();
    }
  },
  async 'sw-hst-12'() {
    const dir = realpathSync(makeTempDir('sw-hst-12-'));
    const firestoreRules = (matchPath) => [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match ' + matchPath + ' { allow read, write: if true; }',
      '  }',
      '}',
    ].join('\\n');
    const openOnly = firestoreRules('/open/{id}');
    const storageAllowAll = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /{allPaths=**} { allow read, write: if true; }',
      '  }',
      '}',
    ].join('\\n');
    const unparseable = openOnly.replace('if true;', 'if true');
    const duplicateFirestore = openOnly + '\\n' + openOnly.replace("rules_version = '2';\\n", '');
    const duplicateReason = 'Firestore rules did not compile: Duplicate service name declaration.';

    const harness = createHarness(dir, { rules: openOnly });
    const { runtime, sendOp } = await harness.start();
    let toolSeq = 0;
    async function callTool(name, args) {
      const id = 'tool-' + (++toolSeq);
      runtime.receive({ type: 'tool-call', callerId: 'agent', id, name, args });
      const frame = await harness.waitForFrame((m) => m.type === 'tool-result' && m.id === id);
      assert.equal(frame.ok, true, JSON.stringify(frame));
      return frame.result;
    }
    const activeRules = async () => (await sendOp('tab-1', { method: 'getActiveRules', service: 'firestore' })).value;
    async function expectRulesInForce(openPath, lockedPath) {
      assert.equal((await sendOp('tab-1', { method: 'setDoc', path: openPath, data: { v: 1 } })).ok, true);
      assert.equal((await sendOp('tab-1', { method: 'setDoc', path: lockedPath, data: { v: 1 } })).ok, false);
    }

    try {
      await expectRulesInForce('open/a', 'locked/a');
      const before = await activeRules();
      assert.equal(before.status, 'active');
      assert.equal(before.source, openOnly);

      // Duplicate service declarations are refused with the shared reason.
      const dup = await callTool('firestore_simulator_create', { rules: duplicateFirestore, documents: { 'locked/b': { v: 1 } } });
      assert.equal(dup.ok, false, JSON.stringify(dup));
      assert.equal(dup.summary, duplicateReason);
      assert.equal(dup.data.code, 'RULES_REFUSED');
      assert.deepEqual(await activeRules(), before);
      await expectRulesInForce('open/b', 'locked/c');
      assert.equal((await sendOp('tab-1', { method: 'getDoc', path: 'open/a' })).ok, true);
      const broken = await callTool('firestore_simulator_create', { rules: unparseable });
      assert.equal(broken.ok, false, JSON.stringify(broken));
      assert.match(broken.summary, /^Firestore rules did not parse at line 4, column \\d+: /);
      assert.deepEqual(await activeRules(), before);
      await expectRulesInForce('open/c', 'locked/d');
      const storageLoaded = await callTool('firestore_simulator_create', { rules: storageAllowAll });
      assert.equal(storageLoaded.ok, true, JSON.stringify(storageLoaded));
      assert.equal((await sendOp('tab-1', { method: 'setDoc', path: 'open/denied', data: { v: 1 } })).ok, false);
      const otherOnly = firestoreRules('/other/{id}');
      const loaded = await callTool('firestore_simulator_create', { rules: otherOnly });
      assert.equal(loaded.ok, true, JSON.stringify(loaded));
      const after = await activeRules();
      assert.equal(after.status, 'active');
      assert.equal(after.source, otherOnly);
      await expectRulesInForce('other/a', 'open/d');
      // #1456: sandbox.fork refuses candidateRules production would not load before saving the branch.
      const refusedFork = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'sandbox.fork', args: { branch: 'dup-rules', candidateRules: duplicateFirestore }, projectDir: dir, allowProduction: false },
        {},
      );
      assert.equal(refusedFork.ok, false, JSON.stringify(refusedFork));
      assert.equal(refusedFork.summary.startsWith(duplicateReason), true, JSON.stringify(refusedFork));
      assert.equal(existsSync(join(dir, '.pyric', 'state', 'branches', 'dup-rules')), false);
      assert.deepEqual(await activeRules(), after);
      // Defense in depth (FS2-ENF-3b): promoting a pre-existing stored branch carrying a refused source reports status 'error' and keeps lastKnownGood.
      const forked = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'sandbox.fork', args: { branch: 'dup-rules' }, projectDir: dir, allowProduction: false },
        {},
      );
      assert.equal(forked.ok, true, JSON.stringify(forked));
      const storedRulesPath = join(dir, '.pyric', 'state', 'branches', 'dup-rules', 'state', 'rules.json');
      const storedRules = JSON.parse(readFileSync(storedRulesPath, 'utf8'));
      storedRules.firestore = duplicateFirestore;
      writeFileSync(storedRulesPath, JSON.stringify(storedRules, null, 2));
      const promoted = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'sandbox.promote', args: { branch: 'dup-rules', confirm: true }, projectDir: dir, allowProduction: false },
        {},
      );
      assert.equal(promoted.ok, true, JSON.stringify(promoted));
      const promotedRules = await activeRules();
      assert.equal(promotedRules.status, 'error', JSON.stringify(promotedRules));
      assert.equal(promotedRules.source, duplicateFirestore);
      assert.equal(promotedRules.lastKnownGood, otherOnly);
      assert.deepEqual(promotedRules.messages.map((m) => m.text), [duplicateReason]);
      assert.equal((await sendOp('tab-1', { method: 'setDoc', path: 'other/b', data: { v: 1 } })).ok, false);
    } finally {
      await runtime.close();
    }
  },
};

const target = process.argv[2];
try {
  await scenarios[target]();
} finally {
  await cleanupAll();
}
`;
