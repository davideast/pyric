/** One lock per group of state files: a claim excludes exactly the claimants
 *  that write the same files under `.pyric/state`. */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimProjectState, type ProjectStateScope } from '../../src/serve/hosted/project-ownership.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-ownership-proj-'));
}

function lockPath(dir: string, name: string): string {
  return join(dir, '.pyric', 'state', name);
}

async function refusal(dir: string, scope: ProjectStateScope): Promise<string> {
  try {
    const claim = await claimProjectState(dir, scope);
    claim.close();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const scopes: ProjectStateScope[] = ['in-process', 'host', 'browser-state'];

describe('project state ownership', () => {
  it('lets a host claim run while an in-process claim is held, and the reverse', async () => {
    const dir = project();
    const inProcess = await claimProjectState(dir, 'in-process');
    const host = await claimProjectState(dir, 'host');
    host.close();
    inProcess.close();

    const hostFirst = await claimProjectState(dir, 'host');
    const inProcessSecond = await claimProjectState(dir, 'in-process');
    inProcessSecond.close();
    hostFirst.close();
  });

  it('refuses a second in-process claim on one project', async () => {
    const dir = project();
    const held = await claimProjectState(dir, 'in-process');
    expect(await refusal(dir, 'in-process')).toBe(
      'An in-process sandbox already owns this project\'s in-process state. Stop it before starting another in-process sandbox.',
    );
    held.close();
  });

  it('refuses a second host claim on one project', async () => {
    const dir = project();
    const held = await claimProjectState(dir, 'host');
    expect(await refusal(dir, 'host')).toBe(
      'A hosted sandbox already owns this project\'s hosted state. Attach to its bridge or stop it before starting another hosted sandbox.',
    );
    held.close();
  });

  it('refuses a second browser-state claim on one project', async () => {
    const dir = project();
    const held = await claimProjectState(dir, 'browser-state');
    expect(await refusal(dir, 'browser-state')).toBe(
      'A served sandbox already owns this project\'s persisted state file. Attach to its bridge or stop it before starting another one.',
    );
    held.close();
  });

  it('excludes only the claimants that write the same files', async () => {
    for (const held of scopes) {
      const dir = project();
      const claim = await claimProjectState(dir, held);
      for (const other of scopes) {
        const sharesFiles = other === held;
        const message = await refusal(dir, other);
        const wasRefused = message !== '';
        expect([held, other, wasRefused]).toEqual([held, other, sharesFiles]);
      }
      claim.close();
    }
  });

  it('separates each scope onto its own lock file and keeps the file after release', async () => {
    const dir = project();
    const names = { 'in-process': 'in-process.lock', host: 'host.lock', 'browser-state': 'browser-state.lock' };
    for (const scope of scopes) {
      const claim = await claimProjectState(dir, scope);
      expect(existsSync(lockPath(dir, names[scope]))).toBe(true);
      claim.close();
      expect(existsSync(lockPath(dir, names[scope]))).toBe(true);
    }
  });

  it('releases a scope for the next claimant when the owner closes', async () => {
    const dir = project();
    const first = await claimProjectState(dir, 'host');
    first.close();
    const second = await claimProjectState(dir, 'host');
    second.close();
  });
});
