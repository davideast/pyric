/**
 * The element a listener's owners name (feature: Listeners).
 *
 * PURE. An owner records the element it identified as a selector, and a
 * selector is not a label: `[data-pyric-owner="nav-3"]` is machine identity,
 * and a structural path is a route through the DOM. Both reduce to the two
 * facts a reader uses to find the thing on screen — the tag, and the id or
 * class that tells it apart from its siblings. `nav#conversations`,
 * `div.conversation`, `nav`.
 *
 * A generated attribute selector carries the tag twice over: the tag owner's
 * `name` is the element's own tag name, and the minted value is prefixed with
 * it. Either is read; the attribute itself never reaches the screen.
 */

import type { ListenerOwner } from 'pyric/sandbox';
import { elementOf, tagOwnerOf } from './listener-groups.js';

/** `[data-pyric-owner="nav-3"]`, and every other single attribute selector. */
const ATTRIBUTE_SELECTOR = /^\[[a-zA-Z][\w-]*(?:=["']?([^"'\]]+)["']?)?\]$/;

/** A minted owner value: the element's tag name, then a base-36 counter. */
const MINTED_OWNER = /^([a-z][a-z0-9-]*?)-[0-9a-z]+$/;

/** A tag name as an element reports it. */
const TAG_NAME = /^[a-z][a-z0-9-]*$/;

interface ElementParts {
  readonly tag?: string;
  readonly id?: string;
  readonly className?: string;
}

/** The tag the owners state on their own: a tag owner names an element by its
 *  lower-case tag name. A component owner's name is a component, not a tag. */
function statedTag(owners: readonly ListenerOwner[] | undefined): string | undefined {
  const name = tagOwnerOf(owners)?.name;
  if (name === undefined || !TAG_NAME.test(name)) return undefined;
  return name;
}

/** The last compound selector in a descendant chain: the element itself,
 *  rather than the ancestors the path walked through to reach it. */
function lastStep(selector: string): string {
  const steps = selector.split('>');
  return steps[steps.length - 1]!.trim();
}

/** The tag, id, and first class one compound selector states. */
function parseStep(step: string): ElementParts {
  const attribute = ATTRIBUTE_SELECTOR.exec(step);
  if (attribute !== null) {
    const minted = MINTED_OWNER.exec(attribute[1] ?? '');
    return minted === null ? {} : { tag: minted[1]! };
  }
  // `:nth-child(2)` and every other pseudo-class states position, not identity.
  const bare = step.replace(/:[a-z-]+(\([^)]*\))?/g, '');
  const parts: { tag?: string; id?: string; className?: string } = {};
  const tag = /^[a-zA-Z][\w-]*/.exec(bare)?.[0];
  if (tag !== undefined) parts.tag = tag.toLowerCase();
  const id = /#([\w-]+)/.exec(bare)?.[1];
  if (id !== undefined) parts.id = id;
  const className = /\.([\w-]+)/.exec(bare)?.[1];
  if (className !== undefined) parts.className = className;
  return parts;
}

/**
 * The element one set of owners names, as `tag#id`, `tag.class`, or `tag`.
 * Nothing when the owners recorded no element.
 */
export function elementLabel(
  owners: readonly ListenerOwner[] | undefined,
): string | undefined {
  const selector = elementOf(owners);
  if (selector === undefined || selector === '') return undefined;
  const parts = parseStep(lastStep(selector));
  const tag = parts.tag ?? statedTag(owners) ?? '';
  if (parts.id !== undefined) return `${tag}#${parts.id}`;
  if (parts.className !== undefined) return `${tag}.${parts.className}`;
  return tag === '' ? undefined : tag;
}
