import { fileURLToPath } from 'node:url';
import { withPyric } from '@pyric/cli/next';

export default withPyric({
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
});
