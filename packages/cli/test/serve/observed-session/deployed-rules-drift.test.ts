import { describe, expect, test } from 'bun:test';
import {
  compareRtdbRulesDrift,
  compareTextRulesDrift,
} from '../../../src/serve/observed-session/deployed-rules-drift.js';

describe('compareTextRulesDrift', () => {
  const SAMPLE_RULES = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /users/{uid} { allow read: if request.auth.uid == uid; }',
    '  }',
    '}',
  ].join('\n');

  test('treats CRLF and trailing whitespace differences as a match', () => {
    const withCrlf = `${SAMPLE_RULES.replace(/\n/g, '\r\n')}\r\n\r\n`;
    const report = compareTextRulesDrift(SAMPLE_RULES, withCrlf, 'Firestore');
    expect(report.status).toBe('match');
    expect(report.drifted).toBe(false);
    expect(report.deployedHash).toBe(report.localHash);
  });

  test('flags drift and pinpoints first differing line', () => {
    const edited = SAMPLE_RULES.replace('request.auth.uid == uid', 'true');
    const report = compareTextRulesDrift(SAMPLE_RULES, edited, 'Firestore');
    expect(report.status).toBe('drifted');
    expect(report.drifted).toBe(true);
    expect(report.firstDiffLine).toBe(4);
    expect(report.deployedHash).not.toBe(report.localHash);
    expect(report.summary).toContain('line 4');
  });

  test('reports no-local-rules when local rules file is absent', () => {
    const report = compareTextRulesDrift(SAMPLE_RULES, null, 'Storage');
    expect(report.status).toBe('no-local-rules');
    expect(report.drifted).toBe(false);
    expect(report.localHash).toBeUndefined();
  });
});

describe('compareRtdbRulesDrift', () => {
  const DEPLOYED_RULES = {
    '.read': false,
    posts: {
      $id: { '.read': 'auth != null', '.write': 'auth.uid === $id' },
    },
  };

  test('ignores comments and formatting differences in local RTDB rules', () => {
    const localWithComments = `{
      // production rules mirror
      "rules": {
        "posts": { "$id": { ".write": "auth.uid === $id", ".read": "auth != null" } },
        ".read": false
      }
    }`;
    const report = compareRtdbRulesDrift(DEPLOYED_RULES, 'abc123', localWithComments);
    expect(report.status).toBe('match');
    expect(report.drifted).toBe(false);
    expect(report.rtdbChanges).toEqual([]);
  });

  test('reports exact rule expression changes when deployed RTDB rules drift from local', () => {
    const localDifferent = JSON.stringify({
      rules: {
        '.read': false,
        posts: {
          $id: { '.read': 'true', '.write': 'auth.uid === $id' },
        },
      },
    });
    const report = compareRtdbRulesDrift(DEPLOYED_RULES, 'abc123', localDifferent);
    expect(report.status).toBe('drifted');
    expect(report.drifted).toBe(true);
    expect(report.rtdbChanges).toEqual([
      {
        path: '/posts/$id',
        kind: '.read',
        change: 'changed',
        deployed: 'auth != null',
        local: 'true',
      },
    ]);
  });

  test('reports no-local-rules when local RTDB rules text is omitted', () => {
    const report = compareRtdbRulesDrift(DEPLOYED_RULES, 'abc123', undefined);
    expect(report.status).toBe('no-local-rules');
    expect(report.drifted).toBe(false);
  });
});
