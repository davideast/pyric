/**
 * Close a message that may wrap text from another source (an evaluator error,
 * a parser diagnostic) as one sentence. Wrapped text that already ends in a
 * terminal mark keeps it, so a wrapper never prints `..`.
 */
export function asSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
