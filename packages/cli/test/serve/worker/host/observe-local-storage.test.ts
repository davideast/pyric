import { describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox, type ObservedCall } from 'pyric/sandbox';
import { getStorageSandbox } from 'pyric/storage';
import type { HostCtx } from '../../../../src/serve/worker/host.js';
import { storageVerdict } from '../../../../src/serve/worker/host/observe-local-storage.js';

const BUCKET = 'proj-1.appspot.com';
const DENIED: ObservedCall['outcome'] = { status: 'error', code: 'storage/unauthorized' };
const OK: ObservedCall['outcome'] = { status: 'ok' };

function makeStorageHost(rules: string): { sandbox: ReturnType<typeof initializeSandbox>; ctx: HostCtx } {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, {
    dbName: `pyric-obs-storage-${crypto.randomUUID()}`,
    rules,
  });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'storage-obs-test',
    subs: new Map(),
    appOptions: { projectId: 'proj-1', storageBucket: BUCKET },
  };
  return { sandbox, ctx };
}

describe('observe-local-storage uncaptured fields, oversized metadata, and same-line allows', () => {
  it('abstains with needs: ["write-data"] when create or update rules inspect uncaptured request.resource hash or storageClass fields', () => {
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function helperReadsCrc(req) {
      let res = req.resource;
      return !('crc32c' in res);
    }
    match /items/{id} {
      allow create: if !('md5Hash' in request.resource);
    }
    match /crc/{id} {
      allow create: if helperReadsCrc(request);
    }
    match /sclass/{id} {
      allow create: if request.resource.get('storageClass', 'STANDARD') == 'STANDARD';
    }
    match /wrapped/{id} {
      allow create: if {'r': request.resource}.r['md5Hash'] == 'abc';
    }
    match /etagCreate/{id} {
      allow create: if request.resource.etag == null && request.resource.size < 100;
    }
    match /etagUpdate/{id} {
      allow update: if !('etag' in request.resource);
    }
  }
}`;
    const { sandbox, ctx } = makeStorageHost(rules);
    try {
      for (const path of ['items/item-1', 'crc/item-1', 'sclass/item-1', 'wrapped/item-1']) {
        const verdict = storageVerdict(
          ctx,
          {
            service: 'storage',
            method: 'uploadBytes',
            bucket: BUCKET,
            path,
            at: 100,
            outcome: DENIED,
            writeData: { size: 12, contentType: 'text/plain' },
          },
          'create',
        );
        expect(verdict).toMatchObject({
          result: 'unevaluated',
          needs: ['write-data'],
        });
      }

      // On create, etag is genuinely null in production, so known size + etag == null stays authoritative.
      const createKnown = storageVerdict(
        ctx,
        {
          service: 'storage',
          method: 'uploadBytes',
          bucket: BUCKET,
          path: 'etagCreate/item-1',
          at: 105,
          outcome: OK,
          writeData: { size: 12, contentType: 'text/plain' },
        },
        'create',
      );
      expect(createKnown).toMatchObject({ result: 'allow' });

      // On update, etag is populated on request.resource in production and uncaptured locally -> abstains.
      const updateEtag = storageVerdict(
        ctx,
        {
          service: 'storage',
          method: 'updateMetadata',
          bucket: BUCKET,
          path: 'etagUpdate/item-1',
          at: 106,
          outcome: DENIED,
          writeData: { contentType: 'text/plain' },
          document: { size: 12, contentType: 'text/plain', generation: '1', metageneration: '1' },
        },
        'update',
      );
      expect(updateEtag).toMatchObject({
        result: 'unevaluated',
        needs: ['write-data'],
      });
    } finally {
      sandbox.dispose();
    }
  });

  it('abstains when writeData is omitted on uploadBytes and getMetadata document is omitted on getMetadata', () => {
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow create: if request.resource.metadata == null;
      allow get: if resource.metadata == null;
    }
  }
}`;
    const { sandbox, ctx } = makeStorageHost(rules);
    try {
      const uploadVerdict = storageVerdict(
        ctx,
        {
          service: 'storage',
          method: 'uploadBytes',
          bucket: BUCKET,
          path: 'docs/doc-1',
          at: 200,
          outcome: DENIED,
        },
        'create',
      );
      expect(uploadVerdict).toMatchObject({
        result: 'unevaluated',
        needs: ['write-data'],
      });

      const getMetaVerdict = storageVerdict(
        ctx,
        {
          service: 'storage',
          method: 'getMetadata',
          bucket: BUCKET,
          path: 'docs/doc-1',
          at: 201,
          outcome: DENIED,
        },
        'get',
      );
      expect(getMetaVerdict).toMatchObject({
        result: 'unevaluated',
        needs: ['stored-document'],
      });
    } finally {
      sandbox.dispose();
    }
  });

  it('inspects all allow rules sharing the same source line and detects token.firebase map equality over redacted email', () => {
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /teams/{teamId} {
      allow get: if resource.size > 1000; allow get: if !('md5Hash' in resource);
      allow create: if request.resource.size > 1000; allow create: if !('md5Hash' in request.resource);
    }
    match /users/{uid} {
      allow get: if request.auth != null && request.auth.token.firebase == {'sign_in_provider': 'password', 'identities': {}};
    }
  }
}`;
    const { sandbox, ctx } = makeStorageHost(rules);
    try {
      const sameLineGet = storageVerdict(
        ctx,
        {
          service: 'storage',
          method: 'getMetadata',
          bucket: BUCKET,
          path: 'teams/team-1',
          at: 300,
          outcome: DENIED,
          document: { size: 10, contentType: 'text/plain' },
        },
        'get',
      );
      expect(sameLineGet).toMatchObject({
        result: 'unevaluated',
        needs: ['stored-document'],
      });

      const sameLineCreate = storageVerdict(
        ctx,
        {
          service: 'storage',
          method: 'uploadBytes',
          bucket: BUCKET,
          path: 'teams/team-1',
          at: 301,
          outcome: DENIED,
          writeData: { size: 10, contentType: 'text/plain' },
        },
        'create',
      );
      expect(sameLineCreate).toMatchObject({
        result: 'unevaluated',
        needs: ['write-data'],
      });

      const firebaseMapEq = storageVerdict(
        ctx,
        {
          service: 'storage',
          method: 'getMetadata',
          bucket: BUCKET,
          path: 'users/u-1',
          at: 302,
          outcome: DENIED,
          account: {
            uid: 'u-1',
            claimNames: ['email', 'firebase'],
            claims: { firebase: { sign_in_provider: 'password', identities: {} } },
          },
        },
        'get',
      );
      expect(firebaseMapEq).toMatchObject({
        result: 'unevaluated',
        needs: ['claim-values'],
      });
    } finally {
      sandbox.dispose();
    }
  });

  it('abstains on sliced/concat/map.get Storage resource containers and nested token.firebase enumerations', () => {
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /slices/{id} {
      allow create: if !('md5Hash' in ['pad', request.resource][1:2][0]);
      allow update: if !('md5Hash' in (request.auth != null ? ['pad', request.resource] : ['pad', request.resource])[1:2][0]);
      allow get: if !('md5Hash' in {'r': resource}.get('r', {}));
    }
    match /lists/{id} {
      allow create: if !('md5Hash' in ([request.resource].concat([]))[0]);
      allow update: if !('md5Hash' in ([request.resource].removeAll([]))[0]);
    }
    match /claims/{id} {
      allow get: if request.auth.token.firebase in [{'sign_in_provider': 'password', 'identities': {}}];
      allow list: if [request.auth.token.firebase] == [{'sign_in_provider': 'password', 'identities': {}}];
      allow create: if [request.auth.token.firebase].hasAny([{'sign_in_provider': 'password', 'identities': {}}]);
      allow delete: if [request.auth.token.firebase, {'sign_in_provider': 'password', 'identities': {}}].toSet().size() == 1;
    }
  }
}`;
    const { sandbox, ctx } = makeStorageHost(rules);
    try {
      const missingEmailAccount = {
        uid: 'u-1',
        claimNames: ['email', 'firebase', 'sub'],
        claims: { sub: 'u-1', firebase: { sign_in_provider: 'password', identities: {} } },
      };

      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'uploadBytes', bucket: BUCKET, path: 'slices/a', at: 500, outcome: DENIED, writeData: { size: 10 } },
          'create',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['write-data'] });

      expect(
        storageVerdict(
          ctx,
          {
            service: 'storage',
            method: 'updateMetadata',
            bucket: BUCKET,
            path: 'slices/a',
            at: 501,
            outcome: DENIED,
            account: { uid: 'u-1', claimNames: ['sub'], claims: { sub: 'u-1' } },
            document: { size: 10 },
            writeData: { contentType: 'text/plain' },
          },
          'update',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['write-data'] });

      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'getMetadata', bucket: BUCKET, path: 'slices/a', at: 502, outcome: DENIED, document: { size: 10 } },
          'get',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['stored-document'] });

      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'uploadBytes', bucket: BUCKET, path: 'lists/a', at: 503, outcome: DENIED, writeData: { size: 10 } },
          'create',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['write-data'] });

      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'updateMetadata', bucket: BUCKET, path: 'lists/a', at: 504, outcome: DENIED, document: { size: 10 }, writeData: { contentType: 'text/plain' } },
          'update',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['write-data'] });

      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'getBytes', bucket: BUCKET, path: 'claims/a', at: 505, outcome: DENIED, account: missingEmailAccount },
          'get',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'listAll', bucket: BUCKET, path: 'claims/a', at: 506, outcome: DENIED, account: missingEmailAccount },
          'list',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'uploadBytes', bucket: BUCKET, path: 'claims/a', at: 507, outcome: DENIED, account: missingEmailAccount, writeData: { size: 10 } },
          'create',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'deleteObject', bucket: BUCKET, path: 'claims/a', at: 508, outcome: DENIED, account: missingEmailAccount },
          'delete',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });
    } finally {
      sandbox.dispose();
    }
  });

  it('abstains when .concat(...) is called on dynamic non-literal-list receivers in Storage rules', () => {
    const { sandbox, ctx } = makeStorageHost(
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /dyn/{id} {
      allow create: if !('md5Hash' in ({'x': 1}.keys().removeAll(['x']).concat([request.resource]))[0]);
      allow update: if !('crc32c' in ({'x': 1}.keys().concat([request.resource]))[1]);
      allow get: if !('etag' in (resource.size > 0 ? {'x': 1}.keys().removeAll(['x']) : ['pad']).concat([resource])[0]);
    }
  }
}`,
    );

    try {
      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'uploadBytes', bucket: BUCKET, path: 'dyn/a', at: 600, outcome: DENIED, writeData: { size: 10 } },
          'create',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['write-data'] });
      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'updateMetadata', bucket: BUCKET, path: 'dyn/a', at: 601, outcome: DENIED, document: { size: 10 }, writeData: { contentType: 'text/plain' } },
          'update',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['write-data'] });
      expect(
        storageVerdict(
          ctx,
          { service: 'storage', method: 'getMetadata', bucket: BUCKET, path: 'dyn/a', at: 602, outcome: DENIED, document: { size: 10 } },
          'get',
        ),
      ).toMatchObject({ result: 'unevaluated', needs: ['stored-document'] });
    } finally {
      sandbox.dispose();
    }
  });
});
