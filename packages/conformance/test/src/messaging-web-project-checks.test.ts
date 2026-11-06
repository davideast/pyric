import { describe, expect, it } from 'bun:test';
import { createECDH } from 'node:crypto';
import { messagingWebProjectProblems } from '../../src/capture/messaging-web/project-checks.ts';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const VAPID_KEY = ecdh.getPublicKey().toString('base64url');

const config = {
  projectId: 'digame-mas',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:0a1b2c3d4e5f6a7b8c9d0e',
};

describe('messagingWebProjectProblems', () => {
  it('finds nothing when the config, sender id, and VAPID key fit the credential project', () => {
    expect(messagingWebProjectProblems(config, VAPID_KEY, 'digame-mas')).toEqual([]);
  });

  it('refuses a web config from another project', () => {
    const problems = messagingWebProjectProblems({ ...config, projectId: 'genkit-idx' }, VAPID_KEY, 'digame-mas');
    expect(problems).toEqual([
      'PYRIC_MESSAGING_FIREBASE_CONFIG is for project genkit-idx, but the send credential is for digame-mas. Token registration and sends need the same project.',
    ]);
  });

  it('refuses a web config with no project', () => {
    const { projectId: _projectId, ...noProject } = config;
    const problems = messagingWebProjectProblems(noProject, VAPID_KEY, 'digame-mas');
    expect(problems[0]).toContain('is for project (none)');
  });

  it('refuses a missing or non-numeric sender id', () => {
    const { messagingSenderId: _senderId, ...noSender } = config;
    expect(messagingWebProjectProblems(noSender, VAPID_KEY, 'digame-mas')).toEqual([
      'PYRIC_MESSAGING_FIREBASE_CONFIG has no numeric messagingSenderId (found (none)).',
    ]);
    expect(messagingWebProjectProblems({ ...config, messagingSenderId: 'digame-mas' }, VAPID_KEY, 'digame-mas')[0])
      .toContain('found digame-mas');
  });

  it('refuses a sender id that is not the project number in the app id', () => {
    const problems = messagingWebProjectProblems({ ...config, messagingSenderId: '999' }, VAPID_KEY, 'digame-mas');
    expect(problems).toEqual([
      'PYRIC_MESSAGING_FIREBASE_CONFIG has messagingSenderId 999, but its appId 1:123456789012:web:0a1b2c3d4e5f6a7b8c9d0e is not a web app of that project number.',
    ]);
  });

  it('refuses an app id that is not a web app id', () => {
    const problems = messagingWebProjectProblems({ ...config, appId: '1:123456789012:android:abc' }, VAPID_KEY, 'digame-mas');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not a web app of that project number');
  });

  it('refuses a VAPID value that is not an uncompressed P-256 public key', () => {
    const notKeys = [
      '',
      'not a key',
      VAPID_KEY.slice(0, -4),
      Buffer.from([0x02, ...ecdh.getPublicKey().subarray(1)]).toString('base64url'),
      ecdh.getPrivateKey().toString('base64url'),
    ];
    for (const value of notKeys) {
      const problems = messagingWebProjectProblems(config, value, 'digame-mas');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('PYRIC_MESSAGING_VAPID_KEY is not a Web Push certificate public key');
    }
  });

  it('reports every problem at once', () => {
    const problems = messagingWebProjectProblems({ projectId: 'other' }, 'x', 'digame-mas');
    expect(problems).toHaveLength(3);
  });
});
