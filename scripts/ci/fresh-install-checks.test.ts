import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import {
  ALLOWANCES,
  auditAdvisoryNotes,
  auditSummary,
  canonicalAddress,
  crashFindings,
  DEV_SETUPS,
  devCommandLine,
  firewallFindings,
  installEnvironment,
  isRegistryRequest,
  parseFirewallRejects,
  runNotes,
  startEgressProxy,
  UNHANDLED_REJECTION_MARK,
  WORKER_ERROR_MARK,
  type Allowance,
  type EgressEntry,
  type RunEvidence,
  type StepRecord,
  type TemplateEvidence,
} from './fresh-install-checks.ts';
import { UPSTREAM_ADVISORIES } from './upstream-advisories.ts';

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

/** The lines that fail the run, with no allowances. */
function failing(evidence: RunEvidence): string[] {
  return crashFindings(evidence, []).failing;
}

function run(templates: TemplateEvidence[], egress: EgressEntry[] = [REGISTRY]): RunEvidence {
  return { templates, egress };
}

describe('crashFindings', () => {
  test('a clean run has no findings', () => {
    expect(failing(run([template(), template({ template: 'node', chipStates: [] })]))).toEqual([]);
  });

  test('a failed install or start step is a finding that names the step', () => {
    const findings = failing(run([template({ failedStep: { step: 'npm install', reason: 'exit 1: ERESOLVE' } })]));
    expect(findings).toEqual(['web: npm install failed: exit 1: ERESOLVE']);
  });

  test('an uncaught page error is a finding', () => {
    const findings = failing(run([template({
      browserLog: ['[page 1 error] TypeError: Cannot read properties of undefined (reading \'uid\')\n    at main.ts:12:3'],
    })]));
    expect(findings).toEqual([
      'web: uncaught page error: [page 1 error] TypeError: Cannot read properties of undefined (reading \'uid\')',
    ]);
  });

  test('an unhandled rejection is a finding', () => {
    const findings = failing(run([template({
      browserLog: [`[page 1 console.error] ${UNHANDLED_REJECTION_MARK} FirebaseError: permission-denied`],
    })]));
    expect(findings).toEqual([
      `web: unhandled rejection: [page 1 console.error] ${UNHANDLED_REJECTION_MARK} FirebaseError: permission-denied`,
    ]);
  });

  test('a worker error, a SharedWorker error and a crashed page are worker crashes', () => {
    const findings = failing(run([template({
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
    const findings = failing(run([template({
      browserLog: [
        '[page 1 console.warning] [vite] connecting...',
        '[page 1 console.error] Failed to load resource: the server responded with a status of 404 (Not Found)',
      ],
    })]));
    expect(findings).toEqual([]);
  });

  test('a runtime chip that is not Ready is a finding; a page without a chip is not where none is expected', () => {
    const findings = failing(run([
      template({ chipStates: ['Ready', 'error: A request failed in the last minute'] }),
      template({ template: 'node', chip: 'not expected', chipStates: ['absent'] }),
    ]));
    expect(findings).toEqual(['web: runtime chip is not Ready: error: A request failed in the last minute']);
  });

  test('an absent chip fails on a template that mounts it', () => {
    const findings = failing(run([template({ template: 'static', chip: 'expected', chipStates: ['Ready', 'absent'] })]));
    expect(findings).toEqual(['static: runtime chip absent, though this template mounts it']);
  });

  test('a blocked external request or WebSocket from a page is a finding', () => {
    const findings = failing(run([template({
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
    const findings = failing(run([template({
      browserLog: [
        '[page 1 response 500] GET http://127.0.0.1:3000/api/status',
        '[page 1 response 404] GET http://127.0.0.1:3000/favicon.ico',
      ],
    })]));
    expect(findings).toEqual(['web: server error response: [page 1 response 500] GET http://127.0.0.1:3000/api/status']);
  });

  test('an error response from a pyric host route is a finding', () => {
    const findings = failing(run([template({ hostErrors: ['403 POST /__pyric/diagnostics (during "write one post")'] })]));
    expect(findings).toEqual(['web: pyric host answered with an error: 403 POST /__pyric/diagnostics (during "write one post")']);
  });

  test('an error stack in the dev server output is a finding with its error line', () => {
    const serverOutput = [
      '  VITE v7.1.0  ready in 412 ms',
      '12:00:01 [vite] Internal server error: Failed to resolve import "firebase/ai"',
      '    at TransformPluginContext._formatError (file:///app/node_modules/vite/dist/node/chunks/dep.js:49258:41)',
      '    at async TransformPluginContext.transform (node:internal/modules/esm/loader:120:7)',
    ].join('\n');
    expect(failing(run([template({ serverOutput })]))).toEqual([
      'web: error in dev server output: 12:00:01 [vite] Internal server error: Failed to resolve import "firebase/ai"',
    ]);
  });

  test('prose with "at" and a URL is not a stack frame', () => {
    const serverOutput = 'Pyric sandbox at http://127.0.0.1:4000\n  Studio at http://127.0.0.1:4000/__pyric/studio\n';
    expect(failing(run([template({ serverOutput })]))).toEqual([]);
  });

  test('a refused off-registry request is a finding', () => {
    const findings = failing(run([template()], [
      REGISTRY,
      { method: 'CONNECT', host: 'github.com', port: 443, allowed: false },
    ]));
    expect(findings).toEqual(['egress: refused CONNECT github.com:443 (only registry.npmjs.org:443 may be reached) (at an unrecorded time)']);
  });

  test('a run with no registry traffic through the guard is a finding', () => {
    expect(failing(run([template()], []))).toEqual([
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
      expect(failing(run([template({ serverOutput: output })]))).toEqual(
        expected.map((line) => `web: error in dev server output: ${line}`),
      );
    });
  }
});

const noAllowances = (rejects: Parameters<typeof firewallFindings>[0], steps: readonly StepRecord[]) =>
  firewallFindings(rejects, steps, new Map(), []).failing;

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
    const findings = failing({
      templates: [],
      egress: [REGISTRY, { method: 'CONNECT', host: 'nodejs.org', port: 443, allowed: false, time: '2026-11-05T01:01:10.000Z' }],
      steps: STEPS,
    });
    expect(findings).toEqual([
      'egress: refused CONNECT nodejs.org:443 (only registry.npmjs.org:443 may be reached) (at 2026-11-05T01:01:10.000Z, during nextjs step 2 "npm install"; started: npm install)',
    ]);
  });

  test('a request during a step that started nothing names what was running', () => {
    const findings = noAllowances([{ time: '2026-11-05T01:02:37.000Z', protocol: 'TCP', destination: '104.16.0.34', port: 443 }], STEPS);
    expect(findings).toEqual([
      'firewall: rejected a direct TCP connection to 104.16.0.34:443 (at 2026-11-05T01:02:37.000Z, during nextjs step 5 "sign in through the sandbox Google dialog"; running: npm run dev -- --port 4100 --hostname 127.0.0.1)',
    ]);
  });

  test('a request between steps names the step before it', () => {
    const findings = noAllowances([{ time: '2026-11-05T01:02:32.000Z', protocol: 'TCP', destination: '104.16.1.34', port: 443 }], STEPS);
    expect(findings).toEqual([
      'firewall: rejected a direct TCP connection to 104.16.1.34:443 (at 2026-11-05T01:02:32.000Z, between steps, after nextjs step 3 "npm run dev serves the page"; started: npm run dev -- --port 4100 --hostname 127.0.0.1)',
    ]);
  });

  test('a request before any step says so', () => {
    expect(noAllowances([{ time: '2026-11-05T00:59:00.000Z', protocol: 'UDP', destination: '168.63.129.16', port: 53 }], STEPS)).toEqual([
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

describe('allowances', () => {
  const chatInstall: StepRecord = {
    template: 'chat', index: 2, step: 'npm install', started: ['npm install'], running: [],
    start: '2026-11-05T01:07:17.000Z', end: '2026-11-05T01:08:00.000Z',
  };
  const chatDev: StepRecord = {
    template: 'chat', index: 5, step: 'send one message', started: [], running: ['npm run dev -- --host 127.0.0.1 --port 41667 --strictPort'],
    start: '2026-11-05T01:08:10.000Z', end: '2026-11-05T01:08:20.000Z',
  };
  const webInstall: StepRecord = { ...chatInstall, template: 'web', start: '2026-11-05T01:00:00.000Z', end: '2026-11-05T01:01:00.000Z' };
  const refused = (host: string, time: string): EgressEntry => ({ method: 'CONNECT', host, port: 443, allowed: false, time });
  // An install-step egress allowance, shaped like the one #2049 needed before its fix shipped.
  const chatInstallHosts: Allowance = {
    name: 'chat-install-hosts',
    label: 'fixture',
    reason: 'a chat install script that downloads a prebuilt binary',
    template: 'chat',
    step: 'npm install',
    egressHosts: ['github.com', 'nodejs.org'],
    port: 443,
    limit: { oncePerHost: true },
  };
  const verdict = (egress: EgressEntry[], steps: StepRecord[]) =>
    crashFindings({ templates: [], egress: [REGISTRY, ...egress], steps }, [chatInstallHosts, ...ALLOWANCES]);
  const registry = new Map([['registry.npmjs.org', ['104.16.0.34', '104.16.1.34', '2606:4700::6810:22']]]);
  const reject = (destination: string, time = '2026-11-05T01:02:37.000Z') => ({ time, protocol: 'TCP', destination, port: 443 });

  test('the chat install reaching github.com and nodejs.org is listed as allowed, not failing', () => {
    const result = verdict([refused('github.com', '2026-11-05T01:07:55.007Z'), refused('nodejs.org', '2026-11-05T01:07:55.093Z')], [chatInstall]);
    expect(result.failing).toEqual([]);
    expect(result.allowed).toHaveLength(2);
    expect(result.allowed[0]).toStartWith('allowed (fixture): egress: refused CONNECT github.com:443');
  });

  test('the same host outside the chat install, or another host during it, still fails', () => {
    const result = verdict([
      refused('github.com', '2026-11-05T01:08:15.000Z'),
      refused('github.com', '2026-11-05T01:00:30.000Z'),
      refused('example.com', '2026-11-05T01:07:30.000Z'),
      refused('nodejs.org', '2026-11-05T01:07:55.093Z'),
    ], [webInstall, chatInstall, chatDev]);
    expect(result.allowed).toHaveLength(1);
    expect(result.failing).toHaveLength(3);
    expect(result.failing.every((line) => line.startsWith('egress: refused CONNECT'))).toBe(true);
  });

  test('a nextjs dev-server reject to an address the registry resolves to is allowed, by its name', () => {
    const result = firewallFindings([reject('104.16.0.34'), reject('2606:4700:0000:0000:0000:0000:6810:0022')], STEPS, registry);
    expect(result.failing).toEqual([]);
    expect(result.allowed).toHaveLength(2);
    expect(result.allowed[0]).toStartWith('allowed (next-dev-version-check): firewall: rejected a direct TCP connection to 104.16.0.34:443');
    expect(result.allowed[0]).toEndWith("the Next.js dev server's version check, made by Next, not by pyric, and sent only to the npm registry");
  });

  test('a reject to another address, or during the nextjs install, still fails', () => {
    const result = firewallFindings([reject('140.82.112.3'), reject('104.16.1.34', '2026-11-05T01:01:00.000Z')], STEPS, registry);
    expect(result.allowed).toEqual([]);
    expect(result.failing.filter((line) => line.startsWith('firewall: rejected'))).toHaveLength(2);
  });

  test('a reject is not allowed when the registry did not resolve', () => {
    expect(firewallFindings([reject('104.16.0.34')], STEPS, new Map()).allowed).toEqual([]);
  });

  test('an allowance that matched nothing in a run that reached its step is stale and fails', () => {
    expect(verdict([], [chatInstall]).failing).toEqual([
      'stale allowance chat-install-hosts (fixture): matched nothing this run; remove it or fix it',
    ]);
    expect(firewallFindings([], STEPS, registry).failing).toEqual([
      'stale allowance next-dev-version-check (next-dev-version-check): matched nothing this run; remove it or fix it',
    ]);
  });

  test('an allowance whose template did not reach its step is not stale', () => {
    expect(verdict([], [webInstall]).failing).toEqual([]);
    expect(firewallFindings([], [STEPS[0]!], registry).failing).toEqual([]);
  });

  test('the list: unique names, a label and reason each, and one kind of target each', () => {
    const names = ALLOWANCES.map((allowance: Allowance) => allowance.name);
    expect(new Set(names).size).toBe(names.length);
    for (const allowance of ALLOWANCES) {
      expect(allowance.label.length > 0 && allowance.reason.length > 0).toBe(true);
      expect((allowance.egressHosts === undefined) !== (allowance.resolvesTo === undefined)).toBe(true);
    }
  });

  test('canonicalAddress compares IPv6 forms', () => {
    expect(canonicalAddress('2606:4700:0000:0000:0000:0000:6810:0022')).toBe(canonicalAddress('2606:4700::6810:22'));
    expect(canonicalAddress('104.16.0.34')).toBe('104.16.0.34');
  });

  const twelve = Array.from({ length: 12 }, (_, i) => `104.16.${i}.34`);
  const registryOfTwelve = new Map([['registry.npmjs.org', twelve]]);
  const at = (base: string, ms: number) => new Date(Date.parse(base) + ms).toISOString();

  test('a burst of 12 rejects within 38 ms of one dev process is allowed', () => {
    const burst = twelve.map((address, i) => reject(address, at('2026-11-05T01:02:37.000Z', Math.round((i * 38) / 11))));
    const result = firewallFindings(burst, STEPS, registryOfTwelve);
    expect(result.failing).toEqual([]);
    expect(result.allowed).toHaveLength(12);
  });

  test('a second burst 9 s after the first, in the same dev process, fails', () => {
    const first = twelve.slice(0, 3).map((address, i) => reject(address, at('2026-11-05T01:02:05.000Z', i * 3)));
    const second = twelve.slice(0, 3).map((address, i) => reject(address, at('2026-11-05T01:02:14.000Z', i * 3)));
    const result = firewallFindings([...first, ...second], STEPS, registryOfTwelve);
    expect(result.allowed).toHaveLength(3);
    expect(result.failing).toHaveLength(3);
    expect(result.failing.every((line) => line.includes('at 2026-11-05T01:02:14'))).toBe(true);
  });

  test('a burst in the gap between two steps the dev process ran in is allowed', () => {
    const result = firewallFindings([reject('104.16.0.34', '2026-11-05T01:02:32.000Z'), reject('104.16.1.34', '2026-11-05T01:02:32.020Z')], STEPS, registryOfTwelve);
    expect(result.failing).toEqual([]);
    expect(result.allowed).toHaveLength(2);
  });

  test('a reject between steps outside the dev process lifetime fails', () => {
    const afterDev: StepRecord = {
      template: 'nextjs', index: 6, step: 'stop the dev server', started: [], running: [],
      start: '2026-11-05T01:02:45.000Z', end: '2026-11-05T01:02:50.000Z',
    };
    const rejects = [reject('104.16.0.34', '2026-11-05T01:02:00.500Z'), reject('104.16.1.34', '2026-11-05T01:02:42.000Z')];
    const result = firewallFindings(rejects, [...STEPS, afterDev], registryOfTwelve);
    expect(result.allowed).toEqual([]);
    expect(result.failing.filter((line) => line.startsWith('firewall: rejected'))).toHaveLength(2);
  });

  test('a port other than the allowance names fails', () => {
    const firewall = firewallFindings([reject('104.16.0.34'), { ...reject('104.16.1.34'), port: 80 }], STEPS, registryOfTwelve);
    expect(firewall.allowed).toHaveLength(1);
    expect(firewall.failing).toHaveLength(1);
    expect(firewall.failing[0]).toContain('104.16.1.34:80');
    const egress = verdict([refused('nodejs.org', '2026-11-05T01:07:55.093Z'), { ...refused('github.com', '2026-11-05T01:07:55.007Z'), port: 80 }], [chatInstall]);
    expect(egress.allowed).toHaveLength(1);
    expect(egress.failing).toHaveLength(1);
    expect(egress.failing[0]).toStartWith('egress: refused CONNECT github.com:80');
  });

  test('a registry reject from a template other than nextjs fails', () => {
    const webSteps = STEPS.map((record) => ({ ...record, template: 'web' }));
    const result = firewallFindings([reject('104.16.0.34')], webSteps, registryOfTwelve);
    expect(result.allowed).toEqual([]);
    expect(result.failing).toHaveLength(1);
    expect(result.failing[0]).toStartWith('firewall: rejected a direct TCP connection to 104.16.0.34:443');
  });

  test('a second CONNECT to the same host in one chat install fails', () => {
    const result = verdict([
      refused('github.com', '2026-11-05T01:07:55.007Z'),
      refused('nodejs.org', '2026-11-05T01:07:55.093Z'),
      refused('github.com', '2026-11-05T01:07:58.000Z'),
    ], [chatInstall]);
    expect(result.allowed).toHaveLength(2);
    expect(result.failing).toHaveLength(1);
    expect(result.failing[0]).toContain('github.com:443 (only registry.npmjs.org:443 may be reached) (at 2026-11-05T01:07:58.000Z');
  });
});

describe('runtime chip expectations', () => {
  test('each page template says whether its plane mounts the chip', () => {
    expect(Object.fromEntries(Object.entries(DEV_SETUPS).map(([name, setup]) => [name, setup.chip]))).toEqual({
      web: 'expected',
      static: 'expected',
      nextjs: 'expected',
      chat: 'expected',
    });
  });

  test('findings.txt says "chip absent" where the chip is not expected, and what showed where it is', () => {
    const notes = runNotes(run([
      template({ template: 'other', chip: 'not expected', chipStates: ['absent', 'absent'] }),
      template({ template: 'static', chip: 'expected', chipStates: ['Ready', 'Ready'] }),
      template({ template: 'node', chip: 'not expected', chipStates: [] }),
    ]));
    expect(notes).toEqual([
      'other: runtime chip not expected: chip absent',
      'static: runtime chip expected: Ready',
      'node: runtime chip not expected: chip absent',
    ]);
  });
});

describe('npm audit', () => {
  test('create and install leave npm\'s audit and funding notices on', () => {
    const env = installEnvironment('http://127.0.0.1:18080');
    const npmSettings = Object.keys(env).filter((name) => name.startsWith('npm_config_')).sort();
    expect(npmSettings).toEqual(['npm_config_https_proxy', 'npm_config_proxy', 'npm_config_registry']);
  });

  test('reads the summary line in each shape npm prints', () => {
    const install = (summary: string) => `added 312 packages, and audited 313 packages in 9s\n\n58 packages are looking for funding\n  run \`npm fund\` for details\n\n${summary}\n`;
    expect(auditSummary(install('found 0 vulnerabilities'))).toBe('found 0 vulnerabilities');
    expect(auditSummary(install('3 moderate severity vulnerabilities\n\nTo address all issues, run:\n  npm audit fix'))).toBe('3 moderate severity vulnerabilities');
    expect(auditSummary(install('1 high severity vulnerability'))).toBe('1 high severity vulnerability');
    expect(auditSummary(install('7 vulnerabilities (2 low, 5 moderate)'))).toBe('7 vulnerabilities (2 low, 5 moderate)');
    expect(auditSummary('added 1 package in 1s\n')).toBeUndefined();
  });

  test('findings.txt has the audit summary of each template, or says it is missing', () => {
    const notes = runNotes(run([
      template({ template: 'web', installOutput: 'added 40 packages, and audited 41 packages in 3s\n\nfound 0 vulnerabilities\n' }),
      template({ template: 'node', chipStates: [], installOutput: 'up to date in 1s\n' }),
    ]));
    expect(notes).toEqual(['web: npm audit: found 0 vulnerabilities', 'node: npm audit: npm install printed no audit summary']);
  });
});

/** `npm audit --json` v2 output, in the shape arborist's AuditReport.toJSON writes. */
const AUDIT_V2 = readFileSync(new URL('./fixtures/npm-audit-v2.json', import.meta.url), 'utf8');

/** npm 11.13.0 `npm audit --json` with no network, stdout and stderr as one stream: exit 1. */
const AUDIT_OFFLINE = [
  'npm warn audit request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org',
  'npm error audit endpoint returned an error',
  '{',
  '  "message": "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org",',
  '  "error": {',
  '    "summary": "",',
  '    "detail": ""',
  '  }',
  '}',
  'npm error A complete log of this run can be found in: /tmp/npm-home/.npm/_logs/2026-11-05T21_42_23_795Z-debug-0.log',
  '',
].join('\n');

const GRPC_UPSTREAM = `(upstream: ${UPSTREAM_ADVISORIES['GHSA-m9gg-hp2v-232j']})`;

/** The advisory lines AUDIT_V2 gives, most severe first. */
const AUDIT_V2_NOTES = [
  'npm audit --json: critical form-data GHSA-fjxv-7rqg-78g4 at node_modules/form-data',
  `npm audit --json: high @grpc/grpc-js GHSA-m9gg-hp2v-232j at node_modules/@grpc/grpc-js ${GRPC_UPSTREAM}`,
  'npm audit --json: high cross-spawn GHSA-3xgq-45jj-v275 at node_modules/cross-spawn',
  'npm audit --json: high tar-fs GHSA-8cj5-5rvv-wf4v at node_modules/tar-fs',
  'npm audit --json: high tar-fs GHSA-vj76-c3g6-qr5v at node_modules/tar-fs',
  'npm audit --json: high undici GHSA-2m5v-pch6-74hx at node_modules/shadcn/node_modules/undici, '
  + 'node_modules/@ai-sdk/mcp/node_modules/undici, node_modules/jsdom/node_modules/undici and 2 more',
];

describe('npm audit --json advisories', () => {
  test('names the package, severity, advisory id and install locations of every high or critical advisory, most severe first', () => {
    // npm exits 1 when it finds any advisory.
    expect(auditAdvisoryNotes({ code: 1, output: AUDIT_V2 })).toEqual(AUDIT_V2_NOTES);
  });

  test('lists at most three install locations and counts the rest, and leaves them out when npm names none', () => {
    const report = JSON.parse(AUDIT_V2) as { vulnerabilities: Record<string, { nodes?: unknown }> };
    const undici = report.vulnerabilities.undici;
    const crossSpawn = report.vulnerabilities['cross-spawn'];
    if (undici === undefined || crossSpawn === undefined) throw new Error('the fixture lists undici and cross-spawn');
    undici.nodes = ['node_modules/a/node_modules/undici', 'node_modules/b/node_modules/undici', 'node_modules/c/node_modules/undici'];
    delete crossSpawn.nodes;
    const notes = auditAdvisoryNotes({ code: 1, output: JSON.stringify(report) });
    expect(notes).toContain('npm audit --json: high undici GHSA-2m5v-pch6-74hx at node_modules/a/node_modules/undici, '
      + 'node_modules/b/node_modules/undici, node_modules/c/node_modules/undici');
    expect(notes).toContain('npm audit --json: high cross-spawn GHSA-3xgq-45jj-v275');
  });

  test('gives the reason for an advisory known upstream and unreachable, and only for that one', () => {
    expect(UPSTREAM_ADVISORIES['GHSA-m9gg-hp2v-232j']).toContain('server');
    const notes = auditAdvisoryNotes({ code: 1, output: AUDIT_V2 });
    expect(notes.filter((note) => note.includes('(upstream: '))).toEqual([AUDIT_V2_NOTES[1]]);
    for (const reason of Object.values(UPSTREAM_ADVISORIES)) expect(reason).not.toContain('\n');
  });

  test('reads the report when npm\'s warnings share the stream with it', () => {
    const output = `npm warn config production Use \`--omit=dev\` instead.\n${AUDIT_V2}\nnpm notice New minor version of npm available!\n`;
    expect(auditAdvisoryNotes({ code: 1, output })).toEqual(AUDIT_V2_NOTES);
  });

  test('an advisory with no GitHub advisory URL is named by its npm source id', () => {
    const report = JSON.parse(AUDIT_V2) as { vulnerabilities: Record<string, { via: Array<Record<string, unknown>> }> };
    delete report.vulnerabilities['cross-spawn']?.via[0]?.url;
    const notes = auditAdvisoryNotes({ code: 1, output: JSON.stringify(report) });
    expect(notes).toContain('npm audit --json: high cross-spawn advisory 1100563 at node_modules/cross-spawn');
  });

  test('says so when no advisory is high or critical', () => {
    const clean = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } });
    expect(auditAdvisoryNotes({ code: 0, output: clean })).toEqual(['npm audit --json: no high or critical advisory']);
  });

  test('notes npm\'s own error when the audit request fails', () => {
    expect(auditAdvisoryNotes({ code: 1, output: AUDIT_OFFLINE })).toEqual([
      'npm audit --json: no report (exit 1): request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org',
    ]);
  });

  test('names the code and summary of npm\'s error object', () => {
    const enolock = JSON.stringify({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.', detail: 'Try creating one first with: npm i --package-lock-only' } }, null, 2);
    expect(auditAdvisoryNotes({ code: 1, output: `npm error code ENOLOCK\n${enolock}\n` }))
      .toEqual(['npm audit --json: no report (exit 1): npm error ENOLOCK: This command requires an existing lockfile.']);
    expect(auditAdvisoryNotes({ code: 1, output: JSON.stringify({ error: { code: 'EAUDITNOPJSON', summary: '' } }) }))
      .toEqual(['npm audit --json: no report (exit 1): npm error EAUDITNOPJSON']);
    expect(auditAdvisoryNotes({ code: 1, output: JSON.stringify({ message: 'request failed', error: { code: 'ECONNRESET', summary: 'socket hang up' } }) }))
      .toEqual(['npm audit --json: no report (exit 1): request failed: npm error ECONNRESET: socket hang up']);
  });

  test('notes, and never throws, when npm prints no JSON, broken JSON or another shape', () => {
    expect(auditAdvisoryNotes({ code: 1, output: '' })).toEqual(['npm audit --json: no report (exit 1): npm printed no JSON']);
    expect(auditAdvisoryNotes({ code: 1, output: 'npm error code ENOLOCK\nnpm error audit This command requires an existing lockfile.\n' }))
      .toEqual(['npm audit --json: no report (exit 1): npm printed no JSON']);
    expect(auditAdvisoryNotes({ code: 1, output: '{\n  "auditReportVersion": 2,\n' })).toEqual(['npm audit --json: no report (exit 1): npm printed no JSON']);
    expect(auditAdvisoryNotes({ code: 0, output: '{\n  "auditReportVersion": 2,\n  "vulnerabilities": [\n}\n' }))
      .toEqual(['npm audit --json: no report (exit 0): npm printed JSON that does not parse']);
    expect(auditAdvisoryNotes({ code: 0, output: '{\n  "auditReportVersion": 1\n}\n' }))
      .toEqual(['npm audit --json: no report (exit 0): the JSON has no vulnerabilities object']);
    const odd = JSON.stringify({ vulnerabilities: { a: null, b: { via: [null, 7, { severity: 'high' }] }, c: { via: 'x' } } });
    expect(auditAdvisoryNotes({ code: 1, output: odd })).toEqual(['npm audit --json: high b (no advisory id)']);
  });

  test('notes a command that did not finish with the first line of its error, not the output it carries', () => {
    const error = `npm audit --json did not exit within 300s:\n${AUDIT_OFFLINE}`;
    expect(auditAdvisoryNotes({ code: null, output: '', error }))
      .toEqual(['npm audit --json: did not finish: npm audit --json did not exit within 300s']);
    expect(auditAdvisoryNotes({ code: null, output: '', error: '\n  spawn npm ENOENT\n' }))
      .toEqual(['npm audit --json: did not finish: spawn npm ENOENT']);
  });

  test('findings.txt lists the advisories after the audit summary, and nothing for a template that never audited', () => {
    const notes = runNotes(run([
      template({ template: 'chat', installOutput: '39 high severity vulnerabilities\n', audit: { code: 1, output: AUDIT_V2 } }),
      template({ template: 'node', installOutput: 'found 0 vulnerabilities\n' }),
    ]));
    expect(notes).toEqual([
      'chat: npm audit: 39 high severity vulnerabilities',
      ...AUDIT_V2_NOTES.map((note) => `chat: ${note}`),
      'node: npm audit: found 0 vulnerabilities',
    ]);
  });

  test('no advisory fails the run', () => {
    expect(failing(run([template({ audit: { code: 1, output: AUDIT_V2 } })]))).toEqual([]);
  });
});

describe('dev command', () => {
  test('is the template\'s own npm run dev, with no host, port or open flags, on its default address', () => {
    expect(Object.fromEntries(Object.entries(DEV_SETUPS).map(([name, setup]) => [name, `${devCommandLine(setup)} -> ${setup.url}`]))).toEqual({
      web: 'npm run dev -> http://localhost:5173',
      static: 'npm run dev -> http://localhost:3473',
      nextjs: 'NEXT_TELEMETRY_DISABLED=1 npm run dev -> http://localhost:3000',
      chat: 'npm run dev -> http://localhost:5173',
    });
  });

  test('findings.txt lists the command run next to the template\'s npm run dev', () => {
    const notes = runNotes(run([template({
      template: 'nextjs',
      devCommand: { ran: 'NEXT_TELEMETRY_DISABLED=1 npm run dev', script: 'pyric sandbox -- next dev', url: 'http://localhost:3000' },
    })]));
    expect(notes).toEqual([
      'nextjs: dev command: ran `NEXT_TELEMETRY_DISABLED=1 npm run dev` (the template\'s `npm run dev` runs `pyric sandbox -- next dev`) '
      + 'and opened http://localhost:3000/; CI is passed through and stdout is a pipe, so no browser opens on its own',
    ]);
  });
});
