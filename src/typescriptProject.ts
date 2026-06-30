import { realpath } from 'node:fs/promises';
import { API, SignatureKind, type Checker, type Type } from '@typescript/native-preview/unstable/async';
import { SyntaxKind, type Node, type SourceFile } from '@typescript/native-preview/unstable/ast';

export interface ReactComponentFunctionMetric {
  file: string;
  name?: string;
  startLine: number;
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

      for (const { canonicalFile, file } of projectRootFiles) {
        if (measuredFileSet.size > 0 && !measuredFileSet.has(canonicalFile)) {
          continue;
        }
        const sourceFile = await project.program.getSourceFile(file);
        if (!sourceFile) {
          continue;
        }
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
  const components: Omit<ReactComponentFunctionMetric, 'file'>[] = [];
  const candidates = collectReactComponentCandidates(sourceFile);
  for (const candidate of candidates) {
    if (!(await isReactComponentCandidate(candidate, checker))) {
      continue;
    }
    const name = findNameNode(candidate);
    components.push({
      name: name ? findCandidateName(name) : undefined,
      startLine: lineAtPosition(sourceFile.text, name?.pos ?? candidate.pos),
    });
  }
  return components;
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

  if (await isReactComponentType(type, node, checker)) {
    return true;
  }

  const name = findNameNode(node);
  const namedType = name ? await checker.getTypeAtLocation(name) : undefined;
  return namedType ? await isReactComponentType(namedType, node, checker) : false;
}

async function isReactComponentType(type: Type, node: Node, checker: Checker): Promise<boolean> {
  if (await hasReactComponentTypeName(type, node, checker)) {
    return true;
  }

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
  return initializer ? isFunctionLikeCandidate(initializer) || initializer.kind === SyntaxKind.CallExpression : false;
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

function findNameNode(node: Node): Node | undefined {
  const name = getNodeProperty(node, 'name');
  if (name) {
    return name;
  }

  const parent = getNodeProperty(node, 'parent');
  return parent?.kind === SyntaxKind.VariableDeclaration ? getNodeProperty(parent, 'name') : undefined;
}

function getNodeProperty(node: Node, property: 'initializer' | 'name' | 'parent'): Node | undefined {
  const value = (node as Partial<Record<typeof property, Node>>)[property];
  return isNode(value) ? value : undefined;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'kind' in value && 'pos' in value && 'end' in value;
}

function lineAtPosition(text: string, position: number): number {
  return text.slice(0, position).split('\n').length;
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
