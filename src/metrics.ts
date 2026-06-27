import Parser from 'tree-sitter';
import { createLanguageRegistry } from './languages.js';
import type {
  CodeMetrics,
  FunctionMetrics,
  HalsteadMetrics,
  LanguageDefinition,
  LanguageName,
  MeasureOptions,
} from './types.js';

const booleanOperators = new Set(['&&', '||', 'and', 'or']);
const operatorTexts = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  '!',
  '~',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '=>',
  'return',
  'throw',
  'yield',
  'await',
  'break',
  'continue',
]);

const operandNodeTypes = new Set([
  'identifier',
  'property_identifier',
  'field_identifier',
  'type_identifier',
  'number',
  'integer',
  'float',
  'string',
  'string_literal',
  'template_string',
  'character_literal',
  'true',
  'false',
  'null',
  'undefined',
  'nil',
]);

interface ComplexityResult {
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  nestingDepth: number;
}

interface CommentSpan {
  line: number;
  startColumn: number;
  endColumn: number;
}

export class TreeMeasurer {
  private readonly registry = createLanguageRegistry();

  registerLanguage(language: LanguageDefinition): void {
    this.registry.set(language.name, language);
    for (const alias of language.aliases ?? []) {
      this.registry.set(alias, language);
    }
  }

  getSupportedLanguages(): LanguageName[] {
    return [...new Set([...this.registry.values()].map((language) => language.name))];
  }

  measure(code: string, options: MeasureOptions): CodeMetrics {
    const language = this.registry.get(options.language);
    if (!language) {
      throw new Error(`Unsupported language: ${options.language}`);
    }

    const parser = new Parser();
    parser.setLanguage(language.parserLanguage);
    const tree = parser.parse(code, undefined, {
      bufferSize: code.length + 1,
    });
    const root = tree.rootNode;
    const functions = collectNodes(root, new Set(language.functionNodeTypes));
    const functionMetrics = functions.map((node) => measureFunction(node, language));
    const globalComplexity = measureComplexity(root, language, 0);
    const lines = measureLines(code, root);
    const halstead = measureHalstead(root, code);

    return {
      language: language.name,
      bytes: Buffer.byteLength(code),
      lines,
      functions: functionMetrics,
      classCount: collectNodes(root, new Set(language.classNodeTypes)).length,
      functionCount: functionMetrics.length,
      cyclomaticComplexity: globalComplexity.cyclomaticComplexity,
      maxCyclomaticComplexity: maxMetric(functionMetrics, 'cyclomaticComplexity'),
      cognitiveComplexity: globalComplexity.cognitiveComplexity,
      maxCognitiveComplexity: maxMetric(functionMetrics, 'cognitiveComplexity'),
      nestingDepth: globalComplexity.nestingDepth,
      halstead,
      maintainabilityIndex: calculateMaintainabilityIndex(
        halstead.volume,
        globalComplexity.cyclomaticComplexity,
        lines.code
      ),
      syntaxTree: options.includeSyntaxTree ? root.toString() : undefined,
    };
  }
}

export const defaultMeasurer = new TreeMeasurer();

export function measureCode(code: string, options: MeasureOptions): CodeMetrics {
  return defaultMeasurer.measure(code, options);
}

function measureFunction(node: Parser.SyntaxNode, language: LanguageDefinition): FunctionMetrics {
  const complexity = measureComplexity(node, language, 0);

  return {
    name: findFunctionName(node),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    cyclomaticComplexity: complexity.cyclomaticComplexity,
    cognitiveComplexity: complexity.cognitiveComplexity,
  };
}

function measureComplexity(node: Parser.SyntaxNode, language: LanguageDefinition, nesting: number): ComplexityResult {
  let cyclomaticComplexity = 1;
  let cognitiveComplexity = 0;
  let nestingDepth = nesting;
  const decisionNodes = new Set(language.decisionNodeTypes);
  const nestingNodes = new Set(language.nestingNodeTypes);

  function visit(current: Parser.SyntaxNode, currentNesting: number): void {
    const isDecision = decisionNodes.has(current.type);
    const isNesting = nestingNodes.has(current.type);

    if (isDecision) {
      cyclomaticComplexity += 1;
      cognitiveComplexity += 1 + currentNesting;
    }

    if (isBooleanOperator(current)) {
      cyclomaticComplexity += 1;
      cognitiveComplexity += 1;
    }

    const childNesting = isNesting ? currentNesting + 1 : currentNesting;
    nestingDepth = Math.max(nestingDepth, childNesting);

    for (const child of current.children) {
      visit(child, childNesting);
    }
  }

  for (const child of node.children) {
    visit(child, nesting);
  }

  return { cyclomaticComplexity, cognitiveComplexity, nestingDepth };
}

function isBooleanOperator(node: Parser.SyntaxNode): boolean {
  if (node.isNamed) {
    return false;
  }

  return booleanOperators.has(node.text);
}

function collectNodes(root: Parser.SyntaxNode, nodeTypes: Set<string>): Parser.SyntaxNode[] {
  const nodes: Parser.SyntaxNode[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (nodeTypes.has(node.type)) {
      nodes.push(node);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return nodes;
}

function measureLines(code: string, root: Parser.SyntaxNode): CodeMetrics['lines'] {
  const sourceLines = code.length === 0 ? [] : code.split(/\r\n|\n|\r/);
  const commentSpans = collectCommentSpans(root);
  let blank = 0;
  let comment = 0;

  for (const [index, line] of sourceLines.entries()) {
    if (line.trim() === '') {
      blank += 1;
      continue;
    }

    if (isCommentOnlyLine(line, index, commentSpans)) {
      comment += 1;
    }
  }

  return {
    total: sourceLines.length,
    code: sourceLines.length - blank - comment,
    comment,
    blank,
  };
}

function collectCommentSpans(root: Parser.SyntaxNode): CommentSpan[] {
  const spans: CommentSpan[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'comment' || node.type === 'line_comment' || node.type === 'block_comment') {
      for (let row = node.startPosition.row; row <= node.endPosition.row; row += 1) {
        spans.push({
          line: row,
          startColumn: row === node.startPosition.row ? node.startPosition.column : 0,
          endColumn: row === node.endPosition.row ? node.endPosition.column : Number.POSITIVE_INFINITY,
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return spans;
}

function isCommentOnlyLine(line: string, lineIndex: number, spans: CommentSpan[]): boolean {
  const relevantSpans = spans.filter((span) => span.line === lineIndex);
  if (relevantSpans.length === 0) {
    return false;
  }

  const firstContentColumn = line.search(/\S/);
  const lastContentColumn = line.trimEnd().length;

  return relevantSpans.some((span) => span.startColumn <= firstContentColumn && span.endColumn >= lastContentColumn);
}

function measureHalstead(root: Parser.SyntaxNode, code: string): HalsteadMetrics {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'comment') {
      return;
    }

    if (node.childCount === 0) {
      const text = code.slice(node.startIndex, node.endIndex);
      if (operatorTexts.has(text) || operatorTexts.has(node.type)) {
        incrementCount(operators, text || node.type);
      } else if (operandNodeTypes.has(node.type)) {
        incrementCount(operands, text);
      }
      return;
    }

    if (operatorTexts.has(node.type)) {
      incrementCount(operators, node.type);
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);

  const distinctOperators = operators.size;
  const distinctOperands = operands.size;
  const totalOperators = sum(operators.values());
  const totalOperands = sum(operands.values());
  const vocabulary = distinctOperators + distinctOperands;
  const length = totalOperators + totalOperands;
  const volume = vocabulary === 0 ? 0 : length * Math.log2(vocabulary);
  const difficulty = distinctOperands === 0 ? 0 : (distinctOperators / 2) * (totalOperands / distinctOperands);
  const effort = difficulty * volume;

  return {
    distinctOperators,
    distinctOperands,
    totalOperators,
    totalOperands,
    vocabulary,
    length,
    volume,
    difficulty,
    effort,
    time: effort / 18,
    bugs: volume / 3000,
  };
}

function findFunctionName(node: Parser.SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    return nameNode.text;
  }

  const parent = node.parent;
  if (!parent) {
    return undefined;
  }

  const parentName = parent.childForFieldName('name');
  return parentName?.text;
}

function calculateMaintainabilityIndex(volume: number, complexity: number, loc: number): number {
  if (loc === 0) {
    return 100;
  }

  const raw = 171 - 5.2 * Math.log(Math.max(volume, 1)) - 0.23 * complexity - 16.2 * Math.log(loc);
  return Math.max(0, Math.min(100, (raw * 100) / 171));
}

function incrementCount(map: Map<string, number>, value: string): void {
  map.set(value, (map.get(value) ?? 0) + 1);
}

function maxMetric(functions: FunctionMetrics[], key: 'cyclomaticComplexity' | 'cognitiveComplexity'): number {
  return functions.length === 0 ? 0 : Math.max(...functions.map((fn) => fn[key]));
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
