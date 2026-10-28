import { realpathSync } from 'node:fs';
import type { ProjectStateScope } from './hosted/project-ownership.js';

/** The part of a generation the registry needs: its idempotent teardown. */
export interface RegisteredGeneration {
  close(): Promise<void>;
}

/**
 * Where one plugin's active generation is held between Vite server generations.
 *
 * `take` removes and returns the generation a replacement must close first.
 * `release` clears the slot only while it still holds that generation, so an
 * old server's close never clears its replacement.
 */
export interface ViteGenerationSlot {
  take(): RegisteredGeneration | null;
  set(generation: RegisteredGeneration): void;
  release(generation: RegisteredGeneration): void;
}

// Vite re-evaluates the config file on every restart and creates the new
// server before it closes the old one, so each restart builds a new `pyric()`
// instance. A config that imports this package by path is bundled with it,
// which also loads a second copy of this module. The registry therefore lives
// on the global object, under a key every copy computes the same way.
const REGISTRY_KEY = Symbol.for('pyric.vite.activeGenerations');

function projectRegistry(): Map<string, RegisteredGeneration> {
  const holder = globalThis as unknown as Record<symbol, Map<string, RegisteredGeneration> | undefined>;
  const existing = holder[REGISTRY_KEY];
  const hasRegistry = existing !== undefined;
  if (hasRegistry) return existing;
  const created = new Map<string, RegisteredGeneration>();
  holder[REGISTRY_KEY] = created;
  return created;
}

function projectSlotKey(projectDir: string, scope: ProjectStateScope): string {
  let directory = projectDir;
  try {
    directory = realpathSync(projectDir);
  } catch {
    // A missing directory fails the ownership claim with its own error.
  }
  return `${scope}\0${directory}`;
}

/**
 * The process-wide slot for a generation that owns a project's state files.
 * Two projects, or two scopes of one project, hold separate slots.
 */
export function projectGenerationSlot(projectDir: string, scope: ProjectStateScope): ViteGenerationSlot {
  const key = projectSlotKey(projectDir, scope);
  const registry = projectRegistry();
  return {
    take() {
      const generation = registry.get(key) ?? null;
      registry.delete(key);
      return generation;
    },
    set(generation) {
      registry.set(key, generation);
    },
    release(generation) {
      const holdsGeneration = registry.get(key) === generation;
      if (holdsGeneration) registry.delete(key);
    },
  };
}

/**
 * A slot private to one plugin instance, for generations that own no project
 * state. Separate servers on one project keep separate generations.
 */
export function localGenerationSlot(): ViteGenerationSlot {
  let active: RegisteredGeneration | null = null;
  return {
    take() {
      const generation = active;
      active = null;
      return generation;
    },
    set(generation) {
      active = generation;
    },
    release(generation) {
      const holdsGeneration = active === generation;
      if (holdsGeneration) active = null;
    },
  };
}
