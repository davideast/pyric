/**
 * Crash-hardening for the `pyric dev` serve process.
 *
 * A live review session had the dev server DIE during normal Studio use —
 * the process was taken down by an error surfacing at the event-loop level
 * (unhandled rejection / unhandled 'error' event), not by anything a request
 * handler returned. These tests pin the two layers of the fix:
 *
 *  1. `installServeProcessGuard` — the process-level last line of defense:
 *     unhandled rejections / uncaught exceptions log LOUDLY and the process
 *     keeps serving.
 *  2. The specific event-emitter paths a browser session can hit are handled
 *     at the source: SSE writes to half-closed sockets, file-stream errors
 *     after the exists-check, rules/workspace watcher errors.
 */
import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { installServeProcessGuard } from '../../src/cli/serve.js';
import { createEventHub } from '../../src/serve/namespace.js';
import { pipeFileToResponse } from '../../src/serve/server.js';
import { watchProjectRules } from '../../src/serve/rules.js';

/** A process-like emitter so the guard is testable without touching the real
 *  process listeners (bun's own handlers stay untouched). */
function fakeProcess() {
  const emitter = new EventEmitter();
  return {
    emitter,
    proc: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        emitter.on(event, cb);
        return emitter as unknown as NodeJS.Process;
      },
      off: (event: string, cb: (...args: unknown[]) => void) => {
        emitter.off(event, cb);
        return emitter as unknown as NodeJS.Process;
      },
    } as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
  };
}

describe('installServeProcessGuard', () => {
  it('logs unhandled rejections loudly (with the stack) instead of dying', () => {
    const { emitter, proc } = fakeProcess();
    const logs: string[] = [];
    installServeProcessGuard((m) => logs.push(m), proc);

    emitter.emit('unhandledRejection', new Error('boom-rejection'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('UNHANDLED REJECTION');
    expect(logs[0]).toContain('boom-rejection');
    expect(logs[0]).toContain('kept alive');
  });

  it('logs uncaught exceptions loudly instead of dying', () => {
    const { emitter, proc } = fakeProcess();
    const logs: string[] = [];
    installServeProcessGuard((m) => logs.push(m), proc);

    emitter.emit('uncaughtException', new Error('boom-exception'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('UNCAUGHT EXCEPTION');
    expect(logs[0]).toContain('boom-exception');
  });

  it('stringifies non-Error reasons', () => {
    const { emitter, proc } = fakeProcess();
    const logs: string[] = [];
    installServeProcessGuard((m) => logs.push(m), proc);
    emitter.emit('unhandledRejection', 'a string reason');
    expect(logs[0]).toContain('a string reason');
  });

  it('uninstalls cleanly', () => {
    const { emitter, proc } = fakeProcess();
    const logs: string[] = [];
    const uninstall = installServeProcessGuard((m) => logs.push(m), proc);
    uninstall();
    emitter.emit('unhandledRejection', new Error('after-uninstall'));
    emitter.emit('uncaughtException', new Error('after-uninstall'));
    expect(logs).toHaveLength(0);
    expect(emitter.listenerCount('unhandledRejection')).toBe(0);
    expect(emitter.listenerCount('uncaughtException')).toBe(0);
  });
});

/** Minimal SSE client stand-in: writes succeed until `kill()` flips it into
 *  the half-closed state where every write throws (the reload race window). */
function sseResponse() {
  const emitter = new EventEmitter();
  const frames: string[] = [];
  let dead = false;
  const res = Object.assign(emitter, {
    writeHead: () => res,
    write: (s: string) => {
      if (dead) throw new Error('write after end');
      frames.push(s);
      return true;
    },
    end: () => res,
  }) as unknown as ServerResponse;
  return { res, frames, kill: () => (dead = true) };
}

describe('createEventHub broadcast hardening', () => {
  it('drops a client whose write throws instead of crashing the broadcast', () => {
    const hub = createEventHub();
    const dying = sseResponse();
    const live = sseResponse();
    hub.handle(new EventEmitter() as never, dying.res);
    hub.handle(new EventEmitter() as never, live.res);
    expect(hub.clientCount()).toBe(2);

    dying.kill(); // half-closed socket: the 'close' event hasn't fired yet
    expect(() => hub.broadcast('rules-changed', { ok: true })).not.toThrow();
    // the dead client is evicted; the live one got the frame
    expect(hub.clientCount()).toBe(1);
    expect(live.frames.some((f) => f.includes('rules-changed'))).toBe(true);
  });
});

describe('pipeFileToResponse', () => {
  it('handles a read-stream error without an unhandled error event', async () => {
    const errors: Error[] = [];
    let destroyed = false;
    const res = Object.assign(new EventEmitter(), {
      headersSent: true,
      writeHead: () => res,
      end: () => res,
      destroy: () => {
        destroyed = true;
      },
      pipe: undefined,
      on: EventEmitter.prototype.on,
      once: EventEmitter.prototype.once,
      emit: EventEmitter.prototype.emit,
      write: () => true,
    }) as unknown as ServerResponse;
    pipeFileToResponse(join(tmpdir(), `definitely-missing-${Date.now()}`), res, (e) =>
      errors.push(e),
    );
    // ENOENT arrives async — wait a tick for the stream's error event.
    await new Promise((r) => setTimeout(r, 50));
    expect(errors).toHaveLength(1);
    expect((errors[0] as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(destroyed).toBe(true);
  });

  it('answers 500 when headers were not yet sent', async () => {
    let status = 0;
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: () => res,
      destroy: () => {},
      write: () => true,
    }) as unknown as ServerResponse;
    pipeFileToResponse(join(tmpdir(), `definitely-missing-${Date.now()}`), res);
    await new Promise((r) => setTimeout(r, 50));
    expect(status).toBe(500);
  });
});

describe('watchProjectRules watcher errors', () => {
  it('routes watcher error events to onError instead of crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-watch-'));
    const file = join(dir, 'firestore.rules');
    writeFileSync(file, 'service cloud.firestore { match /databases/{d}/documents { match /{p=**} { allow read: if true; } } }');
    const errors: string[] = [];
    const watcher = watchProjectRules(file, () => {}, (m) => errors.push(m));
    expect(watcher.listenerCount('error')).toBeGreaterThan(0);
    watcher.emit('error', new Error('EMFILE: too many open files'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('EMFILE');
    watcher.close();
  });
});
