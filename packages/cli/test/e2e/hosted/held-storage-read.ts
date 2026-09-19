import { writeFileSync } from 'node:fs';

/** Pause the fixture object's real binary reads; SIGUSR2 releases/rearms them. */
export function writeHeldStorageReadPreload(preload: string, failsFirstReads: boolean): void {
  writeFileSync(preload, `
    import { subscribe } from 'node:diagnostics_channel';
    subscribe('http.server.request.start', ({ request }) => {
      const isPipelineEnd = request.headers['x-pyric-test-pipeline-end'] === '1';
      if (isPipelineEnd) process.stderr.write('HTTP pipeline received\\n');
    });
    const readBytes = Blob.prototype.arrayBuffer;
    let holding = true;
    let failsReads = ${failsFirstReads};
    const held = [];
    const release = request => {
      if (failsReads) request.reject(new Error('Controlled binary read failure'));
      else request.resolve();
    };
    process.on('SIGUSR1', () => {
      const request = held.shift();
      const hasRequest = request !== undefined;
      if (hasRequest) release(request);
    });
    process.on('SIGUSR2', () => {
      holding = !holding;
      if (holding) { process.stderr.write('ARMED\\n'); return; }
      for (const request of held.splice(0)) release(request);
      failsReads = false;
    });
    Blob.prototype.arrayBuffer = async function () {
      const pausesRead = holding && this.type === 'application/x-pyric-held';
      if (pausesRead) {
        process.stderr.write('HELD\\n');
        await new Promise((resolve, reject) => held.push({ resolve, reject }));
      }
      return readBytes.call(this);
    };
  `);
}
