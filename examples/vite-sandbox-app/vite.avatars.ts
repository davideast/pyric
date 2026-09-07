import type { AssetRequest, AssetResult } from '@pyric/cli/vite';

// Avatar source for the `avatars` option in vite.config.ts: generates each user's
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
