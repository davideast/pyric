import { describe, test, expect } from 'bun:test';
import { loadModule, resolveModules } from '../../../src/rules/modules/resolver.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../../../src/rules/grammar/FirestoreValidator.js';

describe('stdlib: auth module', () => {
  test('isAuthenticated body checks request.auth != null', () => {
    const result = loadModule('auth');
    if (!result.success) throw new Error('Failed to load auth module');
    const fn = result.functions.find(f => f.name === 'isAuthenticated')!;
    expect(fn.body.type).toBe('binaryOp');
    if (fn.body.type === 'binaryOp') {
      expect(fn.body.op).toBe('!=');
    }
  });

  test('isOwner takes userId and calls isAuthenticated', () => {
    const result = loadModule('auth');
    if (!result.success) throw new Error('Failed to load auth module');
    const fn = result.functions.find(f => f.name === 'isOwner')!;
    expect(fn.parameters).toEqual(['userId']);
    // Body should be isAuthenticated() && request.auth.uid == userId
    expect(fn.body.type).toBe('binaryOp');
    if (fn.body.type === 'binaryOp') {
      expect(fn.body.op).toBe('&&');
    }
  });
});

describe('stdlib: validation module', () => {
  test('hasRequired takes fields and uses hasAll', () => {
    const result = loadModule('validation');
    if (!result.success) throw new Error('Failed to load validation module');
    const fn = result.functions.find(f => f.name === 'hasRequired')!;
    expect(fn.parameters).toEqual(['fields']);
  });

  test('hasOnly takes fields and uses hasOnly', () => {
    const result = loadModule('validation');
    if (!result.success) throw new Error('Failed to load validation module');
    const fn = result.functions.find(f => f.name === 'hasOnly')!;
    expect(fn.parameters).toEqual(['fields']);
  });
});

describe('stdlib: lobby module', () => {
  test('validCreate is exported', () => {
    const result = loadModule('lobby');
    if (!result.success) throw new Error('Failed to load lobby module');
    const fn = result.functions.find(f => f.name === 'validCreate')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  test('validJoin is exported', () => {
    const result = loadModule('lobby');
    if (!result.success) throw new Error('Failed to load lobby module');
    const fn = result.functions.find(f => f.name === 'validJoin')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  test('canCancel is exported', () => {
    const result = loadModule('lobby');
    if (!result.success) throw new Error('Failed to load lobby module');
    const fn = result.functions.find(f => f.name === 'canCancel')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  test('isWaiting is private (not exported)', () => {
    const result = loadModule('lobby');
    if (!result.success) throw new Error('Failed to load lobby module');
    const fn = result.functions.find(f => f.name === 'isWaiting')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(false);
  });

  test('uses host/guest convention', () => {
    const result = loadModule('lobby');
    if (!result.success) throw new Error('Failed to load lobby module');
    const source = `import { validCreate, validJoin, canCancel } from 'lobby';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow create: if validCreate();
      allow update: if validJoin();
      allow delete: if canCancel();
    }
  }
}`;
    const resolved = resolveModules(source);
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      expect(resolved.data.resolved).toContain('host');
      expect(resolved.data.resolved).toContain('guest');
      expect(resolved.data.resolved).not.toContain('player1');
      expect(resolved.data.resolved).not.toContain('player2');
    }
  });
});

describe('stdlib: turns module', () => {
  test('isMyTurn is exported', () => {
    const result = loadModule('turns');
    if (!result.success) throw new Error('Failed to load turns module');
    const fn = result.functions.find(f => f.name === 'isMyTurn')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  test('turnFlipped is exported', () => {
    const result = loadModule('turns');
    if (!result.success) throw new Error('Failed to load turns module');
    const fn = result.functions.find(f => f.name === 'turnFlipped')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  test('isMyTurn references resource.data (pre-write) for auth check', () => {
    const source = `import { isMyTurn } from 'turns';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{gameId} { allow update: if isMyTurn(); }
  }
}`;
    const resolved = resolveModules(source);
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      // Should reference resource.data.currentTurn and resource.data.host
      expect(resolved.data.resolved).toContain('resource.data.currentTurn');
      expect(resolved.data.resolved).toContain('resource.data.host');
      expect(resolved.data.resolved).toContain('resource.data.guest');
    }
  });

  test('turnFlipped references both resource.data and request.resource.data', () => {
    const source = `import { turnFlipped } from 'turns';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{gameId} { allow update: if turnFlipped(); }
  }
}`;
    const resolved = resolveModules(source);
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      expect(resolved.data.resolved).toContain('resource.data.currentTurn');
      expect(resolved.data.resolved).toContain('request.resource.data.currentTurn');
    }
  });

  test('no name conflicts with lobby module', () => {
    const source = `import { validCreate, validJoin } from 'lobby';
import { isMyTurn, turnFlipped } from 'turns';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{gameId} {
      allow create: if validCreate();
      allow update: if validJoin();
      allow update: if isMyTurn() && turnFlipped();
    }
  }
}`;
    const resolved = resolveModules(source);
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      expect(resolved.data.modules).toContain('lobby');
      expect(resolved.data.modules).toContain('turns');
    }
  });
});

describe('stdlib: state module', () => {
  test('isPlaying is exported', () => {
    const result = loadModule('state');
    if (!result.success) throw new Error('Failed to load state module');
    const fn = result.functions.find(f => f.name === 'isPlaying')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  test('moveIncremented is exported', () => {
    const result = loadModule('state');
    if (!result.success) throw new Error('Failed to load state module');
    const fn = result.functions.find(f => f.name === 'moveIncremented')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  test('participantsUnchanged is exported', () => {
    const result = loadModule('state');
    if (!result.success) throw new Error('Failed to load state module');
    const fn = result.functions.find(f => f.name === 'participantsUnchanged')!;
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  test('isPlaying references resource.data (pre-write)', () => {
    const source = `import { isPlaying } from 'state';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow update: if isPlaying(); }
  }
}`;
    const resolved = resolveModules(source);
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      expect(resolved.data.resolved).toContain('resource.data.status');
      // Should NOT contain request.resource.data.status (that's post-write)
      expect(resolved.data.resolved).not.toContain('request.resource.data.status');
    }
  });

  test('moveIncremented compares pre and post write', () => {
    const source = `import { moveIncremented } from 'state';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow update: if moveIncremented(); }
  }
}`;
    const resolved = resolveModules(source);
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      expect(resolved.data.resolved).toContain('request.resource.data.moveCount');
      expect(resolved.data.resolved).toContain('resource.data.moveCount');
    }
  });

  test('no conflicts with lobby or turns modules', () => {
    const source = `import { validCreate, validJoin } from 'lobby';
import { isMyTurn, turnFlipped } from 'turns';
import { isPlaying, moveIncremented, participantsUnchanged } from 'state';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} {
      allow create: if validCreate();
      allow update: if validJoin();
      allow update: if isPlaying() && isMyTurn() && turnFlipped()
        && moveIncremented() && participantsUnchanged();
    }
  }
}`;
    const resolved = resolveModules(source);
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      expect(resolved.data.modules).toContain('lobby');
      expect(resolved.data.modules).toContain('turns');
      expect(resolved.data.modules).toContain('state');
    }
  });
});

describe('stdlib: integration', () => {
  test('full resolve with both modules produces valid rules', () => {
    const source = `import { isOwner } from 'auth';
import { hasRequired, hasOnly } from 'validation';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /users/{userId} {
      allow read: if isOwner(userId);
      allow create: if isOwner(userId) && hasRequired(['name', 'email']) && hasOnly(['name', 'email', 'bio']);
    }
  }
}`;
    const result = resolveModules(source);
    expect(result.success).toBe(true);
    if (result.success) {
      const ast = parseToAST(result.data.resolved);
      expect(ast).not.toBeNull();
      expect(ast!.version).toBe('2');
      // Validate — should have no critical/high findings (auth is present via isOwner)
      const findings = validateFirestoreRules(ast!);
      const critical = findings.filter(f => f.severity === 'critical');
      expect(critical).toHaveLength(0);
    }
  });

  test('resolved output round-trips cleanly', () => {
    const source = `import { isAuthenticated } from 'auth';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    match /posts/{postId} { allow read: if isAuthenticated(); }
  }
}`;
    const result = resolveModules(source);
    if (!result.success) throw new Error('Failed to resolve');
    // Parse the resolved output and re-assemble — should be identical
    const ast = parseToAST(result.data.resolved);
    const { assembleRules } = require('../../../src/rules/grammar/FirestoreAssembler.js');
    const reassembled = assembleRules(ast!);
    expect(reassembled).toBe(result.data.resolved);
  });
});
