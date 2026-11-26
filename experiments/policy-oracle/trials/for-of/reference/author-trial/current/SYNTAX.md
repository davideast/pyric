# Current Pyric traversal

Use `compileBoundedModule`, the `use extension bounded;` directive, and one exported function. Example of a search over a finite list:

```js
use extension bounded;
export function hasZero(values) {
  return bounded.any(values, v => v == 0, 8);
}
```

The final argument is a literal maximum list length. Arrays, indexing expressions, local `let` bindings, arithmetic, comparisons, boolean operators and conditional expressions are available. The public runner compiles the file and invokes the exported function.
