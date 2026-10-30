import { describe, expect, it } from 'bun:test';
import {
  MANUAL_CONFIG_FLAG,
  assertWebConfigProject,
  manualWebConfig,
  oracleRunMode,
  skipReason,
  webConfigFromEnv,
} from '../../src/oracle-run-setup.ts';

const CONFIG = { apiKey: 'k', authDomain: 'd', projectId: 'digame-mas' };

describe('oracle-run setup', () => {
  it('loads the credential by default, even when a web config is in the environment', () => {
    expect(oracleRunMode(['bun', 'run.ts', 'auth-'])).toBe('credential');
  });

  it('runs without a credential only under the explicit flag', () => {
    expect(oracleRunMode(['bun', 'run.ts', MANUAL_CONFIG_FLAG])).toBe('manual');
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
});
