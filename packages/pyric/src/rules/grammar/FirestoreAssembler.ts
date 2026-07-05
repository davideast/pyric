import type {
  FirestoreRules, MatchBlock, AllowRule, FunctionDef,
  LetBinding, Expression, PathPattern, PathSegment,
} from './FirestoreAST.js';

// ---- Precedence table ----

const PRECEDENCE: Record<string, number> = {
  '||': 2,
  '&&': 3,
  '==': 5, '!=': 5,
  '>': 6, '<': 6, '>=': 6, '<=': 6,
  '+': 7, '-': 7,
  '*': 8, '/': 8, '%': 8,
};

function precedenceOf(expr: Expression): number {
  switch (expr.type) {
    case 'ternary': return 1;
    case 'binaryOp': return PRECEDENCE[expr.op] ?? 0;
    case 'inExpr': return 4;
    case 'isExpr': return 4;
    case 'unaryOp': return 9;
    default: return 100; // atoms, postfix — never need parens
  }
}

// ---- Expression assembly ----

function assembleExprInner(expr: Expression): string {
  switch (expr.type) {
    case 'literal': {
      if (typeof expr.value === 'string') {
        // Use raw (preserves escapes) but normalize double quotes to single
        if (expr.raw.startsWith('"') && expr.raw.endsWith('"')) {
          const inner = expr.raw.slice(1, -1);
          return `'${inner}'`;
        }
        return expr.raw;
      }
      return expr.raw;
    }
    case 'identifier':
      return expr.name;

    case 'memberAccess':
      return `${assembleExprWithPrec(expr.object, 10)}.${expr.property}`;

    case 'methodCall':
      return `${assembleExprWithPrec(expr.object, 10)}.${expr.method}(${expr.args.map(a => assembleExpression(a)).join(', ')})`;

    case 'bracketAccess':
      return `${assembleExprWithPrec(expr.object, 10)}[${assembleExpression(expr.index)}]`;

    case 'sliceAccess':
      return `${assembleExprWithPrec(expr.object, 10)}[${assembleExpression(expr.start)}:${assembleExpression(expr.end)}]`;

    case 'binaryOp': {
      const prec = PRECEDENCE[expr.op] ?? 0;
      const left = assembleExprWithPrec(expr.left, prec);
      const right = assembleExprWithPrec(expr.right, prec + 1);
      return `${left} ${expr.op} ${right}`;
    }

    case 'unaryOp':
      return `${expr.op}${assembleExprWithPrec(expr.operand, 9)}`;

    case 'ternary':
      return `${assembleExprWithPrec(expr.condition, 2)} ? ${assembleExpression(expr.consequent)} : ${assembleExpression(expr.alternate)}`;

    case 'inExpr':
      return `${assembleExprWithPrec(expr.element, 5)} in ${assembleExprWithPrec(expr.collection, 5)}`;

    case 'isExpr':
      return `${assembleExprWithPrec(expr.value, 5)} is ${expr.typeName}`;

    case 'listLiteral':
      if (expr.elements.length === 0) return '[]';
      return `[${expr.elements.map(e => assembleExpression(e)).join(', ')}]`;

    case 'mapLiteral':
      if (expr.entries.length === 0) return '{}';
      return `{${expr.entries.map(e => `${assembleExpression(e.key)}: ${assembleExpression(e.value)}`).join(', ')}}`;

    case 'pathLiteral':
      return '/' + expr.segments.map(s =>
        typeof s === 'string' ? s : `$(${assembleExpression(s)})`
      ).join('/');

    case 'functionCall':
      return `${expr.name}(${expr.args.map(a => assembleExpression(a)).join(', ')})`;
  }
}

function assembleExprWithPrec(expr: Expression, parentPrec: number): string {
  const result = assembleExprInner(expr);
  const myPrec = precedenceOf(expr);
  if (myPrec < parentPrec) {
    return `(${result})`;
  }
  return result;
}

export function assembleExpression(expr: Expression): string {
  return assembleExprWithPrec(expr, 0);
}

// ---- Path assembly ----

function assemblePath(path: PathPattern): string {
  return '/' + path.segments.map(seg => {
    switch (seg.type) {
      case 'literal': return seg.value;
      case 'wildcard': return `{${seg.name}}`;
      case 'recursive': return `{${seg.name}=**}`;
    }
  }).join('/');
}

// ---- Structural assembly ----

function indent(level: number): string {
  return ' '.repeat(level);
}

function assembleFunction(fn: FunctionDef, level: number): string {
  const pad = indent(level);
  const bodyPad = indent(level + 2);
  const params = fn.parameters.join(', ');
  const lines: string[] = [];
  const exportPrefix = fn.exported ? 'export ' : '';
  lines.push(`${pad}${exportPrefix}function ${fn.name}(${params}) {`);
  for (const binding of fn.lets) {
    lines.push(`${bodyPad}let ${binding.name} = ${assembleExpression(binding.value)};`);
  }
  lines.push(`${bodyPad}return ${assembleExpression(fn.body)};`);
  lines.push(`${pad}}`);
  return lines.join('\n');
}

function assembleAllow(allow: AllowRule, level: number): string {
  const pad = indent(level);
  const ops = allow.operations.join(', ');
  return `${pad}allow ${ops}: if ${assembleExpression(allow.condition)};`;
}

export function assembleMatchBlock(match: MatchBlock, level: number = 0): string {
  const pad = indent(level);
  const innerLevel = level + 2;
  const lines: string[] = [];

  lines.push(`${pad}match ${assemblePath(match.path)} {`);

  for (const fn of match.functions) {
    lines.push(assembleFunction(fn, innerLevel));
  }

  for (const allow of match.allows) {
    lines.push(assembleAllow(allow, innerLevel));
  }

  for (const child of match.children) {
    lines.push(assembleMatchBlock(child, innerLevel));
  }

  lines.push(`${pad}}`);
  return lines.join('\n');
}

export function assembleRules(ast: FirestoreRules): string {
  const lines: string[] = [];
  for (const imp of ast.imports) {
    lines.push(`import { ${imp.functions.join(', ')} } from '${imp.module}';`);
  }
  lines.push(`rules_version = '${ast.version}';`);
  lines.push(`service ${ast.service.name} {`);

  const root = ast.service.match;
  const rootPad = indent(2);
  const innerLevel = 4;

  lines.push(`${rootPad}match ${assemblePath(root.path)} {`);

  for (const fn of root.functions) {
    lines.push(assembleFunction(fn, innerLevel));
  }

  for (const allow of root.allows) {
    lines.push(assembleAllow(allow, innerLevel));
  }

  for (const child of root.children) {
    lines.push(assembleMatchBlock(child, innerLevel));
  }

  lines.push(`${rootPad}}`);
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
