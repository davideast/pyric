/** Run once to record, restart serve.ts, then run with --inspect. */
import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const cliRequire = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const { Client } = await import(cliRequire.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(cliRequire.resolve('@modelcontextprotocol/sdk/inMemory.js'));
import { initializeSandbox, captureFullState } from 'pyric/sandbox';
import { buildInProcessMcpServer } from '../../packages/cli/src/bridge/server/in-process.js';
import { createBridge } from '../../packages/cli/src/bridge/server/bridge.js';
import { buildMcpServer } from '../../packages/cli/src/bridge/server/mcp.js';
import { getBridgeToolSurface } from '../../packages/cli/src/bridge/server/mcp-contract.js';

const projectDir = fileURLToPath(new URL('.', import.meta.url));
const manifestPath = join(tmpdir(), 'pyric-capture-handoff.json');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Saved = { id: string; service: string; hash: string; writes: number };

if (!process.argv.includes('--inspect')) {
  const browser = await chromium.launch();
  const saved: Saved[] = [];
  try {
    for (const service of ['firestore', 'rtdb']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
      await page.goto(`http://localhost:5197/?service=${service}`);
      await page.getByRole('button', { name: 'Minimize pyric', exact: true }).click();
      await page.locator('#rate-burst').click();
      await expect(page.locator('#rate-burst')).toBeEnabled({ timeout: 20000 });
      await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
      await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
      await page.getByRole('button', { name: 'Rates', exact: true }).click();
      await page.locator(`[data-rate-incidents=${service}]`).click();
      await page.locator('[data-rate-incident]').first().click();
      const writes = Number(await page.locator('[data-history-total=writes]').textContent());
      expect(writes).toBeGreaterThan(0);
      const response = page.waitForResponse(response => response.url().endsWith('/__pyric/rate-captures') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Save capture…', exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(201);
      const capture = result.request().postDataJSON();
      expect(capture.frame.incident).toBeTruthy();
      const entry = await result.json();
      saved.push({ id: entry.id, service, hash: digest(capture), writes });
      await page.close();
    }
    await writeFile(manifestPath, JSON.stringify(saved));
    console.log('Recorded both incidents and closed their pages. Restart serve.ts, then run with --inspect.');
  } finally { await browser.close(); }
} else {
  const saved: Saved[] = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sandbox = initializeSandbox();
  const before = digest(await captureFullState(sandbox));
  const evidence: unknown[] = [];
  try {
    for (const transport of ['service', 'bridge'] as const) {
      const server = transport === 'service'
        ? buildInProcessMcpServer(sandbox, { projectDir })
        : buildMcpServer(createBridge({ project: 'flow-lab', version: 'test' }), getBridgeToolSurface({ projectDir }));
      const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
      const agent = new Client({ name: 'capture-handoff', version: 'test' });
      await server.connect(serverWire); await agent.connect(clientWire);
      const call = async (method: 'listCaptures' | 'openCapture', args = {}) => {
        const response = await agent.callTool(transport === 'service'
          ? { name: 'sandbox', arguments: { method, args } }
          : { name: method === 'listCaptures' ? 'sandbox_list_captures' : 'sandbox_open_capture', arguments: args });
        expect(response.isError).not.toBe(true);
        const content = response.content as Array<{ type: string; text: string }>;
        return JSON.parse(content.find(block => block.type === 'text')!.text).data;
      };
      try {
        const listing = await call('listCaptures');
        for (const entry of saved) {
          expect(listing.captures.some((capture: { id: string }) => capture.id === entry.id)).toBe(true);
          const capture = await call('openCapture', { id: entry.id });
          expect(digest(capture)).toBe(entry.hash);
          const { frame } = capture;
          const incident = frame.incident;
          expect(frame.totals.writes).toBe(entry.writes);
          expect(incident.peak).toBeGreaterThan(incident.limit);
          expect(incident.aboveSeconds).toBeGreaterThanOrEqual(incident.sustainedSeconds);
          expect(capture.operations.length).toBeGreaterThan(0);
          expect(capture.replay.available).toBe(false);
          expect(capture.operationCoverage).toContain('20,000');
          expect(capture.measurement.scope).toBe('This page');
          expect(capture.measurement.notes.some((note: { text: string }) => note.text.includes(entry.service === 'rtdb' ? 'not billed download size' : 'Index scans'))).toBe(true);
          expect(capture.sessionFixture.scope).toContain('not the starting state');
          if (transport === 'service') {
            const operations = capture.operations.filter((event: { kind: string }) => event.kind === (entry.service === 'firestore' ? 'write' : 'operation'));
            const groups: Record<string, number> = {};
            for (const operation of operations) {
              const key = `${operation.method} ${operation.path}`;
              groups[key] = (groups[key] ?? 0) + 1;
            }
            evidence.push({ id: entry.id, service: entry.service, operation: incident.operation, limit: incident.limit, sustainedSeconds: incident.sustainedSeconds, peak: incident.peak, aboveSeconds: incident.aboveSeconds, duration: frame.duration, totals: frame.totals, operationGroups: groups, measurement: capture.measurement, gaps: [capture.operationCoverage, capture.sessionFixture.scope, capture.replay.reason] });
          }
        }
        expect((await call('openCapture')).frame.service.service).toBe(saved.at(-1)!.service);
        console.log(`PASS ${transport}: list, inspect saved incidents, open latest without live pages`);
      } finally { await agent.close(); await server.close(); }
    }
    expect(digest(await captureFullState(sandbox))).toBe(before);
    await writeFile(join(tmpdir(), 'pyric-capture-handoff-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally { sandbox.dispose(); }
}
