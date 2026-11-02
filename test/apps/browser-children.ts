/**
 * Keeps the runner's browser processes reachable for the life of the run.
 *
 * Playwright starts a browser with extra stdio pipes for its protocol. Under
 * Bun 1.3.11, collecting such a child after it has exited closes its
 * descriptors by number a second time. A browser launched since then holds
 * those same numbers, so it loses its pipes: its commands never answer, and
 * neither `close()` nor SIGKILL ever settles, since Playwright waits on a
 * close event that no longer comes. Nothing collected, nothing closed twice.
 *
 * Spawns with only the three standard streams don't do this, and are left to
 * the collector.
 *
 * To remove this: on a newer Bun, take out the `retainBrowserChildren` call in
 * driver.ts and run browser-children.test.ts. If it passes there, that Bun has
 * fixed this, and this file can go once CI's pinned Bun is at that version.
 */
import type { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';

const STANDARD_STREAMS = 3;

/** Writable, unlike the bindings of an ESM import, and the object Playwright calls `spawn` on. */
const childProcessModule = createRequire(import.meta.url)('node:child_process') as { spawn: typeof nodeSpawn };

const retained: unknown[] = [];
let installed = false;

/** Call before launching a browser. Later calls do nothing. */
export function retainBrowserChildren(): void {
  if (installed) return;
  installed = true;
  const original = childProcessModule.spawn;
  childProcessModule.spawn = ((...args: Parameters<typeof nodeSpawn>) => {
    const child = original(...args);
    if (child.stdio.length > STANDARD_STREAMS) retained.push(child, [...child.stdio]);
    return child;
  }) as typeof nodeSpawn;
}
