import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { LiveCallRecord, LiveObserver } from '../../src/observe.js';
import { isAdminMethodGated, runInsideAdminCall, type AdminRow } from '../../src/admin/patch.js';
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

function errorCodeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err: unknown) {
    return (err as { code?: string })?.code;
  }
}

class BucketQueryOpts {
  readonly project: string;
  constructor(project: string) {
    this.project = project;
  }
}

class GetterUserProjectOpts {
  readonly #project: string;
  constructor(project: string) {
    this.#project = project;
  }
  get userProject(): string {
    return this.#project;
  }
}

class UriRequestOpts {
  readonly uri: string;
  constructor(uri: string) {
    this.uri = uri;
  }
}

describe('storage-gates', () => {
  const observer: LiveObserver = Object.assign(
    (_record: LiveCallRecord) => undefined,
    { client: 'node' as const, hostProjectId: HOST_PROJECT },
  );

  it('extracts HmacKey project ids, userProject settings, and cross-project option, URI, and bucket refusals', () => {
    expect(hmacKeyProjectOf({ baseUrl: '/projects/org-beta/hmacKeys' })).toBe('org-beta');
    expect(hmacKeyProjectOf({ baseUrl: '/projects/{{projectId}}/hmacKeys' })).toBeUndefined();
    expect(hmacKeyProjectOf({ projectId: 'org-gamma' })).toBe('org-gamma');

    expect(userProjectOf({ userProject: 'org-beta' }, undefined)).toBe('org-beta');
    expect(userProjectOf({}, { userProject: 'org-gamma' })).toBe('org-gamma');

    expect(bucketProjectRefusal('Bucket.getFiles', `${HOST_PROJECT}.appspot.com`, observer)).toBeNull();
    expect(bucketProjectRefusal('Bucket.getFiles', 'org-beta.appspot.com', observer)).toMatchObject({
      code: 'PYRIC_LIVE_REFUSED',
    });

    // Allowed positive controls: host project, unresolved {{projectId}} placeholder, and object paths containing /projects/.
    const safeOpts: readonly unknown[] = [
      { project: HOST_PROJECT },
      { project: '{{projectId}}' },
      new BucketQueryOpts(HOST_PROJECT),
      { uri: `https://storage.googleapis.com/storage/v1/projects/${HOST_PROJECT}/hmacKeys` },
      { uri: 'https://storage.googleapis.com/storage/v1/projects/{{projectId}}/hmacKeys' },
      { uri: `https://storage.googleapis.com/storage/v1/b?project=${HOST_PROJECT}` },
      { uri: 'https://storage.googleapis.com/storage/v1/b?project={{projectId}}' },
      { uri: `https://storage.googleapis.com/storage/v1/b/${HOST_PROJECT}.appspot.com/o/projects%2Forg-beta%2Ffile.txt` },
      { uri: `https://storage.googleapis.com/storage/v1/b/${HOST_PROJECT}.appspot.com/o/projects/org-beta/file.txt` },
      { uri: `https://storage.googleapis.com/storage/v1/b/${HOST_PROJECT}.appspot.com/o?prefix=projects/org-beta/` },
      Buffer.from('projects/org-beta/hmacKeys'),
      new Date(),
    ];
    for (const okOpt of safeOpts) {
      expect(() => assertStorageCallOptionsAllowed('Storage.request', [okOpt], observer)).not.toThrow();
    }

    const cyclicHost: Record<string, unknown> = { project: HOST_PROJECT };
    cyclicHost.request = cyclicHost;
    expect(() => assertStorageCallOptionsAllowed('Storage.request', [cyclicHost], observer)).not.toThrow();

    // Refused option objects (plain, non-plain class, prototype getter, Object.create, URLSearchParams, Map, headers, URIs).
    const refusedOpts: readonly unknown[] = [
      { project: 'org-beta' },
      { projectId: 'org-beta' },
      { userProject: 'org-beta' },
      new BucketQueryOpts('org-beta'),
      new GetterUserProjectOpts('org-beta'),
      Object.create({ projectId: 'org-beta' }),
      { qs: new BucketQueryOpts('org-beta') },
      { qs: new URLSearchParams({ project: 'org-beta' }) },
      { qs: new Map([['userProject', 'org-beta']]) },
      { qs: { project: [HOST_PROJECT, 'org-beta'] } },
      { request: new BucketQueryOpts('org-beta') },
      { headers: { 'X-Goog-User-Project': 'org-beta' } },
      { headers: new Headers({ 'x-goog-user-project': 'org-beta' }) },
      { uri: 'https://storage.googleapis.com/storage/v1/projects/org-beta/hmacKeys' },
      { uri: '/projects/org-beta/hmacKeys' },
      { uri: 'https://storage.googleapis.com/storage/v1/projects/org-beta:list' },
      { uri: 'https://storage.googleapis.com/storage/v1/b?project=org-beta' },
      { uri: `https://storage.googleapis.com/storage/v1/b?project=${HOST_PROJECT}&project=org-beta` },
      { uri: `https://storage.googleapis.com/storage/v1/b/${HOST_PROJECT}.appspot.com/o?userProject=org-beta` },
      { uri: 'https://storage.googleapis.com/storage/v1/b?projectId=org-beta' },
      { uri: '/b/org-beta.appspot.com/o' },
      { uri: `https://storage.googleapis.com/storage/v1/b/${HOST_PROJECT}.appspot.com/o/a/rewriteTo/b/org-beta.appspot.com/o/b` },
      { uri: 'https://org-beta.appspot.com.storage.googleapis.com/doc.txt' },
      { uri: 'gs://org-beta.appspot.com/doc.txt' },
      { uri: `https://storage.googleapis.com/storage/v1/b/${HOST_PROJECT}.appspot.com/o/a/../../../../projects/org-beta/hmacKeys` },
      { url: new URL('https://storage.googleapis.com/storage/v1/b?project=org-beta') },
      new UriRequestOpts('https://storage.googleapis.com/storage/v1/projects/org-beta/hmacKeys'),
    ];
    for (const badOpt of refusedOpts) {
      expect(
        errorCodeOf(() => assertStorageCallOptionsAllowed('Storage.request', [badOpt], observer)),
      ).toBe('PYRIC_LIVE_REFUSED');
    }
  });

  it('gates setUserProject, per-call Storage options, and makeAuthenticatedRequest including reentrant stream and onAuthenticated calls', async () => {
    let realRequestCalls = 0;

    class FakeService {
      readonly projectId: string;
      declare makeAuthenticatedRequest: (
        reqOpts: { uri: string; qs?: unknown },
        cbOrOpts?:
          | ((err: unknown, body?: unknown) => void)
          | { onAuthenticated: (err: unknown, reqOpts?: unknown) => void },
      ) => unknown;
      constructor(projectId: string) {
        this.projectId = projectId;
        this.makeAuthenticatedRequest = (reqOpts, cbOrOpts) => {
          realRequestCalls += 1;
          if (typeof cbOrOpts === 'function') {
            cbOrOpts(null, { downloadTokens: 't1' });
            return { abort() {} };
          }
          if (cbOrOpts !== undefined && typeof cbOrOpts.onAuthenticated === 'function') {
            cbOrOpts.onAuthenticated(null, reqOpts);
            return { abort() {} };
          }
          const out = new PassThrough();
          out.end('ok');
          return out;
        };
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
      async getFiles(_opts?: unknown): Promise<[unknown[]]> {
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

    expect(errorCodeOf(() => hostBucket.setUserProject('org-beta'))).toBe('PYRIC_LIVE_REFUSED');
    expect(hostBucket.userProject).toBe(HOST_PROJECT);

    const optErr = await hostBucket
      .getFiles({ userProject: 'org-beta' })
      .catch((err: unknown) => (err as { code?: string }).code);
    expect(optErr).toBe('PYRIC_LIVE_REFUSED');

    const nonPlainOptErr = await hostBucket
      .getFiles(new GetterUserProjectOpts('org-beta'))
      .catch((err: unknown) => (err as { code?: string }).code);
    expect(nonPlainOptErr).toBe('PYRIC_LIVE_REFUSED');

    const hostSvc = new FakeService(HOST_PROJECT);
    expect(isAdminMethodGated(hostSvc.makeAuthenticatedRequest)).toBe(true);

    const crossUriErr = await new Promise<unknown>((resolve) => {
      hostSvc.makeAuthenticatedRequest({ uri: 'http://127.0.0.1/v0/b/org-beta.appspot.com/o/doc.txt' }, (err) =>
        resolve(err),
      );
    });
    expect((crossUriErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    const crossProjectPathErr = await new Promise<unknown>((resolve) => {
      hostSvc.makeAuthenticatedRequest({ uri: 'http://127.0.0.1/storage/v1/projects/org-beta/hmacKeys' }, (err) =>
        resolve(err),
      );
    });
    expect((crossProjectPathErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    const crossQueryErr = await new Promise<unknown>((resolve) => {
      hostSvc.makeAuthenticatedRequest({ uri: 'http://127.0.0.1/storage/v1/b?project=org-beta' }, (err) =>
        resolve(err),
      );
    });
    expect((crossQueryErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    // Reentrant calls inside runInsideAdminCall (matching Service.requestStream / Service.request)
    // must STILL validate URI and options across stream, callback, and onAuthenticated modes.
    const reentrantStreamErr = await new Promise<unknown>((resolve) => {
      const stream = runInsideAdminCall(() =>
        hostSvc.makeAuthenticatedRequest({ uri: 'http://127.0.0.1/storage/v1/b/org-beta.appspot.com/o' }),
      ) as PassThrough;
      stream.once('error', resolve);
      stream.once('end', () => resolve(null));
      stream.resume();
    });
    expect((reentrantStreamErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    const reentrantCbErr = await new Promise<unknown>((resolve) => {
      runInsideAdminCall(() =>
        hostSvc.makeAuthenticatedRequest({ uri: 'http://127.0.0.1/storage/v1/projects/org-beta/hmacKeys' }, (err) =>
          resolve(err),
        ),
      );
    });
    expect((reentrantCbErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    const reentrantOnAuthErr = await new Promise<unknown>((resolve) => {
      runInsideAdminCall(() =>
        hostSvc.makeAuthenticatedRequest(
          { uri: 'http://127.0.0.1/storage/v1/b?project=org-beta' },
          { onAuthenticated: (err) => resolve(err) },
        ),
      );
    });
    expect((reentrantOnAuthErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    expect(realRequestCalls).toBe(0);

    // Positive control: host-project reentrant stream call reaches the underlying method cleanly.
    const hostChunk = await new Promise<string>((resolve, reject) => {
      const stream = runInsideAdminCall(() =>
        hostSvc.makeAuthenticatedRequest({ uri: `http://127.0.0.1/storage/v1/b/${HOST_PROJECT}.appspot.com/o` }),
      ) as PassThrough;
      let data = '';
      stream.on('data', (chunk: Buffer | string) => {
        data += String(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(data));
    });
    expect(hostChunk).toBe('ok');
    expect(realRequestCalls).toBe(1);
  });
});
