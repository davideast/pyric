/**
 * The three infrastructure outcomes exist because Antigravity's failures are
 * indistinguishable from a task failure unless the raw stdout and stderr are
 * read: a quota refusal, a stream cut off mid-run, and a run that touched the
 * sandbox through built-in file tools instead of the surface under test. Each
 * canned transcript below is a trimmed excerpt of what the CLI actually prints.
 */
import { describe, expect, test } from 'bun:test';
import { classifyOutcome } from '../outcome.js';

describe('throttled is detected per CLI', () => {
  test('antigravity: a quota reached message throttles a completed run', () => {
    expect(
      classifyOutcome('antigravity', 'completed', 'Individual quota reached for this session', '', 0),
    ).toBe('throttled');
  });

  test('claude: a rate limit message throttles a completed run', () => {
    expect(classifyOutcome('claude', 'completed', '', 'Error: rate limit exceeded', 0)).toBe(
      'throttled',
    );
  });

  test('claude: a bare 429 mention throttles a crashed run', () => {
    expect(classifyOutcome('claude', 'crash', '', 'upstream returned 429', 0)).toBe('throttled');
  });

  test('codex: a rate limit or 429 mention throttles', () => {
    expect(classifyOutcome('codex', 'completed', '{"error":"429 Too Many Requests"}', '', 0)).toBe(
      'throttled',
    );
  });
});

describe('interrupted is detected', () => {
  test('antigravity: "the stream was interrupted" marks the run interrupted', () => {
    expect(
      classifyOutcome('antigravity', 'crash', 'The stream was interrupted before completion', '', 0),
    ).toBe('interrupted');
  });

  test('an empty response with a nonzero status and no quota signal is interrupted', () => {
    expect(classifyOutcome('claude', 'crash', '   \n  ', 'exit 1', 0)).toBe('interrupted');
  });

  test('an empty response with a quota signal is throttled, not interrupted', () => {
    expect(classifyOutcome('claude', 'crash', '', 'rate limit hit, exit 1', 0)).toBe('throttled');
  });
});

describe('bypassed is detected from built-in tool use with zero MCP calls', () => {
  test('antigravity: view_file and run_command tool_name entries with zero calls', () => {
    const stdout = '{"tool_name":"view_file","path":"headless.json"}\n{"tool_name":"run_command"}';
    expect(classifyOutcome('antigravity', 'completed', stdout, '', 0)).toBe('bypassed');
  });

  test('claude: a Read tool_use block with zero calls', () => {
    const stdout = '{"type":"tool_use","name":"Read","input":{}}';
    expect(classifyOutcome('claude', 'completed', stdout, '', 0)).toBe('bypassed');
  });

  test('codex: a command_execution item with zero calls', () => {
    const stdout = '{"item":{"type":"command_execution"}}';
    expect(classifyOutcome('codex', 'completed', stdout, '', 0)).toBe('bypassed');
  });

  test('built-in tool use is not bypassed when at least one MCP call was logged', () => {
    const stdout = '{"type":"tool_use","name":"Read","input":{}}';
    expect(classifyOutcome('claude', 'completed', stdout, '', 1)).toBe('completed');
  });
});

describe('one run can carry more than one signal, so precedence is fixed', () => {
  test('a run that used built-in tools and then hit quota is throttled, not bypassed', () => {
    // The agent read a file, then the account refused it before it called
    // anything. Quota explains why the run ended, so it wins: reporting this as
    // a bypass would blame the surface for an account limit.
    const stdout = '{"type":"tool_use","name":"Read","input":{}}';
    expect(classifyOutcome('claude', 'completed', stdout, 'Error: rate limit exceeded', 0)).toBe(
      'throttled',
    );
  });

  test('a run that used built-in tools and was cut off is interrupted, not bypassed', () => {
    const stdout = '{"tool_name":"view_file"}\nThe stream was interrupted before completion';
    expect(classifyOutcome('antigravity', 'completed', stdout, '', 0)).toBe('interrupted');
  });
});

describe('a run with none of the signals keeps its spawn outcome', () => {
  test('a plain completed run stays completed', () => {
    expect(classifyOutcome('claude', 'completed', 'all done', '', 3)).toBe('completed');
  });

  test('a timeout is never reclassified, because the process never got to say why', () => {
    expect(classifyOutcome('antigravity', 'timeout', 'quota reached', '', 0)).toBe('timeout');
  });

  test('an unknown CLI falls back to the plain spawn outcome', () => {
    expect(classifyOutcome('unknown-cli', 'completed', 'quota reached', '', 0)).toBe('completed');
  });
});
