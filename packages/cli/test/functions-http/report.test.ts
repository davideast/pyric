import { describe, expect, test } from 'bun:test';
import { functionsTriggersLine } from '../../src/functions/http/report.js';

describe('functionsTriggersLine', () => {
  test('formats singular and plural trigger counts without hardcoding a trigger kind', () => {
    expect(functionsTriggersLine(0, 'functions/index.js')).toBe('functions 0 triggers from functions/index.js');
    expect(functionsTriggersLine(1, 'functions/index.js')).toBe('functions 1 trigger from functions/index.js');
    expect(functionsTriggersLine(3, 'functions/dist/index.js')).toBe(
      'functions 3 triggers from functions/dist/index.js',
    );
  });
});
