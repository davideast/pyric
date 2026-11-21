import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import {
  runIosOracleProbe,
  type IosAdminAuthAdapter,
} from '../../src/ios-oracle-runtime.ts';
import {
  assertValidIosOracleAppName,
  buildAuthSimXcodebuildArgs,
  buildFirestoreSimXcodebuildArgs,
  formatIosOracleSpawnFailure,
  normalizeIosOracleGoogleAppId,
  stageIosPackageTemplate,
} from '../../src/ios-oracle-simulator.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = join(HERE, '..', '..');
const NATIVE_IOS_RIG_ROOT = join(CONFORMANCE_ROOT, 'rigs', 'native-ios-oracle');

const SYNTHETIC_SERVICE_ACCOUNT: OracleServiceAccount = {
  kind: 'application-default',
  project_id: 'demo-oracle-project',
  client_email: 'capture-sa@demo-oracle-project.iam.gserviceaccount.com',
  credential: {
    getAccessToken: async () => ({ access_token: 'synthetic-token', expires_in: 3600 }),
  },
};

const VALID_FIR_IOS_APP_ID_REGEX = /^1:[0-9]{1,18}:ios:[0-9a-f]{1,16}$/;

function detectSwiftFrontendForParse(): string | null {
  const localFrontend = join(homedir(), '.local', 'swift', 'usr', 'bin', 'swift-frontend');
  if (existsSync(localFrontend)) {
    return localFrontend;
  }
  const pathFrontend = Bun.which('swift-frontend');
  if (pathFrontend !== null) {
    return pathFrontend;
  }
  const swiftc = Bun.which('swiftc');
  if (swiftc !== null) {
    const siblingFrontend = join(dirname(realpathSync(swiftc)), 'swift-frontend');
    if (existsSync(siblingFrontend)) {
      return siblingFrontend;
    }
    return swiftc;
  }
  return null;
}

async function runSingleProcessSwiftParse(
  swiftParser: string,
  swiftFiles: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([swiftParser, '-parse', ...swiftFiles], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdoutText}\n${stderrText}` };
}

describe('normalizeIosOracleGoogleAppId and assertValidIosOracleAppName', () => {
  it('converts web, android, macos, and overlong appIds into valid FIRApp iOS GOOGLE_APP_ID values', () => {
    const fromWeb22Hex = normalizeIosOracleGoogleAppId(
      '1:987654321098:web:AbCdEf0123456789fedcba',
      '987654321098',
    );
    expect(fromWeb22Hex).toBe('1:987654321098:ios:abcdef0123456789');
    expect(fromWeb22Hex).toMatch(VALID_FIR_IOS_APP_ID_REGEX);

    const fromAndroid = normalizeIosOracleGoogleAppId(
      '1:123456789012:android:0011223344556677',
      '123456789012',
    );
    expect(fromAndroid).toBe('1:123456789012:ios:0011223344556677');
    expect(fromAndroid).toMatch(VALID_FIR_IOS_APP_ID_REGEX);

    const fromMacosShortHex = normalizeIosOracleGoogleAppId('1:555666777888:macos:ab12', '555666777888');
    expect(fromMacosShortHex).toBe('1:555666777888:ios:ab12000000000000');
    expect(fromMacosShortHex).toMatch(VALID_FIR_IOS_APP_ID_REGEX);

    const fromOverlongIosHex = normalizeIosOracleGoogleAppId(
      '1:987654321098:ios:0123456789abcdef9999',
      '987654321098',
    );
    expect(fromOverlongIosHex).toBe('1:987654321098:ios:0123456789abcdef');
    expect(fromOverlongIosHex).toMatch(VALID_FIR_IOS_APP_ID_REGEX);

    const preservedValidIos = normalizeIosOracleGoogleAppId('1:222:ios:DeF01', '222');
    expect(preservedValidIos).toBe('1:222:ios:def01');
    expect(preservedValidIos).toMatch(VALID_FIR_IOS_APP_ID_REGEX);

    const repairedNonHexIosSuffix = normalizeIosOracleGoogleAppId('1:333:ios:fsapp', '333');
    expect(repairedNonHexIosSuffix).toBe('1:333:ios:0000000000000000');
    expect(repairedNonHexIosSuffix).toMatch(VALID_FIR_IOS_APP_ID_REGEX);

    const fallbackFromNumericSender = normalizeIosOracleGoogleAppId(undefined, '777888999000');
    expect(fallbackFromNumericSender).toBe('1:777888999000:ios:0000000000000000');
    expect(fallbackFromNumericSender).toMatch(VALID_FIR_IOS_APP_ID_REGEX);

    const fallbackZeroes = normalizeIosOracleGoogleAppId('', 'non-numeric-sender');
    expect(fallbackZeroes).toBe('1:000000000000:ios:0000000000000000');
    expect(fallbackZeroes).toMatch(VALID_FIR_IOS_APP_ID_REGEX);
  });

  it('validates FirebaseApp name tokens against FIRApp character-set rules', () => {
    expect(assertValidIosOracleAppName('ios_0123456789abcdef0123456789abcdef')).toBe(
      'ios_0123456789abcdef0123456789abcdef',
    );
    expect(assertValidIosOracleAppName('pyric-ios-auth-ios_abc123')).toBe(
      'pyric-ios-auth-ios_abc123',
    );
    expect(() => assertValidIosOracleAppName('')).toThrow(/Invalid FirebaseApp name token/);
    expect(() => assertValidIosOracleAppName('bad:name')).toThrow(/Invalid FirebaseApp name token/);
    expect(() => assertValidIosOracleAppName('bad.name')).toThrow(/Invalid FirebaseApp name token/);
    expect(() => assertValidIosOracleAppName('bad space')).toThrow(/Invalid FirebaseApp name token/);
  });
});

describe('Simulator xcodebuild flags and NSException diagnostic extraction', () => {
  it('passes ad-hoc Simulator code-signing and diagnostic-suppression flags matching firebase-ios-sdk SPM runs', () => {
    const authArgs = buildAuthSimXcodebuildArgs({
      stagedPackageDir: '/tmp/staged/auth-sim',
      derivedDataDir: '/tmp/cache/auth-dd',
      clonedPackagesDir: '/tmp/cache/spm',
      destination: 'platform=iOS Simulator,id=SIM-AUTH-1',
      env: {},
    });
    expect(authArgs).toEqual([
      'test',
      '-project',
      '/tmp/staged/auth-sim/HostApp/AuthOracleHost.xcodeproj',
      '-scheme',
      'AuthOracleHost',
      '-destination',
      'platform=iOS Simulator,id=SIM-AUTH-1',
      '-derivedDataPath',
      '/tmp/cache/auth-dd',
      '-clonedSourcePackagesDirPath',
      '/tmp/cache/spm',
      '-collect-test-diagnostics',
      'never',
      '-only-testing:AuthOracleHostedTests/AuthOracleHostedTests/testCaptureSelectedOracleProbe',
      'ONLY_ACTIVE_ARCH=YES',
      'COMPILER_INDEX_STORE_ENABLE=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGNING_ALLOWED=YES',
    ]);
    expect(authArgs).not.toContain('CODE_SIGNING_ALLOWED=NO');
    expect(authArgs).not.toContain('CODE_SIGNING_IDENTITY=');

    const fsArgs = buildFirestoreSimXcodebuildArgs({
      stagedPackageDir: '/tmp/staged/firestore-sim',
      derivedDataDir: '/tmp/cache/firestore-dd',
      clonedPackagesDir: '/tmp/cache/spm',
      destination: 'platform=iOS Simulator,id=SIM-FS-1',
      env: {},
    });
    expect(fsArgs).toEqual([
      'test',
      '-project',
      '/tmp/staged/firestore-sim/HostApp/FirestoreOracleHost.xcodeproj',
      '-scheme',
      'FirestoreOracleHost',
      '-destination',
      'platform=iOS Simulator,id=SIM-FS-1',
      '-derivedDataPath',
      '/tmp/cache/firestore-dd',
      '-clonedSourcePackagesDirPath',
      '/tmp/cache/spm',
      '-collect-test-diagnostics',
      'never',
      '-only-testing:FirestoreOracleHostedTests/FirestoreOracleHostedTests/testCaptureSelectedOracleProbe',
      'ONLY_ACTIVE_ARCH=YES',
      'COMPILER_INDEX_STORE_ENABLE=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGNING_ALLOWED=YES',
    ]);
  });

  it('preserves NSException reason, FirebaseCore log codes, and early stack frames above trailing xcodebuild summary noise', () => {
    const noisyCompileLines = Array.from(
      { length: 75 },
      (_, idx) =>
        `CompileC /Users/runner/DerivedData/Build/Intermediates.noindex/File${String(idx)}.o -fmodules -module-name FirebaseCore`,
    );
    const crashLines = [
      'Test Case \'-[AuthOracleSimTests.AuthOracleSimTests testCaptureSelectedOracleProbe]\' started.',
      'PYRIC_IOS_ORACLE_CLEANUP_UID:uid-before-nsexception',
      '2026-11-21 15:24:11.120 xctest[5412:99102] 11.4.0 - [FirebaseCore][I-COR000005] No app has been configured yet.',
      '2026-11-21 15:24:11.125 xctest[5412:99102] *** Terminating app due to uncaught exception \'com.firebase.core\', reason: \'Configuration fails. It may be caused by an invalid GOOGLE_APP_ID in GoogleService-Info.plist or set in the customized options.\'',
      '*** First throw call stack:',
      '(',
      '\t0   CoreFoundation                      0x00000001804b910c __exceptionPreprocess + 172',
      '\t1   libobjc.A.dylib                     0x0000000180092da8 objc_exception_throw + 72',
      '\t2   CoreFoundation                      0x00000001804b901c -[NSException initWithCoder:] + 0',
      '\t3   AuthOracleSimTests                  0x0000000105390a10 +[FIRApp configureWithName:options:] + 480',
      '\t4   AuthOracleSimTests                  0x0000000105a5c72c $s18PyricIosAuthOracle0cD11ProbeRunnerO3run9inputData10Foundation0I0VAG_tYaKFZTY0_ + 1152',
    ];
    for (let frame = 5; frame <= 15; frame += 1) {
      crashLines.push(
        `\t${String(frame)}   libswift_Concurrency.dylib          0x0000000246fe1800 swift_task_switch + ${String(frame * 16)}`,
      );
    }
    crashLines.push(
      ')',
      'libc++abi: terminating due to uncaught exception of type NSException',
    );
    const trailingSummaryLines = Array.from(
      { length: 38 },
      (_, idx) => `xcodebuild summary trailer line ${String(idx + 1)}: Restarting after unexpected exit`,
    );
    trailingSummaryLines.push('** TEST FAILED **');

    const stdout = [...noisyCompileLines, ...crashLines, ...trailingSummaryLines].join('\n');
    const err = formatIosOracleSpawnFailure('xcodebuild AuthOracleSimTests', 65, stdout, '');

    expect(err.message).toContain('xcodebuild AuthOracleSimTests exited with status 65:');
    expect(err.message).toContain('Diagnostic highlights:');
    expect(err.message).toContain('[FirebaseCore][I-COR000005]');
    expect(err.message).toContain(
      "*** Terminating app due to uncaught exception 'com.firebase.core', reason: 'Configuration fails.",
    );
    expect(err.message).toContain('0   CoreFoundation');
    expect(err.message).toContain('3   AuthOracleSimTests');
    expect(err.message).toContain('libc++abi: terminating due to uncaught exception of type NSException');
    const highlightsSection = err.message.split('Recent output tail:')[0];
    expect(highlightsSection).toBeDefined();
    expect(highlightsSection).not.toContain('CompileC /Users/runner/DerivedData');
    expect(err.output).toContain('PYRIC_IOS_ORACLE_CLEANUP_UID:uid-before-nsexception');
  });
});

describe('runIosOracleProbe Web appId normalization across all Apple rigs and Swift syntax check', () => {
  it('rewrites Web appId from resolveWebConfig into a valid iOS googleAppId for RTDB, Auth, and Firestore rigs', async () => {
    const webShapedConfig = {
      apiKey: 'demo-web-api-key',
      authDomain: 'demo-oracle-project.firebaseapp.com',
      databaseURL: 'https://demo-oracle-project-default-rtdb.firebaseio.com',
      projectId: 'demo-oracle-project',
      appId: '1:654321098765:web:fedcba9876543210abcdef',
      messagingSenderId: '654321098765',
    };
    const expectedIosAppId = '1:654321098765:ios:fedcba9876543210';

    let observedRtdbAppId = '';
    await runIosOracleProbe({
      probeId: 'rtdb-swift-dedicated-crud-and-query-order',
      mode: 'macos-rtdb-cli',
      deps: {
        platform: 'darwin',
        env: { PYRIC_ORACLE_RTDB_URL: 'https://pyric-oracle-rtdb-dedicated.firebaseio.com' },
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => webShapedConfig,
        deployScopedRtdbSession: async (_sa, _dbUrl, _runId, fn) => fn(),
        executeRtdbCli: (req) => {
          const parsed = JSON.parse(readFileSync(req.inputPath, 'utf8')) as { googleAppId: string };
          observedRtdbAppId = parsed.googleAppId;
          writeFileSync(req.outputPath, JSON.stringify({ ok: true }));
          return '';
        },
      },
    });
    expect(observedRtdbAppId).toBe(expectedIosAppId);

    const mockAdmin: IosAdminAuthAdapter = {
      createCustomToken: async (uid) => `token-${uid}`,
      deleteUser: async () => {},
      dispose: async () => {},
    };
    const simJson = () =>
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
            { udid: 'SIM-DIAG-1', name: 'iPhone 17', state: 'Booted', isAvailable: true },
          ],
        },
      });

    let observedAuthAppId = '';
    await runIosOracleProbe({
      probeId: 'auth-swift-anonymous-and-custom-token-session',
      mode: 'ios-sim-auth',
      deps: {
        platform: 'darwin',
        env: {},
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => webShapedConfig,
        openAdminAuth: async () => mockAdmin,
        queryAvailableSimulatorsJson: simJson,
        executeAuthSim: (req) => {
          const parsed = JSON.parse(
            readFileSync(
              join(req.stagedPackageDir, 'Tests', 'AuthOracleSimTests', 'Resources', 'oracle-input.json'),
              'utf8',
            ),
          ) as { googleAppId: string };
          observedAuthAppId = parsed.googleAppId;
          const b64 = Buffer.from(JSON.stringify({ ok: true }), 'utf8').toString('base64');
          return `PYRIC_IOS_ORACLE_RESULT_B64:${b64}`;
        },
      },
    });
    expect(observedAuthAppId).toBe(expectedIosAppId);

    let observedFirestoreAppId = '';
    await runIosOracleProbe({
      probeId: 'firestore-swift-crud-merge-sentinels-and-codecs',
      mode: 'ios-sim-firestore',
      deps: {
        platform: 'darwin',
        env: {},
        loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
        resolveWebConfig: async () => webShapedConfig,
        openAdminAuth: async () => mockAdmin,
        queryAvailableSimulatorsJson: simJson,
        deployScopedFirestoreSession: async (_sa, _runId, fn) => fn(),
        executeFirestoreSim: (req) => {
          const parsed = JSON.parse(
            readFileSync(
              join(
                req.stagedPackageDir,
                'Tests',
                'FirestoreOracleSimTests',
                'Resources',
                'oracle-input.json',
              ),
              'utf8',
            ),
          ) as { googleAppId: string };
          observedFirestoreAppId = parsed.googleAppId;
          const b64 = Buffer.from(JSON.stringify({ ok: true }), 'utf8').toString('base64');
          return `PYRIC_IOS_ORACLE_RESULT_B64:${b64}`;
        },
      },
    });
    expect(observedFirestoreAppId).toBe(expectedIosAppId);
  });

  it(
    'keeps defensive Swift googleAppId normalization and bundleID fallbacks parse-clean across all three rigs',
    async () => {
      const authRunnerPath = join(
        NATIVE_IOS_RIG_ROOT,
        'auth-sim',
        'Sources',
        'PyricIosAuthOracle',
        'AuthOracleProbeRunner.swift',
      );
      const fsRunnerPath = join(
        NATIVE_IOS_RIG_ROOT,
        'firestore-sim',
        'Sources',
        'PyricIosFirestoreOracle',
        'FirestoreOracleProbeRunner.swift',
      );
      const rtdbMainPath = join(
        NATIVE_IOS_RIG_ROOT,
        'rtdb-cli',
        'Sources',
        'RtdbOracleCLI',
        'main.swift',
      );

      expect(readFileSync(authRunnerPath, 'utf8')).toContain('normalizeIosGoogleAppId');
      expect(readFileSync(authRunnerPath, 'utf8')).toContain('dev.pyric.ios.oracle.auth');
      expect(readFileSync(fsRunnerPath, 'utf8')).toContain('normalizeIosGoogleAppId');
      expect(readFileSync(fsRunnerPath, 'utf8')).toContain('dev.pyric.ios.oracle.firestore');
      expect(readFileSync(rtdbMainPath, 'utf8')).toContain('makeRtdbFirebaseOptions');
      expect(readFileSync(rtdbMainPath, 'utf8')).toContain('dev.pyric.ios.oracle.rtdb');

      const swiftParser = detectSwiftFrontendForParse();
      if (swiftParser !== null) {
        const swiftFiles = [
          authRunnerPath,
          fsRunnerPath,
          rtdbMainPath,
          join(
            NATIVE_IOS_RIG_ROOT,
            'rtdb-cli',
            'Sources',
            'RtdbOracleCLI',
            'RtdbWave4ListenersAndOnDisconnectProbes.swift',
          ),
          join(
            NATIVE_IOS_RIG_ROOT,
            'rtdb-cli',
            'Sources',
            'RtdbOracleCLI',
            'RtdbWave4NavigationAndSnapshotProbes.swift',
          ),
          join(
            NATIVE_IOS_RIG_ROOT,
            'auth-sim',
            'HostApp',
            'Sources',
            'AuthOracleHostApp.swift',
          ),
          join(
            NATIVE_IOS_RIG_ROOT,
            'auth-sim',
            'HostApp',
            'Tests',
            'AuthOracleHostedTests.swift',
          ),
          join(
            NATIVE_IOS_RIG_ROOT,
            'firestore-sim',
            'HostApp',
            'Sources',
            'FirestoreOracleHostApp.swift',
          ),
          join(
            NATIVE_IOS_RIG_ROOT,
            'firestore-sim',
            'HostApp',
            'Tests',
            'FirestoreOracleHostedTests.swift',
          ),
        ];
        const parsed = await runSingleProcessSwiftParse(swiftParser, swiftFiles);
        expect(parsed.exitCode, parsed.output).toBe(0);
      }
    },
    90_000,
  );

  it('validates Simulator TEST_HOST Xcode projects, keychain entitlements, schemes, and template staging for Auth and Firestore rigs', () => {
    const specs = [
      {
        rigSubdir: 'auth-sim',
        hostName: 'AuthOracleHost',
        testTargetName: 'AuthOracleHostedTests',
        packageProductName: 'PyricIosAuthOracle',
        bundleId: 'dev.pyric.ios.oracle.auth',
        appTargetId: 'AA0000000000000000000010',
        testTargetId: 'AA0000000000000000000020',
      },
      {
        rigSubdir: 'firestore-sim',
        hostName: 'FirestoreOracleHost',
        testTargetName: 'FirestoreOracleHostedTests',
        packageProductName: 'PyricIosFirestoreOracle',
        bundleId: 'dev.pyric.ios.oracle.firestore',
        appTargetId: 'BB0000000000000000000010',
        testTargetId: 'BB0000000000000000000020',
      },
    ];

    const scratch = createPrivateJobTmpDir('ios-host-ut');
    try {
      for (const spec of specs) {
        const templateDir = join(NATIVE_IOS_RIG_ROOT, spec.rigSubdir);
        const stagedDir = join(scratch, spec.rigSubdir);
        stageIosPackageTemplate(templateDir, stagedDir);

        const hostDir = join(stagedDir, 'HostApp');
        const pbxprojPath = join(hostDir, `${spec.hostName}.xcodeproj`, 'project.pbxproj');
        const schemePath = join(
          hostDir,
          `${spec.hostName}.xcodeproj`,
          'xcshareddata',
          'xcschemes',
          `${spec.hostName}.xcscheme`,
        );
        const entitlementsPath = join(hostDir, 'Resources', `${spec.hostName}.entitlements`);
        const infoPlistPath = join(hostDir, 'Resources', 'Info.plist');

        expect(existsSync(join(templateDir, 'HostApp', `${spec.hostName}.xcodeproj`))).toBe(false);
        expect(existsSync(join(hostDir, '..', 'Package.swift'))).toBe(true);
        expect(existsSync(pbxprojPath)).toBe(true);
        expect(existsSync(schemePath)).toBe(true);
        expect(existsSync(entitlementsPath)).toBe(true);
        expect(existsSync(infoPlistPath)).toBe(true);

        const pbx = readFileSync(pbxprojPath, 'utf8');
        expect(pbx.startsWith('// !$*UTF8*$!\n')).toBe(true);
        expect(pbx).toContain('objectVersion = 56;');
        expect(pbx).toContain(`CODE_SIGN_ENTITLEMENTS = Resources/${spec.hostName}.entitlements;`);
        expect(pbx).toContain('ENTITLEMENTS_REQUIRED = YES;');
        expect(pbx).toContain('CODE_SIGN_STYLE = Automatic;');
        expect(pbx).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${spec.bundleId};`);
        expect(pbx).toContain('BUNDLE_LOADER = "$(TEST_HOST)";');
        expect(pbx).toContain(
          `TEST_HOST = "$(BUILT_PRODUCTS_DIR)/${spec.hostName}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${spec.hostName}";`,
        );
        expect(pbx).toContain('isa = XCLocalSwiftPackageReference;');
        expect(pbx).toContain('relativePath = ..;');
        expect(pbx).toContain(`productName = ${spec.packageProductName};`);

        let curlyDepth = 0;
        let parenDepth = 0;
        for (const ch of pbx) {
          if (ch === '{') curlyDepth += 1;
          if (ch === '}') curlyDepth -= 1;
          if (ch === '(') parenDepth += 1;
          if (ch === ')') parenDepth -= 1;
          expect(curlyDepth >= 0 && parenDepth >= 0).toBe(true);
        }
        expect(curlyDepth).toBe(0);
        expect(parenDepth).toBe(0);

        const definedIds = new Set<string>();
        for (const defMatch of pbx.matchAll(/^\t\t([0-9A-F]{24})\b[^\n=]*=\s*\{/gm)) {
          const id = defMatch[1];
          if (id !== undefined) {
            definedIds.add(id);
          }
        }
        expect(definedIds.has(spec.appTargetId)).toBe(true);
        expect(definedIds.has(spec.testTargetId)).toBe(true);
        for (const refMatch of pbx.matchAll(/\b([0-9A-F]{24})\b/g)) {
          const id = refMatch[1];
          if (id !== undefined) {
            expect(definedIds.has(id)).toBe(true);
          }
        }

        for (const groupFileMatch of pbx.matchAll(
          /path = ([^;]+); sourceTree = "<group>";/g,
        )) {
          const relPath = groupFileMatch[1];
          if (relPath !== undefined && relPath !== 'Products') {
            expect(existsSync(join(hostDir, relPath))).toBe(true);
          }
        }

        const entitlementsXml = readFileSync(entitlementsPath, 'utf8');
        expect(entitlementsXml).toContain('<key>keychain-access-groups</key>');
        expect(entitlementsXml).not.toContain('AppIdentifierPrefix');

        const infoPlistXml = readFileSync(infoPlistPath, 'utf8');
        expect(infoPlistXml).toContain('<key>UIApplicationSceneManifest</key>');

        const schemeXml = readFileSync(schemePath, 'utf8');
        expect(schemeXml).toContain(`BlueprintIdentifier = "${spec.appTargetId}"`);
        expect(schemeXml).toContain(`BlueprintIdentifier = "${spec.testTargetId}"`);
        expect(schemeXml).toContain(`BuildableName = "${spec.hostName}.app"`);
        expect(schemeXml).toContain(`BuildableName = "${spec.testTargetName}.xctest"`);
        expect(schemeXml).toContain('parallelizable = "NO"');
      }
    } finally {
      removePrivateJobTmpDir(scratch);
    }
  });
});
