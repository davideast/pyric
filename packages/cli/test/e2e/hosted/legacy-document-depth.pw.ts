import { expect, test } from '@playwright/test';
import { deserializeSnapshot } from '../../../../pyric/dist/sandbox/persistence/serialize.js';

test('legacy persisted documents reject excess depth before marker rehydration', () => {
  for (const version of [1, 2]) {
    for (const depth of [64, 65]) {
      const document = '{"nested":'.repeat(depth) + 'null' + '}'.repeat(depth);
      const bundle = `{"version":${version},"savedAt":0,"firestore":{"shared/deep":${document}}}`;
      const exceedsLimit = depth > 64;
      if (exceedsLimit) {
        expect(() => deserializeSnapshot(bundle)).toThrow('Encoded document nesting exceeds 64 containers.');
      } else {
        expect(deserializeSnapshot(bundle).firestore['shared/deep']).toEqual(JSON.parse(document));
      }
    }
  }
});
