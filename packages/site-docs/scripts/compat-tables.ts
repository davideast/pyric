import { splitFences } from './markdown-structure';

/* ── Conformance row lists ─────────────────────────────────────────── */
//
// The COMPAT matrices are authored as markdown tables, and a table is
// the wrong display for them: a one-glyph status column between two
// prose columns never aligns, and the probe text fights the behavior
// text for width. On Conformance pages the port rewrites each
// `# | Behavior | Status | Probe [| …]` table into a row list — status
// dot, number, behavior, probe on its own muted line. Tables with any
// other header (the status legend, the target tables) pass through
// untouched. The generator can adopt this shape natively later; until
// then the port owns the transform.

const STATUS_META: Record<string, { key: string; label: string }> = {
  '✓': { key: 'ok', label: 'Conforming' },
  '⚠': { key: 'diverged', label: 'Diverged (documented)' },
  '✗': { key: 'bug', label: 'Bug' },
  '—': { key: 'unsupported', label: 'Unsupported' },
  '?': { key: 'unverified', label: 'Unverified' },
};

/** Inline markdown → HTML for a table cell: code, links, bold, em.
 *  Escapes everything else. Enough for the COMPAT cells, which use
 *  exactly that subset. */
function mdInlineHtml(md: string): string {
  let s = md
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

/** Split a markdown table row into cells (escaped pipes survive). */
function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'));
}

export function transformCompatTables(body: string): string {
  return splitFences(body)
    .map((part) => {
      if (part.isFence) return part.text;
      const lines = part.text.split('\n');
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isHeader =
          /^\s*\|/.test(line) &&
          i + 1 < lines.length &&
          /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1]);
        if (isHeader) {
          const header = splitRow(line).map((h) => h.trim().toLowerCase());
          const col = (name: string) => header.findIndex((h) => h === name || h.startsWith(name));
          const iNum = col('#');
          const iApi = col('api');
          const iCat = col('category');
          const iBeh = col('behavior');
          const iSt = col('status');
          const iPr = col('probe');
          const iMeaning = col('meaning');
          // Consolidated status roundups are two-column API tables. Render
          // them as readable rows under the section that already names the
          // status, without inventing a status dot.
          if (header.length === 2 && header[0] === 'api') {
            let j = i + 2;
            const html: string[] = ['<div class="compat-list compat-list--plain">'];
            while (j < lines.length && /^\s*\|/.test(lines[j])) {
              const cells = splitRow(lines[j]);
              const apiName = (cells[0] ?? '').trim();
              const detail = (cells[1] ?? '').trim();
              const mainInner = apiName
                ? `<code class="compat-api">${mdInlineHtml(apiName)}</code><span class="compat-sub">${mdInlineHtml(detail)}</span>`
                : `<span class="compat-behavior">${mdInlineHtml(detail)}</span>`;
              html.push(
                '<div class="compat-row">',
                `<div class="compat-line"><span class="compat-main">${mainInner}</span></div>`,
                '</div>',
              );
              j++;
            }
            html.push('</div>');
            out.push(html.join('\n'));
            i = j - 1;
            continue;
          }
          // The status legend becomes the key for the dots: one compact
          // line per status, same dot the rows use.
          if (iBeh < 0 && iSt >= 0 && iMeaning >= 0) {
            let j = i + 2;
            const html: string[] = ['<div class="compat-key">'];
            while (j < lines.length && /^\s*\|/.test(lines[j])) {
              const cells = splitRow(lines[j]);
              const glyph = (cells[iSt] ?? '').trim();
              const meta = STATUS_META[glyph];
              if (meta) {
                html.push(
                  `<span class="compat-key-item"><span class="compat-dot" data-status="${meta.key}"></span>${mdInlineHtml(
                    (cells[iMeaning] ?? '').trim(),
                  )}</span>`,
                );
              }
              j++;
            }
            html.push('</div>');
            out.push(html.join('\n'));
            i = j - 1;
            continue;
          }
          if (iBeh >= 0 && iSt >= 0) {
            let j = i + 2;
            const rows: string[][] = [];
            while (j < lines.length && /^\s*\|/.test(lines[j])) {
              rows.push(splitRow(lines[j]));
              j++;
            }
            const html: string[] = ['<div class="compat-list">'];
            for (const cells of rows) {
              const status = (cells[iSt] ?? '').trim();
              // A status may carry a qualifier ("✓ (wrap)"): the glyph
              // drives the dot, the rest joins the evidence.
              const glyph = status.slice(0, 1);
              const meta = STATUS_META[status] ?? STATUS_META[glyph];
              const qualifier = meta && status.length > 1 ? status.slice(1).trim() : '';
              const probe = iPr >= 0 ? (cells[iPr] ?? '').trim() : '';
              const apiName = iApi >= 0 ? (cells[iApi] ?? '').trim() : '';
              const category = iCat >= 0 ? (cells[iCat] ?? '').trim() : '';
              const extras = cells
                .map((c, k) => ({ c, k }))
                .filter(({ k }) => ![iNum, iApi, iCat, iBeh, iSt, iPr].includes(k))
                .map(({ c }) => c.trim())
                .filter(Boolean);
              // The scan line is status plus the API heading and its
              // category/behaviour sub-line. Evidence hides behind a native
              // disclosure; rows without evidence render as plain rows.
              const dot = meta
                ? `<span class="compat-dot" data-status="${meta.key}" role="img" aria-label="${meta.label}" title="${meta.label}"></span>`
                : `<span class="compat-status">${mdInlineHtml(status)}</span>`;
              const behaviorHtml = mdInlineHtml(cells[iBeh] ?? '');
              let mainInner: string;
              if (apiName) {
                const sub = [
                  category ? `<span class="compat-category">${mdInlineHtml(category)}</span>` : '',
                  `<span class="compat-behavior">${behaviorHtml}</span>`,
                ]
                  .filter(Boolean)
                  .join(' · ');
                mainInner = `<code class="compat-api">${mdInlineHtml(apiName)}</code><span class="compat-sub">${sub}</span>`;
              } else {
                mainInner = `<span class="compat-behavior">${behaviorHtml}</span>`;
              }
              const scanLine = [dot, `<span class="compat-main">${mainInner}</span>`].join('');
              const evidence = [
                probe ? `<div class="compat-probe">${mdInlineHtml(probe)}</div>` : '',
                qualifier ? `<div class="compat-note">${mdInlineHtml(qualifier)}</div>` : '',
                ...extras.map((ex) => `<div class="compat-note">${mdInlineHtml(ex)}</div>`),
              ]
                .filter(Boolean)
                .join('\n');
              if (evidence) {
                html.push(
                  `<details class="compat-row" data-status="${meta?.key ?? 'unknown'}">`,
                  `<summary class="compat-line">${scanLine}</summary>`,
                  `<div class="compat-evidence">${evidence}</div>`,
                  '</details>',
                );
              } else {
                html.push(
                  `<div class="compat-row" data-status="${meta?.key ?? 'unknown'}">`,
                  `<div class="compat-line">${scanLine}</div>`,
                  '</div>',
                );
              }
            }
            html.push('</div>');
            out.push(html.join('\n'));
            i = j - 1;
            continue;
          }
        }
        out.push(line);
      }
      return out.join('\n');
    })
    .join('');
}

