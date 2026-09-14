import { readFileSync } from 'node:fs';
import { startSoakServe } from '../soak/harness.js';

/** A real CLI process serving the normal SDK fixture from its own temporary project. */
export function startHostedFixture() {
  return startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    },
  });
}
