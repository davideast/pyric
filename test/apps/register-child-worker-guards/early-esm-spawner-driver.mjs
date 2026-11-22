import { resolve } from 'node:path';

const childProbe = resolve('sandbox-probe-child.mjs');
const res = globalThis.__earlyEsmSpawnSync(process.execPath, [childProbe], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { PATH: process.env.PATH },
});
const line = (res.stdout || '').split('\n').find((entry) => entry.startsWith('PROBE '));
console.log(
  `EARLY_ESM_OUTCOME ${JSON.stringify({
    status: res.status,
    parentActive: globalThis[Symbol.for('pyric.register.active')] === true,
    probe: line ? JSON.parse(line.slice('PROBE '.length)) : null,
  })}`,
);
