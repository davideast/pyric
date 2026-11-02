// A repro script that breaks the sandbox's rule: it leaves a link where the
// harness writes the try's phase output once the sandbox stops, pointing at
// a file of the host's. The harness must refuse to touch it and call the
// try invalid, not inconclusive.
import { symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = dirname(process.env.PYRIC_BUILDER_NETWORK_LOG ?? '');
symlinkSync('/etc/hostname', join(root, 'logs', '02-repro-phase.log'));
console.log('left a link at logs/02-repro-phase.log');
process.exit(1);
