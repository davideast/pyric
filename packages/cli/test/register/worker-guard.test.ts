/**
 * The register's worker-thread coverage (`src/register/worker-guard.ts`, #1442).
 *
 * Node runs `--import` preloads in a worker built from a file, a `data:` URL
 * or ESM source, but not in one built from CommonJS source with `eval: true`,
 * and not in one given an `execArgv` without the import when the register came
 * from the command line. `guardWorkerArguments` closes both, and leaves every
 * other worker as the caller built it.
 */
import { describe, expect, it } from 'bun:test';
import { guardWorkerArguments, installWorkerGuard } from '../../src/register/worker-guard.js';

const REGISTER_URL = 'file:///app/node_modules/@pyric/cli/dist/register/index.js';
const REGISTER_PATH = '/app/node_modules/@pyric/cli/dist/register/index.js';
const PREFIX = `typeof require === 'function' && require(${JSON.stringify(REGISTER_PATH)});`;

describe('guardWorkerArguments', () => {
  it('prefixes eval source with a require of the register that ESM source skips', () => {
    const [source, options] = guardWorkerArguments('console.log(1)', { eval: true }, REGISTER_URL);
    expect(source).toBe(`${PREFIX}\nconsole.log(1)`);
    expect(options).toEqual({ eval: true });
  });

  it('keeps a leading use strict directive first', () => {
    const [source] = guardWorkerArguments(`'use strict';\nconsole.log(1)`, { eval: true }, REGISTER_URL);
    expect(source).toBe(`'use strict';\n${PREFIX}\nconsole.log(1)`);
  });

  it('adds the register import to an explicit execArgv', () => {
    const [, options] = guardWorkerArguments('/app/worker.js', { execArgv: ['--no-warnings'] }, REGISTER_URL);
    expect(options).toEqual({ execArgv: ['--no-warnings', '--import', REGISTER_URL] });
  });

  it('leaves an explicit execArgv that already imports the register alone', () => {
    const execArgv = ['--import', REGISTER_URL];
    const [, options] = guardWorkerArguments('/app/worker.js', { execArgv }, REGISTER_URL);
    expect(options).toEqual({ execArgv: ['--import', REGISTER_URL] });
  });

  it('leaves a file worker that inherits the parent execArgv alone', () => {
    expect(guardWorkerArguments('/app/worker.js', undefined, REGISTER_URL)).toEqual(['/app/worker.js', undefined]);
    const url = new URL('file:///app/worker.js');
    expect(guardWorkerArguments(url, { workerData: 1 }, REGISTER_URL)).toEqual([url, { workerData: 1 }]);
  });

  it('never changes the options object the caller passed', () => {
    const options = { eval: true, execArgv: ['--no-warnings'] };
    guardWorkerArguments('console.log(1)', options, REGISTER_URL);
    expect(options).toEqual({ eval: true, execArgv: ['--no-warnings'] });
  });
});

describe('installWorkerGuard', () => {
  class FakeWorker {
    readonly args: unknown[];
    constructor(...args: unknown[]) {
      this.args = args;
    }
  }

  it('replaces Worker with a subclass that guards its arguments', () => {
    const workerThreads: { Worker: typeof FakeWorker } = { Worker: FakeWorker };
    installWorkerGuard(REGISTER_URL, workerThreads);
    const worker = new workerThreads.Worker('console.log(1)', { eval: true });
    expect(worker).toBeInstanceOf(FakeWorker);
    expect(worker.args[0]).toBe(`${PREFIX}\nconsole.log(1)`);
  });

  it('wraps only once', () => {
    const workerThreads: { Worker: typeof FakeWorker } = { Worker: FakeWorker };
    installWorkerGuard(REGISTER_URL, workerThreads);
    const once = workerThreads.Worker;
    installWorkerGuard(REGISTER_URL, workerThreads);
    expect(workerThreads.Worker).toBe(once);
  });
});
