/**
 * The layout checks, run inside the page with `page.evaluate(probeLayout)`.
 * Playwright sends the function's source, so it imports nothing and every
 * helper lives inside it.
 *
 * - horizontal-scroll: the page is wider than the viewport.
 * - overlap: two visible interactive elements, neither inside the other, overlap.
 * - clipped-text: an element holding text is wider inside than its box
 *   (scrollWidth > clientWidth).
 * - column-misaligned: in a list or grid of rows (role=list, a table, or rows
 *   of `.item-track-grid` / `.library-track-card` sharing a parent), the cells
 *   of one column don't share a left edge within 1px.
 *
 * Each finding's `key` names the element, so a finding the start commit
 * already had can be told apart from a new one.
 */
export type LayoutRule = 'horizontal-scroll' | 'overlap' | 'clipped-text' | 'column-misaligned';

export interface LayoutFinding {
  rule: LayoutRule;
  key: string;
  detail: string;
}

export function probeLayout(): LayoutFinding[] {
  const TOLERANCE_PX = 1;
  const IGNORED = '[data-pyric-runtime-chip-host], pyric-runtime-chip, [data-radix-popper-content-wrapper], [role="tooltip"], [data-sonner-toaster], nextjs-portal';
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="switch"], [role="slider"], [role="tab"], [tabindex]:not([tabindex="-1"])';
  const ROW_CLASSES = ['item-track-grid', 'library-track-card'];
  const findings: LayoutFinding[] = [];

  const describe = (element: Element): string => {
    const id = element.id === '' ? '' : `#${element.id}`;
    const classes = [...element.classList].slice(0, 4).map((name) => `.${name}`).join('');
    const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${element.tagName.toLowerCase()}${id}${classes}${text === '' ? '' : ` "${text}"`}`;
  };
  /** Tag, id and classes only: page data changes between commits, the element's identity doesn't. */
  const keyOf = (element: Element): string => describe(element).replace(/ ".*"$/, '');
  const isVisible = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const hasBox = box.width > 0 && box.height > 0;
    return hasBox && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
  };
  const isIgnored = (element: Element): boolean => element.closest(IGNORED) !== null;

  const root = document.documentElement;
  const scrollsSideways = root.scrollWidth > root.clientWidth + TOLERANCE_PX;
  if (scrollsSideways) findings.push({ rule: 'horizontal-scroll', key: 'page', detail: `the page is ${root.scrollWidth}px wide in a ${root.clientWidth}px viewport` });

  const interactive = [...document.querySelectorAll(INTERACTIVE)].filter((element) => isVisible(element) && !isIgnored(element));
  for (let i = 0; i < interactive.length; i += 1) {
    for (let j = i + 1; j < interactive.length; j += 1) {
      const a = interactive[i] as Element;
      const b = interactive[j] as Element;
      const isNested = a.contains(b) || b.contains(a);
      if (isNested) continue;
      const boxA = a.getBoundingClientRect();
      const boxB = b.getBoundingClientRect();
      const width = Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left);
      const height = Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.top, boxB.top);
      const overlaps = width > TOLERANCE_PX && height > TOLERANCE_PX;
      if (overlaps) findings.push({ rule: 'overlap', key: `${keyOf(a)} | ${keyOf(b)}`, detail: `${describe(a)} and ${describe(b)} overlap by ${Math.round(width)}x${Math.round(height)}px` });
    }
  }

  const hasOwnText = (element: Element): boolean => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '');
  for (const element of document.body.querySelectorAll('*')) {
    const isCandidate = hasOwnText(element) && element.clientWidth > 0 && isVisible(element) && !isIgnored(element);
    if (!isCandidate) continue;
    const isClipped = element.scrollWidth > element.clientWidth + TOLERANCE_PX;
    if (isClipped) findings.push({ rule: 'clipped-text', key: keyOf(element), detail: `${describe(element)} needs ${element.scrollWidth}px and has ${element.clientWidth}px` });
  }

  /** A row's cells: its visible children, after stepping through wrappers that hold a single element. */
  const cellsOf = (row: Element): Element[] => {
    let current = row;
    while (current.children.length === 1) current = current.children[0] as Element;
    return [...current.children].filter(isVisible);
  };
  const groups: { container: Element; rows: Element[] }[] = [];
  for (const list of document.querySelectorAll('[role="list"]')) groups.push({ container: list, rows: [...list.children] });
  for (const table of document.querySelectorAll('table')) groups.push({ container: table, rows: [...table.querySelectorAll('tr')] });
  for (const name of ROW_CLASSES) {
    const parents = new Set([...document.querySelectorAll(`.${name}`)].map((row) => row.parentElement).filter((parent): parent is HTMLElement => parent !== null));
    for (const parent of parents) groups.push({ container: parent, rows: [...parent.children].filter((row) => row.classList.contains(name)) });
  }
  for (const { container, rows } of groups) {
    const visibleRows = rows.filter((row) => isVisible(row) && !isIgnored(row)).map(cellsOf);
    if (visibleRows.length < 2) continue;
    const counts = new Map<number, number>();
    for (const cells of visibleRows) counts.set(cells.length, (counts.get(cells.length) ?? 0) + 1);
    const [columns] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0];
    const comparable = visibleRows.filter((cells) => cells.length === columns);
    for (let column = 0; column < columns; column += 1) {
      const lefts = comparable.map((cells) => (cells[column] as Element).getBoundingClientRect().left);
      const spread = Math.max(...lefts) - Math.min(...lefts);
      if (spread > TOLERANCE_PX) {
        findings.push({ rule: 'column-misaligned', key: `${keyOf(container)} column ${column + 1}`, detail: `column ${column + 1} of ${describe(container)} starts at ${Math.round(spread)}px apart across ${comparable.length} rows` });
      }
    }
  }
  return findings;
}
