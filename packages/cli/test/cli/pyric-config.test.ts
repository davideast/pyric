import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPyricConfig, readPyricConfigSync } from '../../src/cli/pyric-config.js';

describe('pyric-config', () => {
  it('returns empty defaults when pyric.json does not exist (async)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-config-none-'));
    try {
      const config = await readPyricConfig(tmp);
      expect(config).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty defaults when pyric.json does not exist (sync)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-config-none-'));
    try {
      const config = readPyricConfigSync(tmp);
      expect(config).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('parses valid pyric.json with command and port', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-config-valid-'));
    try {
      writeFileSync(
        join(tmp, 'pyric.json'),
        JSON.stringify({
          command: 'next dev',
          port: 4400,
          rules: 'security/firestore.rules',
          project: 'my-project',
        }),
      );
      const config = await readPyricConfig(tmp);
      expect(config.command).toBe('next dev');
      expect(config.port).toBe(4400);
      expect(config.rules).toBe('security/firestore.rules');
      expect(config.project).toBe('my-project');

      const configSync = readPyricConfigSync(tmp);
      expect(configSync).toEqual(config);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('parses rules as an object', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-config-rules-'));
    try {
      writeFileSync(
        join(tmp, 'pyric.json'),
        JSON.stringify({
          rules: {
            firestore: 'firestore.rules',
            database: 'database.rules.json',
          },
        }),
      );
      const config = await readPyricConfig(tmp);
      expect(config.rules).toEqual({
        firestore: 'firestore.rules',
        database: 'database.rules.json',
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws descriptive error on malformed JSON', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-config-malformed-'));
    try {
      writeFileSync(join(tmp, 'pyric.json'), '{ malformed');
      expect(readPyricConfig(tmp)).rejects.toThrow('pyric: failed to parse pyric.json');
      expect(() => readPyricConfigSync(tmp)).toThrow('pyric: failed to parse pyric.json');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
