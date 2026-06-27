import { describe, expect, it } from 'vitest';
import { measureCode, supportedLanguages } from '../../src/index.js';

interface LanguageCase {
  code: string;
  expected: {
    classCount?: number;
    functionCount: number;
    functionNames: string[];
    language: string;
    maxCyclomaticComplexity: number;
  };
  language: string;
  name: string;
}

const languageCases: LanguageCase[] = [
  {
    name: 'JavaScript',
    language: 'javascript',
    code: [
      'class Score {}',
      'function score(value) {',
      '  // ignore negative input',
      '  if (value < 0 || value == null) {',
      '    return 0;',
      '  }',
      '  return value > 10 ? 10 : value;',
      '}',
      '',
    ].join('\n'),
    expected: {
      language: 'javascript',
      functionCount: 1,
      functionNames: ['score'],
      classCount: 1,
      maxCyclomaticComplexity: 4,
    },
  },
  {
    name: 'JSX',
    language: 'jsx',
    code: [
      'export function Card({ active }) {',
      '  return <section>{active ? <span>yes</span> : null}</section>;',
      '}',
    ].join('\n'),
    expected: {
      language: 'jsx',
      functionCount: 1,
      functionNames: ['Card'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'TypeScript',
    language: 'typescript',
    code: [
      'export function choose(flag: boolean): number {',
      '  if (flag) {',
      '    return 1;',
      '  }',
      '  return 2;',
      '}',
    ].join('\n'),
    expected: {
      language: 'typescript',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'TSX',
    language: 'tsx',
    code: [
      'type Props = { active: boolean };',
      'export function Card({ active }: Props) {',
      '  return <section>{active ? <span>yes</span> : null}</section>;',
      '}',
    ].join('\n'),
    expected: {
      language: 'tsx',
      functionCount: 1,
      functionNames: ['Card'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'Python',
    language: 'python',
    code: ['def choose(value):', '    if value > 10:', '        return 10', '    return value'].join('\n'),
    expected: {
      language: 'python',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'Go',
    language: 'go',
    code: [
      'package example',
      '',
      'func choose(value int) int {',
      '  if value > 10 {',
      '    return 10',
      '  }',
      '  return value',
      '}',
    ].join('\n'),
    expected: {
      language: 'go',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
];

describe('measureCode e2e', () => {
  for (const testCase of languageCases) {
    it(`measures ${testCase.name} code from the syntax tree`, () => {
      const metrics = measureCode(testCase.code, { language: testCase.language });

      expect(metrics.language).toBe(testCase.expected.language);
      expect(metrics.bytes).toBe(Buffer.byteLength(testCase.code));
      expect(metrics.lines.total).toBe(testCase.code.split('\n').length);
      expect(metrics.lines.code).toBeGreaterThan(0);
      expect(metrics.functionCount).toBe(testCase.expected.functionCount);
      expect(metrics.functions.map((fn) => fn.name)).toEqual(testCase.expected.functionNames);
      expect(metrics.classCount).toBe(testCase.expected.classCount ?? 0);
      expect(metrics.maxCyclomaticComplexity).toBe(testCase.expected.maxCyclomaticComplexity);
      expect(metrics.cyclomaticComplexity).toBeGreaterThanOrEqual(metrics.maxCyclomaticComplexity);
      expect(metrics.maintainabilityIndex).toBeGreaterThan(0);
    });
  }

  it('measures line counts, comments, complexity, and Halstead metrics together', () => {
    const code = [
      'function score(value) {',
      '  // ignore negative input',
      '  if (value < 0 || value == null) {',
      '    return 0;',
      '  }',
      '  return value > 10 ? 10 : value;',
      '}',
      '',
    ].join('\n');

    const metrics = measureCode(code, { language: 'javascript' });

    expect(metrics.lines).toEqual({
      total: 8,
      code: 6,
      comment: 1,
      blank: 1,
    });
    expect(metrics.functions[0]).toMatchObject({
      name: 'score',
      startLine: 1,
      endLine: 7,
      cyclomaticComplexity: 4,
      cognitiveComplexity: 3,
    });
    expect(metrics.cyclomaticComplexity).toBe(4);
    expect(metrics.cognitiveComplexity).toBe(3);
    expect(metrics.halstead.length).toBeGreaterThan(0);
    expect(metrics.halstead.volume).toBeGreaterThan(0);
  });

  it('measures multiple functions and reports the maximum function complexity', () => {
    const code = [
      'function simple() {',
      '  return 1;',
      '}',
      '',
      'function complex(value) {',
      '  if (value > 10) {',
      '    return value;',
      '  }',
      '  return value === 0 ? 1 : value;',
      '}',
    ].join('\n');

    const metrics = measureCode(code, { language: 'javascript' });

    expect(metrics.functionCount).toBe(2);
    expect(metrics.functions.map((fn) => fn.name)).toEqual(['simple', 'complex']);
    expect(metrics.functions.map((fn) => fn.cyclomaticComplexity)).toEqual([1, 3]);
    expect(metrics.maxCyclomaticComplexity).toBe(3);
  });

  it('supports built-in language aliases', () => {
    const cases = [
      { alias: 'js', code: 'function run() { return 1; }', expectedLanguage: 'javascript' },
      { alias: 'ts', code: 'export function run(): number { return 1; }', expectedLanguage: 'typescript' },
      { alias: 'py', code: 'def run():\n    return 1', expectedLanguage: 'python' },
    ];

    for (const { alias, code, expectedLanguage } of cases) {
      expect(measureCode(code, { language: alias }).language).toBe(expectedLanguage);
    }
  });

  it('includes the syntax tree only when requested', () => {
    const code = 'function run() { return 1; }';

    expect(measureCode(code, { language: 'javascript' }).syntaxTree).toBeUndefined();
    expect(measureCode(code, { language: 'javascript', includeSyntaxTree: true }).syntaxTree).toContain(
      'function_declaration'
    );
  });

  it('returns zero source metrics for empty code', () => {
    const metrics = measureCode('', { language: 'javascript' });

    expect(metrics.lines).toEqual({
      total: 0,
      code: 0,
      comment: 0,
      blank: 0,
    });
    expect(metrics.functionCount).toBe(0);
    expect(metrics.maxCyclomaticComplexity).toBe(0);
    expect(metrics.maxCognitiveComplexity).toBe(0);
    expect(metrics.halstead.length).toBe(0);
    expect(metrics.maintainabilityIndex).toBe(100);
  });

  it('throws for unsupported languages', () => {
    expect(() => measureCode('puts "hello"', { language: 'ruby' })).toThrow('Unsupported language: ruby');
  });

  it('lists built-in languages', () => {
    expect(supportedLanguages).toEqual(['javascript', 'jsx', 'typescript', 'tsx', 'python', 'go']);
  });
});
