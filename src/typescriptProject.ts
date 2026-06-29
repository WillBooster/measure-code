import { API } from '@typescript/native-preview/unstable/async';
import { SyntaxKind, type Node } from '@typescript/native-preview/unstable/ast';

export interface TypeScriptProjectMetrics {
  callExpressionCount: number;
  configDiagnosticCount: number;
  configFile: string;
  declarationDiagnosticCount: number;
  diagnosticFileCount: number;
  measuredRootFileCount: number;
  projectCount: number;
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
    const measuredFileSet = new Set(measuredFiles);
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

    for (const project of projects) {
      totals.rootFileCount += project.rootFiles.length;
      totals.measuredRootFileCount += project.rootFiles.filter((file) => measuredFileSet.has(file)).length;

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

      for (const file of project.rootFiles) {
        if (measuredFileSet.size > 0 && !measuredFileSet.has(file)) {
          continue;
        }
        const sourceFile = await project.program.getSourceFile(file);
        if (!sourceFile) {
          continue;
        }
        const callExpressions = collectCallExpressions(sourceFile);
        totals.callExpressionCount += callExpressions.length;
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
      unresolvedCallExpressionCount,
      resolvedCallExpressionRatio:
        totals.callExpressionCount === 0 ? 0 : totals.resolvedCallExpressionCount / totals.callExpressionCount,
    };
  } finally {
    await api.close();
  }
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
