/**
 * The markup every chip view builds from: escaped text, icons, sections,
 * rows, buttons, and the action bar. Views compose these strings; the chip
 * owns the one stylesheet that draws them.
 */
export function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Small, shared stroke icons; provider marks use their recognizable silhouettes. */
export function iconHtml(name: string): string {
  const paths: Record<string, string> = {
    traffic: '<path d="M7 3v18m-4-4 4 4 4-4M17 21V3m-4 4 4-4 4 4"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--pyric-content)"/><circle cx="15" cy="17" r="3" fill="var(--pyric-content)"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    unavailable: '<circle cx="12" cy="12" r="9"/><path d="m6 18 12-12"/>',
    warning: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="m7 4 13 8-13 8Z"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    minimize: '<path d="M5 12h14"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    password: '<rect x="4" y="9" width="16" height="12" rx="2"/><path d="M8 9V6a4 4 0 0 1 8 0v3M12 14v3"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    'google.com': '<path d="M20 7a9 9 0 1 0 1 6h-9M21 13v-2h-9"/>',
    'github.com': '<path d="M8 21v-4c-5 1-5-3-7-3m15 7v-4c0-1-.3-2-1-2 4-.5 6-2 6-6 0-2-.5-3-2-4 .3-1 .3-2 0-3-2 0-3 1-4 2a14 14 0 0 0-6 0C8 3 7 2 5 2c-.3 1-.3 2 0 3-1.5 1-2 2-2 4 0 4 2 5.5 6 6-.7 0-1 1-1 2"/>',
    'facebook.com': '<path d="M14 22V12h4l1-4h-5V6c0-2 1-3 4-3V0h-4c-4 0-5 3-5 6v2H6v4h3v10"/>',
    'twitter.com': '<path d="m4 3 16 18h-4L1 3h4m15 0L4 21"/>',
    'microsoft.com': '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
    'apple.com': '<path d="M15 3c0-2 2-3 3-3 0 2-1 3-3 3Zm-3 3C5 1 1 9 5 17c3 6 4 3 7 3s4 3 7-3c-5-2-5-7-1-9-2-3-4-3-6-2Z"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.user}</svg>`;
}

export function sectionHtml(title: string, body: string, meta = '', action = ''): string {
  return `<section class="section"><div class="section-heading"><div class="section-line"><span class="section-title">${escapeAttribute(title)}</span><span class="actions"><span class="section-meta">${escapeAttribute(meta)}</span>${action}</span></div></div>${body}</section>`;
}

export function emptyHtml(title: string, detail: string): string {
  return `<div class="empty"><div class="intro"><span class="section-title">${escapeAttribute(title)}</span><span class="hint">${escapeAttribute(detail)}</span></div></div>`;
}

/** `12 listeners`, `1 listener`, etc. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** A view: what the scrolling area holds, and its action bar. */
export interface ChipView { body: string; bar: string }

/** Named cells containing escaped text or trusted component markup. */
export interface RowCells {
  /** Column one, or the whole text width when `c2` is absent. */
  c1: string;
  /** Optional avatar or listener mark, outside the text cells. */
  leading?: string;
  /** Column two, at L2. Present only on a tab with a fixed first column. */
  c2?: string;
  /** The sub-row under column one; with `c2`, under the first column only. */
  s1?: string;
  /** The sub-row under column two. */
  s2?: string;
  /** The sub-row's right-aligned cell, ending at R. Only without `c2`. */
  s1Right?: string;
  /** The trailing fact or action slot, already escaped or built. */
  slot: string;
  className?: string;
  attributes?: string;
  title?: string | null;
}

/** A row: two lines, three columns, the same cells on every tab. */
export function rowHtml(cells: RowCells): string {
  const hasSub = cells.s1 !== undefined || cells.s2 !== undefined || cells.s1Right !== undefined;
  const wide = cells.c2 === undefined;
  const classes = `row${hasSub ? ' sub' : ''}${cells.leading ? ' has-leading' : ''}${cells.className ? ` ${cells.className}` : ''}`;
  const title = cells.title ? ` title="${escapeAttribute(cells.title)}"` : '';
  const attributes = cells.attributes ? ` ${cells.attributes}` : '';
  let html = `<span class="c1${wide ? ' wide' : ''}">${cells.c1}</span>`;
  if (!wide) html += `<span class="c2">${cells.c2}</span>`;
  html += `<span class="slot">${cells.slot}</span>`;
  if (hasSub) {
    if (wide && cells.s1Right !== undefined) {
      html += `<span class="s1 wide split"><span>${cells.s1 ?? ''}</span><span class="right">${cells.s1Right}</span></span>`;
    } else {
      html += `<span class="s1${wide ? ' wide' : ''}">${cells.s1 ?? ''}</span>`;
      if (!wide || cells.s2) html += `<span class="s2">${cells.s2 ?? ''}</span>`;
    }
  }
  return `<div class="${classes}"${title}${attributes}><span class="row-content">${cells.leading ? `<span class="leading">${cells.leading}</span>` : ''}${html}</span></div>`;
}

/** A row whose own click is its action; `pressed` marks it active. */
export function buttonRowHtml(cells: RowCells & { label: string; pressed?: boolean; expanded?: boolean }): string {
  const inner = rowHtml(cells);
  const body = inner.slice(inner.indexOf('>') + 1, -'</div>'.length);
  const hasSub = cells.s1 !== undefined || cells.s2 !== undefined || cells.s1Right !== undefined;
  const classes = `row${hasSub ? ' sub' : ''}${cells.leading ? ' has-leading' : ''}${cells.className ? ` ${cells.className}` : ''}`;
  const title = cells.title ? ` title="${escapeAttribute(cells.title)}"` : '';
  return `<button class="${classes}" type="button" aria-label="${escapeAttribute(cells.label)}"${cells.pressed === undefined ? '' : ` aria-pressed="${cells.pressed}"`}${cells.expanded === undefined ? '' : ` aria-expanded="${cells.expanded}"`}${title} ${cells.attributes ?? ''}>${body}</button>`;
}

/** The one button, wherever it sits. */
export function buttonHtml(attributes: string, label: string, title?: string): string {
  return `<button class="btn" type="button" ${attributes}${title ? ` title="${escapeAttribute(title)}"` : ''}>${escapeAttribute(label)}</button>`;
}

/** The action bar: up to three buttons against R, the primary one rightmost. */
export function barHtml(buttons: readonly string[], hint = ''): string {
  return `<div class="bar${hint ? '' : ' no-hint'}" data-action-bar><span class="bar-hint">${hint}</span><span class="actions">${buttons.join('')}</span></div>`;
}

/** `12:50:43` in the page's own clock, which is the one the developer reads. */
export function clockTime(at: number): string {
  const time = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}
