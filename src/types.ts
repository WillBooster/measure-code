export type SupportedLanguage = 'go' | 'javascript' | 'jsx' | 'python' | 'typescript' | 'tsx';

export type LanguageName = SupportedLanguage | (string & {});
export type ParserLanguage = unknown;

export interface LanguageDefinition {
  name: LanguageName;
  parserLanguage: ParserLanguage;
  aliases?: readonly string[];
  functionNodeTypes?: readonly string[];
  classNodeTypes?: readonly string[];
  decisionNodeTypes?: readonly string[];
  nestingNodeTypes?: readonly string[];
}

export interface MeasureOptions {
  language: LanguageName;
  includeSyntaxTree?: boolean;
}

export interface LineMetrics {
  total: number;
  code: number;
  comment: number;
  blank: number;
}

export interface HalsteadMetrics {
  distinctOperators: number;
  distinctOperands: number;
  totalOperators: number;
  totalOperands: number;
  vocabulary: number;
  length: number;
  volume: number;
  difficulty: number;
  effort: number;
  time: number;
  bugs: number;
}

export interface FunctionMetrics {
  name?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  returnsJsx: boolean;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  callCount: number;
  uniqueCalleeCount: number;
  fanIn: number;
  fanOut: number;
  recursive: boolean;
}

export interface CallGraphMetrics {
  callCount: number;
  uniqueCalleeCount: number;
  internalCallCount: number;
  internalEdgeCount: number;
  recursiveFunctionCount: number;
  maxFanIn: number;
  maxFanOut: number;
  maxCallDepth: number;
}

export interface CouplingMetrics {
  importCount: number;
  importSourceCount: number;
  relativeImportCount: number;
  externalImportCount: number;
  exportCount: number;
}

export interface DeclarationMetrics {
  exported: boolean;
  name: string;
  startLine: number;
}

export interface ModuleMetrics {
  declarations: DeclarationMetrics[];
  importSources: string[];
}

export interface CohesionMetrics {
  averageFunctionIdentifierOverlap: number;
  sharedIdentifierCount: number;
  uniqueIdentifierCount: number;
}

export interface SyntaxFeatureMetrics {
  assignmentCount: number;
  awaitExpressionCount: number;
  loopStatementCount: number;
  mutableBindingCount: number;
  returnStatementCount: number;
  throwStatementCount: number;
  tryStatementCount: number;
}

export interface TypeComplexityMetrics {
  typeAnnotationCount: number;
  typeAliasCount: number;
  interfaceCount: number;
  genericParameterCount: number;
  unionTypeCount: number;
  intersectionTypeCount: number;
  conditionalTypeCount: number;
  typeAssertionCount: number;
  nonNullAssertionCount: number;
  satisfiesExpressionCount: number;
}

export interface CodeMetrics {
  language: LanguageName;
  bytes: number;
  lines: LineMetrics;
  functions: FunctionMetrics[];
  classCount: number;
  functionCount: number;
  cyclomaticComplexity: number;
  maxCyclomaticComplexity: number;
  cognitiveComplexity: number;
  maxCognitiveComplexity: number;
  nestingDepth: number;
  callGraph: CallGraphMetrics;
  coupling: CouplingMetrics;
  module: ModuleMetrics;
  cohesion: CohesionMetrics;
  syntaxFeatures: SyntaxFeatureMetrics;
  typeComplexity: TypeComplexityMetrics;
  halstead: HalsteadMetrics;
  maintainabilityIndex: number;
  syntaxTree?: string;
}
