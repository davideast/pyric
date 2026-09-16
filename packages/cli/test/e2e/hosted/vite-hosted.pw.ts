import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric, type PyricOptions } from '../../../dist/vite.js';

const allowRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**} { allow read, write: if request.auth != null; }
  }
}`;

async function withVite(
  options: PyricOptions,
  run: (server: ViteDevServer, root: string) => Promise<void>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-hosted-')));
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><html><head></head><body>
    <button id="write" disabled>Write shared document</button>
    <output id="write-result"></output><output id="document">Starting</output>
    <script type="module" src="/main.js"></script></body></html>`,
  );
  writeFileSync(join(root, 'main.js'), readFileSync(new URL('./fixture/main.js', import.meta.url)));
  writeFileSync(join(root, 'firestore.rules'), allowRules);
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [pyric(options)],
      server: { host: '127.0.0.1', port: 0 },
    });
    await run(server, root);
  } finally {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function listeningUrl(server: ViteDevServer): string {
  const url = server.resolvedUrls?.local[0];
  const isNotListening = url === undefined;
  if (isNotListening) throw new Error('Vite did not expose a listening URL');
  return url;
}

test('explicit Vite Node host shares browser writes and survives restart', async ({ browser }) => {
  await withVite({ hosted: true }, async (server, root) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      await server.listen();
      const url = listeningUrl(server);
      const health = await fetch(`${url}__pyric/health`).then((response) => response.json());
      expect(health.sandboxConnected).toBe(true);
      const init = await fetch(`${url}__pyric/init.json`).then((response) => response.json());
      expect(init.hosted).toBe(true);
      expect(init.projectKey).toBe(root);
      for (const context of [first, second]) {
        await context.addInitScript(() => {
          Object.defineProperty(globalThis, 'SharedWorker', {
            value: class {
              constructor() {
                throw new Error('Node mode must not start a SharedWorker');
              }
            },
          });
        });
      }
      const writer = await first.newPage();
      const observer = await second.newPage();
      const errors: string[] = [];
      writer.on('pageerror', (error) => errors.push(error.message));
      observer.on('pageerror', (error) => errors.push(error.message));
      await writer.goto(url);
      await observer.goto(url);
      await expect(writer.locator('meta[name="pyric-sandbox-host"]')).toHaveAttribute(
        'content',
        'node',
      );
      await expect(writer.locator('#write')).toBeEnabled();
      await writer.locator('#write').click();
      await expect(writer.locator('#write-result')).toHaveText('Written');
      await expect(observer.locator('#document')).toHaveText('Hello from the other browser');

      await expect(() => {
        const capture = readFileSync(join(root, '.pyric/last-session.json'), 'utf8');
        expect(capture).toContain('Hello from the other browser');
      }).toPass({ timeout: 5_000 });
      const deniedRules = allowRules.replace('request.auth != null', 'false');
      writeFileSync(join(root, 'firestore.rules'), deniedRules);
      await expect
        .poll(async () => {
          const payload = await fetch(`${url}__pyric/init.json`).then((response) =>
            response.json(),
          );
          return payload.rules;
        })
        .toContain('if false');
      await writer.locator('#write').click();
      await expect(writer.locator('#write-result')).toContainText('denied');
      writeFileSync(join(root, 'firestore.rules'), allowRules);
      await expect
        .poll(async () => {
          const payload = await fetch(`${url}__pyric/init.json`).then((response) =>
            response.json(),
          );
          return payload.rules;
        })
        .toContain('request.auth != null');

      await server.restart();
      await observer.reload();
      await expect(observer.locator('#document')).toHaveText('Hello from the other browser');
      expect(errors).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test('omitting hosted retains the SharedWorker sandbox', async ({ browser }) => {
  await withVite({ bridge: true, capture: false, ui: false }, async (server) => {
    await server.listen();
    const url = listeningUrl(server);
    const init = await fetch(`${url}__pyric/init.json`).then((response) => response.json());
    expect(init.hosted).toBe(false);
    expect(init.persist).toBe(false);
    const context = await browser.newContext();
    try {
      const writer = await context.newPage();
      const observer = await context.newPage();
      await writer.goto(url);
      await observer.goto(url);
      await expect(writer.locator('meta[name="pyric-worker-v"]')).toHaveCount(1);
      await expect(writer.locator('meta[name="pyric-sandbox-host"]')).toHaveCount(0);
      await expect(writer.locator('#write')).toBeEnabled();
      await writer.locator('#write').click();
      await expect(observer.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await context.close();
    }
  });
});

test('hosted rejects middleware mode explicitly', async () => {
  await expect(
    withVite({ hosted: true }, async (server) => {
      await server.close();
      await createServer({
        root: server.config.root,
        configFile: false,
        plugins: [pyric({ hosted: true })],
        server: { middlewareMode: true },
        logLevel: 'silent',
      });
    }),
  ).rejects.toThrow('middleware mode is unsupported');
});

test('hosted owns project state until Vite closes', async () => {
  await withVite({ hosted: true, capture: false, ui: false }, async (server, root) => {
    const createReplacement = () =>
      createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [pyric({ hosted: true, capture: false, ui: false })],
        server: { host: '127.0.0.1', port: 0 },
      });
    await expect(createReplacement()).rejects.toThrow('already owns this project');
    await server.close();
    const replacement = await createReplacement();
    try {
      await replacement.listen();
      const url = listeningUrl(replacement);
      const health = await fetch(`${url}__pyric/health`).then((response) => response.json());
      expect(health.sandboxConnected).toBe(true);
    } finally {
      await replacement.close();
    }
  });
});
