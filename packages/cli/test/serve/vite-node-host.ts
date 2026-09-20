import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface ViteNodeHost {
  port: number;
  close(): Promise<void>;
}

/** Run Vite on its supported Node host; the test runner only drives the wire. */
export async function startViteNodeHost(root: string): Promise<ViteNodeHost> {
  const script = fileURLToPath(new URL('./fixtures/vite-node-host.mjs', import.meta.url));
  const child = fork(script, [root], {
    execPath: process.env.PYRIC_TEST_NODE ?? 'node',
    execArgv: [],
    silent: true,
  });
  const ready = Promise.withResolvers<number>();
  const exited = Promise.withResolvers<number | null>();
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', error => { ready.reject(error); exited.reject(error); });
  void exited.promise.catch(() => {});
  child.once('exit', code => {
    exited.resolve(code);
    ready.reject(new Error(`Vite exited before readiness (${code}): ${stderr}`));
  });
  child.once('message', (message: unknown) => {
    const isEnvelope = typeof message === 'object' && message !== null && 'port' in message;
    const hasNoEnvelope = !isEnvelope;
    if (hasNoEnvelope) {
      ready.reject(new Error('Vite sent invalid readiness'));
      return;
    }
    const port = message.port;
    const hasInvalidPort = typeof port !== 'number';
    if (hasInvalidPort) {
      ready.reject(new Error('Vite readiness omitted its port'));
      return;
    }
    ready.resolve(port);
  });
  const deadline = setTimeout(() => ready.reject(new Error(`Vite startup timed out: ${stderr}`)), 30_000);
  let port: number;
  try {
    port = await ready.promise;
  } catch (error) {
    child.kill('SIGKILL');
    await exited.promise.catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  return {
    port,
    async close() {
      const isRunning = child.exitCode === null && child.signalCode === null;
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        if (isRunning) child.send('close');
        const code = await exited.promise;
        const failedToClose = code !== 0;
        if (failedToClose) throw new Error(`Vite did not close cleanly (${code}): ${stderr}`);
      } catch (error) {
        child.kill('SIGKILL');
        await exited.promise.catch(() => {});
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
