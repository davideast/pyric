// A repro script for the fake builder's planted problem `fake-1`: it checks
// it runs in a fresh app with the packed @pyric/cli installed, then reports
// that the problem shows (exit 1), with the text `--expect` looks for.
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('node_modules/@pyric/cli/package.json', 'utf8'));
console.log(`installed ${manifest.name}@${manifest.version}, reproducing ${process.env.PYRIC_REPRO_PROBLEM}`);
console.log('planted problem shows');
process.exit(1);
