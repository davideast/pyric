import { describe, expect, test } from 'bun:test';
import {
  buildCompliantCustomMetadata,
  storageBindingsAt,
} from '../../../src/assurance-surface/probes/storage-metadata-materializer.js';
import {
  compliantByteSize,
  isProbeableStorageSite,
  mergedStorageConstraint,
  storageOpCategory,
  synthesizeMatchingContentType,
} from '../../../src/assurance-surface/probes/storage-step-builder.js';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import { storageOwnerConditions, storageValueHints } from '../../../src/assurance-surface/rules/storage-owners.js';
import { extractSdkUsage } from '../../../src/assurance-surface/usage.js';
import { parseResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';

describe('storage-step-builder', () => {
  test('synthesizes valid MIME strings for common and custom Storage regex patterns', () => {
    expect(synthesizeMatchingContentType(undefined)).toBe('application/octet-stream');
    expect(synthesizeMatchingContentType('image/.*')).toBe('image/png');
    expect(synthesizeMatchingContentType('image/(jpeg|webp)')).toBe('image/jpeg');
    expect(synthesizeMatchingContentType('application/pdf')).toBe('application/pdf');
    expect(synthesizeMatchingContentType('video/.*')).toBe('video/mp4');
    expect(synthesizeMatchingContentType('application/vnd\\.custom\\..+')).toMatch(
      /^application\/vnd\.custom\..+$/,
    );
    expect(synthesizeMatchingContentType('text/csv;\\s*charset=utf-8')).toMatch(
      /^text\/csv;\s*charset=utf-8$/,
    );
    expect(
      synthesizeMatchingContentType('application/vnd\\.items\\+json(;\\s*version=\\d+)?'),
    ).toMatch(/^application\/vnd\.items\+json(;\s*version=\d+)?$/);
  });

  test('merges StorageMetadataConstraint size, contentType, and customMetadata keys across entries', () => {
    const surface = projectRuleSurface({
      storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{uploadId} {
      allow create: if request.resource.size < 1024
        && request.resource.contentType.matches('image/.*')
        && request.resource.metadata.ownerId == request.auth.uid
        && 'tag' in request.resource.metadata;
    }
  }
}`,
    });
    const merged = mergedStorageConstraint(surface.entries);
    expect(merged.contentTypePattern).toBe('image/.*');
    expect(merged.maxSizeBytes).toBe(1023);
    expect(merged.ownerMetadataKey).toBe('ownerId');
    expect(merged.requiredCustomMetadataKeys).toEqual(['ownerId', 'tag']);
    expect(compliantByteSize(merged.maxSizeBytes)).toBe(16);
    expect(compliantByteSize(4)).toBe(4);
  });

  test('identifies probeable Storage sites and excludes unresolved or recursive wildcard templates', () => {
    expect(
      isProbeableStorageSite({
        service: 'storage',
        op: 'uploadBytes',
        path: 'files/{uid}/{fileId}',
        source: 'a.ts:1',
        resolution: 'resolved',
      }),
    ).toBe(true);
    expect(
      isProbeableStorageSite({
        service: 'storage',
        op: 'listAll',
        path: '',
        source: 'a.ts:2',
        resolution: 'resolved',
      }),
    ).toBe(true);
    expect(
      isProbeableStorageSite({
        service: 'storage',
        op: 'list',
        path: '',
        source: 'a.ts:3',
        resolution: 'resolved',
      }),
    ).toBe(true);
    expect(
      storageOpCategory({
        service: 'storage',
        op: 'list',
        path: 'orgs/{orgId}/assets',
        source: 'a.ts:4',
        resolution: 'resolved',
      }),
    ).toBe('read');
    expect(
      isProbeableStorageSite({
        service: 'storage',
        op: 'uploadBytes',
        path: 'files/{rest=**}',
        source: 'a.ts:5',
        resolution: 'resolved',
      }),
    ).toBe(false);
  });

  test('rebinds unscoped wildcardBucket bindings and hints for named client buckets without leaking across explicit buckets', () => {
    const unscopedRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{fileId} {
      allow create: if request.auth.uid == uid
        && request.resource.metadata.tier == 'pro';
    }
  }
}`;
    const usage = extractSdkUsage({
      root: 'app',
      files: {
        'src/upload.ts': [
          "import { getAuth } from 'firebase/auth';",
          "import { getStorage, ref, uploadBytes } from 'firebase/storage';",
          'export async function run(bytes: Uint8Array, tier: string) {',
          '  const uid = getAuth().currentUser!.uid;',
          "  const storage = getStorage(undefined, 'gs://my-app.firebasestorage.app');",
          '  await uploadBytes(ref(storage, `files/${uid}/report.pdf`), bytes, { customMetadata: { tier } });',
          '  await uploadBytes(ref(storage, `unmatched/${uid}/scratch.bin`), bytes);',
          '}',
        ].join('\n'),
      },
    });
    const sites = [...usage.operations];
    const fileSite = sites.find((s) => s.path.startsWith('files/'))!;
    const conditions = storageOwnerConditions(unscopedRules, 'storage.rules');
    const bindings = inferOwnerBindings(conditions, sites);
    const hints = storageValueHints(unscopedRules);
    const surface = projectRuleSurface({ storage: unscopedRules });

    const matchedBindings = storageBindingsAt(fileSite, bindings, surface);
    expect(matchedBindings).toHaveLength(1);
    expect(matchedBindings[0]!.strength).toBe('strong');

    const sitePattern = parseResourcePattern('storage', fileSite.path, fileSite.resourceId);
    const meta = buildCompliantCustomMetadata(
      fileSite,
      sitePattern,
      { requiredCustomMetadataKeys: ['tier'] },
      hints,
      { role: 'owner', uid: 'u-alice', email: 'a@example.test', displayName: 'Alice', token: {} },
      {},
      surface,
    );
    expect(meta).toEqual({ tier: 'pro' });
  });
});
