# Proposed Pyric traversal

Use `compileFunction`, the `use extension loops;` directive, and one function. Example of a search over a finite list:

```js
use extension loops;
function hasZero(values) {
  for (const v of bounded(values, 8)) {
    if (v == 0) return true;
  }
  return false;
}
```

A literal list also supplies a bound. Arrays, indexing expressions, local `let` bindings, arithmetic, comparisons, boolean operators and conditional expressions are available. The public runner compiles the file and invokes the function.
