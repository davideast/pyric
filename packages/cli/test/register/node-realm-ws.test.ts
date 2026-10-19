/**
 * The installed `ws` still gives the Node host client a socket to unreference
 * (#1082). If a `ws` upgrade stops emitting `'upgrade'` with the upgraded
 * `net.Socket`, this fails, rather than Node processes silently staying up
 * while their connection to the host is open. It runs the realm under Node in
 * a child process: Bun swaps `ws` for its own WebSocket.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/node-realm-ws.mjs', import.meta.url));
const distRealm = pathToFileURL(fileURLToPath(new URL('../../dist/register/client/node-realm.js', import.meta.url))).href;

describe('the ws socket the Node host client unreferences', () => {
  it("is the net.Socket ws hands out on its public 'upgrade' event, and a release without one warns once", () => {
    const result = spawnSync('node', [fixture, distRealm], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(outcome.upgradeGivesNetSocket).toBe(true);
    expect(outcome.unreferenced).toBe(true);
    expect(outcome.warningsWithSocket).toBe(0);
    expect(outcome.warningsWithoutSocket).toBe(1);
    expect(String(outcome.warning)).toContain('stays up while its connection to the Node host is open');
  }, 30_000);
});
