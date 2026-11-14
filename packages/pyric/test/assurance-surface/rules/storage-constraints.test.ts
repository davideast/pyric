import { describe, expect, test } from 'bun:test';
import { parseResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';
import {
  projectRuleSurface,
  storageValueHints,
} from '../../../src/assurance-surface/usage.js';

describe('StorageMetadataConstraint and Storage ValueHint extraction', () => {
  test('extracts contentTypePattern, maxSizeBytes (< vs <=), requiredCustomMetadataKeys, ownerMetadataKey, and valueHints', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  function validUpload(maxMb) {',
      "    return request.resource.contentType.matches('image/.*')",
      '      && request.resource.size < maxMb * 1024 * 1024',
      "      && 'orgId' in request.resource.metadata",
      "      && request.resource.metadata.keys().hasAll(['checksum', 'orgId'])",
      '      && request.resource.metadata.owner == request.auth.uid;',
      '  }',
      '  match /b/{bucket}/o {',
      '    match /files/{uid}/{fileId} {',
      '      allow create: if request.auth != null && validUpload(5);',
      '    }',
      '    match /avatars/{uid}/avatar.svg {',
      "      allow create: if request.auth.uid == uid && request.resource.contentType == 'image/svg+xml' && request.resource.size <= 1048576 && request.resource.metadata.category != null && request.resource.metadata.tier == 'pro';",
      '    }',
      '    match /icons/{uid} {',
      "      allow create: if request.auth.uid == uid && (request.resource.contentType == 'image/png' || request.resource.contentType == 'image/webp') && request.resource.metadata.get('visibility', 'public') == 'public';",
      '    }',
      '    match /adminOnly/{fileId} {',
      "      allow create: if request.auth.token.admin == true || (request.resource.size < 1024 && 'tag' in request.resource.metadata);",
      '    }',
      '    match /combinedWrite/{fileId} {',
      "      allow write: if request.auth != null && (request.resource == null || (request.resource.contentType == 'application/pdf' && request.resource.size < 4096));",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({ storage: rules });

    const fileEntry = surface.matching(
      parseResourcePattern('storage', 'files/{uid}/{fileId}'),
      'uploadBytes',
    )[0]!;
    expect(fileEntry.storageMetadata).toEqual({
      contentTypePattern: 'image/.*',
      maxSizeBytes: 5 * 1024 * 1024 - 1,
      requiredCustomMetadataKeys: ['checksum', 'orgId', 'owner'],
      ownerMetadataKey: 'owner',
    });

    const svgEntry = surface.matching(
      parseResourcePattern('storage', 'avatars/{uid}/avatar.svg'),
      'uploadString',
    )[0]!;
    expect(svgEntry.storageMetadata).toEqual({
      contentTypePattern: '^image/svg\\+xml$',
      maxSizeBytes: 1048576,
      requiredCustomMetadataKeys: ['category', 'tier'],
    });
    expect(svgEntry.valueHints).toEqual([
      {
        service: 'storage',
        path: 'avatars/{uid}/avatar.svg',
        field: 'tier',
        value: 'pro',
        wildcardBucket: true,
      },
    ]);
    expect(storageValueHints(rules)).toEqual([
      {
        service: 'storage',
        path: 'avatars/{uid}/avatar.svg',
        field: 'tier',
        value: 'pro',
        wildcardBucket: true,
      },
    ]);

    const iconEntry = surface.matching(
      parseResourcePattern('storage', 'icons/{uid}'),
      'uploadBytes',
    )[0]!;
    expect(iconEntry.storageMetadata).toEqual({
      contentTypePattern: '^(?:image/png|image/webp)$',
    });

    // Escape-hatch disjunction (`admin || ...`) does not impose unconditional upload constraints.
    const adminOrSmall = surface.matching(
      parseResourcePattern('storage', 'adminOnly/{fileId}'),
      'uploadBytes',
    )[0]!;
    expect(adminOrSmall.storageMetadata).toBeUndefined();

    // Combined `allow write` with `request.resource == null || ...` delete guard preserves upload constraints.
    const combinedWrite = surface.matching(
      parseResourcePattern('storage', 'combinedWrite/{fileId}'),
      'uploadBytes',
    )[0]!;
    expect(combinedWrite.storageMetadata).toEqual({
      contentTypePattern: '^application/pdf$',
      maxSizeBytes: 4095,
    });
  });

  test('preserves per-branch disjunctive storageMetadataArms across || expressions without Cartesian weakening', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /assets/{fileId} {',
      '      allow write: if request.auth != null && (',
      "        (request.resource.contentType.matches('image/.*') && request.resource.size < 1000 && 'orgId' in request.resource.metadata)",
      "        || (request.resource.contentType.matches('video/.*') && request.resource.size < 50000)",
      '      );',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({ storage: rules });
    const entry = surface.matching(
      parseResourcePattern('storage', 'assets/{fileId}'),
      'uploadBytes',
    )[0]!;
    expect(entry.storageMetadataArms).toEqual([
      {
        contentTypePattern: 'image/.*',
        contentTypeConjuncts: [['image/.*']],
        maxSizeBytes: 999,
        requiredCustomMetadataKeys: ['orgId'],
      },
      {
        contentTypePattern: 'video/.*',
        contentTypeConjuncts: [['video/.*']],
        maxSizeBytes: 49999,
      },
    ]);
  });

  test('extracts incoming request.resource and stored resource HTTP metadata constraints across ==, matches, and in', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /assets/{uid}/{name} {',
      "      allow create: if request.auth.uid == uid && request.resource.cacheControl == 'public, max-age=3600' && request.resource.contentDisposition.matches('inline.*') && request.resource.contentEncoding in ['gzip', 'br'];",
      "      allow update: if request.auth.uid == uid && resource.cacheControl == 'public, max-age=3600' && request.resource.contentLanguage == 'de';",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({ storage: rules });
    const createEntry = surface.matching(
      parseResourcePattern('storage', 'assets/{uid}/{name}'),
      'uploadBytes',
    )[0]!;
    expect(createEntry.storageMetadata?.httpHeaders).toEqual({
      cacheControl: [['^public, max-age=3600$']],
      contentDisposition: [['inline.*']],
      contentEncoding: [['^gzip$', '^br$']],
    });

    const updateEntry = surface.matching(
      parseResourcePattern('storage', 'assets/{uid}/{name}'),
      'updateMetadata',
    )[0]!;
    expect(updateEntry.storageMetadata?.storedHttpHeaders).toEqual({
      cacheControl: [['^public, max-age=3600$']],
    });
    expect(updateEntry.storageMetadata?.httpHeaders).toEqual({
      contentLanguage: [['^de$']],
    });
  });
});
