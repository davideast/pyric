import { describe, expect, test } from 'bun:test';
import { TraceRecorder } from '../../../src/rules/simulator/trace-recorder.js';

describe('TraceRecorder', () => {
  test('records values, errors, frames, and parent relationships', () => {
    const recorder = new TraceRecorder();
    const root = { type: 'identifier' as const, name: 'root' };
    const child = { type: 'literal' as const, value: true, raw: 'true' };

    recorder.enterFrame('isOwner');
    expect(recorder.capture(root, () => recorder.capture(child, () => true))).toBe(true);
    recorder.exitFrame();

    expect(recorder.entries).toEqual([
      { source: 'root', kind: 'identifier', parent: null, value: true, inlinedFrom: { name: 'isOwner' } },
      { source: 'true', kind: 'literal', parent: 0, value: true, inlinedFrom: { name: 'isOwner' } },
    ]);
  });
});
