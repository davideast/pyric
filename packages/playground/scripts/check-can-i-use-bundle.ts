import { gzipSync } from 'node:zlib';

const result = await Bun.build({
  entrypoints: [new URL('../src/lib/tools/core/can-i-use.ts', import.meta.url).pathname],
  target: 'browser',
  minify: true,
  write: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const GZIP_BUDGET_BYTES = 90_000;

const firstOutput = result.outputs[0];
if (!firstOutput) {
  throw new Error('Browser can-i-use build produced no output bundle');
}
const source = await firstOutput.text();
const gzipBytes = gzipSync(source).byteLength;
if (/[,{](?:"claims"|claims):/.test(source) || source.includes('CONFORMANCE_IMPORT_EVIDENCE')) {
  throw new Error('Browser can-i-use bundle contains Node-only claim evidence');
}
if (gzipBytes > GZIP_BUDGET_BYTES) {
  throw new Error(`Browser can-i-use bundle is ${gzipBytes} gzip bytes; budget is ${GZIP_BUDGET_BYTES}`);
}
console.log(`Browser can-i-use bundle: ${source.length} bytes raw, ${gzipBytes} bytes gzip`);
