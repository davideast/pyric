import { expect, it } from 'bun:test';
import type { RegisterOptions } from 'pyric/messaging';
import type { RegisterOptions as SwRegisterOptions } from 'pyric/messaging/sw';
import type { RegisterOptions as UpstreamRegisterOptions } from 'firebase/messaging';
import type { RegisterOptions as UpstreamSwRegisterOptions } from 'firebase/messaging/sw';

type Assignable<From, To> = [From] extends [To] ? true : false;
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

function assertType<T extends true>(): void {}

function verifyMessagingRegisterOptionsCompile(): void {
  assertType<Assignable<RegisterOptions, UpstreamRegisterOptions>>();
  assertType<Assignable<UpstreamRegisterOptions, RegisterOptions>>();
  assertType<Exact<RegisterOptions, UpstreamRegisterOptions>>();

  assertType<Assignable<SwRegisterOptions, UpstreamSwRegisterOptions>>();
  assertType<Assignable<UpstreamSwRegisterOptions, SwRegisterOptions>>();
  assertType<Exact<SwRegisterOptions, UpstreamSwRegisterOptions>>();
  assertType<Exact<RegisterOptions, SwRegisterOptions>>();

  const options: RegisterOptions = {
    vapidKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  };
  const upstreamClient: UpstreamRegisterOptions = options;
  const swOptions: SwRegisterOptions = upstreamClient;
  const upstreamSw: UpstreamSwRegisterOptions = swOptions;
  void upstreamSw;
}

it('pyric/messaging and pyric/messaging/sw RegisterOptions match upstream firebase declarations under strict tsc', () => {
  verifyMessagingRegisterOptionsCompile();
  const result = Bun.spawnSync(
    [
      process.execPath,
      'x',
      'tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'ES2022',
      '--moduleResolution',
      'bundler',
      '--target',
      'ES2022',
      '--types',
      'bun-types',
      'test/messaging/types.test.ts',
    ],
    {
      cwd: `${import.meta.dir}/../..`,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(0);
}, 30_000);
