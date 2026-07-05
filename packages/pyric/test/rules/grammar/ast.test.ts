import { describe, test, expect } from 'bun:test';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Expression, MatchBlock } from '../../../src/rules/grammar/FirestoreAST.js';

const CORPUS = join(import.meta.dir, '../corpus');
function loadCorpus(path: string): string {
  return readFileSync(join(CORPUS, path), 'utf-8');
}

describe('Firestore AST Generation', () => {
  describe('top-level structure', () => {
    test('minimal file', () => {
      const ast = parseToAST(loadCorpus('valid/001-minimal.rules'));
      expect(ast).not.toBeNull();
      expect(ast!.version).toBe('2');
      expect(ast!.service.name).toBe('cloud.firestore');
    });

    test('documents match path', () => {
      const ast = parseToAST(loadCorpus('valid/001-minimal.rules'));
      const docMatch = ast!.service.match;
      expect(docMatch.path.segments[0]).toEqual({ type: 'literal', value: 'databases' });
      expect(docMatch.path.segments[1]).toEqual({ type: 'wildcard', name: 'database' });
      expect(docMatch.path.segments[2]).toEqual({ type: 'literal', value: 'documents' });
    });
  });

  describe('match blocks', () => {
    test('single match with allow', () => {
      const ast = parseToAST(loadCorpus('valid/002-allow-all.rules'));
      const children = ast!.service.match.children;
      expect(children.length).toBe(1);
      expect(children[0].path.segments[0]).toEqual({ type: 'recursive', name: 'document' });
      expect(children[0].allows.length).toBe(1);
      expect(children[0].allows[0].operations).toEqual(['read', 'write']);
    });

    test('multiple match blocks', () => {
      const ast = parseToAST(loadCorpus('valid/004-all-operation-types.rules'));
      const children = ast!.service.match.children;
      expect(children.length).toBe(1);
      const match = children[0];
      expect(match.allows.length).toBe(7);
    });

    test('nested match (subcollections)', () => {
      const ast = parseToAST(loadCorpus('valid/009-nested-match.rules'));
      const teams = ast!.service.match.children[0];
      expect(teams.path.raw).toContain('teams');
      expect(teams.children.length).toBe(2); // members + projects
      const projects = teams.children.find(c => c.path.raw.includes('projects'));
      expect(projects).toBeDefined();
      expect(projects!.children.length).toBe(1); // tasks
    });

    test('recursive wildcard', () => {
      const ast = parseToAST(loadCorpus('valid/016-recursive-wildcard.rules'));
      const docMatch = ast!.service.match;
      const recursiveMatch = docMatch.children.find(c =>
        c.path.segments.some(s => s.type === 'recursive'),
      );
      expect(recursiveMatch).toBeDefined();
      const recSeg = recursiveMatch!.path.segments.find(s => s.type === 'recursive');
      expect(recSeg).toEqual({ type: 'recursive', name: 'document' });
    });
  });

  describe('allow rules', () => {
    test('operations parsed correctly', () => {
      const ast = parseToAST(loadCorpus('valid/004-all-operation-types.rules'));
      const allows = ast!.service.match.children[0].allows;
      const ops = allows.map(a => a.operations).flat();
      expect(ops).toContain('read');
      expect(ops).toContain('write');
      expect(ops).toContain('get');
      expect(ops).toContain('list');
      expect(ops).toContain('create');
      expect(ops).toContain('update');
      expect(ops).toContain('delete');
    });

    test('combined operations', () => {
      const ast = parseToAST(loadCorpus('valid/005-combined-operations.rules'));
      const allows = ast!.service.match.children[0].allows;
      const readWrite = allows.find(a => a.operations.includes('read') && a.operations.includes('write'));
      expect(readWrite).toBeDefined();
    });

    test('condition is an expression', () => {
      const ast = parseToAST(loadCorpus('valid/006-auth-checks.rules'));
      const users = ast!.service.match.children[0];
      const readAllow = users.allows.find(a => a.operations.includes('read'));
      expect(readAllow).toBeDefined();
      expect(readAllow!.condition.type).toBe('binaryOp');
    });
  });

  describe('functions', () => {
    test('top-level functions', () => {
      const ast = parseToAST(loadCorpus('valid/008-functions.rules'));
      const fns = ast!.service.match.functions;
      expect(fns.length).toBeGreaterThanOrEqual(3);
      const names = fns.map(f => f.name);
      expect(names).toContain('isAuthenticated');
      expect(names).toContain('isOwner');
      expect(names).toContain('hasRole');
    });

    test('function parameters', () => {
      const ast = parseToAST(loadCorpus('valid/008-functions.rules'));
      const fns = ast!.service.match.functions;
      const isOwner = fns.find(f => f.name === 'isOwner');
      expect(isOwner!.parameters).toEqual(['userId']);
      const hasRole = fns.find(f => f.name === 'hasRole');
      expect(hasRole!.parameters).toEqual(['userId', 'role']);
    });

    test('function body is an expression', () => {
      const ast = parseToAST(loadCorpus('valid/008-functions.rules'));
      const isAuth = ast!.service.match.functions.find(f => f.name === 'isAuthenticated');
      expect(isAuth!.body.type).toBe('binaryOp');
    });

    test('scoped functions inside match', () => {
      const ast = parseToAST(loadCorpus('edge-cases/003-scoped-functions.rules'));
      // Top-level has isAuthenticated
      const topFns = ast!.service.match.functions;
      expect(topFns.some(f => f.name === 'isAuthenticated')).toBe(true);
      // teamA has its own scoped function
      const teamA = ast!.service.match.children.find(c => c.path.raw.includes('teamA'));
      expect(teamA!.functions.length).toBe(1);
      expect(teamA!.functions[0].name).toBe('isTeamAMember');
    });
  });

  describe('expressions', () => {
    test('literal true', () => {
      const ast = parseToAST(loadCorpus('valid/002-allow-all.rules'));
      const cond = ast!.service.match.children[0].allows[0].condition;
      expect(cond.type).toBe('literal');
      if (cond.type === 'literal') expect(cond.value).toBe(true);
    });

    test('binary operation', () => {
      const ast = parseToAST(loadCorpus('valid/006-auth-checks.rules'));
      const users = ast!.service.match.children[0];
      const cond = users.allows[0].condition;
      expect(cond.type).toBe('binaryOp');
      if (cond.type === 'binaryOp') {
        expect(cond.op).toBe('!=');
      }
    });

    test('member access chain', () => {
      const ast = parseToAST(loadCorpus('valid/006-auth-checks.rules'));
      const users = ast!.service.match.children[0];
      const cond = users.allows[0].condition;
      // request.auth != null → left side is memberAccess
      if (cond.type === 'binaryOp') {
        expect(cond.left.type).toBe('memberAccess');
      }
    });
  });

  describe('production rules', () => {
    test('blockingfun production file', () => {
      const ast = parseToAST(loadCorpus('valid/021-production-blockingfun.rules'));
      expect(ast).not.toBeNull();
      expect(ast!.version).toBe('2');

      // Has functions
      const fns = ast!.service.match.functions;
      const fnNames = fns.map(f => f.name);
      expect(fnNames).toContain('isAuthenticated');
      expect(fnNames).toContain('isOwner');
      expect(fnNames).toContain('isAdmin');
      expect(fnNames).toContain('isValidEmail');
      expect(fnNames).toContain('isValidUrl');
      expect(fnNames).toContain('hasOnlyAllowedFields');
      expect(fnNames).toContain('hasRequiredFields');

      // Has match blocks
      const matches = ast!.service.match.children;
      const matchPaths = matches.map(m => m.path.raw);
      expect(matchPaths.some(p => p.includes('users'))).toBe(true);
      expect(matchPaths.some(p => p.includes('marathons'))).toBe(true);
      expect(matchPaths.some(p => p.includes('likes'))).toBe(true);
    });

    test('complex real-world file', () => {
      const ast = parseToAST(loadCorpus('valid/020-complex-real-world.rules'));
      expect(ast).not.toBeNull();

      // Posts match has nested comments
      const posts = ast!.service.match.children.find(m => m.path.raw.includes('posts'));
      expect(posts).toBeDefined();
      expect(posts!.children.length).toBe(1); // comments
      expect(posts!.children[0].path.raw).toContain('comments');

      // Posts has create/update/delete with different conditions
      expect(posts!.allows.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('AllowRule source positions', () => {
    // Ohm's `getLineAndColumn()` reports positions relative to the *trimmed*
    // source the grammar matched against. `parseToASTOrError` strips
    // leading whitespace before matching, then post-walks the AST to shift
    // `AllowRule.loc.line` back by the number of newlines that were
    // trimmed. These tests pin the contract: `loc.line` always corresponds
    // to a line in the *original* input the caller passed in.

    test('allow rule loc matches the original source line (no leading blanks)', () => {
      const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if true;
    }
  }
}`;
      const ast = parseToAST(src);
      const allow = ast!.service.match.children[0].allows[0];
      expect(allow.loc).toBeDefined();
      // The `allow` keyword is on line 5 (1-indexed) of the source above.
      expect(allow.loc!.line).toBe(5);
    });

    test('loc.line is shifted to match the ORIGINAL source when input has leading blank lines', () => {
      // Three leading blank lines before the real rules content. Without
      // shift compensation, Ohm reports `allow` at line 5 (its position
      // in the *trimmed* input); the post-walk must shift by 3.
      const src = `


rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if true;
    }
  }
}`;
      const ast = parseToAST(src);
      const allow = ast!.service.match.children[0].allows[0];
      expect(allow.loc).toBeDefined();
      // Original-source line: 3 leading blanks (lines 1-3 blank) +
      // rules_version on line 4 + service open on 5 + match on 6 +
      // nested match on 7 + allow on line 8.
      expect(allow.loc!.line).toBe(8);
    });

    test('shift handles a single leading newline', () => {
      const src = `\nrules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if true;
    }
  }
}`;
      const ast = parseToAST(src);
      const allow = ast!.service.match.children[0].allows[0];
      expect(allow.loc!.line).toBe(6);
    });

    test('shift applies to allow rules in nested match blocks', () => {
      const src = `

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /parent/{p} {
      allow read: if true;
      match /child/{c} {
        allow write: if true;
      }
    }
  }
}`;
      const ast = parseToAST(src);
      // Original-source layout (1-indexed):
      //   line 1: blank
      //   line 2: blank
      //   line 3: rules_version
      //   line 4: service open
      //   line 5: outer documents match
      //   line 6: parent match
      //   line 7: allow read    ← parent's allow
      //   line 8: child match
      //   line 9: allow write   ← child's allow
      const parent = ast!.service.match.children[0];
      expect(parent.allows[0].loc!.line).toBe(7);
      const child = parent.children[0];
      expect(child.allows[0].loc!.line).toBe(9);
    });

    test('trailing whitespace is trimmed but does NOT affect line numbers', () => {
      // Only LEADING whitespace shifts lines. Trailing whitespace is also
      // stripped by `trim()` but lives below all the `allow` keywords, so
      // their positions are unaffected. Regression guard against a future
      // change that accidentally counts trailing newlines too.
      const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if true;
    }
  }
}


`;
      const ast = parseToAST(src);
      const allow = ast!.service.match.children[0].allows[0];
      expect(allow.loc!.line).toBe(5);
    });
  });

  describe('MatchBlock source positions', () => {
    // MatchBlock.loc was added to support the path-resolution trace
    // — `debug_firestore_rules` quotes "near-miss" blocks with their
    // source line. Same shift-on-leading-blanks logic as AllowRule.

    test('match block loc points at the `match` keyword line', () => {
      const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if true;
    }
  }
}`;
      const ast = parseToAST(src);
      // Root match is /databases/{database}/documents → line 3.
      expect(ast!.service.match.loc!.line).toBe(3);
      // Child match /docs/{id} → line 4.
      expect(ast!.service.match.children[0].loc!.line).toBe(4);
    });

    test('match block loc shifts to match the ORIGINAL source on leading blanks', () => {
      const src = `

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if true;
    }
  }
}`;
      const ast = parseToAST(src);
      // 2 leading blank lines, then rules_version, service, match — root
      // match is on line 5 in the original source.
      expect(ast!.service.match.loc!.line).toBe(5);
      // Nested match /docs/{id} is on line 6.
      expect(ast!.service.match.children[0].loc!.line).toBe(6);
    });

    test('nested match blocks each get their own loc', () => {
      const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /parent/{p} {
      match /child/{c} {
        allow read: if true;
      }
    }
  }
}`;
      const ast = parseToAST(src);
      const parent = ast!.service.match.children[0];
      expect(parent.loc!.line).toBe(4);
      const child = parent.children[0];
      expect(child.loc!.line).toBe(5);
    });
  });
});
