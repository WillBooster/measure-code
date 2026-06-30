import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { API, SignatureKind, type Checker, type Type } from '@typescript/native-preview/unstable/async';
import { getTokenPosOfNode, SyntaxKind, type Node, type SourceFile } from '@typescript/native-preview/unstable/ast';

export interface ReactComponentFunctionMetric {
  file: string;
  name?: string;
  startLine: number;
  startColumn: number;
}

export interface TypeScriptProjectMetrics {
  callExpressionCount: number;
  configDiagnosticCount: number;
  configFile: string;
  declarationDiagnosticCount: number;
  diagnosticFileCount: number;
  measuredRootFileCount: number;
  projectCount: number;
  reactComponentFunctions: ReactComponentFunctionMetric[];
  resolvedCallExpressionCount: number;
  resolvedCallExpressionRatio: number;
  rootFileCount: number;
  semanticDiagnosticCount: number;
  suggestionDiagnosticCount: number;
  syntacticDiagnosticCount: number;
  unresolvedCallExpressionCount: number;
}

interface DiagnosticLike {
  fileName?: string;
}

interface ReactComponentCandidateMetric extends Omit<ReactComponentFunctionMetric, 'file'> {
  implementationKey: string;
}

export async function measureTypeScriptProject(
  configFile: string,
  measuredFiles: readonly string[] = []
): Promise<TypeScriptProjectMetrics> {
  const api = new API({ cwd: process.cwd() });
  try {
    const snapshot = await api.updateSnapshot({ openProject: configFile });
    const projects = snapshot.getProjects();
    const measuredFileByCanonicalFile = await mapMeasuredFilesByCanonicalFile(measuredFiles);
    const measuredFileSet = new Set(measuredFileByCanonicalFile.keys());
    const diagnosticFiles = new Set<string>();
    const totals = {
      callExpressionCount: 0,
      configDiagnosticCount: 0,
      declarationDiagnosticCount: 0,
      measuredRootFileCount: 0,
      resolvedCallExpressionCount: 0,
      rootFileCount: 0,
      semanticDiagnosticCount: 0,
      suggestionDiagnosticCount: 0,
      syntacticDiagnosticCount: 0,
    };
    const reactComponentFunctions: ReactComponentFunctionMetric[] = [];
    const analyzedFiles = new Set<string>();

    for (const project of projects) {
      const projectRootFiles = await Promise.all(
        project.rootFiles.map(async (file) => ({ canonicalFile: await canonicalizeFile(file), file }))
      );
      totals.rootFileCount += projectRootFiles.length;
      totals.measuredRootFileCount += projectRootFiles.filter(({ canonicalFile }) =>
        measuredFileSet.has(canonicalFile)
      ).length;

      const syntacticDiagnostics = await project.program.getSyntacticDiagnostics();
      const semanticDiagnostics = await project.program.getSemanticDiagnostics();
      const suggestionDiagnostics = await project.program.getSuggestionDiagnostics();
      const declarationDiagnostics = await project.program.getDeclarationDiagnostics();
      const configDiagnostics = await project.program.getConfigFileParsingDiagnostics();
      totals.syntacticDiagnosticCount += syntacticDiagnostics.length;
      totals.semanticDiagnosticCount += semanticDiagnostics.length;
      totals.suggestionDiagnosticCount += suggestionDiagnostics.length;
      totals.declarationDiagnosticCount += declarationDiagnostics.length;
      totals.configDiagnosticCount += configDiagnostics.length;
      addDiagnosticFiles(diagnosticFiles, [
        ...syntacticDiagnostics,
        ...semanticDiagnostics,
        ...suggestionDiagnostics,
        ...declarationDiagnostics,
        ...configDiagnostics,
      ]);

      const projectAnalysisFiles =
        measuredFileSet.size === 0
          ? projectRootFiles
          : [...measuredFileByCanonicalFile.entries()].map(([canonicalFile, file]) => ({ canonicalFile, file }));
      const configDirectory = path.dirname(project.configFileName);
      const canonicalConfigDirectory = await canonicalizeFile(configDirectory);
      for (const { canonicalFile, file } of projectAnalysisFiles) {
        if (analyzedFiles.has(canonicalFile)) {
          continue;
        }
        const sourceFile = await getProjectSourceFile(
          project,
          file,
          canonicalFile,
          configDirectory,
          canonicalConfigDirectory
        );
        if (!sourceFile) {
          continue;
        }
        analyzedFiles.add(canonicalFile);
        const callExpressions = collectCallExpressions(sourceFile);
        totals.callExpressionCount += callExpressions.length;
        const fileReactComponentFunctions = await collectReactComponentFunctions(sourceFile, project.checker);
        reactComponentFunctions.push(
          ...fileReactComponentFunctions.map((component) => ({
            ...component,
            file: measuredFileByCanonicalFile.get(canonicalFile) ?? file,
          }))
        );
        for (const callExpression of callExpressions) {
          if (await project.checker.getResolvedSignature(callExpression)) {
            totals.resolvedCallExpressionCount += 1;
          }
        }
      }
    }

    const unresolvedCallExpressionCount = totals.callExpressionCount - totals.resolvedCallExpressionCount;
    return {
      ...totals,
      configFile,
      diagnosticFileCount: diagnosticFiles.size,
      projectCount: projects.length,
      reactComponentFunctions,
      unresolvedCallExpressionCount,
      resolvedCallExpressionRatio:
        totals.callExpressionCount === 0 ? 0 : totals.resolvedCallExpressionCount / totals.callExpressionCount,
    };
  } finally {
    await api.close();
  }
}

async function getProjectSourceFile(
  project: { configFileName: string; program: { getSourceFile: (file: string) => Promise<SourceFile | undefined> } },
  file: string,
  canonicalFile: string,
  configDirectory: string,
  canonicalConfigDirectory: string
): Promise<SourceFile | undefined> {
  for (const candidate of getProjectFileCandidates(file, canonicalFile, configDirectory, canonicalConfigDirectory)) {
    const sourceFile = await project.program.getSourceFile(candidate);
    if (sourceFile) {
      return sourceFile;
    }
  }
  return undefined;
}

function getProjectFileCandidates(
  file: string,
  canonicalFile: string,
  configDirectory: string,
  canonicalConfigDirectory: string
): string[] {
  const candidates = new Set([file, canonicalFile]);
  if (canonicalFile.startsWith(`${canonicalConfigDirectory}${path.sep}`)) {
    candidates.add(path.join(configDirectory, path.relative(canonicalConfigDirectory, canonicalFile)));
  }
  return [...candidates];
}

async function mapMeasuredFilesByCanonicalFile(files: readonly string[]): Promise<Map<string, string>> {
  const measuredFileByCanonicalFile = new Map<string, string>();
  for (const file of files) {
    measuredFileByCanonicalFile.set(await canonicalizeFile(file), file);
  }
  return measuredFileByCanonicalFile;
}

async function canonicalizeFile(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return file;
  }
}

async function collectReactComponentFunctions(
  sourceFile: SourceFile,
  checker: Checker
): Promise<Omit<ReactComponentFunctionMetric, 'file'>[]> {
  const components: ReactComponentCandidateMetric[] = [];
  const candidates = collectReactComponentCandidates(sourceFile);
  for (const candidate of candidates) {
    if (!(await isReactComponentCandidate(candidate, checker))) {
      continue;
    }
    const name = findNameNode(candidate);
    const functionNode = findComponentFunctionNode(candidate);
    const startOffset = findFunctionStartPosition(sourceFile.text, functionNode, name, sourceFile);
    const startPosition = positionToLineColumn(sourceFile.text, startOffset);
    components.push({
      implementationKey: `${functionNode.pos}:${functionNode.end}`,
      name: name ? findCandidateName(name) : undefined,
      startColumn: startPosition.column,
      startLine: startPosition.line,
    });
  }
  return dedupeReactComponentFunctions(components);
}

function collectReactComponentCandidates(root: Node): Node[] {
  const candidates: Node[] = [];
  visitNode(root, (node) => {
    if (isFunctionLikeCandidate(node) || isVariableFunctionCandidate(node)) {
      candidates.push(node);
    }
  });
  return candidates;
}

async function isReactComponentCandidate(node: Node, checker: Checker): Promise<boolean> {
  const type = await checker.getTypeAtLocation(node);
  if (!type) {
    return false;
  }

  const name = findNameNode(node);
  const componentName = name ? findCandidateName(name) : undefined;
  if (await hasReactComponentTypeName(type, node, checker)) {
    return true;
  }

  const namedType = name ? await checker.getTypeAtLocation(name) : undefined;
  if (namedType && (await hasReactComponentTypeName(namedType, node, checker))) {
    return true;
  }

  if (!isUppercaseComponentName(componentName)) {
    return false;
  }

  return (
    (await hasReactRenderableReturnType(type, node, checker)) ||
    Boolean(namedType && (await hasReactRenderableReturnType(namedType, node, checker)))
  );
}

async function hasReactRenderableReturnType(type: Type, node: Node, checker: Checker): Promise<boolean> {
  const signatures = await checker.getSignaturesOfType(type, SignatureKind.Call);
  for (const signature of signatures) {
    const returnType = await checker.getReturnTypeOfSignature(signature);
    if (returnType && (await isReactRenderableType(returnType, node, checker))) {
      return true;
    }
  }
  return false;
}

async function hasReactComponentTypeName(type: Type, node: Node, checker: Checker): Promise<boolean> {
  const typeName = await checker.typeToString(type, node);
  return /\b(?:FC|FunctionComponent|ComponentType|MemoExoticComponent|ForwardRefExoticComponent|LazyExoticComponent)\b/u.test(
    typeName
  );
}

async function isReactRenderableType(type: Type, node: Node, checker: Checker): Promise<boolean> {
  const typeName = await checker.typeToString(type, node);
  return /\b(?:JSX\.Element|React\.JSX\.Element|ReactElement|ReactNode)\b/u.test(typeName);
}

function isFunctionLikeCandidate(node: Node): boolean {
  if (node.kind === SyntaxKind.FunctionDeclaration && !getNodeProperty(node, 'body')) {
    return false;
  }

  return (
    node.kind === SyntaxKind.FunctionDeclaration ||
    node.kind === SyntaxKind.FunctionExpression ||
    node.kind === SyntaxKind.ArrowFunction
  );
}

function isVariableFunctionCandidate(node: Node): boolean {
  if (node.kind !== SyntaxKind.VariableDeclaration) {
    return false;
  }

  const initializer = getNodeProperty(node, 'initializer');
  const unwrappedInitializer = initializer ? unwrapExpression(initializer) : undefined;
  return unwrappedInitializer
    ? isFunctionLikeCandidate(unwrappedInitializer) || unwrappedInitializer.kind === SyntaxKind.CallExpression
    : false;
}

function findComponentFunctionNode(node: Node): Node {
  if (isFunctionLikeCandidate(node)) {
    return node;
  }

  const initializer = getNodeProperty(node, 'initializer');
  const unwrappedInitializer = initializer ? unwrapExpression(initializer) : undefined;
  if (!unwrappedInitializer) {
    return node;
  }
  if (isFunctionLikeCandidate(unwrappedInitializer)) {
    return unwrappedInitializer;
  }
  if (isComponentImplementationWrapperCall(unwrappedInitializer)) {
    return findComponentImplementationWrapperFunction(unwrappedInitializer) ?? node;
  }
  return node;
}

function isComponentImplementationWrapperCall(node: Node): boolean {
  if (node.kind !== SyntaxKind.CallExpression) {
    return false;
  }

  const expression = getNodeProperty(node, 'expression');
  const expressionName = expression ? findCallExpressionName(expression) : undefined;
  return expressionName === 'memo' || expressionName === 'forwardRef';
}

function findCallExpressionName(expression: Node): string | undefined {
  const name = getNodeProperty(expression, 'name');
  return name ? findCandidateName(name) : findCandidateName(expression);
}

function findComponentImplementationWrapperFunction(node: Node): Node | undefined {
  let functionNode: Node | undefined;
  node.forEachChild((child) => {
    const unwrappedChild = unwrapExpression(child);
    if (isFunctionLikeCandidate(unwrappedChild)) {
      functionNode = unwrappedChild;
    } else if (isComponentImplementationWrapperCall(unwrappedChild)) {
      functionNode = findComponentImplementationWrapperFunction(unwrappedChild);
    }
    return functionNode;
  });
  return functionNode;
}

function findFunctionStartPosition(
  text: string,
  functionNode: Node,
  name: Node | undefined,
  sourceFile: SourceFile
): number {
  const tokenPosition = getTokenPosOfNode(functionNode, sourceFile);
  if (functionNode.kind !== SyntaxKind.FunctionDeclaration || !name) {
    return tokenPosition;
  }

  const functionName = findCandidateName(name);
  const namePosition = functionName ? text.indexOf(functionName, tokenPosition) : -1;
  const functionPosition = namePosition >= 0 ? text.lastIndexOf('function', namePosition) : -1;
  if (functionPosition < tokenPosition) {
    return tokenPosition;
  }

  const modifierText = text.slice(tokenPosition, functionPosition);
  const asyncMatch = /\basync\s*$/u.exec(modifierText);
  return asyncMatch ? tokenPosition + asyncMatch.index : functionPosition;
}

function dedupeReactComponentFunctions(
  components: readonly ReactComponentCandidateMetric[]
): Omit<ReactComponentFunctionMetric, 'file'>[] {
  const componentByKey = new Map<string, ReactComponentCandidateMetric>();
  for (const component of components) {
    const existingComponent = componentByKey.get(component.implementationKey);
    if (!existingComponent || (!existingComponent.name && component.name)) {
      componentByKey.set(component.implementationKey, component);
    }
  }
  return [...componentByKey.values()].map((component) => ({
    name: component.name,
    startColumn: component.startColumn,
    startLine: component.startLine,
  }));
}

function findCandidateName(name: Node): string | undefined {
  if ('escapedText' in name) {
    return String(name.escapedText);
  }
  if ('text' in name && typeof name.text === 'string') {
    return name.text;
  }
  return undefined;
}

function isUppercaseComponentName(name: string | undefined): boolean {
  return name !== undefined && /^[A-Z]/u.test(name);
}

function findNameNode(node: Node): Node | undefined {
  const name = getNodeProperty(node, 'name');
  if (name) {
    return name;
  }

  let currentNode: Node | undefined = node;
  while (currentNode) {
    const parent = getNodeProperty(currentNode, 'parent');
    if (!parent) {
      return undefined;
    }
    if (parent.kind === SyntaxKind.VariableDeclaration) {
      return getNodeProperty(parent, 'name');
    }
    if (!isExpressionWrapperNode(parent)) {
      return undefined;
    }
    currentNode = parent;
  }
  return undefined;
}

function unwrapExpression(node: Node): Node {
  let currentNode = node;
  while (isExpressionWrapperNode(currentNode)) {
    const expression = getNodeProperty(currentNode, 'expression');
    if (!expression) {
      return currentNode;
    }
    currentNode = expression;
  }
  return currentNode;
}

function isExpressionWrapperNode(node: Node): boolean {
  return (
    node.kind === SyntaxKind.ParenthesizedExpression ||
    node.kind === SyntaxKind.AsExpression ||
    node.kind === SyntaxKind.TypeAssertionExpression ||
    node.kind === SyntaxKind.SatisfiesExpression
  );
}

function getNodeProperty(
  node: Node,
  property: 'body' | 'expression' | 'initializer' | 'name' | 'parent'
): Node | undefined {
  const value = (node as Partial<Record<typeof property, Node>>)[property];
  return isNode(value) ? value : undefined;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'kind' in value && 'pos' in value && 'end' in value;
}

function positionToLineColumn(text: string, position: number): { column: number; line: number } {
  const lines = text.slice(0, position).split('\n');
  return { column: lines.at(-1)?.length ?? 0, line: lines.length };
}

function collectCallExpressions(root: Node): Node[] {
  const calls: Node[] = [];
  visitNode(root, (node) => {
    if (node.kind === SyntaxKind.CallExpression) {
      calls.push(node);
    }
  });
  return calls;
}

function visitNode(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  node.forEachChild((child) => {
    visitNode(child, visitor);
    return;
  });
}

function addDiagnosticFiles(files: Set<string>, diagnostics: readonly DiagnosticLike[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.fileName) {
      files.add(diagnostic.fileName);
    }
  }
}
