# nextjs-sandbox-app

Reference example: a Firebase application built with **Next.js** and the
`@pyric/cli/next` (`withPyric`) configuration wrapper. This is the exact shape
scaffolding generates when using `pyric init --template nextjs` or
`npm create pyric@latest -- --template nextjs`, maintained here as an automated
verification test and integration reference.

During local development, the application runs entirely against Pyric's local
sandbox backend. It requires no Firebase project setup, cloud credentials, or
Java emulator installation.

- **Develop:** `bun run dev` or `npm run dev` runs `pyric sandbox -- next dev`.
  The `withPyric` wrapper automatically aliases client-side SDK imports to sandbox
  browser mirrors, preserves `@pyric/cli/register` Node runtime loader interception
  for Server Components and Route Handlers, and deploys your `firestore.rules`
  with real-time feedback in Pyric Studio.
- **Build for production:** `bun run build` or `npm run build` runs `next build`.
  Production mode triggers identity passthrough in `withPyric`, packaging the
  canonical `firebase` and `firebase-admin` SDKs without modification or runtime
  overhead. Configure `.env.local` or environment keys using `.env.example` as a reference.
- **Deploy:** `npx firebase-tools deploy` (via Firebase Web Frameworks) after production build, or deploy standard built artifacts directly to Vercel and cloud compute platforms.

> Your source code imports canonical `firebase/*` and `firebase-admin/*` specifiers
> uniformly. Switching between local sandbox environments and production cloud
> infrastructure occurs through the environment runtime (`pyric sandbox` vs `next build`),
> never requiring code edits.
