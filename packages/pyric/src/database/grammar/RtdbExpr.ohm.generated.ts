// AUTO-GENERATED — do not edit by hand. Regenerate via:
//   bun packages/rtdb/scripts/inline-grammar.ts
// Source: RtdbExpr.ohm

export const RTDB_EXPR_OHM_SOURCE = `RtdbExpr {
  Expr = Ternary

  Ternary
    = Logical "?" Ternary ":" Ternary  -- ternary
    | Logical

  Logical
    = Logical "&&" Comparison  -- and
    | Logical "||" Comparison  -- or
    | Comparison

  Comparison
    = Comparison "===" Additive  -- strictEq
    | Comparison "!==" Additive  -- strictNeq
    | Comparison ">=" Additive   -- gte
    | Comparison "<=" Additive   -- lte
    | Comparison ">" Additive    -- gt
    | Comparison "<" Additive    -- lt
    | Comparison "==" Additive   -- looseEq
    | Comparison "!=" Additive   -- looseNeq
    | Additive

  Additive
    = Additive "+" Multiplicative  -- add
    | Additive "-" Multiplicative  -- sub
    | Multiplicative

  Multiplicative
    = Multiplicative "*" UnaryExpr  -- mul
    | Multiplicative "/" UnaryExpr  -- div
    | Multiplicative "%" UnaryExpr  -- mod
    | UnaryExpr

  UnaryExpr
    = "!" UnaryExpr  -- not
    | "-" UnaryExpr  -- neg
    | CallExpr

  CallExpr
    = CallExpr "." ident "(" ListOf<Expr, ","> ")"  -- methodCall
    | CallExpr "." ident                             -- memberAccess
    | CallExpr "[" Expr "]"                          -- indexAccess
    | Primary

  Primary
    = "(" Expr ")"  -- paren
    | Array
    | literal
    | ident

  Array = "[" ListOf<Expr, ","> "]"

  literal
    = number
    | string
    | regex
    | bool
    | null

  number
    = digit+ "." digit+  -- float
    | digit+              -- int

  string
    = "\\"" doubleStringChar* "\\""  -- double
    | "'" singleStringChar* "'"    -- single

  doubleStringChar
    = "\\\\" any  -- escape
    | ~"\\"" any -- char

  singleStringChar
    = "\\\\" any  -- escape
    | ~"'" any  -- char

  regex = "/" regexBody "/" regexFlags

  regexBody = regexChar+

  regexChar
    = "\\\\" any     -- escape
    | ~("/" | "\\n") any  -- char

  regexFlags = alnum*

  bool
    = "true" ~identChar   -- true
    | "false" ~identChar  -- false

  null = "null" ~identChar

  ident = "$"? identStart identChar*

  identStart = letter | "_"

  identChar = alnum | "_" | "$"
}
`;
