/**
 * Sandbox state behind the `control_sandbox_environment` tool: which action
 * reaches which canonical operation, and what each one carries across.
 */
import { describe, expect, it } from 'bun:test';

import { SANDBOX_STATE_ROUTES } from '../../../../src/bridge/surface/render/discriminator-sandbox-state-routes.js';

/** The route one call takes, the way the renderer picks it. */
function routeFor(args: Record<string, unknown>) {
  const route = SANDBOX_STATE_ROUTES.find((candidate) => candidate.selects(args));
  if (route === undefined) throw new Error(`no state route selects ${JSON.stringify(args)}`);
  return route;
}

describe('the sandbox state routes', () => {
  it('take every action they carry to its canonical operation', () => {
    const operations = SANDBOX_STATE_ROUTES.map((route) => [route.action, route.operation]);
    expect(operations).toEqual([
      ['reset_all', 'reset_sandbox'],
      ['seed', 'seed_sandbox'],
      ['checkpoint', 'checkpoint_sandbox'],
      ['restore', 'restore_sandbox'],
      ['list_checkpoints', 'list_sandbox_checkpoints'],
      ['events', 'list_sandbox_events'],
      ['export_fixture', 'export_sandbox_fixture'],
      ['seed_fixture', 'seed_sandbox_fixture'],
    ]);
  });

  it('carry the scope and the confirm a reset takes', () => {
    const args = { action: 'reset_all', scope: 'database', confirm: true };
    expect(routeFor(args).translate(args)).toEqual({ scope: 'database', confirm: true });
  });

  it('carry the checkpoint name under the name the method takes it as', () => {
    const args = { action: 'restore', checkpointName: 'before-cleanup', confirm: true };
    expect(routeFor(args).translate(args)).toEqual({ name: 'before-cleanup', confirm: true });
  });

  it('carry the cursor, the limit, and the kind an events page takes', () => {
    const args = { action: 'events', since: 'evt-1', limit: 20, kind: 'denials' };
    expect(routeFor(args).translate(args)).toEqual({
      since: 'evt-1',
      limit: 20,
      kind: 'denials',
    });
  });

  it('carry the fixture path, and the flag that leaves passwords out', () => {
    const exported = { action: 'export_fixture', fixturePath: 'f.json', excludePasswords: true };
    expect(routeFor(exported).translate(exported)).toEqual({
      path: 'f.json',
      excludePasswords: true,
    });
    const seeded = { action: 'seed_fixture', fixturePath: 'f.json' };
    expect(routeFor(seeded).translate(seeded)).toEqual({ path: 'f.json' });
  });

  it('parses the encoded seed a seed action carries', () => {
    const args = { action: 'seed', seedSnapshotJson: '{"firestore":{"a/b":{"n":1}}}' };
    expect(routeFor(args).translate(args)).toEqual({ firestore: { 'a/b': { n: 1 } } });
  });
});
