import { withPyric } from '@pyric/cli/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

// Under development mode (`pyric dev -- next dev`), withPyric maps client-side
// firebase/* SDK imports to Pyric sandbox adapters via Webpack/Turbopack aliases,
// externalizes server-side firebase and firebase-admin imports for Node loader
// hooks (@pyric/cli/register), and proxies /__pyric/* bridge traffic.
// Under `next build` (mode production), withPyric acts as an identity passthrough,
// compiling canonical Firebase SDKs untouched with zero runtime overhead.
export default withPyric(nextConfig);
