/**
 * Replays committed production Storage rules verb observations (#1884) through
 * both MCP `rules.simulate` (`METHODS_BY_KEY.get('rules.simulate')`) and the
 * CLI `pyric rules simulate --service storage` command runner (`runSurfaceMethod`):
 *
 * 1. `stdlib-realstorage-request-resource-fields.json` (`behavior.overwrite`):
 *    a coarse `write` with payload over an existing stored object binds `create`
 *    (`verb-create` ALLOW, `verb-update` DENY, `create-stored-and-new-size` ALLOW,
 *    `resource-existing` ALLOW).
 * 2. `storage-updatemetadata-request-method.json`:
 *    a granular `update` over a stored object binds `update` (matching live
 *    `updateMetadata`), while a coarse `write` with payload over the same stored
 *    object binds `create` (matching live `uploadBytes`).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, updateMetadata, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import { METHODS_BY_KEY } from '../../../../src/bridge/surface/index.js';
import { STORAGE_RULES } from '../../../../src/bridge/surface/rules-engines/storage.js';
import { parseArgs } from '../../../../src/cli/parse-args.js';
import { runSurfaceMethod } from '../../../../src/cli/surface-method-runner.js';
import { useTempDirs } from '../../../use-temp-dirs.js';
import {
  OBSERVATION_NAME as OVERWRITE_OBSERVATION_NAME,
  PROBE_PAYLOAD,
  PROBE_REPLACEMENT,
  probePath,
  requestResourceRules,
} from '../../../../../conformance/src/storage-request-resource-probes.ts';
import {
  updateMetadataMethodOracleTarget,
  updateMetadataMethodPaths,
} from '../../../../../conformance/probes/storage/storage-updatemetadata-request-method.ts';

const OVERWRITE_OBSERVATION = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'storage-rules',
  `${OVERWRITE_OBSERVATION_NAME}.json`,
);

const UPDATE_METHOD_OBSERVATION = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'storage',
  'storage-updatemetadata-request-method.json',
);

const REPLAY_UIDS = {
  seedUid: 'pyric-seed-client',
  updateMethodUid: 'pyric-update-method-client',
  createMethodUid: 'pyric-create-method-client',
} as const;

type Verdict = 'ALLOW' | 'DENY';

interface UpdateMethodCaptured {
  behavior: {
    deniedControl: {
      createClient: { verdict: Verdict };
      updateClient: { verdict: Verdict };
    };
    sameObjectRequestMethod: {
      whenMethodEqualsCreate: { verdict: Verdict };
      whenMethodEqualsUpdate: { verdict: Verdict };
    };
    sameObjectGranularVerb: {
      allowCreateVerb: { verdict: Verdict };
      allowUpdateVerb: { verdict: Verdict };
    };
  };
}

function readOverwriteObservation(): {
  verdicts: Record<string, Verdict>;
  probeRules: string;
} {
  const raw = JSON.parse(readFileSync(OVERWRITE_OBSERVATION, 'utf8')) as {
    behavior: { overwrite: Record<string, Verdict> };
    probeRules: string;
  };
  return { verdicts: raw.behavior.overwrite, probeRules: raw.probeRules };
}

function readUpdateMethodVerdicts(): UpdateMethodCaptured['behavior'] {
  const raw = JSON.parse(readFileSync(UPDATE_METHOD_OBSERVATION, 'utf8')) as UpdateMethodCaptured;
  return raw.behavior;
}

function toVerdict(allowed: boolean): Verdict {
  if (allowed) return 'ALLOW';
  return 'DENY';
}

async function liveVerdict(op: () => Promise<unknown>): Promise<Verdict> {
  try {
    await op();
    return 'ALLOW';
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code !== 'storage/unauthorized') {
      throw err;
    }
    return 'DENY';
  }
}

const makeTempDir = useTempDirs('pyric-cli-1884-');

async function runCliMethod(cwd: string, key: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runSurfaceMethod(key, parseArgs(argv), {
    cwd,
    stdout: { write: (text) => void (stdout += text) },
    stderr: { write: (text) => void (stderr += text) },
    discover: async () => null,
  });
  return { code, stdout, stderr };
}

describe('Storage rules.simulate against committed overwrite and updateMetadata observations (#1884)', () => {
  const { verdicts: overwriteVerdicts, probeRules: capturedProbeRules } = readOverwriteObservation();
  const updateMethodVerdicts = readUpdateMethodVerdicts();

  it('replays stdlib-realstorage-request-resource-fields overwrite probes through MCP rules.simulate', async () => {
    const simulateRecord = METHODS_BY_KEY.get('rules.simulate');
    if (simulateRecord === undefined) {
      throw new Error('missing rules.simulate method record');
    }

    const prefix = 'replay/request-resource';
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {${requestResourceRules(prefix)}  }
}`;
    const sandbox = initializeSandbox({});
    const ctx = createSurfaceContext(sandbox);
    await STORAGE_RULES.install(ctx, rules);
    const admin = getAdminStorageSandbox(sandbox);

    const probeIds = [
      'verb-create',
      'verb-update',
      'create-stored-and-new-size',
      'resource-existing',
    ] as const;

    for (const id of probeIds) {
      const objectPath = probePath(prefix, 'overwrite', id);
      await uploadBytes(ref(admin, objectPath), PROBE_PAYLOAD, {
        contentType: 'application/octet-stream',
      });
      const simResult = await simulateRecord.handler(
        {
          service: 'storage',
          operation: 'write',
          path: objectPath,
          data: {
            contentType: 'text/plain',
            size: PROBE_REPLACEMENT.byteLength,
          },
        },
        ctx,
      );
      expect(simResult.ok).toBe(true);
      const allowed = (simResult.data as { allowed: boolean }).allowed;
      expect(toVerdict(allowed)).toBe(overwriteVerdicts[id]);
    }
  });

  it('replays storage-updatemetadata-request-method and overwrite create binding across MCP rules.simulate and live SDK', async () => {
    const simulateRecord = METHODS_BY_KEY.get('rules.simulate');
    if (simulateRecord === undefined) {
      throw new Error('missing rules.simulate method record');
    }

    const runId = 'mcp_1884';
    const bucketId = 'demo-pyric.appspot.com';
    const paths = updateMetadataMethodPaths(runId);
    const rules = updateMetadataMethodOracleTarget(bucketId, runId, REPLAY_UIDS).freshRules;

    const sandbox = initializeSandbox({});
    const ctx = createSurfaceContext(sandbox);
    ctx.storageBucketName = () => bucketId;
    await STORAGE_RULES.install(ctx, rules);

    const seedStorage = getStorageSandbox(sandbox.withAuth({ uid: REPLAY_UIDS.seedUid }));
    const updateStorage = getStorageSandbox(sandbox.withAuth({ uid: REPLAY_UIDS.updateMethodUid }));
    const createStorage = getStorageSandbox(sandbox.withAuth({ uid: REPLAY_UIDS.createMethodUid }));

    const seedMeta = { contentType: 'text/plain', customMetadata: { stage: 'seed' } };
    await uploadBytes(ref(seedStorage, paths.deniedControlPath), PROBE_PAYLOAD, seedMeta);
    await uploadBytes(ref(seedStorage, paths.targetPath), PROBE_PAYLOAD, seedMeta);
    await uploadBytes(ref(seedStorage, paths.granularPath), PROBE_PAYLOAD, seedMeta);

    const simulateCase = async (
      operation: 'update' | 'write',
      objectPath: string,
      uid: string,
      data?: Record<string, unknown>,
    ): Promise<Verdict> => {
      const args: Record<string, unknown> = {
        service: 'storage',
        operation,
        path: objectPath,
        uid,
      };
      if (data !== undefined) {
        args.data = data;
      }
      const res = await simulateRecord.handler(args, ctx);
      expect(res.ok).toBe(true);
      return toVerdict((res.data as { allowed: boolean }).allowed);
    };

    expect(await simulateCase('update', paths.deniedControlPath, REPLAY_UIDS.createMethodUid)).toBe(
      updateMethodVerdicts.deniedControl.createClient.verdict,
    );
    expect(await simulateCase('update', paths.deniedControlPath, REPLAY_UIDS.updateMethodUid)).toBe(
      updateMethodVerdicts.deniedControl.updateClient.verdict,
    );

    expect(await simulateCase('update', paths.targetPath, REPLAY_UIDS.createMethodUid)).toBe(
      updateMethodVerdicts.sameObjectRequestMethod.whenMethodEqualsCreate.verdict,
    );
    expect(await simulateCase('update', paths.targetPath, REPLAY_UIDS.updateMethodUid)).toBe(
      updateMethodVerdicts.sameObjectRequestMethod.whenMethodEqualsUpdate.verdict,
    );

    expect(await simulateCase('update', paths.granularPath, REPLAY_UIDS.createMethodUid)).toBe(
      updateMethodVerdicts.sameObjectGranularVerb.allowCreateVerb.verdict,
    );
    expect(await simulateCase('update', paths.granularPath, REPLAY_UIDS.updateMethodUid)).toBe(
      updateMethodVerdicts.sameObjectGranularVerb.allowUpdateVerb.verdict,
    );

    const liveUpdateCreateArm = await liveVerdict(() =>
      updateMetadata(ref(createStorage, paths.targetPath), { customMetadata: { stage: 'c' } }),
    );
    const liveUpdateUpdateArm = await liveVerdict(() =>
      updateMetadata(ref(updateStorage, paths.targetPath), { customMetadata: { stage: 'u' } }),
    );
    expect(liveUpdateCreateArm).toBe(updateMethodVerdicts.sameObjectRequestMethod.whenMethodEqualsCreate.verdict);
    expect(liveUpdateUpdateArm).toBe(updateMethodVerdicts.sameObjectRequestMethod.whenMethodEqualsUpdate.verdict);

    const overwritePayload = { contentType: 'text/plain', size: PROBE_REPLACEMENT.byteLength };
    expect(await simulateCase('write', paths.targetPath, REPLAY_UIDS.updateMethodUid, overwritePayload)).toBe(
      overwriteVerdicts['verb-update'],
    );
    expect(await simulateCase('write', paths.targetPath, REPLAY_UIDS.createMethodUid, overwritePayload)).toBe(
      overwriteVerdicts['verb-create'],
    );
    expect(await simulateCase('write', paths.granularPath, REPLAY_UIDS.updateMethodUid, overwritePayload)).toBe(
      overwriteVerdicts['verb-update'],
    );
    expect(await simulateCase('write', paths.granularPath, REPLAY_UIDS.createMethodUid, overwritePayload)).toBe(
      overwriteVerdicts['verb-create'],
    );

    const liveOverwriteUpdateArm = await liveVerdict(() =>
      uploadBytes(ref(updateStorage, paths.targetPath), PROBE_REPLACEMENT, { contentType: 'text/plain' }),
    );
    const liveOverwriteCreateArm = await liveVerdict(() =>
      uploadBytes(ref(createStorage, paths.targetPath), PROBE_REPLACEMENT, { contentType: 'text/plain' }),
    );
    expect(liveOverwriteUpdateArm).toBe(overwriteVerdicts['verb-update']);
    expect(liveOverwriteCreateArm).toBe(overwriteVerdicts['verb-create']);
  });

  it('replays stdlib-realstorage-request-resource-fields overwrite probes through CLI pyric rules simulate', async () => {
    const cwd = makeTempDir();

    const prefix = 'replay/cli-1884';
    const targetIds = ['verb-create', 'verb-update', 'create-stored-and-new-size', 'resource-existing'] as const;
    const capturedLines = capturedProbeRules
      .split('\n')
      .filter((line) => targetIds.some((id) => line.includes(`/overwrite/${id}.bin`)))
      .map((line) => line.replaceAll('<prefix>', prefix));
    expect(capturedLines).toHaveLength(targetIds.length);

    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${capturedLines.join('\n')}
  }
}`;
    const rulesFile = join(cwd, 'storage.rules');
    writeFileSync(rulesFile, rules);
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ storage: { rules: 'storage.rules' } }));

    for (const id of targetIds) {
      const objectPath = probePath(prefix, 'overwrite', id);
      const uploaded = await runCliMethod(cwd, 'storage.uploadBytes', [
        'storage',
        'uploadBytes',
        '--path',
        objectPath,
        '--contentBase64',
        Buffer.from(PROBE_PAYLOAD).toString('base64'),
        '--metadata',
        JSON.stringify({ contentType: 'application/octet-stream' }),
      ]);
      expect(uploaded.code).toBe(0);

      const simulated = await runCliMethod(cwd, 'rules.simulate', [
        'rules',
        'simulate',
        '--service',
        'storage',
        '--operation',
        'write',
        '--path',
        objectPath,
        '--rules-file',
        rulesFile,
        '--data',
        JSON.stringify({ contentType: 'text/plain', size: PROBE_REPLACEMENT.byteLength }),
      ]);
      expect(simulated.code).toBe(0);
      expect(simulated.stdout).toContain(`${objectPath}: ${overwriteVerdicts[id]}`);
    }
  });

  it('replays storage-updatemetadata-request-method update and write verbs through CLI pyric rules simulate', async () => {
    const cwd = makeTempDir();
    const runId = 'cli_1884';
    const bucketId = 'demo-pyric.appspot.com';
    const paths = updateMetadataMethodPaths(runId);
    const rules = updateMetadataMethodOracleTarget(bucketId, runId, REPLAY_UIDS).freshRules;

    const rulesFile = join(cwd, 'storage.rules');
    writeFileSync(rulesFile, rules);
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ storage: { rules: 'storage.rules' } }));
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-pyric' } }));

    const seedPaths = [paths.deniedControlPath, paths.targetPath, paths.granularPath];
    for (const objectPath of seedPaths) {
      const uploaded = await runCliMethod(cwd, 'storage.uploadBytes', [
        'storage',
        'uploadBytes',
        '--path',
        objectPath,
        '--contentBase64',
        Buffer.from(PROBE_PAYLOAD).toString('base64'),
        '--metadata',
        JSON.stringify({ contentType: 'text/plain', customMetadata: { stage: 'seed' } }),
      ]);
      expect(uploaded.code).toBe(0);
    }

    const cliSimulate = async (
      operation: 'update' | 'write',
      objectPath: string,
      uid: string,
      data?: Record<string, unknown>,
    ): Promise<Verdict> => {
      const argv = [
        'rules',
        'simulate',
        '--service',
        'storage',
        '--operation',
        operation,
        '--path',
        objectPath,
        '--uid',
        uid,
        '--rules-file',
        rulesFile,
        '--json',
      ];
      if (data !== undefined) {
        argv.push('--data', JSON.stringify(data));
      }
      const res = await runCliMethod(cwd, 'rules.simulate', argv);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout) as { ok: boolean; data: { allowed: boolean } };
      expect(parsed.ok).toBe(true);
      return toVerdict(parsed.data.allowed);
    };

    expect(await cliSimulate('update', paths.deniedControlPath, REPLAY_UIDS.createMethodUid)).toBe(
      updateMethodVerdicts.deniedControl.createClient.verdict,
    );
    expect(await cliSimulate('update', paths.deniedControlPath, REPLAY_UIDS.updateMethodUid)).toBe(
      updateMethodVerdicts.deniedControl.updateClient.verdict,
    );
    expect(await cliSimulate('update', paths.targetPath, REPLAY_UIDS.createMethodUid)).toBe(
      updateMethodVerdicts.sameObjectRequestMethod.whenMethodEqualsCreate.verdict,
    );
    expect(await cliSimulate('update', paths.targetPath, REPLAY_UIDS.updateMethodUid)).toBe(
      updateMethodVerdicts.sameObjectRequestMethod.whenMethodEqualsUpdate.verdict,
    );
    expect(await cliSimulate('update', paths.granularPath, REPLAY_UIDS.createMethodUid)).toBe(
      updateMethodVerdicts.sameObjectGranularVerb.allowCreateVerb.verdict,
    );
    expect(await cliSimulate('update', paths.granularPath, REPLAY_UIDS.updateMethodUid)).toBe(
      updateMethodVerdicts.sameObjectGranularVerb.allowUpdateVerb.verdict,
    );

    const overwritePayload = { contentType: 'text/plain', size: PROBE_REPLACEMENT.byteLength };
    expect(await cliSimulate('write', paths.targetPath, REPLAY_UIDS.updateMethodUid, overwritePayload)).toBe(
      overwriteVerdicts['verb-update'],
    );
    expect(await cliSimulate('write', paths.targetPath, REPLAY_UIDS.createMethodUid, overwritePayload)).toBe(
      overwriteVerdicts['verb-create'],
    );
    expect(await cliSimulate('write', paths.granularPath, REPLAY_UIDS.updateMethodUid, overwritePayload)).toBe(
      overwriteVerdicts['verb-update'],
    );
    expect(await cliSimulate('write', paths.granularPath, REPLAY_UIDS.createMethodUid, overwritePayload)).toBe(
      overwriteVerdicts['verb-create'],
    );
  });
});
