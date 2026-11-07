/**
 * What a rules reload line ends with. On a sandbox host, the `pyric verify`
 * hint, once per host. On a live host, a note that the reload changed only the
 * sandbox, on every reload, with no `pyric verify` hint: production keeps the
 * rules it has deployed.
 */
export function createVerifyHint(options: { live?: boolean } = {}): () => string {
  if (options.live === true) return () => ' for the sandbox. Production keeps its deployed rules.';
  let printedVerifyHint = false;
  return () => {
    if (printedVerifyHint) return '';
    printedVerifyHint = true;
    return ' (run `pyric verify` to replay the captured session against these rules)';
  };
}
