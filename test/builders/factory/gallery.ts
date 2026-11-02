/**
 * `gallery.html` for the morning review: every walked page at each width,
 * the start commit's screenshot beside this hour's. Paths are relative to the
 * check's folder, so the page works from `checks/latest/` too.
 */
import type { PageCapture } from './walk-runner.ts';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function figure(label: string, src: string | undefined): string {
  const body = src === undefined ? '<p class="none">No screenshot</p>' : `<a href="${escapeHtml(src)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy"></a>`;
  return `<figure><figcaption>${escapeHtml(label)}</figcaption>${body}</figure>`;
}

export interface GalleryInput {
  title: string;
  after: readonly PageCapture[];
  before: readonly PageCapture[];
  /** From the check's folder to the before and after screenshot folders. */
  beforeDir: string;
  afterDir: string;
}

export function galleryHtml(input: GalleryInput): string {
  const beforeByKey = new Map(input.before.map((page) => [`${page.path}|${page.width}`, page]));
  const rows = input.after.map((page) => {
    const before = beforeByKey.get(`${page.path}|${page.width}`);
    const beforeSrc = before?.error === undefined && before !== undefined ? `${input.beforeDir}/${before.screenshot}` : undefined;
    const afterSrc = page.error === undefined ? `${input.afterDir}/${page.screenshot}` : undefined;
    return `<section><h2>${escapeHtml(page.path)} at ${page.width}px</h2><div class="pair">${figure('Start commit', beforeSrc)}${figure('This hour', afterSrc)}</div></section>`;
  });
  const empty = rows.length === 0 ? '<p>No pages were walked.</p>' : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; background: #fff; color: #222; }
section { display: grid; gap: 0.5rem; padding-block: 1rem; border-top: 1px solid #ddd; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr)); gap: 1rem; }
figure { display: grid; gap: 0.25rem; margin: 0; }
img { width: 100%; border: 1px solid #ddd; }
.none { color: #777; }
</style></head>
<body><h1>${escapeHtml(input.title)}</h1>${empty}${rows.join('\n')}</body></html>
`;
}
