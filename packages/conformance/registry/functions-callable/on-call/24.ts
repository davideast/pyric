import { CLIENT, row } from './section.ts';

export default row({
  order: 240,
  kind: 'pyric',
  api: 'connectFunctionsEmulator(functions, host, port)',
  behavior:
    'connectFunctionsEmulator is accepted, calls keep routing to pyric\'s gateway, and pyric warns once that the emulator origin is ignored; no call goes to the named host and port.',
  evidence:
    'Owner decision (plan decision 5): honoring port 5001 would send calls to a server that is not running. Upstream sets `emulatorOrigin` and builds `${origin}/${projectId}/${region}/${name}` (' +
    CLIENT +
    ').',
});
