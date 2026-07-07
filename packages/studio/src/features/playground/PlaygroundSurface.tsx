import { useEffect, useMemo, type RefObject } from 'react';

interface StudioSettingsMessage {
  type: 'pyric:studio:navigate-settings';
  section?: 'ai' | 'playground' | 'diagnostics';
}

export type PlaygroundCommandMessage =
  | { type: 'pyric:playground:open-keys' }
  | { type: 'pyric:playground:open-settings' }
  | { type: 'pyric:playground:open-account' }
  | {
      type: 'pyric:playground:set-model';
      providerId: 'gemini' | 'openrouter' | 'ollama' | 'llamaServer' | 'claude';
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

export function PlaygroundSurface({
  frameRef,
  onNavigateSettings,
}: {
  frameRef?: RefObject<HTMLIFrameElement | null>;
  onNavigateSettings: (section?: StudioSettingsMessage['section']) => void;
}) {
  const src = useMemo(() => playgroundSrc(), []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!isStudioSettingsMessage(event.data)) return;
      onNavigateSettings(event.data.section);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onNavigateSettings]);

  return (
    <section className="studio-playground" aria-label="Playground">
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
