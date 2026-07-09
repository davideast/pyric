/**
 * `buildApiKeyField` — translates a `ProviderDef` into the shape
 * `ApiKeyForm` consumes. Centralized so the BYOK modal on `HomePage`
 * and `PlaygroundPage` stay in sync (they render the same form), and
 * so per-provider quirks (Ollama's CORS hint, URL validation) land in
 * one place.
 *
 * The translation handles both BYOK slot kinds — `apiKey` slots map
 * to a password input with the "Get one at <helpUrl>" hint, and
 * `baseUrl` slots map to a `type=url` input pre-filled with the
 * stored override (or the default URL when none is set) plus an
 * inline CORS warning for Ollama specifically.
 */
import type { ApiKeyField } from './ApiKeyForm';
import { OpenRouterSignIn } from './OpenRouterSignIn';
import { validateBaseUrl } from '~/lib/llm/byok';
import type { ProviderDef } from '~/lib/llm/registry';

const OLLAMA_FAQ_URL =
  'https://github.com/ollama/ollama/blob/main/docs/faq.md#how-do-i-configure-ollama-server';

export interface BuildApiKeyFieldOpts {
  /** Only used by the `openrouter` row — see `OpenRouterSignIn`. */
  onKeyChanged?: () => void;
  /** Only used by the `openrouter` row — see `OpenRouterSignIn`. */
  openrouterSignInError?: string | null;
  /** Only used by the `openrouter` row — see `OpenRouterSignIn`. */
  onOpenrouterSignInRetry?: () => void;
}

export function buildApiKeyField(
  def: ProviderDef,
  opts: BuildApiKeyFieldOpts = {},
): ApiKeyField | null {
  // `none` slots (Claude local CLI) have no credential to collect —
  // auth is the CLI's own subscription login on the dev server. The
  // modal simply omits the row.
  if (def.byok.kind === 'none') return null;
  if (def.byok.kind === 'baseUrl') {
    // baseUrl slots always resolve to a string (stored override or
    // default). Render that as the prefilled initial value so the
    // user sees what they're about to save — vs. a password input
    // where prefilling would leak a secret.
    const current = def.byok.getKey() ?? def.byok.defaultBaseUrl;
    const isOllama = def.id === 'ollama';
    return {
      id: def.id,
      label: def.byok.label,
      variant: 'url',
      placeholder: def.byok.defaultBaseUrl,
      initialValue: current,
      hint: `Default: ${def.byok.defaultBaseUrl}. Type to override.`,
      validate: validateBaseUrl,
      ...(isOllama
        ? {
            warning: {
              body: (
                <>
                  Ollama blocks browser origins by default. Start the daemon with
                  {' '}
                  <code className="font-mono text-amber-100/90">
                    OLLAMA_ORIGINS=*
                  </code>
                  {' '}or your origin set. See the{' '}
                  <a
                    href={OLLAMA_FAQ_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline decoration-amber-400/60 hover:decoration-amber-200"
                  >
                    Ollama FAQ
                  </a>
                  .
                </>
              ),
            },
          }
        : {}),
    };
  }
  const has = def.byok.hasKey();
  const isOpenRouter = def.id === 'openrouter';
  return {
    id: def.id,
    label: def.byok.label,
    placeholder: has ? '••••••••••••' : '',
    hint: has
      ? 'Key is set. Type to replace.'
      : `Get one at ${def.byok.helpUrl.replace(/^https?:\/\//, '')}`,
    ...(isOpenRouter && opts.onKeyChanged
      ? {
          extra: (
            <OpenRouterSignIn
              onKeyChanged={opts.onKeyChanged}
              signInError={opts.openrouterSignInError}
              onRetry={opts.onOpenrouterSignInRetry}
            />
          ),
        }
      : {}),
  };
}
