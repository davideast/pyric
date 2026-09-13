/** Optional native anchoring for detached overlay boxes and replaced-element
 * labels. Direct Flow outlines already move with the element's own CSS box.
 * Unavailable or scoped anchors keep the measured-coordinate fallback.
 */
interface AnchorEntry {
  name: string;
  references: number;
  original: string;
  priority: string;
  applied: string;
}
const anchors = new WeakMap<HTMLElement, AnchorEntry>();
const namespace = Math.random().toString(36).slice(2);
let nextAnchor = 0;

/** Returns the cleanup function, or null when this target needs measurement. */
export function tryAnchorOverlay(
  positioned: HTMLElement,
  target: Element,
  matchSize: boolean,
): (() => void) | null {
  const doc = positioned.ownerDocument;
  const view = doc.defaultView;
  if (
    !view ||
    target.getRootNode() !== doc ||
    !(target instanceof view.HTMLElement)
  )
    return null;
  const css = view.CSS;
  if (
    !css?.supports?.("anchor-name", "--pyric-anchor") ||
    !css.supports("position-anchor", "--pyric-anchor") ||
    !css.supports("top", "anchor(top)") ||
    (matchSize && !css.supports("width", "anchor-size(width)"))
  )
    return null;

  // An app may deliberately scope its anchors. A sibling overlay outside that
  // scope cannot resolve the target, even when the browser supports the API.
  for (
    let ancestor: Element | null = target;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const scope = view
      .getComputedStyle(ancestor)
      .getPropertyValue("anchor-scope");
    if (scope && scope !== "none") return null;
  }
  let entry = anchors.get(target);
  if (!entry) {
    const original = target.style.getPropertyValue("anchor-name");
    const priority = target.style.getPropertyPriority("anchor-name");
    const existing = view
      .getComputedStyle(target)
      .getPropertyValue("anchor-name");
    const name = `--pyric-anchor-${namespace}-${++nextAnchor}`;
    const applied =
      existing && existing !== "none" ? `${existing}, ${name}` : name;
    target.style.setProperty("anchor-name", applied, priority);
    entry = { name, references: 0, original, priority, applied };
    anchors.set(target, entry);
  }
  entry.references++;
  positioned.setAttribute("data-pyric-anchored", "");
  positioned.style.setProperty("position", "fixed");
  positioned.style.setProperty("position-anchor", entry.name);
  positioned.style.setProperty("left", "anchor(left)");
  positioned.style.setProperty("top", "anchor(top)");
  if (matchSize) {
    positioned.style.setProperty("width", "anchor-size(width)");
    positioned.style.setProperty("height", "anchor-size(height)");
  }
  if (css.supports("position-visibility", "anchors-visible")) {
    positioned.style.setProperty("position-visibility", "anchors-visible");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.references > 0) return;
    anchors.delete(target);
    const current = target.style.getPropertyValue("anchor-name");
    if (current === entry.applied) {
      if (entry.original)
        target.style.setProperty("anchor-name", entry.original, entry.priority);
      else target.style.removeProperty("anchor-name");
    } else {
      // Preserve application edits made while the diagnostic was active.
      const remaining = current
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== entry.name);
      if (remaining.length)
        target.style.setProperty(
          "anchor-name",
          remaining.join(", "),
          target.style.getPropertyPriority("anchor-name"),
        );
      else target.style.removeProperty("anchor-name");
    }
  };
}
