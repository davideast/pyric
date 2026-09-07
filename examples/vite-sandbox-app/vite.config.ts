import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';
import type { AssetRequest, AssetResult } from '@pyric/cli/vite';

// Under `vite dev` pyric() swaps firebase/* to the in-process pyric
// sandbox and deploys + hot-reloads firestore.rules — no Firebase project,
// credentials, or emulators. `vite build` (mode production) ships the real
// firebase package; the swap never reaches the deployed artifact. For a
// self-contained sandbox preview you can serve under `pyric sandbox`, build with a
// non-production mode: `vite build --mode development` (see the `build:sandbox`
// script). That output is marked and can never be deployed.

// Avatar source for the `avatars` option below: generates each user's
// profile photo once with the Gemini image API (Nano Banana,
// gemini-3.1-flash-image) and returns the bytes to pyric, which caches
// them under .pyric/assets/avatars/. The first sign-in per user pays for
// one generation; every later request and session serves the cached file.
// Runs in the dev server process, never the browser, so GEMINI_API_KEY
// stays out of the page. A thrown error (missing key, network, quota)
// falls back to the built-in generated avatar without caching, so the
// next sign-in retries.
export async function nanoBananaAvatar({ seed, context }: AssetRequest): Promise<AssetResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('nanoBananaAvatar needs GEMINI_API_KEY in the environment');
  }
  const name = typeof context.displayName === 'string' ? context.displayName : 'a mystery developer';
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gemini-3.1-flash-image',
      input: [
        {
          type: 'text',
          text:
            `A friendly square cartoon avatar portrait of ${name}, bold flat colors, ` +
            `simple shapes, centered head and shoulders, plain background. ` +
            `Vary the look using this style code: ${seed}.`,
        },
      ],
      // The interactions endpoint currently supports only image/jpeg.
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1' },
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini image request failed: ${response.status} ${await response.text()}`);
  }
  // Raw interactions responses carry the image inside a model_output step:
  // steps[].content[] blocks of { type: 'image', mime_type, data (base64) }.
  const interaction = (await response.json()) as {
    steps?: Array<{ content?: Array<{ type: string; mime_type?: string; data?: string }> }>;
  };
  const image = interaction.steps
    ?.flatMap((step) => step.content ?? [])
    .find((block) => block.type === 'image' && block.data !== undefined);
  if (image === undefined || image.data === undefined || image.mime_type === undefined) {
    throw new Error('Gemini image response carried no image block');
  }
  return {
    data: Buffer.from(image.data, 'base64'),
    contentType: image.mime_type,
  };
}

export default defineConfig({
  plugins: [
    pyric({
      // Profile photos for provider sign-ins. The default needs no
      // configuration: every federated sign-in gets a deterministic
      // generated avatar. Comment exactly one option back in to try the
      // alternatives.

      // Firebase-null behaviour — photoURL stays null and the avatar
      // route unmounts:
      // avatars: false,

      // A pre-created avatar set: a directory holding a manifest.json and
      // image files; each user is deterministically assigned one:
      // avatars: './avatars',

      // Generate real avatars once per user with Nano Banana (needs
      // GEMINI_API_KEY; see nanoBananaAvatar above):
      // avatars: { source: nanoBananaAvatar },
    }),
  ],
});
