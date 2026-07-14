---
title: Rhythm audit
group: Internal
section: ""
order: 9999
internal: true
slug: _rhythm
description: Internal spacing audit page — every block adjacency in one column.
---

# Rhythm audit

This page exists to audit vertical rhythm in one screenshot. Every
adjacency styled by `rhythm.css` appears below, labeled. It is excluded
from the nav, llms.txt, and the search index.

The paragraph you are reading is `h1 + p` — bound tight to its heading.
This second sentence pads it out enough to show the line-height.

This paragraph is `p + p`: one para beat, close enough to read as the
same thought continuing.

## Section start (p + h2)

The gap above the h2 you just passed is the section beat — it should
dwarf every other gap on the page. This paragraph is `h2 + p`, tight.

Another `p + p` for comparison against the section gap above.

### Subsection (p + h3)

The gap above the h3 is the subsection beat: clearly a new sub-thought,
clearly smaller than a section. This is `h3 + p`.

## Lists

This paragraph introduces a list, so the list hangs off it at the para
beat (`p + ul`):

- First item.
- Second item, one list beat below the first (`--rhythm-list`, three
  quarters of a para beat).
- Third item with a nested list:
  - Nested item one.
  - Nested item two.

The paragraph after the list sits at the group beat (`ul + p`).

1. Ordered lists share the same spacing rules.
2. Item two.

## Code

This paragraph introduces a code block at the group beat (`p + pre`
uses the default, since code blocks are their own block group):

```ts
import { lintFirestoreRules } from 'pyric/rules';

const result = lintFirestoreRules(source);
for (const finding of result.findings) {
  console.log(finding.code, finding.severity);
}
```

The paragraph after a code block returns at the group beat. Inline
code like `pyric dev --persist` participates in the line, not the
rhythm.

```bash
# pre + pre: two code blocks at the group beat
pyric firestore rules lint firestore.rules
```

## Blockquote

This paragraph introduces a quote, so it binds at the para beat. Quotes
left-align with the body column (no content indent) and carry a
hairline rail in the left gutter, not inline with the text:

> A quoted line. Quotes are muted, left-aligned, and marked by a rail
> pushed into the gutter — never by indenting the text.
>
> A second quoted paragraph, one para beat inside the quote.

A paragraph after the quote, back at the group beat (`blockquote + p`).

> A quote can also lead straight into a new section (`blockquote + h2`
> below) — the section beat still dwarfs it, same as any other block.

## Table

This paragraph precedes a table at the group beat:

| Adjacency | Token |
|---|---|
| `p + p` | `--rhythm-para` |
| `* + *` (default) | `--rhythm-group` |
| `* + h3` | `--rhythm-subsection` |
| `* + h2` | `--rhythm-section` |
| `li + li` | `--rhythm-list` |

A closing paragraph after the table.

## Heading directly after heading

### An h3 straight under an h2

Headings bind to what they introduce, so an h3 directly under an h2
sits at the para beat, and this paragraph sits tight under the h3.
