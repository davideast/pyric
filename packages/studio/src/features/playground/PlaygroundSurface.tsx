import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconKey, IconSettings, IconUser } from '../../shell/icons.js';
import { PlaygroundModelControl } from './PlaygroundModelControl.js';

interface StudioSettingsMessage {
  type: 'pyric:studio:navigate-settings';
  section?: 'ai' | 'playground' | 'diagnostics';
}

/** playground → Studio: the current session breadcrumb, rendered on the left of
 *  the Prototype controls bar (the embedded playground suppresses its own
 *  in-workspace copy — see PlaygroundPage's postPlaygroundBreadcrumb). */
interface PlaygroundBreadcrumbMessage {
  type: 'pyric:playground:breadcrumb';
  rootLabel: string;
  rootHref: string;
  title: string | null;
}

function isPlaygroundBreadcrumbMessage(value: unknown): value is PlaygroundBreadcrumbMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'pyric:playground:breadcrumb'
  );
}

export type PlaygroundCommandMessage =
  | { type: 'pyric:playground:open-keys' }
  | { type: 'pyric:playground:open-settings' }
  | { type: 'pyric:playground:open-account' }
  | {
      type: 'pyric:playground:set-model';
      providerId: 'gemini' | 'openrouter' | 'ollama' | 'llamaServer';
      modelId: string;
      effort?: 'off' | 'low' | 'medium' | 'high';
    };

function isStudioSettingsMessage(value: unknown): value is StudioSettingsMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'pyric:studio:navigate-settings'
  );
}

export function playgroundEmbedSrc(
  base: string,
  origin = typeof window !== 'undefined' ? window.location.origin : 'https://pyric.local',
): string {
  const url = new URL(base, origin);
  url.searchParams.set('embed', 'studio');
  return url.origin === origin
    ? url.pathname + url.search + url.hash
    : url.href;
}

function playgroundSrc(): string {
  const base =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PYRIC_PLAYGROUND_URL) ||
    '/__pyric/playground/';
  return playgroundEmbedSrc(base, window.location.origin);
}

export function postPlaygroundCommand(
  frame: HTMLIFrameElement | null,
  message: PlaygroundCommandMessage,
): void {
  if (typeof window === 'undefined') return;
  frame?.contentWindow?.postMessage(message, window.location.origin);
}

/**
 * The Prototype surface: the embedded playground plus ITS contextual controls
 * (model/provider selection, keys, playground settings, account). The controls
 * live here — in the surface they act on — never in the shell bar (N2).
 */
export function PlaygroundSurface({
  onNavigateSettings,
}: {
  onNavigateSettings: (section?: StudioSettingsMessage['section']) => void;
}) {
  const src = useMemo(() => playgroundSrc(), []);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<PlaygroundBreadcrumbMessage | null>(null);
  const sendCommand = useCallback((message: PlaygroundCommandMessage) => {
    postPlaygroundCommand(frameRef.current, message);
  }, []);

  // Root-crumb click: navigate the embedded playground back to its composer.
  // Same-origin (both under the site), so driving the frame's location directly
  // is allowed — no extra inbound command message needed.
  const goHome = useCallback(() => {
    const href = breadcrumb?.rootHref;
    const frameWindow = frameRef.current?.contentWindow;
    if (href && frameWindow) frameWindow.location.assign(href);
  }, [breadcrumb?.rootHref]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (isStudioSettingsMessage(event.data)) {
        onNavigateSettings(event.data.section);
        return;
      }
      if (isPlaygroundBreadcrumbMessage(event.data)) {
        setBreadcrumb(event.data);
        return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onNavigateSettings]);

  return (
    <section className="studio-playground" aria-label="Prototype">
      <div className="studio-playground__controls" aria-label="Prototype controls">
        {breadcrumb ? (
          <nav className="studio-playground__crumbs" aria-label="Prototype breadcrumb">
            <button
              type="button"
              className="studio-playground__crumb-root"
              onClick={goHome}
              title={`Back to ${breadcrumb.rootLabel}`}
            >
              {breadcrumb.rootLabel}
            </button>
            {breadcrumb.title ? (
              <>
                <span aria-hidden className="studio-playground__crumb-sep">
                  /
                </span>
                <span aria-current="page" className="studio-playground__crumb-current">
                  {breadcrumb.title}
                </span>
              </>
            ) : null}
          </nav>
        ) : null}
        <div className="studio-playground__controls-right">
          <PlaygroundModelControl onCommand={sendCommand} />
          <button
            type="button"
            className="studio-icon-button"
            aria-label="Prototype API keys"
            title="API keys"
            onClick={() => sendCommand({ type: 'pyric:playground:open-keys' })}
          >
            <IconKey />
          </button>
          <button
            type="button"
            className="studio-icon-button"
            aria-label="Prototype settings"
            title="Prototype settings"
            onClick={() => sendCommand({ type: 'pyric:playground:open-settings' })}
          >
            <IconSettings />
          </button>
          <button
            type="button"
            className="studio-icon-button"
            aria-label="Prototype account"
            title="Account"
            onClick={() => sendCommand({ type: 'pyric:playground:open-account' })}
          >
            <IconUser />
          </button>
        </div>
      </div>
      <iframe
        ref={frameRef}
        className="studio-playground__frame"
        title="Pyric Playground"
        src={src}
        allow="clipboard-read; clipboard-write"
      />
    </section>
  );
}
