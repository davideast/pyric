import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  auditAdvisoryNotes,
  auditSummary,
  crashFindings,
  installEnvironment,
  runNotes,
  type EgressEntry,
  type RunEvidence,
  type TemplateEvidence,
} from './fresh-install-checks.ts';
import { UPSTREAM_ADVISORIES } from './upstream-advisories.ts';

const REGISTRY: EgressEntry = { method: 'CONNECT', host: 'registry.npmjs.org', port: 443, allowed: true };

function template(overrides: Partial<TemplateEvidence> = {}): TemplateEvidence {
  return {
    template: 'web',
    browserLog: ['[page 1 console.log] [pyric sandbox] firebase/* in this page'],
    serverOutput: '> dev\n> vite\n\n  VITE v7.1.0  ready in 412 ms\n  \u279c  Local:   http://127.0.0.1:5173/\n',
    chipStates: ['Ready'],
    ...overrides,
  };
}

function run(templates: TemplateEvidence[], egress: EgressEntry[] = [REGISTRY]): RunEvidence {
  return { templates, egress };
}

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

  test('GHSA-mrhx-c7xc-m3w5 is not allowlisted as an upstream advisory', () => {
    expect(Object.hasOwn(UPSTREAM_ADVISORIES, 'GHSA-mrhx-c7xc-m3w5')).toBe(false);
  });

  test('fails on unallowlisted high and critical advisories while allowing listed upstream advisories', () => {
    const verdict = crashFindings(run([template({ audit: { code: 1, output: AUDIT_V2 } })]), []);
    expect(verdict.failing).toEqual([
      'web: npm audit --json: critical form-data GHSA-fjxv-7rqg-78g4 at node_modules/form-data',
      'web: npm audit --json: high cross-spawn GHSA-3xgq-45jj-v275 at node_modules/cross-spawn',
      'web: npm audit --json: high tar-fs GHSA-8cj5-5rvv-wf4v at node_modules/tar-fs',
      'web: npm audit --json: high tar-fs GHSA-vj76-c3g6-qr5v at node_modules/tar-fs',
      'web: npm audit --json: high undici GHSA-2m5v-pch6-74hx at node_modules/shadcn/node_modules/undici, '
      + 'node_modules/@ai-sdk/mcp/node_modules/undici, node_modules/jsdom/node_modules/undici and 2 more',
    ]);
    expect(verdict.allowed).toEqual([
      'web: allowed (GHSA-m9gg-hp2v-232j): npm audit --json: high @grpc/grpc-js GHSA-m9gg-hp2v-232j '
      + `at node_modules/@grpc/grpc-js; ${UPSTREAM_ADVISORIES['GHSA-m9gg-hp2v-232j']}`,
    ]);
  });

  test('fails deterministically when zod GHSA-mrhx-c7xc-m3w5 appears in npm audit --json', () => {
    const report = JSON.parse(AUDIT_V2) as { vulnerabilities: Record<string, unknown> };
    const grpcOnly = {
      auditReportVersion: 2,
      vulnerabilities: {
        '@firebase/firestore': report.vulnerabilities['@firebase/firestore'],
        '@grpc/grpc-js': report.vulnerabilities['@grpc/grpc-js'],
        zod: {
          name: 'zod',
          severity: 'high',
          isDirect: false,
          via: [
            {
              source: 1110000,
              name: 'zod',
              dependency: 'zod',
              title: 'Zod high severity advisory',
              url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5',
              severity: 'high',
              range: '<4.6.6',
            },
          ],
          effects: ['pyric'],
          range: '<4.6.6',
          nodes: ['node_modules/zod'],
          fixAvailable: true,
        },
      },
    };
    const verdict = crashFindings(run([template({ audit: { code: 1, output: JSON.stringify(grpcOnly) } })]), []);
    expect(verdict.failing).toEqual([
      'web: npm audit --json: high zod GHSA-mrhx-c7xc-m3w5 at node_modules/zod',
    ]);
    expect(verdict.allowed).toHaveLength(1);
    expect(verdict.allowed[0]).toContain('allowed (GHSA-m9gg-hp2v-232j)');
  });

  test('passes when audit has no advisories, only moderate advisories, or only allowlisted upstream advisories', () => {
    const clean = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } });
    expect(crashFindings(run([template({ audit: { code: 0, output: clean } })]), [])).toEqual({
      failing: [],
      allowed: [],
    });

    const report = JSON.parse(AUDIT_V2) as { vulnerabilities: Record<string, unknown> };
    const moderateAndUpstream = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        esbuild: report.vulnerabilities.esbuild,
        '@firebase/firestore': report.vulnerabilities['@firebase/firestore'],
        '@grpc/grpc-js': report.vulnerabilities['@grpc/grpc-js'],
      },
    });
    const verdict = crashFindings(run([template({ audit: { code: 1, output: moderateAndUpstream } })]), []);
    expect(verdict.failing).toEqual([]);
    expect(verdict.allowed).toEqual([
      'web: allowed (GHSA-m9gg-hp2v-232j): npm audit --json: high @grpc/grpc-js GHSA-m9gg-hp2v-232j '
      + `at node_modules/@grpc/grpc-js; ${UPSTREAM_ADVISORIES['GHSA-m9gg-hp2v-232j']}`,
    ]);
  });

  test('normalizes GHSA id casing for allowlisting and unallowlisted failure reporting', () => {
    const lowercaseReport = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        '@grpc/grpc-js': {
          via: [{ name: '@grpc/grpc-js', severity: 'HIGH', url: 'https://github.com/advisories/ghsa-M9GG-hp2v-232j' }],
          nodes: ['node_modules/@grpc/grpc-js'],
        },
        zod: {
          via: [{ name: 'zod', severity: 'High', url: 'https://github.com/advisories/ghsa-MRHX-c7xc-m3w5' }],
          nodes: ['node_modules/zod'],
        },
      },
    });
    const verdict = crashFindings(run([template({ audit: { code: 1, output: lowercaseReport } })]), []);
    expect(verdict.failing).toEqual([
      'web: npm audit --json: high zod GHSA-mrhx-c7xc-m3w5 at node_modules/zod',
    ]);
    expect(verdict.allowed).toHaveLength(1);
    expect(verdict.allowed[0]).toContain('allowed (GHSA-m9gg-hp2v-232j)');
  });

  test('fails closed when npm audit --json errors, times out, returns invalid JSON, or has an empty allowlist reason', () => {
    const offline = crashFindings(run([template({ audit: { code: 1, output: AUDIT_OFFLINE } })]), []);
    expect(offline.failing).toEqual([
      'web: npm audit --json: no report (exit 1): request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org',
    ]);

    const timedOut = crashFindings(run([template({ audit: { code: null, output: '', error: 'npm audit --json did not exit within 300s:\npartial' } })]), []);
    expect(timedOut.failing).toEqual([
      'web: npm audit --json: did not finish: npm audit --json did not exit within 300s',
    ]);

    const odd = JSON.stringify({ vulnerabilities: { b: { via: [{ severity: 'high' }] } } });
    expect(crashFindings(run([template({ audit: { code: 1, output: odd } })]), []).failing).toEqual([
      'web: npm audit --json: high b (no advisory id)',
    ]);

    const report = JSON.parse(AUDIT_V2) as { vulnerabilities: Record<string, unknown> };
    const grpcOnly = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: { '@grpc/grpc-js': report.vulnerabilities['@grpc/grpc-js'] },
    });
    const blankReason = crashFindings(
      run([template({ audit: { code: 1, output: grpcOnly } })]),
      [],
      { 'GHSA-m9gg-hp2v-232j': '   ' },
    );
    expect(blankReason.failing).toEqual([
      'web: npm audit --json: high @grpc/grpc-js GHSA-m9gg-hp2v-232j at node_modules/@grpc/grpc-js',
    ]);
    expect(blankReason.allowed).toEqual([]);
  });
});
