import { once } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { startHost } from './host-process.js';

const signals: readonly (NodeJS.Signals | undefined)[] = [undefined, 'SIGTERM', 'SIGINT'];
for (const signal of signals) {
  const interruptsStartup = signal !== undefined;
  const scenario = interruptsStartup
    ? `${signal} during startup releases the project and bound port without announcing readiness`
    : 'releasing delayed startup announces readiness and serves browser writes';
  test(scenario, async ({ browser }) => {
    const project = mkdtempSync(join(tmpdir(), 'pyric-startup-interruption-'));
    cpSync(new URL('../soak/fixture/', import.meta.url), project, { recursive: true });
    for (const file of ['index.html', 'main.js']) {
      writeFileSync(join(project, file), readFileSync(new URL(`./fixture/${file}`, import.meta.url)));
    }
    let heldResponse: ServerResponse | undefined;
    let boundPort = 0;
    const barrier = createServer((request, response) => {
      request.resume();
      boundPort = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('port'));
      heldResponse = response;
    });
    let owner: ReturnType<typeof startHost> | undefined;
    let contender: ReturnType<typeof startHost> | undefined;
    let replacement: ReturnType<typeof startHost> | undefined;
    const page = await browser.newPage();
    try {
      await new Promise<void>(resolve => barrier.listen(0, '127.0.0.1', resolve));
      const address = barrier.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The startup barrier has no listening address.');
      const preload = join(project, 'pause-listening.mjs');
      // Delay the platform's first listening notification after the socket binds.
      // A real HTTP request keeps startup pending without replacing a Pyric module.
      writeFileSync(preload, `
        import { Server } from 'node:net';
        const emit = Server.prototype.emit;
        let paused = false;
        Server.prototype.emit = function (event, ...args) {
          const pausesListening = event === 'listening' && !paused;
          if (!pausesListening) return emit.call(this, event, ...args);
          paused = true;
          const address = this.address();
          const hasNoAddress = address === null || typeof address === 'string';
          if (hasNoAddress) throw new Error('The paused server has no bound port.');
          void fetch('http://127.0.0.1:${address.port}/?port=' + address.port)
            .then(response => response.text())
            .then(() => emit.call(this, event, ...args));
          return true;
        };
      `);
      owner = startHost(project, 0, [process.execPath, '--import', preload, CLI_PATH]);
      await expect.poll(() => heldResponse !== undefined).toBe(true);
      expect(boundPort).toBeGreaterThan(0);
      expect(owner.stdout()).toBe('');

      contender = startHost(project, boundPort);
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');

      if (interruptsStartup) {
        const exited = once(owner.child, 'exit');
        owner.child.kill(signal);
        await expect(exited).resolves.toEqual([null, signal]);
        heldResponse?.end('Resume startup');
        expect(await owner.startup).toEqual({ kind: 'exit', code: null });
        expect(owner.stdout()).toBe('');

        replacement = startHost(project, boundPort);
        expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      } else {
        heldResponse?.end('Resume startup');
        expect(await owner.startup, owner.stderr()).toEqual({ kind: 'ready' });
      }
      await page.goto(`http://localhost:${boundPort}`);
      await page.getByRole('button', { name: 'Write shared document' }).click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      heldResponse?.end();
      await page.close();
      await replacement?.stop();
      await contender?.stop();
      await owner?.stop();
      barrier.closeAllConnections();
      await new Promise<void>((resolve, reject) => barrier.close(error => {
        const failedToClose = error !== undefined;
        if (failedToClose) reject(error);
        else resolve();
      }));
      rmSync(project, { recursive: true, force: true });
    }
  });
}
