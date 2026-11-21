import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { probe as authEmailPasswordProbe } from '../../probes/auth-swift/auth-swift-email-password-and-error-codes.ts';
import { probe as authProfileTokenDeleteProbe } from '../../probes/auth-swift/auth-swift-profile-token-claims-and-delete-lifecycle.ts';
import { probe as rtdbQueriesPermissionProbe } from '../../probes/rtdb-swift/rtdb-swift-queries-ranges-limits-and-permission-denied.ts';
import { probe as rtdbWritesTxProbe } from '../../probes/rtdb-swift/rtdb-swift-writes-autoid-servervalue-and-transactions.ts';
import {
  buildIosRtdbPermissionAndQueryRules,
  buildIosRtdbRunRules,
  runIosOracleProbe,
  type IosAdminAuthAdapter,
} from '../../src/ios-oracle-runtime.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
import { mergeOracleRtdbRules } from '../../src/oracle-signal-restore.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = resolve(HERE, '..', '..');
const NATIVE_IOS_ROOT = join(CONFORMANCE_ROOT, 'rigs', 'native-ios-oracle');

const SYNTHETIC_SERVICE_ACCOUNT: OracleServiceAccount = {
  kind: 'application-default',
  project_id: 'demo-oracle-project',
  client_email: 'capture-sa@demo-oracle-project.iam.gserviceaccount.com',
  credential: {
    getAccessToken: async () => ({ access_token: 'synthetic-token', expires_in: 3600 }),
  },
};

describe('Wave 2 ios-sdk-probes descriptors, Swift dispatch parity, and cleanup guarantees', () => {
  it('wires every ios-sdk-probes descriptor to a matching Swift switch arm and cleanup helper', async () => {
    const wave2Probes = [
      authEmailPasswordProbe,
      authProfileTokenDeleteProbe,
      rtdbWritesTxProbe,
      rtdbQueriesPermissionProbe,
    ];
    for (const descriptor of wave2Probes) {
      expect(descriptor.rig).toBe('ios-sdk-probes');
      if (descriptor.pendingRowLink === true) {
        expect(descriptor.matrixRow).toBe('');
        expect(descriptor.rowIds).toEqual([]);
      } else {
        expect(descriptor.pendingRowLink).toBeUndefined();
        expect(descriptor.matrixRow.length).toBeGreaterThan(0);
        expect(descriptor.rowIds.length).toBeGreaterThan(0);
      }
      if (process.platform !== 'darwin') {
        await expect(descriptor.observe()).rejects.toThrow(/requires macOS \(darwin\)/);
      }
    }

    const authRunnerSwift = readFileSync(
      join(
        NATIVE_IOS_ROOT,
        'auth-sim',
        'Sources',
        'PyricIosAuthOracle',
        'AuthOracleProbeRunner.swift',
      ),
      'utf8',
    );
    const authWave2Swift = readFileSync(
      join(
        NATIVE_IOS_ROOT,
        'auth-sim',
        'Sources',
        'PyricIosAuthOracle',
        'AuthEmailPasswordAndProfileProbes.swift',
      ),
      'utf8',
    );
    const rtdbMainSwift = readFileSync(
      join(NATIVE_IOS_ROOT, 'rtdb-cli', 'Sources', 'RtdbOracleCLI', 'main.swift'),
      'utf8',
    );
    const rtdbWave2Swift = readFileSync(
      join(NATIVE_IOS_ROOT, 'rtdb-cli', 'Sources', 'RtdbOracleCLI', 'RtdbWave2Probes.swift'),
      'utf8',
    );

    const loaded = (await loadModularProbes('ios-sdk-probes')).filter(
      (entry) => entry.surfaceDir !== 'firestore-swift',
    );
    for (const entry of loaded) {
      if (entry.surfaceDir === 'auth-swift') {
        expect(authRunnerSwift).toContain(`case "${entry.id}":`);
      } else {
        expect(entry.surfaceDir).toBe('rtdb-swift');
        expect(rtdbMainSwift).toContain(`case "${entry.id}":`);
      }
    }

    expect(authRunnerSwift).toContain('PYRIC_IOS_ORACLE_CLEANUP_UID:');
    expect(authRunnerSwift).toContain('fflush(stdout)');
    expect(authWave2Swift).toContain('createUser(withEmail:');
    expect(authWave2Swift).toContain('signIn(withEmail:');
    expect(authWave2Swift).toContain('createProfileChangeRequest()');
    expect(authWave2Swift).toContain('getIDTokenResult(forcingRefresh: true)');
    expect(authWave2Swift).toContain('.delete()');
    expect(authWave2Swift.split('emitCleanupUid(').length - 1).toBeGreaterThanOrEqual(8);

    expect(rtdbWave2Swift).toContain('childByAutoId()');
    expect(rtdbWave2Swift).toContain('ServerValue.timestamp()');
    expect(rtdbWave2Swift).toContain('ServerValue.increment(');
    expect(rtdbWave2Swift).toContain('TransactionResult.success(withValue:');
    expect(rtdbWave2Swift).toContain('TransactionResult.abort()');
    expect(rtdbWave2Swift).toContain('queryOrderedByKey()');
    expect(rtdbWave2Swift).toContain('queryOrderedByValue()');
    expect(rtdbWave2Swift).toContain('queryEqual(toValue:');
    expect(rtdbWave2Swift).toContain('queryStarting(atValue:');
    expect(rtdbWave2Swift).toContain('queryEnding(atValue:');
    expect(rtdbWave2Swift).toContain('queryLimited(toLast:');
  });

  it('skips custom-token minting when needsCustomToken is false while still deleting all created UIDs', async () => {
    let customTokenCalls = 0;
    const deletedUids: string[] = [];
    let observedDerivedDataDir = '';

    const mockAdmin: IosAdminAuthAdapter = {
      createCustomToken: async () => {
        customTokenCalls += 1;
        return 'unexpected-token';
      },
      deleteUser: async (uid) => {
        deletedUids.push(uid);
      },
      dispose: async () => {},
    };

    const behavior = await runIosOracleProbe({
      probeId: 'auth-swift-email-password-and-error-codes',
      mode: 'ios-sim-auth',
      needsCustomToken: false,
      deps: {
        platform: 'darwin',
        env: {},
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => ({
          apiKey: 'demo-key',
          authDomain: 'demo-oracle-project.firebaseapp.com',
          projectId: 'demo-oracle-project',
          appId: '1:222:ios:def',
          messagingSenderId: '222',
        }),
        openAdminAuth: async () => mockAdmin,
        queryAvailableSimulatorsJson: () =>
          JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                { udid: 'SIM-WAVE2', name: 'iPhone 17', state: 'Booted', isAvailable: true },
              ],
            },
          }),
        executeAuthSim: (req) => {
          observedDerivedDataDir = req.derivedDataDir;
          const bundled = JSON.parse(
            readFileSync(
              join(
                req.stagedPackageDir,
                'Tests',
                'AuthOracleSimTests',
                'Resources',
                'oracle-input.json',
              ),
              'utf8',
            ),
          ) as { probeId: string; customToken: string; expectedCustomUid: string };
          expect(bundled.probeId).toBe('auth-swift-email-password-and-error-codes');
          expect(bundled.customToken).toBe('');
          expect(bundled.expectedCustomUid).toBe('');

          const encoded = Buffer.from(
            JSON.stringify({
              signUpIsAnonymous: false,
              duplicateEmailMatchesEnum: true,
              _cleanupUids: ['ep-uid-created-1'],
            }),
            'utf8',
          ).toString('base64');
          return [
            'PYRIC_IOS_ORACLE_CLEANUP_UID:ep-uid-created-1',
            'PYRIC_IOS_ORACLE_CLEANUP_UID:ep-uid-streamed-2',
            `PYRIC_IOS_ORACLE_RESULT_B64:${encoded}`,
          ].join('\n');
        },
      },
    });

    expect(customTokenCalls).toBe(0);
    expect(observedDerivedDataDir).toContain('xcode-derived-data');
    expect(behavior).toEqual({
      signUpIsAnonymous: false,
      duplicateEmailMatchesEnum: true,
    });
    expect(deletedUids).toEqual(['ep-uid-created-1', 'ep-uid-streamed-2']);
  });

  it('mounts permission-denied RTDB rules with stripTopLevelGrants so ancestor grants cannot mask denied_leaf', async () => {
    const permRules = buildIosRtdbPermissionAndQueryRules();
    expect(permRules).toEqual({
      workspace: {
        '.read': true,
        '.write': true,
        scores: {
          '.indexOn': '.value',
        },
      },
      denied_leaf: {
        '.read': false,
        '.write': false,
      },
    });
    expect('.read' in permRules).toBe(false);
    expect('.write' in permRules).toBe(false);
    expect(buildIosRtdbRunRules()['.read']).toBe(true);

    const baselineWithTopLevelGrant = JSON.stringify({
      rules: {
        '.read': false,
        '.write': false,
        pyric_oracle: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    });
    const merged = mergeOracleRtdbRules(baselineWithTopLevelGrant, {
      runId: 'ios_run_perm',
      rules: permRules,
      stripTopLevelGrants: true,
    });
    expect(merged.outcome).toBe('merged');
    if (merged.outcome === 'merged') {
      const parsedMerged = JSON.parse(merged.next) as {
        rules: { pyric_oracle: Record<string, unknown> };
      };
      expect('.read' in parsedMerged.rules.pyric_oracle).toBe(false);
      expect('.write' in parsedMerged.rules.pyric_oracle).toBe(false);
      expect(parsedMerged.rules.pyric_oracle.ios_run_perm).toEqual(permRules);
    }

    let capturedSessionOpts:
      | { rules: Record<string, unknown>; stripTopLevelGrants: boolean }
      | undefined;
    const rtdbResult = await runIosOracleProbe({
      probeId: 'rtdb-swift-queries-ranges-limits-and-permission-denied',
      mode: 'macos-rtdb-cli',
      rtdbRunRules: permRules,
      deps: {
        platform: 'darwin',
        env: {
          PYRIC_ORACLE_RTDB_URL: 'https://pyric-oracle-rtdb-dedicated.firebaseio.com',
        },
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => ({
          apiKey: 'demo-key',
          authDomain: 'demo-oracle-project.firebaseapp.com',
          projectId: 'demo-oracle-project',
          appId: '1:111:ios:abc',
          messagingSenderId: '111',
        }),
        deployScopedRtdbSession: async (_sa, _dbUrl, _runId, fn, sessionOpts) => {
          capturedSessionOpts = sessionOpts;
          return fn();
        },
        executeRtdbCli: (req) => {
          writeFileSync(
            req.outputPath,
            JSON.stringify({
              keyRangeKeys: ['k2', 'k3'],
              valueLimitToLastKeys: ['p4', 'p5'],
              writeDeniedRejected: true,
              observeDeniedRejected: true,
              getDataDeniedRejected: true,
            }),
          );
          return '';
        },
      },
    });

    expect(capturedSessionOpts).toEqual({
      rules: permRules,
      stripTopLevelGrants: true,
    });
    expect(rtdbResult.writeDeniedRejected).toBe(true);
    expect(rtdbResult.observeDeniedRejected).toBe(true);
    expect(rtdbResult.getDataDeniedRejected).toBe(true);
  });
});
