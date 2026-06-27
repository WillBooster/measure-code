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
  endLine: number;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
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
  halstead: HalsteadMetrics;
  maintainabilityIndex: number;
  syntaxTree?: string;
}
