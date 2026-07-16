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

const source = await result.outputs[0]!.text();
const gzipBytes = gzipSync(source).byteLength;
if (/[,{](?:"claims"|claims):/.test(source) || source.includes('CONFORMANCE_IMPORT_EVIDENCE')) {
  throw new Error('Browser can-i-use bundle contains Node-only claim evidence');
}
if (gzipBytes > 50_000) {
  throw new Error(`Browser can-i-use bundle is ${gzipBytes} gzip bytes; budget is 50000`);
}
console.log(`Browser can-i-use bundle: ${source.length} bytes raw, ${gzipBytes} bytes gzip`);
