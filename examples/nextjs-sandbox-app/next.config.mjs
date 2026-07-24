import { fileURLToPath } from 'node:url';
import { withPyric } from '@pyric/cli/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    'localhost:3000',
    '127.0.0.1:3000',
    'localhost:4000',
    '127.0.0.1:4000',
    'localhost:4288',
    '127.0.0.1:4288',
    'localhost:4289',
    '127.0.0.1:4289',
  ],
};

// Under development mode (`pyric dev -- next dev`), withPyric maps client-side
// firebase/* SDK imports to Pyric sandbox adapters via Webpack/Turbopack aliases,
// externalizes server-side firebase and firebase-admin imports for Node loader
// hooks (@pyric/cli/register), and proxies /__pyric/* bridge traffic.
// Under `next build` (mode production), withPyric acts as an identity passthrough,
// compiling canonical Firebase SDKs untouched with zero runtime overhead.
export default withPyric(nextConfig);
