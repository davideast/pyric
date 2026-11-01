import { describe, expect, it } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { Credential } from 'firebase-admin/app';
import {
  applicationDefaultProject,
  describeOracleCredential,
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleAppOptions,
  oracleCredentialConfigured,
  oracleServiceAccountEmail,
  oracleSignBlob,
  ORACLE_VARIABLES,
  SECONDARY_ORACLE_VARIABLES,
  selectOracleCredentialSource,
  serviceAccountProject,
  signOracleJwt,
  type OracleCredentialDeps,
  type OracleKey,
  type OracleServiceAccount,
} from '../../src/oracle-credential.ts';

const IMPERSONATED_EMAIL = 'oracle-sa@oracle-project.iam.gserviceaccount.com';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const key: OracleKey = {
  project_id: 'key-project',
  client_email: 'key-sa@key-project.iam.gserviceaccount.com',
  private_key: privateKey,
};

function fakeCredential(token: string, email?: string): Credential {
  const credential = { getAccessToken: async () => ({ access_token: token, expires_in: 3600 }) };
  if (email === undefined) return credential;
  return { ...credential, getServiceAccountEmail: async () => email } as Credential;
}

function credentialThatCannotNameItsAccount(): Credential {
  return {
    getAccessToken: async () => ({ access_token: 'adc-token', expires_in: 3600 }),
    getServiceAccountEmail: async () => { throw new Error('Could not load the default credentials'); },
  } as Credential;
}

interface Recorded {
  readPaths: string[];
  certKeys: OracleKey[];
  adcCalls: number;
  logs: string[];
  warnings: string[];
}

function fakeDeps(
  files: Record<string, string> = {},
  adcCredential: Credential = fakeCredential('adc-token', IMPERSONATED_EMAIL),
): { deps: OracleCredentialDeps; recorded: Recorded } {
  const recorded: Recorded = { readPaths: [], certKeys: [], adcCalls: 0, logs: [], warnings: [] };
  const deps: OracleCredentialDeps = {
    log: (message) => recorded.logs.push(message),
    warn: (message) => recorded.warnings.push(message),
    readFile(path) {
      recorded.readPaths.push(path);
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    cert(certKey) {
      recorded.certKeys.push(certKey);
      return fakeCredential('key-token');
    },
    applicationDefault() {
      recorded.adcCalls += 1;
      return adcCredential;
    },
  };
  return { deps, recorded };
}

const ADC_ENV = { PYRIC_ORACLE_PROJECT_ID: 'oracle-project' };

function adcAccount(credential: Credential = fakeCredential('adc-token', IMPERSONATED_EMAIL)): OracleServiceAccount {
  return { kind: 'application-default', project_id: 'oracle-project', credential, client_email: IMPERSONATED_EMAIL };
}

function keyAccount(): OracleServiceAccount {
  return { kind: 'key-file', key, project_id: key.project_id, credential: fakeCredential('key-token') };
}

function verifiesWithKey(data: Buffer | string, signature: Buffer): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(data);
  return verifier.verify(publicKey, signature);
}

describe('selectOracleCredentialSource', () => {
  it('selects the key file when PYRIC_ORACLE_SA_PATH is set, resolved from the working directory', () => {
    expect(selectOracleCredentialSource({ PYRIC_ORACLE_SA_PATH: 'secrets/oracle.json' }, ORACLE_VARIABLES, '/work'))
      .toEqual({ kind: 'key-file', path: '/work/secrets/oracle.json' });
    expect(selectOracleCredentialSource({ PYRIC_ORACLE_SA_PATH: '/abs/oracle.json' }, ORACLE_VARIABLES, '/work'))
      .toEqual({ kind: 'key-file', path: '/abs/oracle.json' });
  });

  it('selects Application Default Credentials when PYRIC_ORACLE_SA_PATH is unset or empty', () => {
    expect(selectOracleCredentialSource({})).toEqual({ kind: 'application-default' });
    expect(selectOracleCredentialSource({ PYRIC_ORACLE_SA_PATH: '' })).toEqual({ kind: 'application-default' });
  });

  it('prefers the key file even when a project is also named', () => {
    const env = { PYRIC_ORACLE_SA_PATH: '/k.json', PYRIC_ORACLE_PROJECT_ID: 'oracle-project' };
    expect(selectOracleCredentialSource(env).kind).toBe('key-file');
  });

  it('reads the secondary variables for the secondary project', () => {
    const env = { PYRIC_ORACLE_SA_PATH: '/primary.json', PYRIC_SECONDARY_ORACLE_SA_PATH: '/secondary.json' };
    expect(selectOracleCredentialSource(env, SECONDARY_ORACLE_VARIABLES))
      .toEqual({ kind: 'key-file', path: '/secondary.json' });
    expect(selectOracleCredentialSource({ PYRIC_ORACLE_SA_PATH: '/primary.json' }, SECONDARY_ORACLE_VARIABLES))
      .toEqual({ kind: 'application-default' });
  });
});

describe('oracleCredentialConfigured', () => {
  it('is true for a key file or an ADC project, and false for neither', () => {
    expect(oracleCredentialConfigured({ PYRIC_ORACLE_SA_PATH: '/k.json' })).toBe(true);
    expect(oracleCredentialConfigured({ PYRIC_ORACLE_PROJECT_ID: 'oracle-project' })).toBe(true);
    expect(oracleCredentialConfigured({})).toBe(false);
    expect(oracleCredentialConfigured({ GOOGLE_APPLICATION_CREDENTIALS: '/adc.json' })).toBe(false);
  });

  it('checks only the variables it is given', () => {
    expect(oracleCredentialConfigured({ PYRIC_ORACLE_PROJECT_ID: 'p' }, SECONDARY_ORACLE_VARIABLES)).toBe(false);
    expect(oracleCredentialConfigured({ PYRIC_SECONDARY_ORACLE_PROJECT_ID: 'p2' }, SECONDARY_ORACLE_VARIABLES)).toBe(true);
  });
});

describe('applicationDefaultProject', () => {
  it('reads the project variable', () => {
    expect(applicationDefaultProject({ PYRIC_ORACLE_PROJECT_ID: 'oracle-project' })).toBe('oracle-project');
  });

  it('refuses to guess a project, naming the variable to set', () => {
    expect(() => applicationDefaultProject({})).toThrow(/PYRIC_ORACLE_PROJECT_ID/);
    expect(() => applicationDefaultProject({}, SECONDARY_ORACLE_VARIABLES)).toThrow(/PYRIC_SECONDARY_ORACLE_PROJECT_ID/);
  });
});

describe('loadOracleServiceAccount', () => {
  it('builds a cert credential from the key file and takes the project from the key', async () => {
    const { deps, recorded } = fakeDeps({ '/k.json': JSON.stringify(key) });
    const sa = await loadOracleServiceAccount({ PYRIC_ORACLE_SA_PATH: '/k.json', PYRIC_ORACLE_PROJECT_ID: 'ignored' }, ORACLE_VARIABLES, deps);
    expect(sa.kind).toBe('key-file');
    expect(sa.project_id).toBe('key-project');
    expect(recorded.readPaths).toEqual(['/k.json']);
    expect(recorded.certKeys).toEqual([key]);
    expect(recorded.adcCalls).toBe(0);
    expect(recorded.logs).toEqual([`[oracle] credential: key file for ${key.client_email}, project key-project`]);
  });

  it('uses Application Default Credentials and the project variable when no key file is named', async () => {
    const { deps, recorded } = fakeDeps();
    const sa = await loadOracleServiceAccount(ADC_ENV, ORACLE_VARIABLES, deps);
    expect(sa.kind).toBe('application-default');
    expect(sa.project_id).toBe('oracle-project');
    expect(oracleServiceAccountEmail(sa)).toBe(IMPERSONATED_EMAIL);
    expect(recorded.adcCalls).toBe(1);
    expect(recorded.readPaths).toEqual([]);
    expect(recorded.certKeys).toEqual([]);
    expect(recorded.warnings).toEqual([]);
  });

  it('logs the account ADC acts as, at load time', async () => {
    const { deps, recorded } = fakeDeps();
    await loadOracleServiceAccount(ADC_ENV, ORACLE_VARIABLES, deps);
    expect(recorded.logs).toEqual([
      `[oracle] credential: Application Default Credentials for ${IMPERSONATED_EMAIL}, project oracle-project`,
    ]);
  });

  it('fails before building any credential when ADC has no project', async () => {
    const { deps, recorded } = fakeDeps();
    await expect(loadOracleServiceAccount({}, ORACLE_VARIABLES, deps)).rejects.toThrow(/PYRIC_ORACLE_PROJECT_ID/);
    expect(recorded.adcCalls).toBe(0);
  });

  it('refuses a plain user ADC login, which names no service account', async () => {
    for (const credential of [fakeCredential('adc-token'), fakeCredential('adc-token', ''), credentialThatCannotNameItsAccount()]) {
      const { deps, recorded } = fakeDeps({}, credential);
      await expect(loadOracleServiceAccount(ADC_ENV, ORACLE_VARIABLES, deps)).rejects.toThrow(/impersonate-service-account/);
      expect(recorded.logs).toEqual([]);
    }
  });

  it('refuses a service account from another project', async () => {
    const { deps, recorded } = fakeDeps({}, fakeCredential('adc-token', 'stale@other-project.iam.gserviceaccount.com'));
    await expect(loadOracleServiceAccount(ADC_ENV, ORACLE_VARIABLES, deps))
      .rejects.toThrow(/stale@other-project\.iam\.gserviceaccount\.com, which belongs to project other-project, but PYRIC_ORACLE_PROJECT_ID is oracle-project/);
    expect(recorded.logs).toEqual([]);
  });

  it('refuses a service account whose email does not name its project', async () => {
    const { deps } = fakeDeps({}, fakeCredential('adc-token', '123-compute@developer.gserviceaccount.com'));
    await expect(loadOracleServiceAccount(ADC_ENV, ORACLE_VARIABLES, deps)).rejects.toThrow(/does not name its project/);
  });

  it('warns when GOOGLE_APPLICATION_CREDENTIALS replaces the gcloud login', async () => {
    const { deps, recorded } = fakeDeps();
    await loadOracleServiceAccount({ ...ADC_ENV, GOOGLE_APPLICATION_CREDENTIALS: '/old/key.json' }, ORACLE_VARIABLES, deps);
    expect(recorded.warnings).toHaveLength(1);
    expect(recorded.warnings[0]).toContain('GOOGLE_APPLICATION_CREDENTIALS is set');
    expect(recorded.warnings[0]).toContain('/old/key.json');
  });

  it('still refuses the wrong account when GOOGLE_APPLICATION_CREDENTIALS names it', async () => {
    const { deps, recorded } = fakeDeps({}, fakeCredential('adc-token', 'key@other-project.iam.gserviceaccount.com'));
    const env = { ...ADC_ENV, GOOGLE_APPLICATION_CREDENTIALS: '/old/key.json' };
    await expect(loadOracleServiceAccount(env, ORACLE_VARIABLES, deps)).rejects.toThrow(/belongs to project other-project/);
    expect(recorded.warnings).toHaveLength(1);
  });

  it('does not warn about GOOGLE_APPLICATION_CREDENTIALS when a key file is named', async () => {
    const { deps, recorded } = fakeDeps({ '/k.json': JSON.stringify(key) });
    await loadOracleServiceAccount({ PYRIC_ORACLE_SA_PATH: '/k.json', GOOGLE_APPLICATION_CREDENTIALS: '/adc.json' }, ORACLE_VARIABLES, deps);
    expect(recorded.warnings).toEqual([]);
  });

  it('surfaces a missing key file rather than falling back to ADC', async () => {
    const { deps, recorded } = fakeDeps();
    await expect(loadOracleServiceAccount({ PYRIC_ORACLE_SA_PATH: '/missing.json' }, ORACLE_VARIABLES, deps)).rejects.toThrow(/ENOENT/);
    expect(recorded.adcCalls).toBe(0);
  });

  it('names the lookup failure when ADC cannot name its account', async () => {
    const { deps } = fakeDeps({}, credentialThatCannotNameItsAccount());
    await expect(loadOracleServiceAccount(ADC_ENV, ORACLE_VARIABLES, deps))
      .rejects.toThrow(/The lookup failed: Could not load the default credentials/);
  });

  it('reaches the secondary project with the oracle account, which lives in the oracle project', async () => {
    const env = { PYRIC_ORACLE_PROJECT_ID: 'oracle-project', PYRIC_SECONDARY_ORACLE_PROJECT_ID: 'secondary-project' };
    const { deps, recorded } = fakeDeps();
    const sa = await loadOracleServiceAccount(env, SECONDARY_ORACLE_VARIABLES, deps);
    expect(sa.project_id).toBe('secondary-project');
    expect(oracleServiceAccountEmail(sa)).toBe(IMPERSONATED_EMAIL);
    expect(recorded.logs).toEqual([
      `[oracle] credential: Application Default Credentials for ${IMPERSONATED_EMAIL}, project secondary-project`,
    ]);
  });

  it('still refuses a secondary credential that names no service account', async () => {
    const env = { PYRIC_SECONDARY_ORACLE_PROJECT_ID: 'secondary-project' };
    const { deps, recorded } = fakeDeps({}, fakeCredential('adc-token'));
    await expect(loadOracleServiceAccount(env, SECONDARY_ORACLE_VARIABLES, deps)).rejects.toThrow(/name no service account/);
    expect(recorded.logs).toEqual([]);
  });
});

describe('serviceAccountProject', () => {
  it('reads the project from IAM and App Engine service account emails', () => {
    expect(serviceAccountProject('firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com')).toBe('digame-mas');
    expect(serviceAccountProject('digame-mas@appspot.gserviceaccount.com')).toBe('digame-mas');
  });

  it('returns null for emails that do not name a project', () => {
    expect(serviceAccountProject('123-compute@developer.gserviceaccount.com')).toBeNull();
    expect(serviceAccountProject('someone@example.com')).toBeNull();
  });
});

describe('oracleAppOptions and describeOracleCredential', () => {
  it('passes the credential, the project, and under ADC the signing account to firebase-admin', () => {
    const sa = adcAccount();
    expect(oracleAppOptions(sa)).toEqual({ credential: sa.credential, projectId: 'oracle-project', serviceAccountId: IMPERSONATED_EMAIL });
    const keyed = keyAccount();
    expect(oracleAppOptions(keyed)).toEqual({ credential: keyed.credential, projectId: 'key-project' });
  });

  it('names the source and the account without exposing the key', () => {
    expect(describeOracleCredential(adcAccount())).toBe(`Application Default Credentials for ${IMPERSONATED_EMAIL}`);
    const described = describeOracleCredential(keyAccount());
    expect(described).toBe(`key file for ${key.client_email}`);
    expect(described).not.toContain('PRIVATE KEY');
  });
});

describe('oracleAccessToken under ADC', () => {
  it('returns the firebase-admin credential token', async () => {
    expect(await oracleAccessToken(adcAccount(), 'https://www.googleapis.com/auth/firebase')).toBe('adc-token');
  });
});

describe('oracleServiceAccountEmail', () => {
  it('reads the key email from a key file and the checked account under ADC', () => {
    expect(oracleServiceAccountEmail(keyAccount())).toBe(key.client_email);
    expect(oracleServiceAccountEmail(adcAccount())).toBe(IMPERSONATED_EMAIL);
  });
});

interface SignBlobCall {
  url: string;
  authorization: string | null;
  payload: string;
}

function fakeSignBlob(signedBlob: Buffer, status = 200): { fetchImpl: typeof fetch; calls: SignBlobCall[] } {
  const calls: SignBlobCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { payload: string };
    calls.push({ url: String(input), authorization: headers.get('Authorization'), payload: body.payload });
    const responseBody = status === 200 ? JSON.stringify({ signedBlob: signedBlob.toString('base64') }) : 'denied';
    return new Response(responseBody, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('oracleSignBlob', () => {
  it('signs locally with a key file and never calls the network', async () => {
    const { fetchImpl, calls } = fakeSignBlob(Buffer.alloc(0));
    const bytes = Buffer.from('header.payload');
    const signature = await oracleSignBlob(keyAccount(), bytes, fetchImpl);
    expect(verifiesWithKey(bytes, signature)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('signs through IAM Credentials signBlob as the impersonated account under ADC', async () => {
    const signed = Buffer.from('signature-bytes');
    const { fetchImpl, calls } = fakeSignBlob(signed);
    const bytes = Buffer.from('header.payload');
    const signature = await oracleSignBlob(adcAccount(), bytes, fetchImpl);
    expect(signature.equals(signed)).toBe(true);
    expect(calls).toEqual([{
      url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(IMPERSONATED_EMAIL)}:signBlob`,
      authorization: 'Bearer adc-token',
      payload: bytes.toString('base64'),
    }]);
  });

  it('fails with the status when signBlob is refused', async () => {
    const { fetchImpl } = fakeSignBlob(Buffer.alloc(0), 403);
    await expect(oracleSignBlob(adcAccount(), Buffer.from('x'), fetchImpl)).rejects.toThrow(/signBlob failed: 403/);
  });
});

describe('signOracleJwt', () => {
  it('produces an RS256 JWT whose signature covers the header and payload', async () => {
    const jwt = await signOracleJwt(keyAccount(), { uid: 'u1', iat: 1 });
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ uid: 'u1', iat: 1 });
    expect(verifiesWithKey(`${header}.${payload}`, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('sends the unsigned token to signBlob under ADC', async () => {
    const { fetchImpl, calls } = fakeSignBlob(Buffer.from('sig'));
    const jwt = await signOracleJwt(adcAccount(), { uid: 'u1' }, fetchImpl);
    const [header, payload, signature] = jwt.split('.');
    expect(Buffer.from(calls[0]!.payload, 'base64').toString()).toBe(`${header}.${payload}`);
    expect(Buffer.from(signature!, 'base64url').toString()).toBe('sig');
  });
});
