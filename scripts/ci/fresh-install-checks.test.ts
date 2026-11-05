import { describe, expect, test } from 'bun:test';
import { connect, type AddressInfo } from 'node:net';
import {
  crashFindings,
  isRegistryRequest,
  startEgressProxy,
  UNHANDLED_REJECTION_MARK,
  WORKER_ERROR_MARK,
  type EgressEntry,
  type RunEvidence,
  type TemplateEvidence,
} from './fresh-install-checks.ts';

const REGISTRY: EgressEntry = { method: 'CONNECT', host: 'registry.npmjs.org', port: 443, allowed: true };

function template(overrides: Partial<TemplateEvidence> = {}): TemplateEvidence {
  return {
    template: 'web',
    browserLog: ['[page 1 console.log] [pyric sandbox] firebase/* in this page'],
    serverOutput: '> dev\n> vite\n\n  VITE v7.1.0  ready in 412 ms\n  ➜  Local:   http://127.0.0.1:5173/\n',
    chipStates: ['Ready'],
    ...overrides,
  };
}

function run(templates: TemplateEvidence[], egress: EgressEntry[] = [REGISTRY]): RunEvidence {
  return { templates, egress };
}

describe('crashFindings', () => {
  test('a clean run has no findings', () => {
    expect(crashFindings(run([template(), template({ template: 'node', chipStates: [] })]))).toEqual([]);
  });

  test('a failed install or start step is a finding that names the step', () => {
    const findings = crashFindings(run([template({ failedStep: { step: 'npm install', reason: 'exit 1: ERESOLVE' } })]));
    expect(findings).toEqual(['web: npm install failed: exit 1: ERESOLVE']);
  });

  test('an uncaught page error is a finding', () => {
    const findings = crashFindings(run([template({
      browserLog: ['[page 1 error] TypeError: Cannot read properties of undefined (reading \'uid\')\n    at main.ts:12:3'],
    })]));
    expect(findings).toEqual([
      'web: uncaught page error: [page 1 error] TypeError: Cannot read properties of undefined (reading \'uid\')',
    ]);
  });

  test('an unhandled rejection is a finding', () => {
    const findings = crashFindings(run([template({
      browserLog: [`[page 1 console.error] ${UNHANDLED_REJECTION_MARK} FirebaseError: permission-denied`],
    })]));
    expect(findings).toEqual([
      `web: unhandled rejection: [page 1 console.error] ${UNHANDLED_REJECTION_MARK} FirebaseError: permission-denied`,
    ]);
  });

  test('a worker error, a SharedWorker error and a crashed page are worker crashes', () => {
    const findings = crashFindings(run([template({
      browserLog: [
        `[page 1 console.error] ${WORKER_ERROR_MARK} SharedWorker /__pyric/worker.js: script error`,
        '[page 1 console.error] Error: Pyric SharedWorker error: worker failed to load',
        '[page crashed] http://127.0.0.1:5173/',
      ],
    })]));
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.startsWith('web: worker crash: '))).toBe(true);
  });

  test('a console warning or an ordinary console error is not a crash', () => {
    const findings = crashFindings(run([template({
      browserLog: [
        '[page 1 console.warning] [vite] connecting...',
        '[page 1 console.error] Failed to load resource: the server responded with a status of 404 (Not Found)',
      ],
    })]));
    expect(findings).toEqual([]);
  });

  test('a runtime chip that is not Ready is a finding; a page without a chip is not', () => {
    const findings = crashFindings(run([
      template({ chipStates: ['Ready', 'error: A request failed in the last minute'] }),
      template({ template: 'static', chipStates: ['absent'] }),
    ]));
    expect(findings).toEqual(['web: runtime chip is not Ready: error: A request failed in the last minute']);
  });

  test('an error stack in the dev server output is a finding with its error line', () => {
    const serverOutput = [
      '  VITE v7.1.0  ready in 412 ms',
      '12:00:01 [vite] Internal server error: Failed to resolve import "firebase/ai"',
      '    at TransformPluginContext._formatError (file:///app/node_modules/vite/dist/node/chunks/dep.js:49258:41)',
      '    at async TransformPluginContext.transform (node:internal/modules/esm/loader:120:7)',
    ].join('\n');
    expect(crashFindings(run([template({ serverOutput })]))).toEqual([
      'web: error stack in dev server output: 12:00:01 [vite] Internal server error: Failed to resolve import "firebase/ai"',
    ]);
  });

  test('prose with "at" and a URL is not a stack frame', () => {
    const serverOutput = 'Pyric sandbox at http://127.0.0.1:4000\n  Studio at http://127.0.0.1:4000/__pyric/studio\n';
    expect(crashFindings(run([template({ serverOutput })]))).toEqual([]);
  });

  test('a refused off-registry request is a finding', () => {
    const findings = crashFindings(run([template()], [
      REGISTRY,
      { method: 'CONNECT', host: 'github.com', port: 443, allowed: false },
    ]));
    expect(findings).toEqual(['egress: refused CONNECT github.com:443 (only registry.npmjs.org:443 may be reached)']);
  });

  test('a run with no registry traffic through the guard is a finding', () => {
    expect(crashFindings(run([template()], []))).toEqual([
      'egress: no request went through the egress guard, so the install bypassed it or never ran',
    ]);
  });
});

describe('isRegistryRequest', () => {
  test('allows only the npm registry over TLS', () => {
    expect(isRegistryRequest('registry.npmjs.org', 443)).toBe(true);
    expect(isRegistryRequest('REGISTRY.NPMJS.ORG', 443)).toBe(true);
    expect(isRegistryRequest('registry.npmjs.org', 80)).toBe(false);
    expect(isRegistryRequest('registry.npmjs.org.example.com', 443)).toBe(false);
    expect(isRegistryRequest('registry.yarnpkg.com', 443)).toBe(false);
    expect(isRegistryRequest('firestore.googleapis.com', 443)).toBe(false);
  });
});

/** Sends `request` to the proxy and resolves with its status line. */
function statusLine(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let text = '';
    socket.on('data', (chunk) => { text += chunk.toString(); });
    socket.on('close', () => resolve(text.split('\r\n', 1)[0] ?? ''));
    socket.on('error', reject);
  });
}

describe('startEgressProxy', () => {
  test('refuses a tunnel to any host but the registry, and records it', async () => {
    const seen: EgressEntry[] = [];
    const proxy = await startEgressProxy(0, (entry) => seen.push(entry));
    const { port } = proxy.address() as AddressInfo;
    const status = await statusLine(port, 'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n');
    proxy.close();
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    expect(seen).toEqual([{ method: 'CONNECT', host: 'github.com', port: 443, allowed: false }]);
  });

  test('refuses plain HTTP, even to the registry, and records it', async () => {
    const seen: EgressEntry[] = [];
    const proxy = await startEgressProxy(0, (entry) => seen.push(entry));
    const { port } = proxy.address() as AddressInfo;
    const status = await statusLine(port, 'GET http://registry.npmjs.org/create-pyric HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n');
    proxy.close();
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    expect(seen).toEqual([{ method: 'GET', host: 'registry.npmjs.org', port: 80, allowed: false }]);
  });
});
