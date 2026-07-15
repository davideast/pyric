import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const authoredListGuide = readFileSync(
  new URL('../../../pyric/docs/storage/how-to/list-and-delete.md', import.meta.url),
  'utf8',
);
const siteListGuide = readFileSync(
  new URL('../../../site-docs/src/content/docs/pyric-storage-how-to-list-and-delete.md', import.meta.url),
  'utf8',
);
const rulesReference = readFileSync(
  new URL('../../../pyric/docs/storage/reference/rules-subset.md', import.meta.url),
  'utf8',
);

describe('authored documentation delegates support policy to can-i-use', () => {
  it('does not revive the obsolete two-verb Storage rules claim', () => {
    for (const source of [authoredListGuide, siteListGuide]) {
      expect(source).not.toContain('distinct `allow list:` verb is deferred');
      expect(source).not.toContain('two-verb model folds get+list into `read`');
      expect(source).toContain('pyric can-i-use storage-rules/rule-kind.allow-list');
    }
  });

  it('keeps the Storage rules page a usage reference, not a support inventory', () => {
    expect(rulesReference).toContain('This page is not an availability inventory');
    expect(rulesReference).not.toContain('Anything not listed is out of scope');
    expect(rulesReference).not.toContain('## Out of scope');
  });
});
