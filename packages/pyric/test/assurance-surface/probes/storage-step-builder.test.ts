import { describe, expect, test } from 'bun:test';
import 'fake-indexeddb/auto';
import { extractAccessSites } from '../../../src/assurance-surface/code/extractor.js';
import { runProbes } from '../../../src/assurance-surface/probes/run-probes.js';
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
import { ownerConditionsFrom } from '../../../src/assurance-surface/rules/analyze-owners.js';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import type { RuleSources } from '../../../src/assurance-surface/rules/rule-sources.js';
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

  test('disjoins separate Storage allow statements instead of conjoining incompatible MIME, size, or metadata arms', () => {
    const surface = projectRuleSurface({
      storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow write: if false;
      allow write: if request.auth != null
        && request.resource.contentType.matches('image/.*')
        && request.resource.size <= 100
        && 'imgTag' in request.resource.metadata;
      allow write: if request.auth != null
        && request.resource.contentType.matches('application/pdf')
        && request.resource.size <= 4096;
    }
  }
}`,
    });
    const merged = mergedStorageConstraint(surface.entries);
    expect(merged.maxSizeBytes).toBe(4096);
    expect(merged.requiredCustomMetadataKeys).toBeUndefined();
    const synth = synthesizeMatchingContentType(
      merged.contentTypePattern,
      merged.contentTypeConjuncts,
    );
    expect(synth === 'image/png' || synth === 'application/pdf').toBe(true);
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

  test('seeds HTTP metadata headers for updateMetadata probes and attacks all sibling and nested allow arms for foreign-slot-write', async () => {
    const clientCode = [
      "import { getAuth } from 'firebase/auth';",
      "import { getStorage, ref, updateMetadata, uploadBytes } from 'firebase/storage';",
      'export async function run(dynLang: string, b: Blob) {',
      '  const uid = getAuth().currentUser!.uid;',
      '  const st = getStorage();',
      "  await uploadBytes(ref(st, `overwrite/${uid}/item.bin`), new Uint8Array([1, 2]), { cacheControl: 'public, max-age=3600' });",
      "  await updateMetadata(ref(st, `overwrite/${uid}/item.bin`), { contentLanguage: 'de' });",
      "  await uploadBytes(ref(st, `asymmetric/${uid}/avatar.png`), new Uint8Array([1, 2]), { contentType: 'image/png' });",
      "  await uploadBytes(ref(st, `nested/${uid}/avatar.png`), new Uint8Array([1, 2]), { contentType: 'image/png' });",
      "  await uploadBytes(ref(st, `combo/${uid}/bad`), new Uint8Array([1]), { cacheControl: 'private, no-store', contentLanguage: dynLang });",
      "  await uploadBytes(ref(st, `imgs/${uid}/blob`), b);",
      '}',
    ].join('\n');

    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /overwrite/{uid}/{name} {
      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.cacheControl == 'public, max-age=3600';
      allow update: if request.auth != null
        && request.auth.uid == uid
        && resource.cacheControl == 'public, max-age=3600'
        && request.resource.contentLanguage == 'de';
    }
    match /asymmetric/{uid}/{file} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*');
      allow write: if request.auth != null
        && request.resource.contentType == 'application/pdf';
    }
    match /nested/{uid} {
      match /{file} {
        allow write: if request.auth != null
          && request.auth.uid == uid
          && request.resource.contentType.matches('image/.*');
      }
      match /{allFiles=**} {
        allow write: if request.auth != null
          && request.resource.contentType == 'application/pdf';
      }
    }
    match /combo/{uid}/{file} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.cacheControl == 'public, max-age=3600'
        && request.resource.contentLanguage == 'en';
    }
    match /imgs/{uid}/{file} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*');
    }
  }
}`;

    const accessSites = extractAccessSites({
      root: '/app',
      files: { 'client.ts': clientCode },
    }).accessSites;
    const sources: RuleSources = {
      firestore: [],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: storageRules }],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);
    const ownerBindings = inferOwnerBindings(conditions, accessSites);

    const report = await runProbes({
      accessSites,
      ownerBindings,
      conditions,
      sources,
    });

    // 1. updateMetadata on overwrite/{uid}/item.bin must NOT emit a false must-allow-denied
    expect(
      report.findings.some(
        (f) => f.path === 'overwrite/{uid}/item.bin' && f.kind === 'must-allow-denied',
      ),
    ).toBe(false);

    // 2. Both sibling and nested overbroad allow write arms must hit foreign-slot-write!
    expect(
      report.findings.some(
        (f) => f.path === 'asymmetric/{uid}/avatar.png' && f.kind === 'foreign-slot-write',
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) => f.path === 'nested/{uid}/avatar.png' && f.kind === 'foreign-slot-write',
      ),
    ).toBe(true);

    // 3. Static cacheControl mismatch alongside unresolved contentLanguage must still hit must-allow-denied!
    expect(
      report.findings.some(
        (f) => f.path === 'combo/{uid}/bad' && f.kind === 'must-allow-denied',
      ),
    ).toBe(true);

    // 4. Untraced Blob omits explicit contentType -> abstains (invalid) rather than synthesizing image/png!
    expect(
      report.findings.some(
        (f) => f.path === 'imgs/{uid}/blob' && f.kind === 'must-allow-denied',
      ),
    ).toBe(false);
    const blobMustAllow = report.results.find(
      (r) => r.probe.template === 'imgs/{uid}/blob' && r.probe.kind === 'must-allow-denied',
    );
    expect(blobMustAllow?.outcome).toBe('invalid');
  });
});
