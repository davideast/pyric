import { describe, expect, it } from 'bun:test';
import {
  MANUAL_CONFIG_FLAG,
  assertDedicatedOracleRtdbUrl,
  assertWebConfigProject,
  isDedicatedOracleRtdbUrl,
  manualWebConfig,
  oracleRunMode,
  resolveOracleRtdbUrl,
  selectDedicatedRtdbInstanceUrl,
  skipReason,
  webConfigFromEnv,
} from '../../src/oracle-run-setup.ts';

const CONFIG = { apiKey: 'k', authDomain: 'd', projectId: 'digame-mas' };

describe('oracle-run setup', () => {
  it('loads the credential by default, even when a web config is in the environment', () => {
    expect(oracleRunMode(['bun', 'run.ts', '--write', 'auth-'])).toBe('credential');
  });

  it('runs without a credential only under the explicit flag', () => {
    expect(oracleRunMode(['bun', 'run.ts', '--write', MANUAL_CONFIG_FLAG])).toBe('manual');
  });

  it('enters inert preview mode unless --write or --capture is passed', () => {
    expect(oracleRunMode(['bun', 'run.ts'])).toBe('preview');
    expect(oracleRunMode(['bun', 'run.ts', 'firestore-'])).toBe('preview');
    expect(oracleRunMode(['bun', 'run.ts', MANUAL_CONFIG_FLAG])).toBe('preview');
    expect(oracleRunMode(['bun', 'run.ts', '--capture'])).toBe('credential');
  });

  it('reads the web config from the environment, or nothing when unset', () => {
    expect(webConfigFromEnv({ PYRIC_ORACLE_FIREBASE_CONFIG: JSON.stringify(CONFIG) })).toEqual(CONFIG);
    expect(webConfigFromEnv({})).toBeUndefined();
    expect(() => webConfigFromEnv({ PYRIC_ORACLE_FIREBASE_CONFIG: '{' })).toThrow(/not valid JSON/);
  });

  it('refuses a web config for a project other than the credential', () => {
    expect(() => assertWebConfigProject(CONFIG, 'digame-mas')).not.toThrow();
    expect(() => assertWebConfigProject(CONFIG, 'genkit-idx')).toThrow(/digame-mas.*genkit-idx/);
  });

  it('needs the web config in manual mode', () => {
    expect(() => manualWebConfig({})).toThrow(MANUAL_CONFIG_FLAG);
  });

  it('names a skip record and passes an observation through', () => {
    expect(skipReason({ skipped: true, reason: 'no service account (manual config?)' }))
      .toBe('no service account (manual config?)');
    expect(skipReason({ skipped: true })).toBe('no reason given');
    expect(skipReason({ skipped: false, code: null })).toBeNull();
    expect(skipReason({ code: 'auth/invalid-credential' })).toBeNull();
    expect(skipReason(null)).toBeNull();
    expect(skipReason([1, 2])).toBeNull();
  });

  it('pins RTDB operations to dedicated non-default oracle instances (#1426 item 3)', () => {
    expect(isDedicatedOracleRtdbUrl('https://pyric-oracle-rtdb-2.firebaseio.com', 'digame-mas')).toBe(true);
    expect(isDedicatedOracleRtdbUrl('https://pyric-oracle-rtdb-2.europe-west1.firebasedatabase.app/', 'digame-mas')).toBe(true);
    expect(isDedicatedOracleRtdbUrl('https://digame-mas-default-rtdb.firebaseio.com', 'digame-mas')).toBe(false);
    expect(isDedicatedOracleRtdbUrl('https://digame-mas.firebaseio.com', 'digame-mas')).toBe(false);

    expect(
      assertDedicatedOracleRtdbUrl('https://pyric-oracle-rtdb-2.firebaseio.com///', 'digame-mas'),
    ).toBe('https://pyric-oracle-rtdb-2.firebaseio.com');
    expect(() =>
      assertDedicatedOracleRtdbUrl('https://digame-mas-default-rtdb.firebaseio.com', 'digame-mas'),
    ).toThrow(/dedicated RTDB oracle instance/);
    expect(() =>
      assertDedicatedOracleRtdbUrl('https://digame-mas.firebaseio.com', 'digame-mas'),
    ).toThrow(/dedicated RTDB oracle instance/);
  });

  it('discovers only dedicated USER_DATABASE instances and ignores DEFAULT_DATABASE', () => {
    expect(
      selectDedicatedRtdbInstanceUrl(
        [
          {
            name: 'projects/1/locations/us-central1/instances/digame-mas-default-rtdb',
            databaseUrl: 'https://digame-mas-default-rtdb.firebaseio.com',
            state: 'ACTIVE',
            type: 'DEFAULT_DATABASE',
          },
          {
            name: 'projects/1/locations/us-central1/instances/pyric-oracle-rtdb-2',
            databaseUrl: 'https://pyric-oracle-rtdb-2.firebaseio.com/',
            state: 'ACTIVE',
            type: 'USER_DATABASE',
          },
        ],
        'digame-mas',
      ),
    ).toBe('https://pyric-oracle-rtdb-2.firebaseio.com');

    expect(
      selectDedicatedRtdbInstanceUrl(
        [
          {
            name: 'projects/1/locations/us-central1/instances/digame-mas-default-rtdb',
            databaseUrl: 'https://digame-mas-default-rtdb.firebaseio.com',
            state: 'ACTIVE',
            type: 'DEFAULT_DATABASE',
          },
        ],
        'digame-mas',
      ),
    ).toBeNull();
  });

  it('replaces a web-config default databaseURL with PYRIC_ORACLE_RTDB_URL or discovered dedicated instance', async () => {
    const fromEnvOverride = await resolveOracleRtdbUrl({
      projectId: 'digame-mas',
      env: { PYRIC_ORACLE_RTDB_URL: 'https://pyric-oracle-rtdb-2.firebaseio.com/' },
      webConfigDatabaseUrl: 'https://digame-mas-default-rtdb.firebaseio.com',
      discoverDedicated: async () => null,
    });
    expect(fromEnvOverride).toBe('https://pyric-oracle-rtdb-2.firebaseio.com');

    const fromDiscovery = await resolveOracleRtdbUrl({
      projectId: 'digame-mas',
      env: {},
      webConfigDatabaseUrl: 'https://digame-mas-default-rtdb.firebaseio.com',
      discoverDedicated: async () => 'https://pyric-oracle-rtdb-2.firebaseio.com',
    });
    expect(fromDiscovery).toBe('https://pyric-oracle-rtdb-2.firebaseio.com');

    await expect(
      resolveOracleRtdbUrl({
        projectId: 'digame-mas',
        env: { PYRIC_ORACLE_RTDB_URL: 'https://digame-mas-default-rtdb.firebaseio.com' },
        webConfigDatabaseUrl: undefined,
        discoverDedicated: async () => null,
      }),
    ).rejects.toThrow(/dedicated RTDB oracle instance/);
  });
});
