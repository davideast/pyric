import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getAdminFirestore, getFirestore, setDoc } from 'pyric/firestore';
import { setRules as setFirestoreRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { captureCheckpoint } from 'pyric/sandbox/checkpoints';
import { buildVerifyFixture, parseVerifyFixture } from '../../src/verify/index.js';
import { parseRepro, REPRO_SCHEMA, type ReproFile } from '../../src/serve/repro/format.js';
import { buildRateCapture, readRateCapture } from '../../src/serve/runtime/rate-capture.js';
import { loadSandboxSeedOption } from '../../src/serve/sandbox-seed-loader.js';
import { applyServeInit } from '../../src/serve/worker/serve-init.js';
import type { HostCtx } from '../../src/serve/worker/host-context.js';
import { buildFixture, readFixtureFile, writeFixtureFile } from '../../src/bridge/surface/fixture.js';
import { createSurfaceContext } from '../../src/bridge/surface/context.js';
import { createCaptureTools } from '../../src/bridge/server/capture-tools.js';
import replaySessionMethod from '../../src/bridge/surface/methods/assurance/replaySession.js';
import applyMethod from '../../src/bridge/surface/methods/sandbox/apply.js';
import exportFixtureMethod from '../../src/bridge/surface/methods/sandbox/exportFixture.js';
import forkMethod from '../../src/bridge/surface/methods/sandbox/fork.js';
import seedFromFixtureMethod from '../../src/bridge/surface/methods/sandbox/seedFromFixture.js';
import saveCaptureMethod from '../../src/bridge/surface/methods/sandbox/saveCapture.js';
import openCaptureMethod from '../../src/bridge/surface/methods/sandbox/openCapture.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerify } from '../../src/cli/verify.js';

type FormatKey =
  | 'verify-session'
  | 'repro'
  | 'rate-capture'
  | 'state-fixture'
  | 'state-fixture-legacy';

interface ProducedSample {
  key: FormatKey;
  family: 'verify-session' | 'repro' | 'rate-capture' | 'state-fixture';
  filename: string;
  payload: unknown;
  /** Consumer command the error must name when this sample is passed to another loader. */
  acceptedByPattern: RegExp;
}

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read, write: if true;
    }
  }
}`;

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-format-matrix-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' } }));
  writeFileSync(join(dir, 'firestore.rules'), FIRESTORE_RULES);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function buildAllSamples(): Promise<ProducedSample[]> {
  const sandbox = initializeSandbox();
  try {
    setFirestoreRules(sandbox, FIRESTORE_RULES);
    await setDoc(doc(getAdminFirestore(sandbox), 'items/seed-1'), { title: 'seeded' });
    await setDoc(doc(getFirestore(sandbox.withAuth({ uid: 'u1' })), 'items/live-1'), { title: 'live' });

    const verifyFixture = buildVerifyFixture({
      sandbox,
      firestoreRules: FIRESTORE_RULES,
    });

    const checkpoint = await captureCheckpoint(sandbox);
    const reproFile: ReproFile = {
      schema: REPRO_SCHEMA,
      createdAt: '2026-11-15T00:00:00.000Z',
      recordedBy: '0.1.0-test',
      truncated: false,
      base: {
        at: 1_700_000_000_000,
        checkpoint,
        databaseInstances: {},
        rules: { firestore: FIRESTORE_RULES, database: {}, storage: null },
        defaultInstance: 'demo-default-rtdb',
        permissive: false,
        appOptions: null,
        sessions: {},
        subscriptions: {},
      },
      entries: [],
    };

    const counts = { reads: 1, writes: 2, deletes: 0, deliveries: 0 };
    const rateCapture = buildRateCapture(
      {
        service: {
          service: 'firestore',
          coverage: 'partial',
          observed: true,
          untrackedMethods: [],
          methods: [],
        },
        points: [{ second: 1, ...counts }],
        from: 1,
        to: 1,
        duration: 1,
        clockOffset: 1000,
        paused: true,
        totals: counts,
        peaks: counts,
      },
      {},
      [],
      null,
    );

    const stateFixture = await buildFixture(sandbox);
    const legacyStateFixture = { ...stateFixture } as Record<string, unknown>;
    delete legacyStateFixture.schema;

    return [
      {
        key: 'verify-session',
        family: 'verify-session',
        filename: 'verify-session.json',
        payload: verifyFixture,
        acceptedByPattern: /pyric verify/i,
      },
      {
        key: 'repro',
        family: 'repro',
        filename: 'repro.json',
        payload: reproFile,
        acceptedByPattern: /repro replay/i,
      },
      {
        key: 'rate-capture',
        family: 'rate-capture',
        filename: 'rate-capture.json',
        payload: rateCapture,
        acceptedByPattern: /openCapture/i,
      },
      {
        key: 'state-fixture',
        family: 'state-fixture',
        filename: 'state-fixture.json',
        payload: stateFixture,
        acceptedByPattern: /seedFromFixture/i,
      },
      {
        key: 'state-fixture-legacy',
        family: 'state-fixture',
        filename: 'state-fixture-legacy.json',
        payload: legacyStateFixture,
        acceptedByPattern: /seedFromFixture/i,
      },
    ];
  } finally {
    sandbox.dispose();
  }
}

function decodeChunk(chunk: string | Uint8Array): string {
  if (typeof chunk === 'string') return chunk;
  return Buffer.from(chunk).toString('utf8');
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runVerifyCaptured(dir: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const prevCwd = process.cwd();
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += decodeChunk(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err += decodeChunk(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.chdir(dir);
  try {
    const code = await runVerify(parseArgs(['verify', ...argv]));
    return { code, out, err };
  } finally {
    process.chdir(prevCwd);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('Pyric file-format matrix: every producer against every consumer loader', () => {
  it('stamps a versioned schema on buildFixture and documents .pyric/last-session.json in exportFixture description', async () => {
    const sandbox = initializeSandbox();
    try {
      const exported = (await buildFixture(sandbox)) as Record<string, unknown>;
      expect(exported.schema).toBe('pyric.state-fixture.v1');
      expect(exportFixtureMethod.description).toContain('.pyric/last-session.json');
      expect(exportFixtureMethod.description).toContain('pyric verify');
    } finally {
      sandbox.dispose();
    }
  });

  it('accepts matching formats and gives actionable wrong-format guidance for every mismatch', async () => {
    const dir = makeTempProject();
    const samples = await buildAllSamples();

    for (const sample of samples) {
      writeFileSync(join(dir, sample.filename), JSON.stringify(sample.payload, null, 2));
    }

    // 1. Consumer: pyric verify (parseVerifyFixture + CLI)
    const verifySourcePattern = /\.pyric\/last-session\.json/;
    for (const sample of samples) {
      if (sample.family === 'verify-session') {
        expect(parseVerifyFixture(sample.payload).schema).toBe('pyric.verify.fixture.v1');
        const cliRes = await runVerifyCaptured(dir, [sample.filename]);
        expect(cliRes.code).toBe(0);
      } else {
        let parseMessage = '';
        try {
          parseVerifyFixture(sample.payload);
        } catch (error) {
          parseMessage = errorMessageOf(error);
        }
        expect(parseMessage).not.toBe('');
        expect(parseMessage).toMatch(sample.acceptedByPattern);
        expect(parseMessage).toMatch(verifySourcePattern);

        const cliRes = await runVerifyCaptured(dir, [sample.filename]);
        expect(cliRes.code).toBe(2);
        expect(cliRes.err).toMatch(sample.acceptedByPattern);
        expect(cliRes.err).toMatch(verifySourcePattern);
      }
    }

    // 2. Consumer: pyric serve repro replay (parseRepro)
    const reproSourcePattern = /repro capture/i;
    for (const sample of samples) {
      if (sample.family === 'repro') {
        expect(parseRepro(sample.payload).schema).toBe(REPRO_SCHEMA);
      } else {
        let parseMessage = '';
        try {
          parseRepro(sample.payload);
        } catch (error) {
          parseMessage = errorMessageOf(error);
        }
        expect(parseMessage).not.toBe('');
        expect(parseMessage).toContain('Not a pyric.repro.v1 file');
        expect(parseMessage).toMatch(sample.acceptedByPattern);
        expect(parseMessage).toMatch(reproSourcePattern);
      }
    }

    // 3. Consumer: sandbox seedFromFixture (readFixtureFile + method handler)
    const stateSourcePattern = /exportFixture/i;
    const seedSandbox = initializeSandbox();
    try {
      const seedCtx = createSurfaceContext(seedSandbox, dir);
      for (const sample of samples) {
        const filePath = join(dir, sample.filename);
        if (sample.family === 'state-fixture') {
          const read = readFixtureFile(filePath);
          expect(read).not.toBeNull();
          const outcome = await seedFromFixtureMethod.handler({ path: sample.filename }, seedCtx);
          expect(outcome.ok).toBe(true);
        } else {
          let readMessage = '';
          try {
            readFixtureFile(filePath);
          } catch (error) {
            readMessage = errorMessageOf(error);
          }
          expect(readMessage).not.toBe('');
          expect(readMessage).toMatch(sample.acceptedByPattern);
          expect(readMessage).toMatch(stateSourcePattern);

          const outcome = await seedFromFixtureMethod.handler({ path: sample.filename }, seedCtx);
          expect(outcome.ok).toBe(false);
          expect(outcome.summary).toMatch(sample.acceptedByPattern);
          expect(outcome.summary).toMatch(stateSourcePattern);
        }
      }
    } finally {
      seedSandbox.dispose();
    }

    // 4. Consumer: sandbox openCapture (path passed as id and foreign file in .pyric/captures/<uuid>.json)
    const rateSourcePattern = /saveCapture|rate monitor|\.pyric\/captures/i;
    const captureSandbox = initializeSandbox();
    try {
      const captureCtx = createSurfaceContext(captureSandbox, dir);
      const rateSample = samples.find((s) => s.key === 'rate-capture');
      if (rateSample === undefined) throw new Error('missing rate-capture sample');
      const saved = await saveCaptureMethod.handler(
        { capture: JSON.stringify(rateSample.payload) },
        captureCtx,
      );
      expect(saved.ok).toBe(true);
      const savedId = (saved.data as { id: string }).id;
      const opened = await openCaptureMethod.handler({ id: savedId }, captureCtx);
      expect(opened.ok).toBe(true);

      mkdirSync(join(dir, '.pyric', 'captures'), { recursive: true });
      let uuidIndex = 1;
      for (const sample of samples) {
        if (sample.family === 'rate-capture') continue;

        // Passing the wrong-format file path directly as id.
        const byPath = await openCaptureMethod.handler({ id: sample.filename }, captureCtx);
        expect(byPath.ok).toBe(false);
        expect(byPath.summary).toMatch(sample.acceptedByPattern);
        expect(byPath.summary).toMatch(rateSourcePattern);

        // Placing the wrong-format file under .pyric/captures/<uuid>.json and opening by id.
        const fakeId = `00000000-0000-4000-8000-00000000000${uuidIndex++}`;
        writeFileSync(
          join(dir, '.pyric', 'captures', `${fakeId}.json`),
          JSON.stringify(sample.payload, null, 2),
        );
        const byId = await openCaptureMethod.handler({ id: fakeId }, captureCtx);
        expect(byId.ok).toBe(false);
        expect(byId.summary).toMatch(sample.acceptedByPattern);
        expect(byId.summary).toMatch(rateSourcePattern);
      }

      // Verify round-trip writeFixtureFile -> readFixtureFile keeps schema intact.
      const stateSample = samples.find((s) => s.key === 'state-fixture');
      if (stateSample === undefined) throw new Error('missing state-fixture sample');
      const roundTripPath = join(dir, 'fixtures', 'roundtrip.json');
      writeFixtureFile(roundTripPath, stateSample.payload as Parameters<typeof writeFixtureFile>[1]);
      const loaded = readFixtureFile(roundTripPath) as Record<string, unknown> | null;
      expect(loaded?.schema).toBe('pyric.state-fixture.v1');

      // Malformed rate-capture opened by valid UUID preserves the corrupt-file error instead of path hint.
      const corruptId = '00000000-0000-4000-8000-0000000000ff';
      writeFileSync(
        join(dir, '.pyric', 'captures', `${corruptId}.json`),
        JSON.stringify({ schema: 'pyric.rate-capture.v1', frame: 'broken' }),
      );
      const corruptOpen = await openCaptureMethod.handler({ id: corruptId }, captureCtx);
      expect(corruptOpen.ok).toBe(false);
      expect(corruptOpen.summary).not.toContain('rather than a file path');
    } finally {
      captureSandbox.dispose();
    }

    // 5. Sibling verify-session consumers: pyric verify cases, assurance.replaySession, sandbox.apply --sessionPath
    const siblingSandbox = initializeSandbox();
    try {
      setFirestoreRules(siblingSandbox, FIRESTORE_RULES);
      const siblingCtx = createSurfaceContext(siblingSandbox, dir);
      const forked = await forkMethod.handler({ branch: 'draft' }, siblingCtx);
      expect(forked.ok).toBe(true);

      // Non-object JSON inputs to parseVerifyFixture still name .pyric/last-session.json.
      for (const nonObject of [[], 'not-an-object']) {
        let nonObjMsg = '';
        try {
          parseVerifyFixture(nonObject);
        } catch (error) {
          nonObjMsg = errorMessageOf(error);
        }
        expect(nonObjMsg).toMatch(/\.pyric\/last-session\.json/);
      }

      for (const sample of samples) {
        if (sample.family === 'verify-session') continue;
        const casesRun = await runVerifyCaptured(dir, ['cases', sample.filename]);
        expect(casesRun.code).toBe(2);
        expect(casesRun.err).toMatch(sample.acceptedByPattern);
        expect(casesRun.err).toMatch(/\.pyric\/last-session\.json/);

        const replayRes = await replaySessionMethod.handler(
          { sessionPath: sample.filename, candidateRules: FIRESTORE_RULES },
          siblingCtx,
        );
        expect(replayRes.ok).toBe(false);
        expect(replayRes.summary).toMatch(sample.acceptedByPattern);
        expect(replayRes.summary).toMatch(/\.pyric\/last-session\.json/);

        const applyRes = await applyMethod.handler(
          { branch: 'draft', sessionPath: sample.filename },
          siblingCtx,
        );
        expect(applyRes.ok).toBe(false);
        expect(applyRes.summary).toMatch(sample.acceptedByPattern);
        expect(applyRes.summary).toMatch(/\.pyric\/last-session\.json/);
      }
    } finally {
      siblingSandbox.dispose();
    }

    // 6. Sibling state-fixture consumer: pyric sandbox --seed (loadSandboxSeedOption + applyServeInit)
    for (const sample of samples) {
      if (sample.family === 'state-fixture') {
        const loadedSeed = await loadSandboxSeedOption({
          projectDir: dir,
          seedFile: sample.filename,
          state: undefined,
          hostedPersistence: undefined,
          hosted: false,
        });
        expect(loadedSeed.seedLabel).toContain('seed envelope');
        expect(loadedSeed.seed).not.toBeNull();

        const initSandbox = initializeSandbox();
        try {
          const hostCtx: HostCtx = {
            sandbox: initSandbox,
            db: getFirestore(initSandbox),
            instanceId: 'seed-init-test',
            subs: new Map(),
          };
          const initResult = applyServeInit(hostCtx, {
            rules: FIRESTORE_RULES,
            rulesHash: null,
            storageRules: null,
            storageRulesHash: null,
            bridgeUrl: null,
            seed: loadedSeed.seed,
            authUsers: loadedSeed.seedUsers ?? undefined,
          });
          expect(initResult.seededDocs).toBe(2);
          const docs = snapshotDocuments(initSandbox);
          expect(docs['items/seed-1']).toBeDefined();
          expect(docs['items/live-1']).toBeDefined();
          expect(docs.schema).toBeUndefined();
        } finally {
          initSandbox.dispose();
        }
      } else {
        let seedErr = '';
        try {
          await loadSandboxSeedOption({
            projectDir: dir,
            seedFile: sample.filename,
            state: undefined,
            hostedPersistence: undefined,
            hosted: false,
          });
        } catch (error) {
          seedErr = errorMessageOf(error);
        }
        expect(seedErr).not.toBe('');
        expect(seedErr).toMatch(sample.acceptedByPattern);
        expect(seedErr).toMatch(/exportFixture/i);
      }
    }

    // 7. Sibling rate-capture consumers: readRateCapture, sandbox.saveCapture, and MCP createCaptureTools
    const captureTools = createCaptureTools(dir);
    const mcpOpenTool = captureTools.find((tool) => tool.name === 'sandbox_open_capture');
    const mcpSaveTool = captureTools.find((tool) => tool.name === 'sandbox_save_capture');
    if (mcpOpenTool === undefined || mcpSaveTool === undefined) {
      throw new Error('missing capture MCP tools');
    }
    const saveSandbox = initializeSandbox();
    const toolCtx = { signal: new AbortController().signal };
    try {
      const saveCtx = createSurfaceContext(saveSandbox, dir);
      for (const sample of samples) {
        if (sample.family === 'rate-capture') continue;
        const serialized = JSON.stringify(sample.payload);

        let readErr = '';
        try {
          readRateCapture(serialized);
        } catch (error) {
          readErr = errorMessageOf(error);
        }
        expect(readErr).toMatch(sample.acceptedByPattern);
        expect(readErr).toMatch(rateSourcePattern);

        let saveErr = '';
        try {
          await saveCaptureMethod.handler({ capture: serialized }, saveCtx);
        } catch (error) {
          saveErr = errorMessageOf(error);
        }
        expect(saveErr).toMatch(sample.acceptedByPattern);
        expect(saveErr).toMatch(rateSourcePattern);

        const mcpOpenRes = (await mcpOpenTool.execute({ id: sample.filename }, toolCtx)) as {
          ok: boolean;
          summary: string;
        };
        expect(mcpOpenRes.ok).toBe(false);
        expect(mcpOpenRes.summary).toMatch(sample.acceptedByPattern);
        expect(mcpOpenRes.summary).toMatch(rateSourcePattern);

        let mcpSaveErr = '';
        try {
          await mcpSaveTool.execute({ capture: serialized }, toolCtx);
        } catch (error) {
          mcpSaveErr = errorMessageOf(error);
        }
        expect(mcpSaveErr).toMatch(sample.acceptedByPattern);
        expect(mcpSaveErr).toMatch(rateSourcePattern);
      }
    } finally {
      saveSandbox.dispose();
    }
  });
});
