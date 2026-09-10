/**
 * Evaluation log writer (`src/bridge/server/audit.ts`).
 *
 * The evaluation writer is the second writer in that file: it appends completed
 * tool events as NDJSON to a caller-named path instead of the per-project audit
 * location. What it must guarantee is that every line the scorer reads is
 * complete, whatever the upstream writer left out, and that the run identity is
 * read once from the environment.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEvalLogWriter,
  readEvalRunIdentity,
  type EvalRunIdentity,
} from '../../src/bridge/server/audit.js';
import type { BridgeToolEvent } from '../../src/bridge/server/bridge.js';

const RUN: EvalRunIdentity = {
  runId: 'r1',
  taskId: 't1',
  variant: 'verb-prefixed',
  cli: 'claude',
  model: 'fable-5-1',
  effort: 'high',
  condition: 'mcp-only',
  seed: 7,
};

function anEvent(overrides: Partial<BridgeToolEvent> = {}): BridgeToolEvent {
  return {
    timestamp: '2026-09-09T00:00:00.000Z',
    mode: 'sandbox',
    project: 'eval',
    tool: 'firestore_get_document',
    args: { path: 'rooms/r1' },
    result: { ok: true, summary: 'read', data: {} },
    durationMs: 3,
    ...overrides,
  };
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('evaluation run identity from the environment', () => {
  it('reads every field and parses the seed as a number', () => {
    const run = readEvalRunIdentity({
      PYRIC_EVAL_RUN_ID: 'run-9',
      PYRIC_EVAL_TASK_ID: 'task-2',
      PYRIC_EVAL_VARIANT: 'noun-prefixed',
      PYRIC_EVAL_CLI: 'codex',
      PYRIC_EVAL_MODEL: 'gpt',
      PYRIC_EVAL_EFFORT: 'medium',
      PYRIC_EVAL_CONDITION: 'agent-default',
      PYRIC_EVAL_SEED: '42',
    });
    expect(run).toEqual({
      runId: 'run-9',
      taskId: 'task-2',
      variant: 'noun-prefixed',
      cli: 'codex',
      model: 'gpt',
      effort: 'medium',
      condition: 'agent-default',
      seed: 42,
    });
  });

  it('defaults every string to empty and the seed to zero', () => {
    expect(readEvalRunIdentity({})).toEqual({
      runId: '',
      taskId: '',
      variant: '',
      cli: '',
      model: '',
      effort: '',
      condition: '',
      seed: 0,
    });
    expect(readEvalRunIdentity({ PYRIC_EVAL_SEED: 'not-a-number' }).seed).toBe(0);
  });
});

describe('evaluation log writer', () => {
  it('appends one NDJSON line per event, completed and indexed from zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-eval-log-'));
    try {
      const path = join(dir, 'nested', 'events.ndjson');
      const writer = createEvalLogWriter(path, RUN);
      writer.write(anEvent());
      writer.write(anEvent({ result: { ok: false, summary: 'denied' } }));

      const lines = readLines(path);
      expect(lines.length).toBe(2);

      const [first, second] = lines as [Record<string, unknown>, Record<string, unknown>];
      expect(first.tool).toBe('firestore_get_document');
      expect(first.operation).toBe(null);
      expect(first.action).toBe(null);
      expect(first.schemaRejected).toBe(false);
      expect(first.isError).toBe(false);
      expect(first.run).toEqual({ ...RUN, callIndex: 0 });

      expect(second.isError).toBe(true);
      expect((second.run as { callIndex: number }).callIndex).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the fields a caller already set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-eval-log-'));
    try {
      const path = join(dir, 'events.ndjson');
      createEvalLogWriter(path, RUN).write(
        anEvent({
          operation: 'get_firestore_document',
          action: 'get',
          schemaRejected: true,
          isError: true,
          result: { ok: false, summary: 'Input validation error' },
        }),
      );
      const [line] = readLines(path) as [Record<string, unknown>];
      expect(line.operation).toBe('get_firestore_document');
      expect(line.action).toBe('get');
      expect(line.schemaRejected).toBe(true);
      expect(line.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing to the per-project audit location', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-eval-log-'));
    try {
      const path = join(dir, 'events.ndjson');
      createEvalLogWriter(path, RUN).write(anEvent());
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(dir, '.pyric'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
