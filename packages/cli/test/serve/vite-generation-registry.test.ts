import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGenerationSlot } from '../../src/serve/vite-generation-registry.js';

const generation = () => ({ close: async () => {} });

test('a second copy of the module sees the generation the first copy registered', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-slot-')));
  try {
    const copy = await import('../../src/serve/vite-generation-registry.js?second-copy') as typeof import('../../src/serve/vite-generation-registry.js');
    expect(copy.projectGenerationSlot).not.toBe(projectGenerationSlot);
    const active = generation();
    projectGenerationSlot(project, 'host').set(active);
    expect(copy.projectGenerationSlot(project, 'host').take()).toBe(active);
    expect(projectGenerationSlot(project, 'host').take()).toBeNull();
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a project reached through a symlink shares its slot; another project or scope does not', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-slot-')));
  try {
    const project = join(parent, 'app');
    const other = join(parent, 'other');
    const link = join(parent, 'link');
    mkdirSync(project);
    mkdirSync(other);
    symlinkSync(project, link, 'dir');
    const active = generation();
    projectGenerationSlot(project, 'host').set(active);
    expect(projectGenerationSlot(other, 'host').take()).toBeNull();
    expect(projectGenerationSlot(project, 'browser-state').take()).toBeNull();
    expect(projectGenerationSlot(link, 'host').take()).toBe(active);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('release clears the slot only while it holds that generation', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-slot-')));
  try {
    const slot = projectGenerationSlot(project, 'host');
    const old = generation();
    const replacement = generation();
    slot.set(old);
    slot.take();
    slot.set(replacement);
    slot.release(old);
    expect(slot.take()).toBe(replacement);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
