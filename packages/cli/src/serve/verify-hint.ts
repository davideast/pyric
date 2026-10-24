export function createVerifyHint(): () => string {
  let printedVerifyHint = false;
  return () => {
    if (printedVerifyHint) return '';
    printedVerifyHint = true;
    return ' (run `pyric verify` to replay the captured session against these rules)';
  };
}
