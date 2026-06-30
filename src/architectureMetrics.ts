import path from 'node:path';
import type { CodeMetrics, DeclarationMetrics } from './types.js';

export interface ArchitectureSourceFile {
  file: string;
  metrics: CodeMetrics;
}

export interface ArchitectureFileMetrics {
  directLocalDependencyCount: number;
  duplicateSymbolGroupCount: number;
  file: string;
  structuralBreadthScore: number;
  structuralCoordination: StructuralCoordinationMetrics;
  structuralFeatureGroups: string[];
  transitiveLocalDependencyCount: number;
}

export interface ArchitectureMetrics {
  duplicateSymbolGroups: DuplicateSymbolGroup[];
  files: ArchitectureFileMetrics[];
  maxDirectLocalDependencyCount: number;
  maxDuplicateSymbolGroupCount: number;
  maxStructuralBreadthScore: number;
  maxStructuralCoordinationScore: number;
  maxTransitiveLocalDependencyCount: number;
}

export interface DuplicateSymbolGroup {
  declarations: DuplicateSymbolDeclaration[];
  files: string[];
  name: string;
}

export interface DuplicateSymbolDeclaration {
  file: string;
  line: number;
}

export interface StructuralCoordinationMetrics {
  asyncBoundaryCount: number;
  branchingScore: number;
  exceptionHandlingCount: number;
  moduleInteractionScore: number;
  score: number;
  stateMutationScore: number;
}

interface SourceFile {
  file: string;
  metrics: CodeMetrics;
  relativeFile: string;
}

export function measureArchitecture(
  files: readonly ArchitectureSourceFile[],
  displayRoot: string
): ArchitectureMetrics {
  const sourceFiles = files.map((file) => ({
    ...file,
    relativeFile: path.relative(displayRoot, file.file) || path.basename(file.file),
  }));
  const dependencyGraph = measureDependencyGraph(sourceFiles);
  const duplicateSymbolGroups = measureDuplicateSymbolGroups(sourceFiles);
  const duplicateGroupCountByFile = measureDuplicateGroupCountByFile(duplicateSymbolGroups);
  const metrics = sourceFiles.map((sourceFile) => {
    const directDependencies = dependencyGraph.get(sourceFile.relativeFile) ?? new Set<string>();
    const structuralCoordination = measureStructuralCoordination(sourceFile.metrics);
    const structuralFeatureGroups = measureStructuralFeatureGroups(sourceFile.metrics);
    return {
      file: sourceFile.relativeFile,
      directLocalDependencyCount: directDependencies.size,
      duplicateSymbolGroupCount: duplicateGroupCountByFile.get(sourceFile.relativeFile) ?? 0,
      structuralBreadthScore: structuralFeatureGroups.length,
      structuralCoordination,
      structuralFeatureGroups,
      transitiveLocalDependencyCount: measureTransitiveDependencyCount(sourceFile.relativeFile, dependencyGraph),
    };
  });

  return {
    duplicateSymbolGroups,
    files: metrics,
    maxDirectLocalDependencyCount: maxFileMetric(metrics, 'directLocalDependencyCount'),
    maxDuplicateSymbolGroupCount: maxFileMetric(metrics, 'duplicateSymbolGroupCount'),
    maxStructuralBreadthScore: maxFileMetric(metrics, 'structuralBreadthScore'),
    maxStructuralCoordinationScore: Math.max(0, ...metrics.map((file) => file.structuralCoordination.score)),
    maxTransitiveLocalDependencyCount: maxFileMetric(metrics, 'transitiveLocalDependencyCount'),
  };
}

function measureDependencyGraph(files: SourceFile[]): Map<string, Set<string>> {
  const fileSet = new Set(files.map((file) => file.relativeFile));
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const dependencies = new Set<string>();
    for (const source of file.metrics.module.importSources) {
      const resolved = resolveLocalImport(file.relativeFile, source, fileSet);
      if (resolved) {
        dependencies.add(resolved);
      }
    }
    graph.set(file.relativeFile, dependencies);
  }
  return graph;
}

function resolveLocalImport(fromFile: string, source: string, fileSet: Set<string>): string | undefined {
  if (!source.startsWith('.')) {
    return undefined;
  }
  const fromDirectory = path.dirname(fromFile);
  const base = path.normalize(path.join(fromDirectory, source));
  const extension = path.extname(base);
  const stems = extension ? [base.slice(0, -extension.length), base] : [base];
  for (const stem of stems) {
    for (const candidate of [
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}.js`,
      `${stem}.jsx`,
      path.join(stem, 'index.ts'),
      path.join(stem, 'index.tsx'),
      path.join(stem, 'index.js'),
    ]) {
      if (fileSet.has(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function measureTransitiveDependencyCount(file: string, graph: Map<string, Set<string>>): number {
  const visited = new Set<string>();
  const pending = [...(graph.get(file) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return visited.size;
}

function measureDuplicateSymbolGroups(files: SourceFile[]): DuplicateSymbolGroup[] {
  const declarationsBySymbol = new Map<string, DuplicateSymbolDeclaration[]>();
  for (const file of files) {
    for (const declaration of file.metrics.module.declarations) {
      const declarations = declarationsBySymbol.get(declaration.name) ?? [];
      declarations.push(toDuplicateSymbolDeclaration(file.relativeFile, declaration));
      declarationsBySymbol.set(declaration.name, declarations);
    }
  }
  return [...declarationsBySymbol.entries()]
    .flatMap(([name, declarations]) => {
      const duplicateFiles = [...new Set(declarations.map((declaration) => declaration.file))].toSorted();
      return duplicateFiles.length > 1
        ? [{ declarations: declarations.toSorted(compareDuplicateDeclarations), files: duplicateFiles, name }]
        : [];
    })
    .toSorted((left, right) => right.files.length - left.files.length || left.name.localeCompare(right.name));
}

function toDuplicateSymbolDeclaration(file: string, declaration: DeclarationMetrics): DuplicateSymbolDeclaration {
  return { file, line: declaration.startLine };
}

function compareDuplicateDeclarations(left: DuplicateSymbolDeclaration, right: DuplicateSymbolDeclaration): number {
  return left.file.localeCompare(right.file) || left.line - right.line;
}

function measureDuplicateGroupCountByFile(groups: DuplicateSymbolGroup[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const file of group.files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
}

function measureStructuralCoordination(metrics: CodeMetrics): StructuralCoordinationMetrics {
  const asyncBoundaryCount = metrics.syntaxFeatures.awaitExpressionCount;
  const exceptionHandlingCount = metrics.syntaxFeatures.tryStatementCount + metrics.syntaxFeatures.throwStatementCount;
  const stateMutationScore = metrics.syntaxFeatures.mutableBindingCount + metrics.syntaxFeatures.assignmentCount;
  const branchingScore =
    metrics.cyclomaticComplexity +
    metrics.syntaxFeatures.loopStatementCount +
    metrics.syntaxFeatures.returnStatementCount;
  const moduleInteractionScore =
    metrics.callGraph.callCount + metrics.callGraph.internalEdgeCount * 2 + metrics.callGraph.maxCallDepth * 3;

  return {
    asyncBoundaryCount,
    branchingScore,
    exceptionHandlingCount,
    moduleInteractionScore,
    score:
      asyncBoundaryCount * 2 +
      exceptionHandlingCount * 3 +
      stateMutationScore +
      branchingScore +
      moduleInteractionScore,
    stateMutationScore,
  };
}

function measureStructuralFeatureGroups(metrics: CodeMetrics): string[] {
  const groups = new Set<string>();
  addGroup(groups, 'class-shapes', metrics.classCount > 0);
  addGroup(groups, 'control-flow', metrics.cognitiveComplexity > 0);
  addGroup(groups, 'external-dependencies', metrics.coupling.externalImportCount > 0);
  addGroup(groups, 'functions', metrics.functionCount > 0);
  addGroup(groups, 'local-dependencies', metrics.coupling.relativeImportCount > 0);
  addGroup(groups, 'module-api', metrics.coupling.exportCount > 0 || metrics.module.declarations.length > 0);
  addGroup(
    groups,
    'state-mutation',
    metrics.syntaxFeatures.mutableBindingCount + metrics.syntaxFeatures.assignmentCount > 0
  );
  addGroup(groups, 'type-shapes', hasTypeShapeMetrics(metrics));
  return [...groups].toSorted();
}

function addGroup(groups: Set<string>, group: string, condition: boolean): void {
  if (condition) {
    groups.add(group);
  }
}

function hasTypeShapeMetrics(metrics: CodeMetrics): boolean {
  return (
    metrics.typeComplexity.typeAnnotationCount +
      metrics.typeComplexity.typeAliasCount +
      metrics.typeComplexity.interfaceCount +
      metrics.typeComplexity.genericParameterCount +
      metrics.typeComplexity.unionTypeCount +
      metrics.typeComplexity.intersectionTypeCount +
      metrics.typeComplexity.conditionalTypeCount >
    0
  );
}

function maxFileMetric(metrics: ArchitectureFileMetrics[], key: keyof ArchitectureFileMetrics): number {
  return Math.max(
    0,
    ...metrics.map((metric) => metric[key]).filter((value): value is number => typeof value === 'number')
  );
}
