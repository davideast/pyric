/**
 * The assurance argument vocabulary: the service names it translates and the
 * one file read every method that names a capture goes through.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CASE_SERVICES,
  REPLAY_SERVICES,
  readFixtureFile,
  verifiableService,
} from '../../../../src/bridge/surface/arguments/assurance.js';
import { CAPTURE_RELATIVE_PATH } from '../../../../src/serve/capture-store.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';
import { recordNoteSession, writeCapture } from '../assurance-fixture.js';

const fail = failFor('assurance', 'replaySession');

describe('the services an assurance method names', () => {
  it('offers the surface names rather than the engine names', () => {
    expect([...REPLAY_SERVICES]).toEqual(['firestore', 'database']);
    expect([...CASE_SERVICES]).toEqual(['firestore']);
  });

  it("translates the surface's database into the replay engine's rtdb", () => {
    expect(verifiableService('database')).toBe('rtdb');
    expect(verifiableService('firestore')).toBe('firestore');
    expect(verifiableService(undefined)).toBe('firestore');
  });
});

describe('reading a capture a method names', () => {
  it('reads a capture written inside the project directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-assurance-args-'));
    writeCapture(dir, CAPTURE_RELATIVE_PATH, await recordNoteSession());
    const read = readFixtureFile(dir, CAPTURE_RELATIVE_PATH, 'sessionPath', fail);
    if (!('fixture' in read)) throw new Error(read.refusal.summary);
    expect(read.fixture.events.length).toBeGreaterThan(0);
  });

  it('refuses a path outside the project directory by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-assurance-args-'));
    const read = readFixtureFile(dir, '../elsewhere.json', 'sessionPath', fail);
    if ('fixture' in read) throw new Error('a path outside the project directory was accepted');
    expect(read.refusal.summary).toContain('outside the project directory');
    expect(read.refusal.data.field).toBe('sessionPath');
  });

  it('refuses a path nothing was written to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-assurance-args-'));
    const read = readFixtureFile(dir, 'captures/missing.json', 'sessionPath', fail);
    if ('fixture' in read) throw new Error('a missing capture was accepted');
    expect(read.refusal.summary).toContain('no file was read there');
  });

  it('refuses a file that is not a capture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-assurance-args-'));
    writeFileSync(join(dir, 'notes.json'), '{"hello":"world"}', 'utf8');
    const read = readFixtureFile(dir, 'notes.json', 'sessionPath', fail);
    if ('fixture' in read) throw new Error('a file that is not a capture was accepted');
    expect(read.refusal.summary).toContain('is not a recorded session');
  });
});
