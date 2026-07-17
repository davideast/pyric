// AUTO-GENERATED — do not edit by hand. Regenerate via:
//   bun run inline-grammar (packages/pyric)
// Source: FirestoreRules.ohm

export const FIRESTORE_RULES_OHM_SOURCE = `FirestoreRules {
  // === Top-level ===
  // Syntactic rules (capitalized) auto-skip spaces between terms.
  // Lexical rules (lowercase) do NOT skip spaces.

  // Two accepted orderings. Real \`firestore.rules\` files put
  // \`rules_version\` at line 1 (Firebase convention), so the
  // \`versionFirst\` branch matches that natural shape. The
  // \`importsFirst\` branch keeps legacy samples that put \`import\`
  // declarations above the version line working. The semantic
  // action below normalizes both into the same AST shape, so
  // downstream code doesn't have to care which path matched.
  // Declaration order is STRICT: imports, then functions (#347 probe,
  // 2026-07-17): the production Rules Test API rejects \`import\` after a
  // \`function\` ("Unexpected 'import'") and any declaration before
  // \`rules_version\` ("Unexpected 'rules_version'"), under both
  // rules_version '2' and '2+modules'. Pinned by
  // test/rules/corpus/invalid/009-/010-.
  RulesFile = RulesVersion? ImportDecl* FunctionDef* ServiceBlock  -- versionFirst
            | ImportDecl* RulesVersion FunctionDef* ServiceBlock   -- importsFirst

  ImportDecl = "import" "{" ListOf<ident, ","> ","? "}" "from" string ";"

  RulesVersion = "rules_version" "=" string ";"

  ServiceBlock = "service" serviceName "{" FunctionDef* DocumentsMatch FunctionDef* "}"

  DocumentsMatch = "match" matchPath "{" MatchBody "}"

  MatchBody = MatchBodyItem*

  MatchBodyItem
    = FunctionDef
    | MatchBlock
    | AllowStatement

  MatchBlock = "match" matchPath "{" MatchBody "}"

  // === Statements ===

  AllowStatement = "allow" OperationList ":" "if" Expr ";"

  OperationList = Operation ("," Operation)*

  FunctionDef = "export"? "function" ident "(" ParameterList ")" "{" FunctionBody "}"

  ParameterList = ListOf<ident, ",">

  FunctionBody = LetBinding* ReturnStatement

  LetBinding = "let" ident "=" Expr ";"

  ReturnStatement = "return" Expr ";"

  // === Lexical: operations and service name ===

  Operation
    = "read" ~identChar
    | "write" ~identChar
    | "get" ~identChar
    | "list" ~identChar
    | "create" ~identChar
    | "update" ~identChar
    | "delete" ~identChar

  serviceName = letter (letter | ".")*

  // === Lexical: match paths ===

  matchPath = "/" matchPathSegment ("/" matchPathSegment)*

  matchPathSegment
    = "{" matchWildcard "}"    -- wildcard
    | pathIdent                -- literal

  matchWildcard
    = identStart identChar* "=" "**"  -- recursive
    | identStart identChar*           -- single

  pathIdent = (letter | digit | "_" | "-" | ".")+

  // === Expressions ===

  Expr = Ternary

  Ternary
    = LogicalOr "?" Ternary ":" Ternary  -- ternary
    | LogicalOr

  LogicalOr
    = LogicalOr "||" LogicalAnd  -- or
    | LogicalAnd

  LogicalAnd
    = LogicalAnd "&&" InIsExpr  -- and
    | InIsExpr

  InIsExpr
    = Equality in Equality   -- in
    | Equality is typeName   -- is
    | Equality

  in = "in" ~identChar
  is = "is" ~identChar

  Equality
    = Equality "==" Comparison  -- eq
    | Equality "!=" Comparison  -- neq
    | Comparison

  Comparison
    = Comparison ">=" Additive  -- gte
    | Comparison "<=" Additive  -- lte
    | Comparison ">" Additive   -- gt
    | Comparison "<" Additive   -- lt
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
    | PostfixExpr

  PostfixExpr
    = PostfixExpr "." memberName "(" ListOf<Expr, ","> ")"  -- methodCall
    | PostfixExpr "." memberName                             -- memberAccess
    | PostfixExpr "[" Expr ":" Expr "]"                      -- sliceAccess
    | PostfixExpr "[" Expr "]"                               -- bracketAccess
    | Primary

  memberName = identStart identChar*

  Primary
    = "(" Expr ")"       -- paren
    | PathLiteral        -- path
    | ListLiteral        -- list
    | MapLiteral         -- map
    | ident "(" ListOf<Expr, ","> ")"  -- functionCall
    | literal
    | ident

  // === Path literals ===

  PathLiteral = "/" PathLitSegment ("/" PathLitSegment)*

  PathLitSegment
    = "$(" Expr ")"          -- interpolation
    | "{" ident "}"          -- captureRef
    | "(" pathIdent ")"      -- parenLiteral
    | pathIdent              -- literal

  // === Literals ===

  literal
    = number
    | string
    | bool
    | null

  number
    = digit+ "." digit+  -- float
    | digit+              -- int

  string
    = "'" singleStringChar* "'"    -- single
    | "\\"" doubleStringChar* "\\""  -- double

  singleStringChar
    = "\\\\" stringEscapeChar  -- escape
    | ~"\\\\" ~"'" any         -- char

  doubleStringChar
    = "\\\\" stringEscapeChar  -- escape
    | ~"\\\\" ~"\\"" any        -- char

  // Valid escape characters following a backslash. Anything else is rejected
  // at parse time to match production semantics — production Firestore Rules
  // raises a syntax error on unknown escapes (e.g. \`\\d\`, \`\\.\`). Keeping the
  // sim strict here prevents over-permissive acceptance that masks model
  // output that would crash at deploy.
  stringEscapeChar = "\\\\" | "'" | "\\"" | "n" | "r" | "t" | "/"

  ListLiteral = "[" ListOf<Expr, ","> ","? "]"

  MapLiteral = "{" ListOf<MapEntry, ","> ","? "}"

  MapEntry = (string | ident) ":" Expr

  bool
    = "true" ~identChar   -- true
    | "false" ~identChar  -- false

  null = "null" ~identChar

  typeName
    = "string" ~identChar
    | "int" ~identChar
    | "float" ~identChar
    | "number" ~identChar
    | "bool" ~identChar
    | "list" ~identChar
    | "map" ~identChar
    | "timestamp" ~identChar
    | "path" ~identChar
    | "bytes" ~identChar
    | "duration" ~identChar
    | "latlng" ~identChar
    | "reference" ~identChar

  ident = ~keyword identStart identChar*

  keyword
    = ("true" | "false" | "null" | "in" | "is" | "if" | "return" | "let") ~identChar

  identStart = letter | "_"

  identChar = alnum | "_"

  // === Whitespace and comments ===

  space += comment

  comment
    = "//" (~"\\n" any)* &("\\n" | end)  -- singleLine
    | "/*" (~"*/" any)* "*/"            -- multiLine
}
`;
