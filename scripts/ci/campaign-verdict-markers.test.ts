import { describe, expect, test } from 'bun:test';
import { parseCommentVerdictTokens, parseVerdictMarkers } from './campaign-verdict-markers.ts';

const HEAD_SHA = '1aa55782a4c9e0b1234567890abcdef123456789';
const STALE_SHA = '8e2e4e59f0000000000000000000000000000000';

describe('parseVerdictMarkers and parseCommentVerdictTokens', () => {
  test('parses column-0 markers across LF, CRLF, lone CR, and case variations', () => {
    const crlfBody = [
      '**Campaign review (`spec`):** `MERGE`',
      '',
      `<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA.toUpperCase()} -->`,
    ].join('\r\n');
    expect(parseVerdictMarkers(crlfBody)).toEqual([
      { axis: 'spec', verdict: 'MERGE', sha: HEAD_SHA },
    ]);

    const loneCrAndMixedCase = [
      'Manual verdict:',
      `<!-- CAMPAIGN-VERDICT axis=Standards verdict=fix sha=${STALE_SHA.toUpperCase()} -->`,
    ].join('\r');
    expect(parseVerdictMarkers(loneCrAndMixedCase)).toEqual([
      { axis: 'standards', verdict: 'FIX', sha: STALE_SHA },
    ]);
  });

  test('ignores markers in indented lines, list fences, HTML pre/code/blockquote, multi-line comments, quotes, and inline text', () => {
    const spoofAttempts = [
      '```markdown',
      `<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      '```',
      '~~~html',
      `<!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} -->`,
      '~~~',
      '- ```html',
      `  <!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      '  ```',
      '1. ```html',
      `<!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} -->`,
      '   ```',
      `  <!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      `    <!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      `\t<!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} -->`,
      `> <!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      '<pre>',
      `<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      '</pre>',
      `<code><!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} --></code>`,
      '<blockquote>',
      `<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      '</blockquote>',
      '<!--',
      `<!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} -->`,
      '-->',
      `Trailing inline <!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} -->`,
      `Inline backtick \`<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->\` sample`,
    ].join('\n');

    const tokens = parseCommentVerdictTokens(spoofAttempts);
    expect(tokens.markers).toEqual([]);
    expect(tokens.malformedMarkers).toEqual([]);
    expect(tokens.hasUnclosedContainer).toBe(false);
  });

  test('flags non-canonical column-0 campaign-verdict HTML comments as malformed', () => {
    const malformedBody = [
      '<!-- campaign-verdict axis=spec verdict=FIX sha=shortsha -->',
      `<!-- campaign-verdict axis=unknown verdict=FIX sha=${HEAD_SHA} -->`,
    ].join('\n');
    const tokens = parseCommentVerdictTokens(malformedBody);
    expect(tokens.markers).toEqual([]);
    expect(tokens.malformedMarkers).toHaveLength(2);
  });
});
