import { describe, expect, it } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Discovered } from '../../../src/serve/discovery.js';
import {
  buildPyricEnvelope,
  formatMcpInstructions,
  probeNodeHost,
  resolveProjectIdentity,
} from '../../../src/bridge/server/project-identity.js';

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('failed to bind loopback server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

function discoveredAt(baseUrl: string, token?: string): Discovered {
  return {
    mcpUrl: `${baseUrl}/__pyric/mcp`,
    url: baseUrl,
    base: baseUrl,
    instanceId: 'test-instance',
    pointerProjectDir: '/tmp/project',
    source: 'pointer /tmp/project/.pyric/serve.json',
    token,
  };
}

describe('resolveProjectIdentity', () => {
  it('detects every supported Firebase and Pyric project marker and canonicalizes symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-identity-'));
    try {
      const emptyDir = join(root, 'empty');
      mkdirSync(emptyDir);
      expect(resolveProjectIdentity(emptyDir)).toEqual({
        projectDir: realpathSync(emptyDir),
        isProject: false,
      });

      const markers = [
        'firebase.json',
        'pyric.json',
        '.firebaserc',
        'firestore.rules',
        'database.rules.json',
        'storage.rules',
      ];
      for (const marker of markers) {
        const dir = join(root, `marker-${marker.replace(/[^a-z0-9]/gi, '-')}`);
        mkdirSync(dir);
        writeFileSync(join(dir, marker), '{}\n', 'utf8');
        expect(resolveProjectIdentity(dir)).toEqual({
          projectDir: realpathSync(dir),
          isProject: true,
        });
      }

      const targetDir = join(root, 'real-project');
      const linkDir = join(root, 'link-project');
      mkdirSync(targetDir);
      writeFileSync(join(targetDir, 'firebase.json'), '{}\n', 'utf8');
      symlinkSync(targetDir, linkDir);
      expect(resolveProjectIdentity(linkDir)).toEqual({
        projectDir: realpathSync(targetDir),
        isProject: true,
      });

      const missingDir = join(root, 'does-not-exist');
      expect(resolveProjectIdentity(missingDir)).toEqual({
        projectDir: missingDir,
        isProject: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formatMcpInstructions and buildPyricEnvelope', () => {
  it('formats concise project and non-project instructions and stamps _pyric', () => {
    const projectIdentity = { projectDir: '/workspace/app', isProject: true };
    const nonProjectIdentity = { projectDir: '/workspace/scratch', isProject: false };

    const hostText = formatMcpInstructions(projectIdentity, 'host', 'http://localhost:3473');
    expect(hostText).toContain('/workspace/app');
    expect(hostText).toContain('http://localhost:3473');
    expect(hostText).not.toContain('warning');

    const localNonProject = formatMcpInstructions(nonProjectIdentity, 'in-process');
    expect(localNonProject).toContain('/workspace/scratch');
    expect(localNonProject).toContain('in-process');
    expect(localNonProject).toContain('--project-dir');

    expect(buildPyricEnvelope('sandbox', 'demo-app', 'host', projectIdentity)).toEqual({
      mode: 'sandbox',
      project: 'demo-app',
      target: 'host',
      projectDir: '/workspace/app',
      isProject: true,
    });
    expect(buildPyricEnvelope('live', 'demo-app', 'in-process')).toEqual({
      mode: 'live',
      project: 'demo-app',
      target: 'in-process',
    });
  });
});

describe('probeNodeHost', () => {
  it('detects a Node sandbox host and forwards the session token', async () => {
    const seenTokens: Array<string | undefined> = [];
    await withServer(
      (req, res) => {
        const tokenHeader = req.headers['x-pyric-session-token'];
        if (typeof tokenHeader === 'string') {
          seenTokens.push(tokenHeader);
        } else {
          seenTokens.push(undefined);
        }
        if (req.url === '/__pyric/hosted/method') {
          res.writeHead(405, { allow: 'POST' }).end();
          return;
        }
        if (req.url === '/__pyric/health') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'sandbox' }));
          return;
        }
        res.writeHead(404).end();
      },
      async (baseUrl) => {
        const result = await probeNodeHost(discoveredAt(baseUrl, 'tok-123'), '/tmp/project');
        expect(result).toEqual({ supportsMethods: true, mode: 'sandbox' });
        expect(seenTokens).toEqual(['tok-123', 'tok-123']);
      },
    );
  });

  it('detects live mode from /__pyric/health on a Node host', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/__pyric/hosted/method') {
          res.writeHead(405, { allow: 'POST' }).end();
          return;
        }
        if (req.url === '/__pyric/health') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'live' }));
          return;
        }
        res.writeHead(404).end();
      },
      async (baseUrl) => {
        const result = await probeNodeHost(discoveredAt(baseUrl), '/tmp/project');
        expect(result).toEqual({ supportsMethods: true, mode: 'live' });
      },
    );
  });

  it('identifies a SharedWorker host (404 on hosted/method) as non-method', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(404).end();
      },
      async (baseUrl) => {
        const result = await probeNodeHost(discoveredAt(baseUrl), '/tmp/project');
        expect(result).toEqual({ supportsMethods: false, mode: 'sandbox' });
      },
    );
  });
});
