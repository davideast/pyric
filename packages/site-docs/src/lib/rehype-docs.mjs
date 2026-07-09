/**
 * Docs-content rehype transforms, applied at build time (SSG — no
 * client JS involved). Registered in astro.config.mjs; runs on every
 * rendered markdown page. The raw .md agent twins ([slug].md.ts) are
 * untouched — these are HTML-presentation concerns only.
 *
 * 1. External links: any <a> whose href is an absolute http(s) URL
 *    opens in a new tab (`target="_blank"` + `rel="noopener
 *    noreferrer"`) and gets the `external-link` class, which site.css
 *    turns into a small up-right arrow after the text (a masked
 *    pseudo-element, so it inherits the link color). "External" IS
 *    "absolute http(s)" here: the port script rewrites every intra-doc
 *    link to a relative form and unlinks everything else, so by the
 *    time markdown reaches rehype, an absolute URL is never this site.
 *
 * 2. Tables: every <table> is wrapped in <div class="table-scroll">,
 *    the page's only horizontal-overflow boundary for wide tables —
 *    the wrapper scrolls (site.css: overflow-x auto, max-width 100%),
 *    the page body never does. Done here rather than with
 *    `table { display: block }` because a block-displayed table stops
 *    being a table to the layout engine (column sizing degrades) and
 *    puts the scrollbar inside the table's own border box.
 */

const EXTERNAL = /^https?:\/\//i;

export default function rehypeDocs() {
  return (tree) => {
    visit(tree);
  };
}

/**
 * Single recursive pass. Children are processed by index so a table
 * can be replaced with its wrapper in place; recursion then descends
 * into the original table node (not the new wrapper), so a wrapped
 * table is never seen — and therefore never wrapped — twice.
 */
function visit(node) {
  if (!node.children) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type !== 'element') continue;

    if (child.tagName === 'a') {
      const href = child.properties?.href;
      if (typeof href === 'string' && EXTERNAL.test(href)) {
        child.properties.target = '_blank';
        child.properties.rel = ['noopener', 'noreferrer'];
        const cls = child.properties.className;
        child.properties.className = Array.isArray(cls)
          ? [...cls, 'external-link']
          : cls
            ? [cls, 'external-link']
            : ['external-link'];
      }
    }

    if (child.tagName === 'table') {
      node.children[i] = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['table-scroll'] },
        children: [child],
      };
    }

    visit(child);
  }
}
