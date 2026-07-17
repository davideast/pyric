import { describe, expect, test } from 'bun:test';
import { selectPrCheckSet, type ChangedPath } from './check-set.ts';

const changed = (path: string, previousPath?: string): ChangedPath => ({ path, previousPath });

describe('PR check-set selection', () => {
  test('uses the release proof only when every changed path has a release contract', () => {
    expect(selectPrCheckSet({
      event: 'pull_request',
      labels: [],
      paths: [changed('scripts/publish-alpha.sh')],
    })).toBe('release-only');
  });

  test('uses the docs proof only for authored Markdown content', () => {
    expect(selectPrCheckSet({
      event: 'pull_request',
      labels: [],
      paths: [changed('packages/site-docs/src/content/get-started.md')],
    })).toBe('docs-only');
  });

  test.each([
    ['mixed release and docs', [changed('scripts/publish-alpha.sh'), changed('packages/site-docs/src/content/get-started.md')]],
    ['non-Markdown docs file', [changed('packages/site-docs/src/content/component.ts')]],
    ['published README', [changed('README.md')]],
    ['untested release wrapper', [changed('scripts/prepare-release.sh')]],
    ['unknown file', [changed('new-area/config.txt')]],
    ['rename into an exemption', [changed('scripts/publish-alpha.sh', 'scripts/old-publisher.sh')]],
  ])('falls back to full CI for %s', (_name, paths) => {
    expect(selectPrCheckSet({ event: 'pull_request', labels: [], paths })).toBe('full');
  });

  test('full-proof labels and non-PR events always select full CI', () => {
    const paths = [changed('scripts/publish-alpha.sh')];
    expect(selectPrCheckSet({ event: 'pull_request', labels: ['ci-full'], paths })).toBe('full');
    expect(selectPrCheckSet({ event: 'pull_request', labels: ['ci-packaging'], paths })).toBe('full');
    expect(selectPrCheckSet({ event: 'push', labels: [], paths })).toBe('full');
  });

  test('adding any non-exempt path revokes an exemption', () => {
    const exemptSets: ChangedPath[][] = [
      [changed('scripts/publish-alpha.sh')],
      [changed('packages/site-docs/src/content/overview.md')],
    ];
    for (const paths of exemptSets) {
      expect(selectPrCheckSet({
        event: 'pull_request',
        labels: [],
        paths: [...paths, changed('package.json')],
      })).toBe('full');
    }
  });
});
