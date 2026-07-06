import { describe, test, expect } from 'bun:test';
import {
  ClaudeTranscriptFilter,
  finalizeClaudeTranscript,
} from './claude-transcript';

const SAMPLE = [
  "I'll build this step by step.\n\n",
  '<function_calls>\n',
  '<invoke name="mcp__playground__firestore_rules_stdlib_list">\n',
  '</invoke>\n',
  '</function_calls>',
  '<function_result>\n{"keys":["auth","firestore"]}\n</function_result>',
  '\n\nDone — rules are ready.',
].join('');

describe('ClaudeTranscriptFilter', () => {
  test('strips markup incrementally and emits activity rows', () => {
    const filter = new ClaudeTranscriptFilter();
    const chunks = [
      "I'll build this step by step.\n\n<function_calls>\n",
      '<invoke name="mcp__playground__write_file">',
      '<parameter name="path">/workspace/firestore.rules</parameter>',
      '<parameter name="content">line1\nline2\nline3</parameter>',
      '</invoke>\n</function_calls>',
      '<function_result>\n{"ok":true}\n</function_result>\n\nDone.',
    ];

    let clean = '';
    const activities: string[] = [];
    const results: string[] = [];

    for (const chunk of chunks) {
      const push = filter.push(chunk);
      clean += push.cleanText;
      for (const a of push.activities) activities.push(a.summary);
      for (const u of push.activityUpdates) results.push(u.resultSummary);
    }
    const tail = filter.flush();
    clean += tail.cleanText;

    expect(clean).toBe("I'll build this step by step.\n\nDone.");
    expect(activities).toEqual(['wrote /workspace/firestore.rules · 3 lines']);
    expect(results).toEqual(['{"ok":true}']);
    expect(filter.raw).toBe(chunks.join(''));
  });

  test('finalizeClaudeTranscript one-shots stored text', () => {
    expect(finalizeClaudeTranscript(SAMPLE)).toBe(
      "I'll build this step by step.\n\nDone — rules are ready.",
    );
  });

  test('holds back partial opening tags across chunks', () => {
    const filter = new ClaudeTranscriptFilter();
    const a = filter.push('hello <function_call');
    expect(a.cleanText).toBe('hello ');
    const b = filter.push('s>\n</function_calls>');
    expect(b.cleanText).toBe('');
    expect(b.activities).toHaveLength(0);
    const tail = filter.flush();
    expect(tail.cleanText).toBe('');
  });
});
