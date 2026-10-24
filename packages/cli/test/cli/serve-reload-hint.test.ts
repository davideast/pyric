import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe } from '../../src/cli/serve.js';

describe('pyric sandbox rules hot-reload hint', () => {
  it('prints the verify hint once per session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-reload-hint-'));
    writeFileSync(join(cwd, 'database.rules.json'), JSON.stringify({ rules: { '.read': false } }));
    
    let logged = '';
    const logger = {
      note: (msg: string) => { logged += msg + '\n'; },
      info: (msg: string) => { logged += msg + '\n'; },
      warn: (msg: string) => { logged += msg + '\n'; },
    };

    const runtime = await startServe({ cwd, port: 0, watch: true, logger });
    try {
      logged = ''; // Clear startup logs
      
      // First reload
      writeFileSync(join(cwd, 'database.rules.json'), JSON.stringify({ rules: { '.read': true } }));
      
      // Wait for reload log
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (logged.includes('rules reloaded')) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
      
      expect(logged).toContain('(run `pyric verify` to test against past sessions)');
      
      logged = ''; // Clear first reload logs
      
      // Second reload
      writeFileSync(join(cwd, 'database.rules.json'), JSON.stringify({ rules: { '.read': false, '.write': true } }));
      
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (logged.includes('rules reloaded')) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
      
      expect(logged).not.toContain('(run `pyric verify` to test against past sessions)');
    } finally {
      await runtime.handle.stop();
    }
  });
});
