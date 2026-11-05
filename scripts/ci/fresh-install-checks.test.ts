import { describe, expect, test } from 'bun:test';
import { connect, type AddressInfo } from 'node:net';
import {
  crashFindings,
  firewallFindings,
  isRegistryRequest,
  parseFirewallRejects,
  startEgressProxy,
  UNHANDLED_REJECTION_MARK,
  WORKER_ERROR_MARK,
  type EgressEntry,
  type RunEvidence,
  type StepRecord,
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

  test('a blocked external request or WebSocket from a page is a finding', () => {
    const findings = crashFindings(run([template({
      browserLog: [
        '[blocked external request] POST https://telemetry.example.com/v1',
        '[blocked external WebSocket] wss://firestore.googleapis.com/ws',
      ],
    })]));
    expect(findings).toEqual([
      'web: page tried to leave the machine: [blocked external request] POST https://telemetry.example.com/v1',
      'web: page tried to leave the machine: [blocked external WebSocket] wss://firestore.googleapis.com/ws',
    ]);
  });

  test('a 5xx response is a finding; a 404 is not', () => {
    const findings = crashFindings(run([template({
      browserLog: [
        '[page 1 response 500] GET http://127.0.0.1:3000/api/status',
        '[page 1 response 404] GET http://127.0.0.1:3000/favicon.ico',
      ],
    })]));
    expect(findings).toEqual(['web: server error response: [page 1 response 500] GET http://127.0.0.1:3000/api/status']);
  });

  test('an error response from a pyric host route is a finding', () => {
    const findings = crashFindings(run([template({ hostErrors: ['403 POST /__pyric/diagnostics (during "write one post")'] })]));
    expect(findings).toEqual(['web: pyric host answered with an error: 403 POST /__pyric/diagnostics (during "write one post")']);
  });

  test('an error stack in the dev server output is a finding with its error line', () => {
    const serverOutput = [
      '  VITE v7.1.0  ready in 412 ms',
      '12:00:01 [vite] Internal server error: Failed to resolve import "firebase/ai"',
      '    at TransformPluginContext._formatError (file:///app/node_modules/vite/dist/node/chunks/dep.js:49258:41)',
      '    at async TransformPluginContext.transform (node:internal/modules/esm/loader:120:7)',
    ].join('\n');
    expect(crashFindings(run([template({ serverOutput })]))).toEqual([
      'web: error in dev server output: 12:00:01 [vite] Internal server error: Failed to resolve import "firebase/ai"',
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
    expect(findings).toEqual(['egress: refused CONNECT github.com:443 (only registry.npmjs.org:443 may be reached) (at an unrecorded time)']);
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
    expect(seen).toMatchObject([{ method: 'CONNECT', host: 'github.com', port: 443, allowed: false }]);
    expect(Number.isNaN(Date.parse(seen[0]!.time ?? ''))).toBe(false);
  });

  test('refuses plain HTTP, even to the registry, and records it', async () => {
    const seen: EgressEntry[] = [];
    const proxy = await startEgressProxy(0, (entry) => seen.push(entry));
    const { port } = proxy.address() as AddressInfo;
    const status = await statusLine(port, 'GET http://registry.npmjs.org/create-pyric HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n');
    proxy.close();
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    expect(seen).toMatchObject([{ method: 'GET', host: 'registry.npmjs.org', port: 80, allowed: false }]);
    expect(Number.isNaN(Date.parse(seen[0]!.time ?? ''))).toBe(false);
  });
});

describe('dev server errors in the shapes each dev command prints', () => {
  const samples: Record<string, { output: string; expected: string[] }> = {
    'Next, webpack-internal and <anonymous> frames': {
      output: ' ⨯ Error: boom\n    at Page (webpack-internal:///(rsc)/./src/app/page.tsx:12:11)\n    at stringify (<anonymous>)',
      expected: ['⨯ Error: boom'],
    },
    'Next, a relative frame': {
      output: ' ⨯ Error: boom\n    at Page (src/app/page.tsx:5:9)\n  3 | export default',
      expected: ['⨯ Error: boom'],
    },
    'Next under Turbopack': {
      output: ' ⨯ Error: boom\n    at Page (.next/server/chunks/ssr/[root-of-the-server]__abc._.js:12:11)',
      expected: ['⨯ Error: boom'],
    },
    'Next, an unhandled rejection with an async frame': {
      output: '⨯ unhandledRejection: Error: x\n    at async Promise.all (index 0)\n    at fn (/x/.next/server/app/page.js:1:2)',
      expected: ['⨯ unhandledRejection: Error: x'],
    },
    'Next, a ⨯ line with no stack': {
      output: ' ⨯ Failed to start server',
      expected: ['⨯ Failed to start server'],
    },
    'Node, anonymous frames': {
      output: 'TypeError: x\n    at <anonymous>:1:2\n    at new Promise (<anonymous>)',
      expected: ['TypeError: x'],
    },
    'Vite, a file: frame': {
      output: '[vite] Internal server error: x\n      at TransformPluginContext._formatError (file:///tmp/a/node_modules/vite/dist/node/chunks/dep.js:1:2)',
      expected: ['[vite] Internal server error: x'],
    },
    'Bun, an absolute frame': {
      output: 'error: boom\n      at /tmp/a/src/app.ts:3:9',
      expected: ['error: boom'],
    },
    'an npm deprecation warning': {
      output: 'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
      expected: [],
    },
    'a Node experimental warning': {
      output: '(node:1234) ExperimentalWarning: Type Stripping is an experimental feature\n(Use `node --trace-warnings ...` to show where the warning was created)',
      expected: [],
    },
  };
  for (const [name, { output, expected }] of Object.entries(samples)) {
    test(name, () => {
      expect(crashFindings(run([template({ serverOutput: output })]))).toEqual(
        expected.map((line) => `web: error in dev server output: ${line}`),
      );
    });
  }
});

const STEPS: StepRecord[] = [
  {
    template: 'nextjs', index: 2, step: 'npm install', started: ['npm install'], running: [],
    start: '2026-11-05T01:00:00.000Z', end: '2026-11-05T01:02:00.000Z',
  },
  {
    template: 'nextjs', index: 3, step: 'npm run dev serves the page', started: ['npm run dev -- --port 4100 --hostname 127.0.0.1'], running: [],
    start: '2026-11-05T01:02:01.000Z', end: '2026-11-05T01:02:30.000Z',
  },
  {
    template: 'nextjs', index: 5, step: 'sign in through the sandbox Google dialog', started: [], running: ['npm run dev -- --port 4100 --hostname 127.0.0.1'],
    start: '2026-11-05T01:02:35.000Z', end: '2026-11-05T01:02:40.000Z',
  },
];

describe('attribution to the step a request fell in', () => {
  test('a refused request names the step whose window holds it and the command it started', () => {
    const findings = crashFindings({
      templates: [],
      egress: [REGISTRY, { method: 'CONNECT', host: 'nodejs.org', port: 443, allowed: false, time: '2026-11-05T01:01:10.000Z' }],
      steps: STEPS,
    });
    expect(findings).toEqual([
      'egress: refused CONNECT nodejs.org:443 (only registry.npmjs.org:443 may be reached) (at 2026-11-05T01:01:10.000Z, during nextjs step 2 "npm install"; started: npm install)',
    ]);
  });

  test('a request during a step that started nothing names what was running', () => {
    const findings = firewallFindings([{ time: '2026-11-05T01:02:37.000Z', protocol: 'TCP', destination: '104.16.0.34', port: 443 }], STEPS);
    expect(findings).toEqual([
      'firewall: rejected a direct TCP connection to 104.16.0.34:443 (at 2026-11-05T01:02:37.000Z, during nextjs step 5 "sign in through the sandbox Google dialog"; running: npm run dev -- --port 4100 --hostname 127.0.0.1)',
    ]);
  });

  test('a request between steps names the step before it', () => {
    const findings = firewallFindings([{ time: '2026-11-05T01:02:32.000Z', protocol: 'TCP', destination: '104.16.1.34', port: 443 }], STEPS);
    expect(findings).toEqual([
      'firewall: rejected a direct TCP connection to 104.16.1.34:443 (at 2026-11-05T01:02:32.000Z, between steps, after nextjs step 3 "npm run dev serves the page"; started: npm run dev -- --port 4100 --hostname 127.0.0.1)',
    ]);
  });

  test('a request before any step says so', () => {
    expect(firewallFindings([{ time: '2026-11-05T00:59:00.000Z', protocol: 'UDP', destination: '168.63.129.16', port: 53 }], STEPS)).toEqual([
      'firewall: rejected a direct UDP connection to 168.63.129.16:53 (at 2026-11-05T00:59:00.000Z, before the first step)',
    ]);
  });
});

describe('parseFirewallRejects', () => {
  test('reads time, protocol, destination and port from dmesg --time-format iso lines', () => {
    const text = [
      '2026-11-05T01:02:37,412345+00:00 fresh-install-reject: IN= OUT=eth0 SRC=10.1.0.4 DST=104.16.0.34 LEN=60 TOS=0x00 PREC=0x00 TTL=64 ID=1 DF PROTO=TCP SPT=40000 DPT=443 WINDOW=64240 RES=0x00 SYN URGP=0 UID=1001 GID=999',
      '2026-11-05T01:02:38,000001+00:00 fresh-install-reject: IN= OUT=eth0 SRC=fe80::1 DST=2606:4700::6810:22 LEN=80 PROTO=ICMPv6 TYPE=128 CODE=0',
      '2026-11-05T01:02:39,000000+00:00 some other kernel line',
    ].join('\n');
    expect(parseFirewallRejects(text)).toEqual([
      { time: '2026-11-05T01:02:37.412+00:00', protocol: 'TCP', destination: '104.16.0.34', port: 443 },
      { time: '2026-11-05T01:02:38.000+00:00', protocol: 'ICMPv6', destination: '2606:4700::6810:22' },
    ]);
  });
});
