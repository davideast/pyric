/**
 * The storage control plane's production boundary, proved at the seam rather
 * than described.
 *
 * The client that talks to Google is built by one function, so a test that
 * counts how many times it is built can assert the thing that matters: no run
 * without the flag, without a confirmation, and without credentials ever
 * builds one. Nothing here makes a network call, and the counted double is
 * what stands in for the client when one is legitimately built.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import type {
  InspectStorageResult,
  ProvisionStorageInput,
  ProvisionStorageOutcome,
} from 'pyric/storage';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import {
  isMissingStorageCredentials,
  storageAdminCredentials,
  STORAGE_ADMIN_CREDENTIAL_SOURCES,
  useStorageAdminClient,
  type StorageAdminClient,
} from '../../../src/bridge/surface/storage-admin.js';

/** An environment with none of the three credential sources set. */
const NO_CREDENTIALS: NodeJS.ProcessEnv = {};

/** What one counted double recorded. */
interface Counted {
  built: number;
  provisioned: ProvisionStorageInput[];
  restore: () => void;
}

const STATUS: InspectStorageResult = {
  serviceState: 'enabled',
  defaultLocation: 'us-central',
  buckets: [{ name: 'projects/demo-project/buckets/demo', bucketId: 'demo' }],
};

const PROVISIONED: ProvisionStorageOutcome = {
  success: true,
  serviceEnabled: true,
  locationFinalized: false,
  locationId: 'us-central',
  bucketCreated: true,
  bucketId: 'demo-project.firebasestorage.app',
  rulesDeployed: false,
  corsApplied: false,
};

/** Replace the client builder with a double that counts, and answers success. */
function countClient(): Counted {
  const counted: Counted = { built: 0, provisioned: [], restore: () => undefined };
  counted.restore = useStorageAdminClient((): StorageAdminClient => {
    counted.built += 1;
    return {
      async status() {
        return STATUS;
      },
      async provision(_scope, input) {
        counted.provisioned.push(input);
        return PROVISIONED;
      },
    };
  });
  return counted;
}

let counted: Counted | null = null;

afterEach(() => {
  counted?.restore();
  counted = null;
  delete process.env.FIREBASE_SA_BASE64;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.PYRIC_PROJECT;
});

/** The service-account environment one legitimate run is given. */
function grantCredentials(): void {
  process.env.FIREBASE_SA_BASE64 = Buffer.from(
    JSON.stringify({
      type: 'service_account',
      project_id: 'demo-project',
      client_email: 'tester@demo-project.iam.gserviceaccount.com',
      private_key: 'unused-by-the-double',
    }),
  ).toString('base64');
}

function storageTool(allowProduction: boolean) {
  const surface = renderSurface('sdk-service', { allowProduction });
  const tool = surface.tools.find((candidate) => candidate.name === 'storage');
  if (tool === undefined) throw new Error('the sdk-service surface renders no storage tool');
  const ctx = createSurfaceContext(initializeSandbox(), process.cwd());
  return (method: string, args: Record<string, unknown>) => tool.execute({ method, args }, ctx);
}

describe('credential discovery', () => {
  it('names the three sources it reads when none of them is set', async () => {
    const found = await storageAdminCredentials({ env: NO_CREDENTIALS });
    if (!isMissingStorageCredentials(found)) {
      throw new Error('credentials were found in an empty environment');
    }
    expect(found.missing).toContain(STORAGE_ADMIN_CREDENTIAL_SOURCES);
    expect(found.sources).toEqual([
      'FIREBASE_SA_BASE64',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'PYRIC_PROJECT',
    ]);
    expect(found.missing).toContain('Application Default Credentials');
  });
});

describe.each([
  ['status', {} as Record<string, unknown>],
  ['provision', { bucket: 'demo-project.firebasestorage.app' } as Record<string, unknown>],
])('%s builds no client until all three are true', (method, args) => {
  it('refuses without the flag, and builds nothing', async () => {
    counted = countClient();
    const refused = await storageTool(false)(method, { ...args, confirm: true });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('--allow-production');
    expect(counted.built).toBe(0);
  });

  it('refuses with the flag and no confirmation, and builds nothing', async () => {
    counted = countClient();
    const refused = await storageTool(true)(method, args);
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('confirm: true');
    expect(counted.built).toBe(0);
  });

  it('refuses with the flag and a confirmation but no credentials, and builds nothing', async () => {
    counted = countClient();
    const refused = await storageTool(true)(method, { ...args, confirm: true });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('FIREBASE_SA_BASE64');
    expect(counted.built).toBe(0);
  });
});

describe('once all three are true', () => {
  it('reports the project the status came back for', async () => {
    counted = countClient();
    grantCredentials();
    const answered = await storageTool(true)('status', { confirm: true });
    expect(counted.built).toBe(1);
    expect(answered.ok).toBe(true);
    const data = answered.data as { project: string; serviceState: string; buckets: unknown[] };
    expect(data.project).toBe('demo-project');
    expect(data.serviceState).toBe('enabled');
    expect(data.buckets).toHaveLength(1);
  });

  it('hands the named bucket to the client and reports what it provisioned', async () => {
    counted = countClient();
    grantCredentials();
    const answered = await storageTool(true)('provision', {
      bucket: 'demo-project.firebasestorage.app',
      confirm: true,
    });
    expect(counted.built).toBe(1);
    expect(counted.provisioned[0]).toEqual({ bucketId: 'demo-project.firebasestorage.app' });
    expect(answered.ok).toBe(true);
    expect((answered.data as { bucket: string }).bucket).toBe(
      'demo-project.firebasestorage.app',
    );
  });

  it('leaves the bucket to the project default when the call names none', async () => {
    counted = countClient();
    grantCredentials();
    const answered = await storageTool(true)('provision', { confirm: true });
    expect(counted.provisioned[0]).toEqual({});
    expect(answered.ok).toBe(true);
  });

  it('reports a refusal from Google as a failure, with its code', async () => {
    counted = countClient();
    counted.restore();
    counted.restore = useStorageAdminClient(
      (): StorageAdminClient => ({
        async status() {
          return STATUS;
        },
        async provision() {
          return {
            success: false,
            error: {
              code: 'PERMISSION_DENIED',
              message: 'the caller lacks serviceusage.services.enable',
              recoverable: false,
            },
          };
        },
      }),
    );
    grantCredentials();
    const refused = await storageTool(true)('provision', { confirm: true });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('serviceusage.services.enable');
    expect((refused.data as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});
