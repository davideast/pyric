import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPyricConfig } from '../../src/cli/pyric-config.js';
import { useTempDirs } from '../use-temp-dirs.js';

const makeTempDir = useTempDirs('pyric-config-');

describe('pyric-config', () => {
  it('returns empty defaults when pyric.json does not exist', async () => {
    const tmp = makeTempDir('pyric-config-none-');
    const config = await readPyricConfig(tmp);
    expect(config).toEqual({});
  });

  it('parses valid pyric.json with command and port', async () => {
    const tmp = makeTempDir('pyric-config-valid-');
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
  });

  it('parses rules as an object', async () => {
    const tmp = makeTempDir('pyric-config-rules-');
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
  });

  it('parses ai configuration matching PyricAiOptions (#373)', async () => {
    const tmp = makeTempDir('pyric-config-ai-');
    writeFileSync(
      join(tmp, 'pyric.json'),
      JSON.stringify({
        ai: {
          mode: 'sandbox',
          engine: {
            kind: 'openai',
            model: 'llama3.2',
            modelMap: { 'gemini-2.5-flash': 'llama3.2' },
          },
          proxyUpstream: 'http://127.0.0.1:11434/v1',
        },
      }),
    );
    const config = await readPyricConfig(tmp);
    expect(config.ai).toEqual({
      mode: 'sandbox',
      engine: {
        kind: 'openai',
        model: 'llama3.2',
        modelMap: { 'gemini-2.5-flash': 'llama3.2' },
      },
      proxyUpstream: 'http://127.0.0.1:11434/v1',
    });
  });

  it('rejects malformed or unknown ai keys in pyric.json (#373)', async () => {
    const nonObject = makeTempDir('pyric-config-ai-nonobj-');
    writeFileSync(join(nonObject, 'pyric.json'), JSON.stringify({ ai: 'llama3.2' }));
    await expect(readPyricConfig(nonObject)).rejects.toThrow("invalid 'ai' in pyric.json");

    const unknownKey = makeTempDir('pyric-config-ai-unknown-');
    writeFileSync(join(unknownKey, 'pyric.json'), JSON.stringify({ ai: { ollama: 'llama3.2' } }));
    await expect(readPyricConfig(unknownKey)).rejects.toThrow("unknown 'ai.ollama' in pyric.json");

    const badMode = makeTempDir('pyric-config-ai-mode-');
    writeFileSync(join(badMode, 'pyric.json'), JSON.stringify({ ai: { mode: 'staging' } }));
    await expect(readPyricConfig(badMode)).rejects.toThrow("invalid 'ai.mode' in pyric.json");

    const badModel = makeTempDir('pyric-config-ai-model-');
    writeFileSync(join(badModel, 'pyric.json'), JSON.stringify({ ai: { model: 123 } }));
    await expect(readPyricConfig(badModel)).rejects.toThrow("invalid 'ai.model' in pyric.json");

    const badEngine = makeTempDir('pyric-config-ai-engine-');
    writeFileSync(join(badEngine, 'pyric.json'), JSON.stringify({ ai: { engine: { kind: 'custom' } } }));
    await expect(readPyricConfig(badEngine)).rejects.toThrow("invalid 'ai.engine' in pyric.json");
  });

  it('throws descriptive error on malformed JSON', async () => {
    const tmp = makeTempDir('pyric-config-malformed-');
    writeFileSync(join(tmp, 'pyric.json'), '{ malformed');
    await expect(readPyricConfig(tmp)).rejects.toThrow('pyric: failed to parse pyric.json');
  });
});
