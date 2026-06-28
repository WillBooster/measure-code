import Parser from 'tree-sitter';
import { createLanguageRegistry } from './languages.js';
import type {
  CallGraphMetrics,
  CodeMetrics,
  CohesionMetrics,
  CouplingMetrics,
  FunctionMetrics,
  HalsteadMetrics,
  LanguageDefinition,
  LanguageName,
  MeasureOptions,
  TypeComplexityMetrics,
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

interface FunctionAnalysis {
  name?: string;
  startLine: number;
  endLine: number;
  returnsJsx: boolean;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  callCount: number;
  callees: Set<string>;
  identifiers: Set<string>;
}

interface StructuralMetrics {
  callGraph: CallGraphMetrics;
  cohesion: CohesionMetrics;
  coupling: CouplingMetrics;
  functions: FunctionMetrics[];
  typeComplexity: TypeComplexityMetrics;
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
    const structuralMetrics = measureStructuralMetrics(root, functions, language);
    const functionMetrics = structuralMetrics.functions;
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
      callGraph: structuralMetrics.callGraph,
      coupling: structuralMetrics.coupling,
      cohesion: structuralMetrics.cohesion,
      typeComplexity: structuralMetrics.typeComplexity,
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

function measureStructuralMetrics(
  root: Parser.SyntaxNode,
  functions: Parser.SyntaxNode[],
  language: LanguageDefinition
): StructuralMetrics {
  const analyses = functions.map((node) => analyzeFunction(node, language));
  const callGraph = measureCallGraph(analyses);
  const functionsWithGraph = analyses.map((analysis) => ({
    name: analysis.name,
    startLine: analysis.startLine,
    endLine: analysis.endLine,
    returnsJsx: analysis.returnsJsx,
    cyclomaticComplexity: analysis.cyclomaticComplexity,
    cognitiveComplexity: analysis.cognitiveComplexity,
    callCount: analysis.callCount,
    uniqueCalleeCount: analysis.callees.size,
    fanIn: callGraph.fanInByName.get(analysis.name ?? '') ?? 0,
    fanOut: callGraph.fanOutByName.get(analysis.name ?? '') ?? 0,
    recursive: callGraph.recursiveNames.has(analysis.name ?? ''),
  }));

  return {
    functions: functionsWithGraph,
    callGraph: callGraph.metrics,
    coupling: measureCoupling(root, language),
    cohesion: measureCohesion(analyses),
    typeComplexity: measureTypeComplexity(root),
  };
}

function analyzeFunction(node: Parser.SyntaxNode, language: LanguageDefinition): FunctionAnalysis {
  const complexity = measureComplexity(node, language, 0);
  const calls = collectCalls(node);
  return {
    name: findFunctionName(node),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    returnsJsx: returnsJsx(node, language),
    cyclomaticComplexity: complexity.cyclomaticComplexity,
    cognitiveComplexity: complexity.cognitiveComplexity,
    callCount: calls.callCount,
    callees: calls.callees,
    identifiers: collectIdentifiers(node),
  };
}

function measureCallGraph(analyses: FunctionAnalysis[]): {
  fanInByName: Map<string, number>;
  fanOutByName: Map<string, number>;
  metrics: CallGraphMetrics;
  recursiveNames: Set<string>;
} {
  const functionNames = new Set(analyses.map((analysis) => analysis.name).filter((name) => name !== undefined));
  const fanInByName = new Map<string, number>();
  const fanOutByName = new Map<string, number>();
  const graph = new Map<string, Set<string>>();
  let callCount = 0;
  let internalCallCount = 0;
  const allCallees = new Set<string>();

  for (const analysis of analyses) {
    callCount += analysis.callCount;
    for (const callee of analysis.callees) {
      allCallees.add(callee);
    }

    if (!analysis.name) {
      continue;
    }

    const internalCallees = new Set([...analysis.callees].filter((callee) => functionNames.has(callee)));
    graph.set(analysis.name, internalCallees);
    fanOutByName.set(analysis.name, internalCallees.size);
    for (const callee of internalCallees) {
      fanInByName.set(callee, (fanInByName.get(callee) ?? 0) + 1);
      internalCallCount += 1;
    }
  }

  const recursiveNames = findRecursiveNames(graph);

  return {
    fanInByName,
    fanOutByName,
    recursiveNames,
    metrics: {
      callCount,
      uniqueCalleeCount: allCallees.size,
      internalCallCount,
      internalEdgeCount: sum([...graph.values()].map((callees) => callees.size)),
      recursiveFunctionCount: recursiveNames.size,
      maxFanIn: maxMapValue(fanInByName),
      maxFanOut: maxMapValue(fanOutByName),
      maxCallDepth: measureMaxCallDepth(graph),
    },
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

function collectCalls(root: Parser.SyntaxNode): { callCount: number; callees: Set<string> } {
  const callees = new Set<string>();
  let callCount = 0;

  function visit(node: Parser.SyntaxNode): void {
    if (isCallNode(node)) {
      callCount += 1;
      const callee = findCalleeName(node);
      if (callee) {
        callees.add(callee);
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return { callCount, callees };
}

function collectIdentifiers(root: Parser.SyntaxNode): Set<string> {
  const identifiers = new Set<string>();

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'identifier' || node.type === 'property_identifier' || node.type === 'field_identifier') {
      identifiers.add(node.text);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return identifiers;
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

function returnsJsx(root: Parser.SyntaxNode, language: LanguageDefinition): boolean {
  const functionNodeTypes = new Set(language.functionNodeTypes);

  function visit(node: Parser.SyntaxNode, insideRoot: boolean): boolean {
    if (!insideRoot && functionNodeTypes.has(node.type)) {
      return false;
    }

    if (node.type === 'return_statement') {
      return containsJsxExpression(node, functionNodeTypes) || containsReactCreateElementCall(node, functionNodeTypes);
    }

    if (root.type === 'arrow_function' && node === getArrowFunctionBody(root) && node.type !== 'statement_block') {
      return containsJsxExpression(node, functionNodeTypes) || containsReactCreateElementCall(node, functionNodeTypes);
    }

    for (const child of node.namedChildren) {
      if (visit(child, false)) {
        return true;
      }
    }
    return false;
  }

  return visit(root, true);
}

function getArrowFunctionBody(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return node.childForFieldName('body') ?? node.namedChild(node.namedChildCount - 1) ?? undefined;
}

function containsJsxExpression(root: Parser.SyntaxNode, functionNodeTypes: Set<string>): boolean {
  return containsNode(root, functionNodeTypes, (node) => node.type.startsWith('jsx_'));
}

function containsReactCreateElementCall(root: Parser.SyntaxNode, functionNodeTypes: Set<string>): boolean {
  return containsNode(root, functionNodeTypes, isReactCreateElementCall);
}

function containsNode(
  root: Parser.SyntaxNode,
  functionNodeTypes: Set<string>,
  predicate: (node: Parser.SyntaxNode) => boolean
): boolean {
  function visit(node: Parser.SyntaxNode, insideRoot: boolean): boolean {
    if (!insideRoot && functionNodeTypes.has(node.type)) {
      return false;
    }

    if (predicate(node)) {
      return true;
    }

    for (const child of node.namedChildren) {
      if (visit(child, false)) {
        return true;
      }
    }
    return false;
  }

  return visit(root, true);
}

function measureCoupling(root: Parser.SyntaxNode, language: LanguageDefinition): CouplingMetrics {
  const importSources = new Set<string>();
  let importCount = 0;
  let exportCount = 0;
  let relativeImportCount = 0;

  function visit(node: Parser.SyntaxNode): void {
    if (isImportNode(node)) {
      importCount += 1;
      for (const source of findImportSources(node, language)) {
        importSources.add(source);
        if (source.startsWith('.') || source.startsWith('/')) {
          relativeImportCount += 1;
        }
      }
    }

    if (isExportNode(node)) {
      exportCount += 1;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);

  return {
    importCount,
    importSourceCount: importSources.size,
    relativeImportCount,
    externalImportCount: importSources.size - relativeImportCount,
    exportCount,
  };
}

function measureCohesion(analyses: FunctionAnalysis[]): CohesionMetrics {
  const allIdentifiers = new Set<string>();
  const sharedIdentifiers = new Set<string>();
  let overlapTotal = 0;
  let pairCount = 0;

  for (const analysis of analyses) {
    for (const identifier of analysis.identifiers) {
      allIdentifiers.add(identifier);
    }
  }

  for (let leftIndex = 0; leftIndex < analyses.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < analyses.length; rightIndex += 1) {
      const left = analyses[leftIndex];
      const right = analyses[rightIndex];
      if (!left || !right) {
        continue;
      }

      const intersection = intersectSets(left.identifiers, right.identifiers);
      const unionSize = new Set([...left.identifiers, ...right.identifiers]).size;
      for (const identifier of intersection) {
        sharedIdentifiers.add(identifier);
      }
      overlapTotal += unionSize === 0 ? 0 : intersection.size / unionSize;
      pairCount += 1;
    }
  }

  return {
    averageFunctionIdentifierOverlap: pairCount === 0 ? 1 : overlapTotal / pairCount,
    sharedIdentifierCount: sharedIdentifiers.size,
    uniqueIdentifierCount: allIdentifiers.size,
  };
}

function measureTypeComplexity(root: Parser.SyntaxNode): TypeComplexityMetrics {
  const metrics: TypeComplexityMetrics = {
    typeAnnotationCount: 0,
    typeAliasCount: 0,
    interfaceCount: 0,
    genericParameterCount: 0,
    unionTypeCount: 0,
    intersectionTypeCount: 0,
    conditionalTypeCount: 0,
    typeAssertionCount: 0,
    nonNullAssertionCount: 0,
    satisfiesExpressionCount: 0,
  };

  function visit(node: Parser.SyntaxNode): void {
    switch (node.type) {
      case 'type_annotation': {
        metrics.typeAnnotationCount += 1;
        break;
      }
      case 'type_alias_declaration': {
        metrics.typeAliasCount += 1;
        break;
      }
      case 'interface_declaration': {
        metrics.interfaceCount += 1;
        break;
      }
      case 'type_parameters':
      case 'type_parameter': {
        metrics.genericParameterCount += node.type === 'type_parameter' ? 1 : 0;
        break;
      }
      case 'union_type': {
        metrics.unionTypeCount += 1;
        break;
      }
      case 'intersection_type': {
        metrics.intersectionTypeCount += 1;
        break;
      }
      case 'conditional_type': {
        metrics.conditionalTypeCount += 1;
        break;
      }
      case 'as_expression':
      case 'type_assertion': {
        metrics.typeAssertionCount += 1;
        break;
      }
      case 'non_null_expression': {
        metrics.nonNullAssertionCount += 1;
        break;
      }
      case 'satisfies_expression': {
        metrics.satisfiesExpressionCount += 1;
        break;
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return metrics;
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

  const wrappedName = findWrappedComponentName(node);
  if (wrappedName) {
    return wrappedName;
  }

  const parent = node.parent;
  if (!parent) {
    return undefined;
  }

  const parentName = parent.childForFieldName('name');
  return parentName?.text;
}

function findWrappedComponentName(node: Parser.SyntaxNode): string | undefined {
  const argumentsNode = node.parent;
  const callNode = argumentsNode?.parent;
  const declaratorNode = callNode?.parent;
  if (
    argumentsNode?.type !== 'arguments' ||
    callNode?.type !== 'call_expression' ||
    declaratorNode?.type !== 'variable_declarator' ||
    !isReactComponentWrapperCall(callNode)
  ) {
    return undefined;
  }

  return declaratorNode.childForFieldName('name')?.text;
}

function isReactComponentWrapperCall(node: Parser.SyntaxNode): boolean {
  const calleeNode = node.childForFieldName('function') ?? node.namedChild(0);
  return (
    calleeNode?.text === 'memo' ||
    calleeNode?.text === 'React.memo' ||
    calleeNode?.text === 'forwardRef' ||
    calleeNode?.text === 'React.forwardRef'
  );
}

function isCallNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'call_expression' || node.type === 'call';
}

function findCalleeName(node: Parser.SyntaxNode): string | undefined {
  const calleeNode = node.childForFieldName('function') ?? node.namedChild(0);
  if (!calleeNode) {
    return undefined;
  }

  return findRightmostIdentifier(calleeNode);
}

function findRightmostIdentifier(node: Parser.SyntaxNode): string | undefined {
  if (
    node.type === 'identifier' ||
    node.type === 'property_identifier' ||
    node.type === 'field_identifier' ||
    node.type === 'attribute'
  ) {
    return node.text;
  }

  for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
    const child = node.namedChild(index);
    if (!child) {
      continue;
    }

    const identifier = findRightmostIdentifier(child);
    if (identifier) {
      return identifier;
    }
  }

  return undefined;
}

function isReactCreateElementCall(node: Parser.SyntaxNode): boolean {
  if (!isCallNode(node)) {
    return false;
  }

  const calleeNode = node.childForFieldName('function') ?? node.namedChild(0);
  return calleeNode?.text === 'React.createElement' || calleeNode?.text === 'createElement';
}

function isImportNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'import_statement' ||
    node.type === 'import_declaration' ||
    node.type === 'import_from_statement' ||
    node.type === 'import_spec' ||
    node.type === 'import_spec_list'
  );
}

function findImportSources(node: Parser.SyntaxNode, language: LanguageDefinition): string[] {
  if (language.name === 'python') {
    const pythonSources = findPythonImportSources(node);
    if (pythonSources.length > 0) {
      return pythonSources;
    }
  }

  const sourceNode = findFirstStringNode(node);
  return sourceNode ? [unquote(sourceNode.text)] : [];
}

function findPythonImportSources(node: Parser.SyntaxNode): string[] {
  if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name');
    return moduleNode ? [normalizeImportSource(moduleNode.text)] : [];
  }

  if (node.type !== 'import_statement') {
    return [];
  }

  return node.namedChildren
    .map((child) => findPythonImportedModuleName(child))
    .filter((source) => source !== undefined);
}

function findPythonImportedModuleName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === 'dotted_name' || node.type === 'relative_import') {
    return normalizeImportSource(node.text);
  }

  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    return normalizeImportSource(nameNode.text);
  }

  for (const child of node.namedChildren) {
    const source = findPythonImportedModuleName(child);
    if (source) {
      return source;
    }
  }

  return undefined;
}

function normalizeImportSource(source: string): string {
  return source.replaceAll(/\s+/gu, '');
}

function findFirstStringNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  if (node.type === 'string' || node.type === 'string_literal' || node.type === 'interpreted_string_literal') {
    return node;
  }

  for (const child of node.namedChildren) {
    const stringNode = findFirstStringNode(child);
    if (stringNode) {
      return stringNode;
    }
  }

  return undefined;
}

function unquote(value: string): string {
  return value.replaceAll(/^['"`]|['"`]$/gu, '');
}

function isExportNode(node: Parser.SyntaxNode): boolean {
  return node.type.startsWith('export') || node.type === 'public_field_definition';
}

function findRecursiveNames(graph: Map<string, Set<string>>): Set<string> {
  const recursiveNames = new Set<string>();

  for (const name of graph.keys()) {
    if (canReach(name, name, graph, new Set())) {
      recursiveNames.add(name);
    }
  }

  return recursiveNames;
}

function canReach(start: string, target: string, graph: Map<string, Set<string>>, visited: Set<string>): boolean {
  const callees = graph.get(start);
  if (!callees) {
    return false;
  }

  for (const callee of callees) {
    if (callee === target) {
      return true;
    }

    if (!visited.has(callee)) {
      visited.add(callee);
      if (canReach(callee, target, graph, visited)) {
        return true;
      }
    }
  }

  return false;
}

function measureMaxCallDepth(graph: Map<string, Set<string>>): number {
  let maxDepth = 0;
  for (const name of graph.keys()) {
    maxDepth = Math.max(maxDepth, measureCallDepth(name, graph, new Set()));
  }
  return maxDepth;
}

function measureCallDepth(name: string, graph: Map<string, Set<string>>, pathNames: Set<string>): number {
  const callees = graph.get(name);
  if (!callees || callees.size === 0 || pathNames.has(name)) {
    return 0;
  }

  pathNames.add(name);
  let maxDepth = 0;
  for (const callee of callees) {
    maxDepth = Math.max(maxDepth, 1 + measureCallDepth(callee, graph, new Set(pathNames)));
  }
  return maxDepth;
}

function intersectSets(left: Set<string>, right: Set<string>): Set<string> {
  const intersection = new Set<string>();
  for (const value of left) {
    if (right.has(value)) {
      intersection.add(value);
    }
  }
  return intersection;
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

function maxMapValue(map: Map<string, number>): number {
  let maximum = 0;
  for (const value of map.values()) {
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
