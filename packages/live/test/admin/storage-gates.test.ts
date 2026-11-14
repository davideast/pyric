import { describe, expect, it } from 'bun:test';
import type { LiveCallRecord, LiveObserver } from '../../src/observe.js';
import { isAdminMethodGated, type AdminRow } from '../../src/admin/patch.js';
import { adminProjectGate, type AdminApp } from '../../src/admin/project-gate.js';
import {
  assertStorageCallOptionsAllowed,
  bucketProjectRefusal,
  gateMakeAuthenticatedRequest,
  hmacKeyProjectOf,
  patchSetUserProject,
  patchStorageCallChecks,
  userProjectOf,
} from '../../src/admin/storage-gates.js';

const HOST_PROJECT = 'org-alpha';

describe('storage-gates', () => {
  const observer: LiveObserver = Object.assign(
    (_record: LiveCallRecord) => undefined,
    { client: 'node' as const, hostProjectId: HOST_PROJECT },
  );

  it('extracts HmacKey project ids, userProject settings, and cross-project option/bucket refusals', () => {
    expect(hmacKeyProjectOf({ baseUrl: '/projects/org-beta/hmacKeys' })).toBe('org-beta');
    expect(hmacKeyProjectOf({ baseUrl: '/projects/{{projectId}}/hmacKeys' })).toBeUndefined();
    expect(hmacKeyProjectOf({ projectId: 'org-gamma' })).toBe('org-gamma');

    expect(userProjectOf({ userProject: 'org-beta' }, undefined)).toBe('org-beta');
    expect(userProjectOf({}, { userProject: 'org-gamma' })).toBe('org-gamma');

    expect(bucketProjectRefusal('Bucket.getFiles', `${HOST_PROJECT}.appspot.com`, observer)).toBeNull();
    expect(bucketProjectRefusal('Bucket.getFiles', 'org-beta.appspot.com', observer)).toMatchObject({
      code: 'PYRIC_LIVE_REFUSED',
    });

    expect(() =>
      assertStorageCallOptionsAllowed('Storage.getBuckets', [{ project: HOST_PROJECT }], observer),
    ).not.toThrow();

    for (const badOpt of [{ project: 'org-beta' }, { projectId: 'org-beta' }, { userProject: 'org-beta' }]) {
      let caught: unknown;
      try {
        assertStorageCallOptionsAllowed('Storage.getBuckets', [badOpt], observer);
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');
    }
  });

  it('gates setUserProject, per-call Storage options, and makeAuthenticatedRequest', async () => {
    class FakeService {
      readonly projectId: string;
      declare makeAuthenticatedRequest: (
        reqOpts: { uri: string },
        cb: (err: unknown, body?: unknown) => void,
      ) => void;
      constructor(projectId: string) {
        this.projectId = projectId;
        this.makeAuthenticatedRequest = (_reqOpts, cb) => cb(null, { downloadTokens: 't1' });
      }
    }

    class FakeBucket {
      readonly name: string;
      readonly projectId: string;
      userProject?: string;
      constructor(name: string, projectId: string) {
        this.name = name;
        this.projectId = projectId;
      }
      setUserProject(project: string): void {
        this.userProject = project;
      }
      async getFiles(_opts?: { userProject?: string }): Promise<[unknown[]]> {
        return [[]];
      }
    }

    const gate = adminProjectGate(HOST_PROJECT, () => undefined, {});
    const appOf = (self: unknown): AdminApp => ({ options: { projectId: (self as { projectId: string }).projectId } });
    const row: AdminRow = { module: '@google-cloud/storage', observer, gate, appOf };

    gateMakeAuthenticatedRequest(FakeService.prototype, gate, appOf, observer);
    patchSetUserProject(FakeBucket.prototype, observer, (self) => (self as FakeBucket).projectId);
    patchStorageCallChecks(FakeBucket.prototype, 'Bucket', ['getFiles'], new Set(), row, () => false, () => undefined);

    expect(isAdminMethodGated(FakeBucket.prototype.setUserProject)).toBe(true);
    expect(isAdminMethodGated(FakeBucket.prototype.getFiles)).toBe(true);

    const hostBucket = new FakeBucket(`${HOST_PROJECT}.appspot.com`, HOST_PROJECT);
    hostBucket.setUserProject(HOST_PROJECT);
    expect(hostBucket.userProject).toBe(HOST_PROJECT);

    let setErr: unknown;
    try {
      hostBucket.setUserProject('org-beta');
    } catch (err) {
      setErr = err;
    }
    expect((setErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');
    expect(hostBucket.userProject).toBe(HOST_PROJECT);

    const optErr = await hostBucket
      .getFiles({ userProject: 'org-beta' })
      .catch((err: unknown) => (err as { code?: string }).code);
    expect(optErr).toBe('PYRIC_LIVE_REFUSED');

    const hostSvc = new FakeService(HOST_PROJECT);
    expect(isAdminMethodGated(hostSvc.makeAuthenticatedRequest)).toBe(true);
    const crossUriErr = await new Promise<unknown>((resolve) => {
      hostSvc.makeAuthenticatedRequest({ uri: 'http://127.0.0.1/v0/b/org-beta.appspot.com/o/doc.txt' }, (err) =>
        resolve(err),
      );
    });
    expect((crossUriErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');
  });
});
