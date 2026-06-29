import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ArchitectureFileMetrics {
  directLocalDependencyCount: number;
  duplicateSymbolGroupCount: number;
  file: string;
  orchestration: OrchestrationMetrics;
  responsibilityBreadthScore: number;
  responsibilityDomains: string[];
  transitiveLocalDependencyCount: number;
}

export interface ArchitectureMetrics {
  duplicateSymbolGroups: DuplicateSymbolGroup[];
  files: ArchitectureFileMetrics[];
  maxDirectLocalDependencyCount: number;
  maxDuplicateSymbolGroupCount: number;
  maxOrchestrationScore: number;
  maxResponsibilityBreadthScore: number;
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

export interface OrchestrationMetrics {
  awaitCount: number;
  earlyReturnCount: number;
  mutableStateCount: number;
  processLifecycleScore: number;
  retryLoopCount: number;
  score: number;
  sideEffectCallCount: number;
  tryFinallyCount: number;
}

interface SourceFile {
  file: string;
  relativeFile: string;
  text: string;
}

const importSourcePattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/gu;
const symbolPattern =
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{3,}|[A-Za-z_$][\w$]{3,})\s*=|^(?:export\s+)?(?:class|interface|type)\s+([A-Za-z_$][\w$]*)\b/gmu;
const duplicateSymbolStoplist = new Set([
  'args',
  'error',
  'formatError',
  'message',
  'name',
  'options',
  'output',
  'PackageJson',
  'parsed',
  'proc',
  'readPackageJson',
  'response',
  'result',
  'runCommand',
  'RunCommandOptions',
  'sleep',
]);

const responsibilityDomains = new Map<string, RegExp>([
  ['agent', /\b(agent|codex|claude|antigravity|thread|prompt)\b/iu],
  ['callback', /\b(callback|server|post|request|response|url)\b/iu],
  ['ci', /\b(ci|check|workflow|job|run|failed|passed|pending)\b/iu],
  ['git', /\b(git|branch|commit|merge|pullRequest|pr)\b/iu],
  ['github', /\b(github|octokit|graphql|issue|repository)\b/iu],
  ['log', /\b(log|logger|stderr|stdout|progress|output)\b/iu],
  ['terminal', /\b(terminal|spawn|ansi|escape|paste|tty|process)\b/iu],
  ['verification', /\b(verify|verification|test|behaviorCheck)\b/iu],
  ['workspace', /\b(workspace|worktree|cwd|path|directory)\b/iu],
]);

export async function measureArchitecture(files: readonly string[], displayRoot: string): Promise<ArchitectureMetrics> {
  const sourceFiles = await readSourceFiles(files, displayRoot);
  const dependencyGraph = measureDependencyGraph(sourceFiles);
  const duplicateSymbolGroups = measureDuplicateSymbolGroups(sourceFiles);
  const duplicateGroupCountByFile = measureDuplicateGroupCountByFile(duplicateSymbolGroups);
  const metrics = sourceFiles.map((sourceFile) => {
    const directDependencies = dependencyGraph.get(sourceFile.relativeFile) ?? new Set<string>();
    const orchestration = measureOrchestration(sourceFile.text);
    const domains = measureResponsibilityDomains(sourceFile);
    return {
      file: sourceFile.relativeFile,
      directLocalDependencyCount: directDependencies.size,
      duplicateSymbolGroupCount: duplicateGroupCountByFile.get(sourceFile.relativeFile) ?? 0,
      orchestration,
      responsibilityBreadthScore: domains.length,
      responsibilityDomains: domains,
      transitiveLocalDependencyCount: measureTransitiveDependencyCount(sourceFile.relativeFile, dependencyGraph),
    };
  });

  return {
    duplicateSymbolGroups,
    files: metrics,
    maxDirectLocalDependencyCount: maxFileMetric(metrics, 'directLocalDependencyCount'),
    maxDuplicateSymbolGroupCount: maxFileMetric(metrics, 'duplicateSymbolGroupCount'),
    maxOrchestrationScore: Math.max(0, ...metrics.map((file) => file.orchestration.score)),
    maxResponsibilityBreadthScore: maxFileMetric(metrics, 'responsibilityBreadthScore'),
    maxTransitiveLocalDependencyCount: maxFileMetric(metrics, 'transitiveLocalDependencyCount'),
  };
}

async function readSourceFiles(files: readonly string[], displayRoot: string): Promise<SourceFile[]> {
  return await Promise.all(
    files.map(async (file) => ({
      file,
      relativeFile: path.relative(displayRoot, file) || path.basename(file),
      text: await readFile(file, 'utf8'),
    }))
  );
}

function measureDependencyGraph(files: SourceFile[]): Map<string, Set<string>> {
  const fileSet = new Set(files.map((file) => file.relativeFile));
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const dependencies = new Set<string>();
    for (const source of importSources(file.text)) {
      const resolved = resolveLocalImport(file.relativeFile, source, fileSet);
      if (resolved) {
        dependencies.add(resolved);
      }
    }
    graph.set(file.relativeFile, dependencies);
  }
  return graph;
}

function importSources(text: string): string[] {
  importSourcePattern.lastIndex = 0;
  return [...text.matchAll(importSourcePattern)]
    .map((match) => match[1] ?? match[2])
    .filter((source): source is string => source !== undefined && source.length > 0);
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
    symbolPattern.lastIndex = 0;
    for (const match of file.text.matchAll(symbolPattern)) {
      const symbol = match[1] ?? match[2] ?? match[3];
      if (!isMeaningfulDuplicateSymbol(symbol)) {
        continue;
      }
      const declarations = declarationsBySymbol.get(symbol) ?? [];
      declarations.push({ file: file.relativeFile, line: lineAtOffset(file.text, match.index ?? 0) });
      declarationsBySymbol.set(symbol, declarations);
    }
  }
  return [...declarationsBySymbol.entries()]
    .flatMap(([name, declarations]) => {
      const files = [...new Set(declarations.map((declaration) => declaration.file))].toSorted();
      return files.length > 1
        ? [{ declarations: declarations.toSorted(compareDuplicateDeclarations), files, name }]
        : [];
    })
    .toSorted((left, right) => right.files.length - left.files.length || left.name.localeCompare(right.name));
}

function compareDuplicateDeclarations(left: DuplicateSymbolDeclaration, right: DuplicateSymbolDeclaration): number {
  return left.file.localeCompare(right.file) || left.line - right.line;
}

function lineAtOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

function isMeaningfulDuplicateSymbol(symbol: string | undefined): symbol is string {
  return symbol !== undefined && symbol.length >= 4 && !duplicateSymbolStoplist.has(symbol) && symbol !== 'main';
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

function measureOrchestration(text: string): OrchestrationMetrics {
  const awaitCount = countMatches(text, /\bawait\b/gu);
  const retryLoopCount = countMatches(
    text,
    /\bfor\s*\([^)]*(?:attempt|retry)[^)]*\)|\bwhile\s*\([^)]*(?:attempt|retry)[^)]*\)/giu
  );
  const mutableStateCount = countMatches(text, /\blet\s+[A-Za-z_$][\w$]*/gu);
  const earlyReturnCount = countMatches(text, /\breturn\b/gu);
  const tryFinallyCount = countMatches(text, /\btry\b|\bfinally\b/gu);
  const processLifecycleScore =
    countMatches(
      text,
      /\b(?:spawn|kill|AbortController|AbortSignal|addEventListener|removeEventListener|setTimeout|clearTimeout|processGroups?|pid|SIGTERM|SIGKILL|signal)\b/gu
    ) +
    countMatches(text, /^const\s+[A-Za-z_$][\w$]*\s*=\s*new\s+(?:Map|Set)\b/gmu) * 2;
  const sideEffectCallCount = countMatches(
    text,
    /\b(?:spawn|serve|fetch|graphql|runCommand|runCommandOrThrow|ghAllowExitCodes|write|kill|close|send|sleep|assign|merge|commit|push)\b/gu
  );
  return {
    awaitCount,
    earlyReturnCount,
    mutableStateCount,
    processLifecycleScore,
    retryLoopCount,
    score: awaitCount + retryLoopCount * 4 + mutableStateCount + sideEffectCallCount + tryFinallyCount * 2,
    sideEffectCallCount,
    tryFinallyCount,
  };
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

function measureResponsibilityDomains(file: SourceFile): string[] {
  const haystack = `${file.relativeFile}\n${stripTextLiteralsAndComments(file.text)}`;
  return [...responsibilityDomains.entries()]
    .filter(([, pattern]) => pattern.test(haystack))
    .map(([domain]) => domain)
    .toSorted();
}

function stripTextLiteralsAndComments(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, ' ')
    .replaceAll(/\/\/[^\n\r]*/gu, ' ')
    .replaceAll(/`(?:\\[\s\S]|[^`\\])*`/gu, ' ')
    .replaceAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gu, ' ');
}

function maxFileMetric(metrics: ArchitectureFileMetrics[], key: keyof ArchitectureFileMetrics): number {
  return Math.max(
    0,
    ...metrics.map((metric) => metric[key]).filter((value): value is number => typeof value === 'number')
  );
}
