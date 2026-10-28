/**
 * What the network guard refuses once the real-admin tripwire fires (#1475).
 *
 * A plain `block` guard refuses the hosts in the endpoint catalog. The
 * tripwire widens that to every Google host: `*.googleapis.com`,
 * `*.firebaseio.com`, `*.firebasedatabase.app`, `*.cloudfunctions.net`,
 * `*.run.app`, and the GCE metadata server in each of its names. A real
 * `firebase-admin` holding this machine's credentials reaches Google APIs no
 * catalog lists (`oauth2`, `firebaserules`, `firebaseremoteconfig`), and
 * `PYRIC_GUARD_ALLOW` is then the only way through.
 *
 * These drive `evaluateEgress` and `installNetGuard` with stand-in seams, so
 * no socket opens.
 */
import { describe, expect, it } from 'bun:test';
import { GOOGLE_ENDPOINT_CATALOG } from '../../src/google-endpoints.js';
import { lookupGoogleHost } from '../../src/google-hosts.js';
import { evaluateEgress, installNetGuard, wrapDispatcher } from '../../src/register/net-guard.js';

const UNLISTED_APIS = [
  'oauth2.googleapis.com',
  'firebaserules.googleapis.com',
  'firebaseremoteconfig.googleapis.com',
  'cloudtasks.googleapis.com',
  'iamcredentials.googleapis.com',
  'firebaseappcheck.googleapis.com',
  'firebasedataconnect.googleapis.com',
  'eventarcpublishing.googleapis.com',
];

/** Every name and spelling a process can reach the GCE metadata server by. */
const METADATA_NAMES = [
  '169.254.169.254',
  '2852039166',
  '0xa9fea9fe',
  '::ffff:169.254.169.254',
  'metadata.google.internal',
  'METADATA.google.internal.',
  'metadata',
  'fd20:ce::254',
  '[fd20:ce:0:0:0:0:0:254]',
];

const tripped = { mode: 'block' as const, allow: [] as string[], scope: 'google' as const };
const plainBlock = { mode: 'block' as const, allow: [] as string[] };

describe('lookupGoogleHost', () => {
  it('covers every catalog host, so the tripwire never refuses less than block', () => {
    for (const entry of GOOGLE_ENDPOINT_CATALOG) {
      expect(lookupGoogleHost(entry.host), entry.host).toBeDefined();
    }
  });

  it('names the catalog service where the catalog has one', () => {
    expect(lookupGoogleHost('firestore.googleapis.com')?.service).toBe('Cloud Firestore');
    expect(lookupGoogleHost('firebaserules.googleapis.com')?.service).toBe('a Google API');
    expect(lookupGoogleHost('svc-abc-uc.a.run.app')?.service).toBe('Cloud Run');
  });

  it('matches on label boundaries only', () => {
    expect(lookupGoogleHost('googleapis.com.example.com')).toBeUndefined();
    expect(lookupGoogleHost('notgoogleapis.com')).toBeUndefined();
    expect(lookupGoogleHost('mymetadata')).toBeUndefined();
    expect(lookupGoogleHost('example.com')).toBeUndefined();
  });
});

describe('evaluateEgress after the tripwire', () => {
  it('refuses Google APIs the catalog does not list', () => {
    for (const host of UNLISTED_APIS) {
      expect(evaluateEgress(host, tripped), host).toMatchObject({ verdict: 'block', permitted: false, host });
    }
    expect(evaluateEgress('svc-abc-uc.a.run.app', tripped)).toMatchObject({ verdict: 'block', service: 'Cloud Run' });
  });

  it('refuses the metadata server under every name, whatever the allowlist says', () => {
    for (const name of METADATA_NAMES) {
      const allowAll = { ...tripped, allow: [name, 'metadata', 'metadata.google.internal'] };
      expect(evaluateEgress(name, allowAll), name).toMatchObject({
        verdict: 'block',
        permitted: false,
        alwaysBlock: true,
        service: 'GCE metadata server',
      });
    }
  });

  it('lets PYRIC_GUARD_ALLOW through, and nothing else', () => {
    const allow = { ...tripped, allow: ['firebaserules.googleapis.com'] };
    expect(evaluateEgress('firebaserules.googleapis.com', allow)).toMatchObject({ verdict: 'allow', permitted: true });
    expect(evaluateEgress('oauth2.googleapis.com', allow)).toMatchObject({ verdict: 'block' });
  });

  it('lets Google Fonts through by exact name, while oauth2 and the metadata server stay refused', () => {
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'FONTS.googleapis.com.']) {
      expect(evaluateEgress(host, tripped), host).toBeNull();
    }
    // Exact names only: no subdomain, lookalike or sibling rides the exemption.
    for (const host of ['x.fonts.googleapis.com', 'fonts.googleapis.com.evil.googleapis.com', 'oauth2.googleapis.com']) {
      expect(evaluateEgress(host, tripped), host).toMatchObject({ verdict: 'block', permitted: false });
    }
    for (const name of METADATA_NAMES) {
      expect(evaluateEgress(name, tripped), name).toMatchObject({ verdict: 'block', alwaysBlock: true });
    }
  });

  it('leaves other hosts alone', () => {
    expect(evaluateEgress('example.com', tripped)).toBeNull();
    expect(evaluateEgress('127.0.0.1', tripped)).toBeNull();
  });
});

describe('evaluateEgress under plain block', () => {
  it('keeps the catalog list', () => {
    for (const host of UNLISTED_APIS) expect(evaluateEgress(host, plainBlock), host).toBeNull();
    expect(evaluateEgress('svc-abc-uc.a.run.app', plainBlock)).toBeNull();
    expect(evaluateEgress('metadata', plainBlock)).toBeNull();
    expect(evaluateEgress('firestore.googleapis.com', plainBlock)).toMatchObject({ verdict: 'block' });
  });
});

describe('the refusal line after the tripwire', () => {
  it('names PYRIC_GUARD_ALLOW as the one way through, not PYRIC_GUARD=warn', () => {
    const lines: string[] = [];
    const real = { dispatch: (): boolean => true };
    const wrapped = wrapDispatcher(real, { ...tripped, write: (line) => void lines.push(line) });
    expect(() => wrapped.dispatch({ origin: 'https://oauth2.googleapis.com', path: '/token' }, {})).toThrow(
      expect.objectContaining({ code: 'PYRIC_GUARD_BLOCKED' }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('BLOCK oauth2.googleapis.com');
    expect(lines[0]).toContain('PYRIC_GUARD_ALLOW=oauth2.googleapis.com');
    expect(lines[0]).not.toContain('PYRIC_GUARD=warn');
  });
});

describe('NetGuard.escalate', () => {
  const noNet = { connect: () => ({}), createConnection: () => ({}) };
  const noTls = { connect: () => ({}) };
  const noPrototypes = { agentPrototypes: [], socketPrototypes: [], requestPrototypes: [] };
  const UNDICI = Symbol.for('undici.globalDispatcher.1');

  function installed(mode: string) {
    const calls: unknown[] = [];
    const scope: Record<symbol, unknown> = { [UNDICI]: { dispatch: (opts: unknown) => calls.push(opts) } };
    const lines: string[] = [];
    const env: Record<string, string | undefined> = { PYRIC_SANDBOX: '1', PYRIC_GUARD: mode };
    const guard = installNetGuard({
      scope,
      env,
      write: (line) => void lines.push(line),
      net: noNet,
      tls: noTls,
      ...noPrototypes,
    })!;
    const dispatch = (host: string): unknown =>
      (scope[UNDICI] as { dispatch: (o: unknown, h: unknown) => unknown }).dispatch({ origin: `https://${host}` }, {});
    return { guard, lines, env, calls, dispatch };
  }

  it('to every Google host refuses unlisted APIs, from warn', () => {
    const { guard, lines, dispatch } = installed('warn');
    expect(guard.escalate('the real firebase-admin loaded', 'google')).toBe(true);
    expect(guard.mode).toBe('block');
    expect(() => dispatch('firebaserules.googleapis.com')).toThrow(expect.objectContaining({ code: 'PYRIC_GUARD_BLOCKED' }));
    const escalation = lines.find((line) => line.includes('escalated to block'))!;
    expect(escalation).toContain('the real firebase-admin loaded');
    expect(escalation).toContain(
      'refuses every connection to *.googleapis.com, *.firebaseio.com, *.firebasedatabase.app, ' +
        '*.cloudfunctions.net and *.run.app',
    );
    expect(escalation).toContain('the GCE metadata server (169.254.169.254, metadata.google.internal, metadata, fd20:ce::254)');
    expect(escalation).toContain('except Google Fonts (fonts.googleapis.com and fonts.gstatic.com)');
    expect(escalation).toContain('PYRIC_GUARD_ALLOW permits a host on purpose, but never the metadata server');
    expect(escalation).not.toContain('Google/Firebase endpoints');
  });

  it('to every Google host widens a block guard too', () => {
    const { guard, dispatch, lines } = installed('block');
    expect(() => dispatch('oauth2.googleapis.com')).not.toThrow();
    expect(guard.escalate('the real firebase-admin loaded', 'google')).toBe(true);
    expect(() => dispatch('oauth2.googleapis.com')).toThrow(expect.objectContaining({ code: 'PYRIC_GUARD_BLOCKED' }));
    expect(lines.filter((line) => line.includes('escalated to block'))).toHaveLength(1);
    // Once is enough: a second escalation changes nothing and says nothing.
    expect(guard.escalate('again', 'google')).toBe(false);
    expect(guard.escalate('again')).toBe(false);
    expect(lines.filter((line) => line.includes('escalated to block'))).toHaveLength(1);
  });

  it('to the catalog keeps the catalog list, and its line names those hosts', () => {
    const { guard, dispatch, lines } = installed('warn');
    expect(guard.escalate('withPyric runs the Next dev server')).toBe(true);
    expect(() => dispatch('oauth2.googleapis.com')).not.toThrow();
    expect(() => dispatch('firestore.googleapis.com')).toThrow(expect.objectContaining({ code: 'PYRIC_GUARD_BLOCKED' }));
    const escalation = lines.find((line) => line.includes('escalated to block'))!;
    expect(escalation).toContain('refuses every connection to the hosts in its endpoint catalog (identitytoolkit.googleapis.com,');
    expect(escalation).toContain('metadata.google.internal)');
    expect(escalation).toContain('PYRIC_GUARD_ALLOW permits a host on purpose, but never the metadata server');
  });

  it('sets PYRIC_GUARD=block in the environment, so children started later inherit it', () => {
    const tripwire = installed('warn');
    tripwire.guard.escalate('the real firebase-admin loaded', 'google');
    expect(tripwire.env.PYRIC_GUARD).toBe('block');

    const dev = installed('');
    dev.guard.escalate('withPyric runs the Next dev server');
    expect(dev.env.PYRIC_GUARD).toBe('block');
  });
});
