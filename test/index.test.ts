import { describe, expect, it } from 'vitest';
import { measureCode, supportedLanguages } from '../src/index.js';

describe('measureCode', () => {
  it('measures JavaScript line counts and complexity from the syntax tree', () => {
    const metrics = measureCode(
      [
        'function score(value) {',
        '  // ignore negative input',
        '  if (value < 0 || value == null) {',
        '    return 0;',
        '  }',
        '  return value > 10 ? 10 : value;',
        '}',
        '',
      ].join('\n'),
      { language: 'javascript' }
    );

    expect(metrics.lines).toEqual({
      total: 8,
      code: 6,
      comment: 1,
      blank: 1,
    });
    expect(metrics.functionCount).toBe(1);
    expect(metrics.functions[0]).toMatchObject({
      name: 'score',
      cyclomaticComplexity: 4,
    });
    expect(metrics.cyclomaticComplexity).toBeGreaterThanOrEqual(4);
    expect(metrics.cognitiveComplexity).toBeGreaterThan(0);
    expect(metrics.halstead.length).toBeGreaterThan(0);
    expect(metrics.maintainabilityIndex).toBeGreaterThan(0);
  });

  it('supports TypeScript', () => {
    const metrics = measureCode(
      [
        'export function choose(flag: boolean): number {',
        '  if (flag) {',
        '    return 1;',
        '  }',
        '  return 2;',
        '}',
      ].join('\n'),
      { language: 'typescript' }
    );

    expect(metrics.functionCount).toBe(1);
    expect(metrics.functions[0]?.name).toBe('choose');
    expect(metrics.maxCyclomaticComplexity).toBe(2);
  });

  it('supports Python', () => {
    const metrics = measureCode(
      ['def choose(value):', '    if value > 10:', '        return 10', '    return value'].join('\n'),
      { language: 'python' }
    );

    expect(metrics.functionCount).toBe(1);
    expect(metrics.functions[0]?.name).toBe('choose');
    expect(metrics.maxCyclomaticComplexity).toBe(2);
  });

  it('supports Go', () => {
    const metrics = measureCode(
      [
        'package example',
        '',
        'func choose(value int) int {',
        '  if value > 10 {',
        '    return 10',
        '  }',
        '  return value',
        '}',
      ].join('\n'),
      { language: 'go' }
    );

    expect(metrics.functionCount).toBe(1);
    expect(metrics.functions[0]?.name).toBe('choose');
    expect(metrics.maxCyclomaticComplexity).toBe(2);
  });

  it('lists built-in languages', () => {
    expect(supportedLanguages).toEqual(['javascript', 'jsx', 'typescript', 'tsx', 'python', 'go']);
  });
});
