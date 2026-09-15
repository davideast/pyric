/** Hosted selection is stamped before Studio starts; absence retains SharedWorker. */
export function readHostedTarget(): { url: string; projectKey: string } | null {
  const hasDocument = typeof document !== 'undefined';
  const hasNoDocument = !hasDocument;
  if (hasNoDocument) return null;
  const declaration = document.querySelector('meta[name="pyric-sandbox-host"]');
  const isHosted = declaration?.getAttribute('content') === 'node';
  const isNotHosted = !isHosted;
  if (isNotHosted) return null;
  const projectKey = declaration.getAttribute('data-project-key');
  const hasIdentity = projectKey !== null && projectKey.length > 0;
  const isMissingIdentity = !hasIdentity;
  if (isMissingIdentity) throw new Error('The hosted sandbox has no project identity. Restart the host and reload Studio.');
  const isSecure = location.protocol === 'https:';
  const protocol = isSecure ? 'wss:' : 'ws:';
  return { url: `${protocol}//${location.host}/__pyric/sandbox`, projectKey };
}

export function stampHostedTarget(html: string, projectKey: string | undefined): string {
  const isSharedWorker = projectKey === undefined;
  if (isSharedWorker) return html;
  const escaped = projectKey.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const declaration = `<meta name="pyric-sandbox-host" content="node" data-project-key="${escaped}" data-pyric-serve>`;
  return html.replace(/<head[^>]*>/i, head => head + declaration);
}
