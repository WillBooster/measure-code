#!/usr/bin/env node

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { measureArchitecture, type ArchitectureFileMetrics, type ArchitectureMetrics } from './architectureMetrics.js';
import {
  type CliOptions,
  configFileName,
  loadConfig,
  type ResolvedOptions,
  resolveOptions,
  resolveThresholds,
  type Thresholds,
} from './cliConfig.js';
import { measureCode } from './metrics.js';
import { measureTypeScriptProject, type TypeScriptProjectMetrics } from './typescriptProject.js';
import type { CodeMetrics, FunctionMetrics, LanguageName } from './types.js';

interface FileMetrics {
  file: string;
  metrics: CodeMetrics;
}

interface RiskTrigger {
  metric: string;
  score: number;
  threshold: number;
  value: number;
}

interface RiskFinding {
  cognitiveComplexity: number;
  cyclomaticComplexity: number;
  endLine?: number;
  file: string;
  kind: 'component' | 'file' | 'function';
  language: LanguageName;
  name?: string;
  score: number;
  startLine?: number;
  triggers: RiskTrigger[];
}

interface ScanResult {
  architecture?: ArchitectureMetrics;
  componentFunctionKeys?: Set<string>;
  displayRoot: string;
  errors: string[];
  fatalError?: string;
  files: FileMetrics[];
  namedComponentFunctionKeys?: Set<string>;
  typeScriptProject?: TypeScriptProjectMetrics;
}

const languageByExtension = new Map<string, LanguageName>([
  ['.cjs', 'javascript'],
  ['.cts', 'typescript'],
  ['.go', 'go'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.mjs', 'javascript'],
  ['.mts', 'typescript'],
  ['.py', 'python'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
]);

const ignoredDirectoryNames = new Set([
  '.agents',
  '.claude',
  '.cursor',
  '.git',
  '.next',
  '.playwright-cli',
  '.tox',
  '.tmp',
  '.turbo',
  '.venv',
  '.yarn',
  '__fixtures__',
  '__generated__',
  '__pycache__',
  'coverage',
  'dist',
  'fixtures',
  'generated',
  'node_modules',
  'test-fixtures',
  'vendor',
  'venv',
]);

const testDirectoryNames = new Set(['__tests__', 'test', 'tests']);
const testFilePattern = /(?:^test(?:[_-].*)?|\.(?:spec|test)|[_-]test)\.[^.]+$/iu;

// oxlint-disable-next-line unicorn/prefer-top-level-await -- CommonJS build output cannot preserve top-level await.
void main().catch((error: unknown) => {
  writeStderr(`Error: ${formatError(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const program = new Command()
    .name('code-gauge')
    .description('Measure code metrics and list high-risk findings.')
    .argument('[target]', 'file or directory to measure', '.')
    .option('--config <path>', `config file to use instead of the auto-detected ${configFileName}`)
    .option('--file-loc-threshold <number>', 'minimum file code LOC to report', parsePositiveInteger)
    .option('--function-loc-threshold <number>', 'minimum function physical LOC span to report', parsePositiveInteger)
    .option(
      '--component-loc-threshold <number>',
      'minimum React component physical LOC span to report',
      parsePositiveInteger
    )
    .option('--cognitive-threshold <number>', 'minimum cognitive complexity to report', parsePositiveInteger)
    .option('--cyclomatic-threshold <number>', 'minimum cyclomatic complexity to report', parsePositiveInteger)
    .option('--call-threshold <number>', 'minimum function call count to report', parsePositiveInteger)
    .option('--import-threshold <number>', 'minimum unique import sources per file to report', parsePositiveInteger)
    .option('--fan-out-threshold <number>', 'minimum intra-file fan-out per function to report', parsePositiveInteger)
    .option('--parameter-threshold <number>', 'minimum function parameter count to report', parsePositiveInteger)
    .option(
      '--duplicate-block-threshold <number>',
      'minimum count of duplicated code blocks per file to report',
      parsePositiveInteger
    )
    .option(
      '--transitive-dependency-threshold <number>',
      'minimum transitively reachable local files to report',
      parsePositiveInteger
    )
    .option(
      '--structural-breadth-threshold <number>',
      'minimum structural breadth score to report',
      parsePositiveInteger
    )
    .option(
      '--structural-coordination-threshold <number>',
      'minimum structural coordination score to report',
      parsePositiveInteger
    )
    .option('--state-mutation-threshold <number>', 'minimum state mutation score to report', parsePositiveInteger)
    .option(
      '--duplicate-symbol-group-threshold <number>',
      'minimum duplicate symbol group count to report',
      parsePositiveInteger
    )
    .option('--max-findings <number>', 'maximum number of risk findings to print', parsePositiveInteger)
    .option('--include-tests', 'include test files and test directories')
    .option('--tsconfig <path>', 'TypeScript project file to use instead of auto-detected tsconfig.json')
    .option('--json', 'print JSON output')
    .option('--fail-on-error', 'exit with code 1 when files or directories cannot be scanned')
    .option('--fail-on-risk', 'exit with code 1 when high-risk findings are found');

  program.action(async (target: string, cliOptions: CliOptions) => {
    const resolvedTarget = resolveTarget(target);
    const config = await loadConfig(cliOptions.config, await configSearchDirectory(resolvedTarget));
    const options = resolveOptions(cliOptions, config);
    const result = await scanTarget(resolvedTarget, options);
    await addArchitectureMetrics(result);
    await addTypeScriptProjectMetrics(result, options, resolvedTarget);
    const risks = findRiskyFunctions(
      result.files,
      result.architecture,
      result.componentFunctionKeys,
      result.namedComponentFunctionKeys,
      options,
      result.displayRoot
    );

    if (options.json) {
      printJson(result, risks, options);
    } else {
      printTextReport(resolvedTarget, result, risks, options);
    }

    if (
      result.fatalError ||
      (options.failOnError && result.errors.length > 0) ||
      (options.failOnRisk && risks.length > 0)
    ) {
      process.exitCode = 1;
    }
  });

  await program.parseAsync();
}

function resolveTarget(target: string): string {
  if (target === '~') {
    return os.homedir();
  }

  if (target.startsWith('~/')) {
    return path.join(os.homedir(), target.slice(2));
  }

  return path.resolve(target);
}

/** Returns the directory from which the config file search should start (the target itself if it is a directory). */
async function configSearchDirectory(target: string): Promise<string> {
  try {
    const targetStat = await stat(target);
    return targetStat.isDirectory() ? target : path.dirname(target);
  } catch {
    return path.dirname(target);
  }
}

async function scanTarget(target: string, options: ResolvedOptions): Promise<ScanResult> {
  const files: FileMetrics[] = [];
  const errors: string[] = [];
  const visitedFiles = new Set<string>();
  let canonicalTarget = target;
  try {
    canonicalTarget = await realpath(target);
  } catch {
    // stat below reports missing targets with the original path.
  }

  const fallbackDisplayRoot = path.dirname(canonicalTarget);
  let targetStat;

  try {
    targetStat = await stat(canonicalTarget);
  } catch (error) {
    const fatalError = `${formatPath(canonicalTarget, fallbackDisplayRoot)}: ${formatError(error)}`;
    return { displayRoot: fallbackDisplayRoot, files, errors: [fatalError], fatalError };
  }

  if (targetStat.isFile()) {
    const displayRoot = path.dirname(canonicalTarget);
    const language = getLanguage(canonicalTarget, options, true);
    if (!language) {
      const fatalError = `${formatPath(canonicalTarget, displayRoot)}: unsupported file type`;
      return { displayRoot, files, errors: [fatalError], fatalError };
    }

    await measureFile(canonicalTarget, language, files, errors, visitedFiles, displayRoot, canonicalTarget);
    return { displayRoot, files, errors };
  }

  await scanDirectory(canonicalTarget, options, files, errors, new Set(), visitedFiles, canonicalTarget);
  return { displayRoot: canonicalTarget, files, errors };
}

async function addTypeScriptProjectMetrics(
  result: ScanResult,
  options: ResolvedOptions,
  resolvedTarget: string
): Promise<void> {
  if (result.fatalError) {
    return;
  }
  if (result.files.length === 0) {
    return;
  }

  const explicitConfigFile = options.tsconfig;
  const isExplicitConfig = explicitConfigFile !== undefined;
  if (!isExplicitConfig && !result.files.some(({ file }) => isTypeScriptProjectCandidateFile(file))) {
    return;
  }

  const configFile = explicitConfigFile ? resolveTarget(explicitConfigFile) : await findNearestTsconfig(resolvedTarget);
  if (!configFile) {
    return;
  }

  try {
    result.typeScriptProject = await measureTypeScriptProject(
      configFile,
      result.files.map(({ file }) => file)
    );
    result.componentFunctionKeys = new Set(
      result.typeScriptProject.reactComponentFunctions.map((component) =>
        functionLocationKey(component.file, component.startLine, component.startColumn)
      )
    );
    result.namedComponentFunctionKeys = new Set(
      result.typeScriptProject.reactComponentFunctions.flatMap((component) =>
        component.name ? [functionNameLocationKey(component.file, component.name, component.startLine)] : []
      )
    );
  } catch (error) {
    if (isExplicitConfig) {
      result.errors.push(`${formatPath(configFile, result.displayRoot)}: ${formatError(error)}`);
    }
  }
}

function isTypeScriptProjectCandidateFile(file: string): boolean {
  return ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'].includes(path.extname(file));
}

async function findNearestTsconfig(target: string): Promise<string | undefined> {
  const targetStat = await stat(target);
  let currentDirectory = targetStat.isDirectory() ? target : path.dirname(target);
  while (true) {
    const configFile = path.join(currentDirectory, 'tsconfig.json');
    if (await fileExists(configFile)) {
      return configFile;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const fileStat = await stat(file);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function addArchitectureMetrics(result: ScanResult): Promise<void> {
  if (result.fatalError) {
    return;
  }

  try {
    result.architecture = measureArchitecture(
      result.files.map(({ file, metrics }) => ({ file, metrics })),
      result.displayRoot
    );
  } catch (error) {
    result.errors.push(`architecture metrics: ${formatError(error)}`);
  }
}

async function scanDirectory(
  directory: string,
  options: ResolvedOptions,
  files: FileMetrics[],
  errors: string[],
  visitedDirectories: Set<string>,
  visitedFiles: Set<string>,
  rootDirectory: string
): Promise<void> {
  let resolvedDirectory;
  try {
    resolvedDirectory = await realpath(directory);
  } catch (error) {
    errors.push(`${formatPath(directory, rootDirectory)}: ${formatError(error)}`);
    return;
  }

  if (!isWithinDirectory(resolvedDirectory, rootDirectory)) {
    return;
  }

  if (visitedDirectories.has(resolvedDirectory)) {
    return;
  }
  visitedDirectories.add(resolvedDirectory);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    errors.push(`${formatPath(directory, rootDirectory)}: ${formatError(error)}`);
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      await scanSymbolicLink(
        entry.name,
        entryPath,
        options,
        files,
        errors,
        visitedDirectories,
        visitedFiles,
        rootDirectory
      );
      continue;
    }

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name, options)) {
        continue;
      }
      await scanDirectory(entryPath, options, files, errors, visitedDirectories, visitedFiles, rootDirectory);
      continue;
    }

    if (entry.isFile()) {
      await measureScannableFile(entryPath, options, files, errors, visitedFiles, rootDirectory);
    }
  }
}

async function scanSymbolicLink(
  name: string,
  entryPath: string,
  options: ResolvedOptions,
  files: FileMetrics[],
  errors: string[],
  visitedDirectories: Set<string>,
  visitedFiles: Set<string>,
  rootDirectory: string
): Promise<void> {
  let resolvedPath;
  try {
    resolvedPath = await realpath(entryPath);
  } catch (error) {
    errors.push(`${formatPath(entryPath, rootDirectory)}: ${formatError(error)}`);
    return;
  }

  if (!isWithinDirectory(resolvedPath, rootDirectory)) {
    return;
  }

  let entryStat;
  try {
    entryStat = await stat(entryPath);
  } catch (error) {
    errors.push(`${formatPath(entryPath, rootDirectory)}: ${formatError(error)}`);
    return;
  }

  if (entryStat.isDirectory()) {
    if (shouldSkipDirectory(name, options) || shouldSkipDirectory(path.basename(resolvedPath), options)) {
      return;
    }
    await scanDirectory(entryPath, options, files, errors, visitedDirectories, visitedFiles, rootDirectory);
    return;
  }

  if (entryStat.isFile()) {
    await measureScannableFile(
      entryPath,
      options,
      files,
      errors,
      visitedFiles,
      rootDirectory,
      resolvedPath,
      resolvedPath
    );
  }
}

async function measureScannableFile(
  file: string,
  options: ResolvedOptions,
  files: FileMetrics[],
  errors: string[],
  visitedFiles: Set<string>,
  displayRoot: string,
  languageFile = file,
  realFile?: string
): Promise<void> {
  const language = getLanguage(languageFile, options);
  if (language) {
    await measureFile(file, language, files, errors, visitedFiles, displayRoot, realFile);
  }
}

async function measureFile(
  file: string,
  language: LanguageName,
  files: FileMetrics[],
  errors: string[],
  visitedFiles: Set<string>,
  displayRoot: string,
  realFile?: string
): Promise<void> {
  try {
    const resolvedFile = realFile ?? (await realpath(file));
    if (visitedFiles.has(resolvedFile)) {
      return;
    }
    visitedFiles.add(resolvedFile);

    const code = await readFile(file, 'utf8');
    files.push({
      file,
      metrics: measureCode(code, { language }),
    });
  } catch (error) {
    errors.push(`${formatPath(file, displayRoot)}: ${formatError(error)}`);
  }
}

function findRiskyFunctions(
  files: FileMetrics[],
  architecture: ArchitectureMetrics | undefined,
  componentFunctionKeys: Set<string> | undefined,
  namedComponentFunctionKeys: Set<string> | undefined,
  options: ResolvedOptions,
  displayRoot: string
): RiskFinding[] {
  const architectureByFile = new Map(architecture?.files.map((file) => [file.file, file]));
  const findings = files.flatMap(({ file, metrics }) => {
    const isReactFile = metrics.functions.some(
      (fn) => fn.returnsJsx || isReactComponent(file, fn, componentFunctionKeys, namedComponentFunctionKeys)
    );
    const thresholds = resolveThresholds(options, metrics.language, isReactFile);
    return [
      ...findRiskyFileMetrics(
        file,
        metrics,
        architectureByFile.get(formatPath(file, displayRoot)),
        thresholds,
        displayRoot
      ),
      ...metrics.functions.flatMap((fn) =>
        findRiskyFunctionMetrics(
          file,
          metrics.language,
          fn,
          thresholds,
          displayRoot,
          componentFunctionKeys,
          namedComponentFunctionKeys
        )
      ),
    ];
  });

  findings.sort(compareRiskFindings);
  return findings;
}

function findRiskyFileMetrics(
  file: string,
  metrics: CodeMetrics,
  architecture: ArchitectureFileMetrics | undefined,
  thresholds: Thresholds,
  displayRoot: string
): RiskFinding[] {
  const triggers: RiskTrigger[] = [];
  const formattedFile = formatPath(file, displayRoot);
  addTrigger(triggers, 'file LOC', metrics.lines.code, thresholds.fileLoc);
  addTrigger(triggers, 'import sources', metrics.coupling.importSourceCount, thresholds.import);
  addTrigger(triggers, 'duplicated blocks', metrics.duplication.duplicateBlockCount, thresholds.duplicateBlock);
  if (architecture) {
    const hasFileScaleRisk = metrics.lines.code >= 100 || architecture.directLocalDependencyCount >= 8;
    if (hasFileScaleRisk) {
      addTrigger(
        triggers,
        'transitive local dependencies',
        architecture.transitiveLocalDependencyCount,
        thresholds.transitiveDependency
      );
    }
    if (
      triggers.length > 0 ||
      architecture.directLocalDependencyCount >= 8 ||
      architecture.structuralCoordination.score >= thresholds.structuralCoordination
    ) {
      addTrigger(triggers, 'structural breadth', architecture.structuralBreadthScore, thresholds.structuralBreadth);
    }
    addTrigger(
      triggers,
      'structural coordination',
      architecture.structuralCoordination.score,
      thresholds.structuralCoordination
    );
    addTrigger(
      triggers,
      'state mutation',
      architecture.structuralCoordination.stateMutationScore,
      thresholds.stateMutation
    );
    addTrigger(
      triggers,
      'duplicate symbol groups',
      architecture.duplicateSymbolGroupCount,
      thresholds.duplicateSymbolGroup
    );
  }
  if (triggers.length === 0) {
    return [];
  }

  return [
    {
      file: formattedFile,
      language: metrics.language,
      kind: 'file',
      cyclomaticComplexity: metrics.cyclomaticComplexity,
      cognitiveComplexity: metrics.cognitiveComplexity,
      triggers,
      score: maxTriggerScore(triggers),
    },
  ];
}

function findRiskyFunctionMetrics(
  file: string,
  language: LanguageName,
  fn: FunctionMetrics,
  thresholds: Thresholds,
  displayRoot: string,
  componentFunctionKeys?: Set<string>,
  namedComponentFunctionKeys?: Set<string>
): RiskFinding[] {
  const loc = fn.endLine - fn.startLine + 1;
  const isComponent = isReactComponent(file, fn, componentFunctionKeys, namedComponentFunctionKeys);
  const kind = isComponent ? 'component' : 'function';
  const triggers: RiskTrigger[] = [];
  addTrigger(triggers, 'cognitive complexity', fn.cognitiveComplexity, thresholds.cognitive);
  addTrigger(triggers, 'cyclomatic complexity', fn.cyclomaticComplexity, thresholds.cyclomatic);
  addTrigger(triggers, isComponent ? 'component LOC' : 'function LOC', loc, getLocThreshold(isComponent, thresholds));
  addTrigger(triggers, 'function calls', fn.callCount, thresholds.call);
  addTrigger(triggers, 'fan-out', fn.fanOut, thresholds.fanOut);
  addTrigger(triggers, 'parameters', fn.parameterCount, thresholds.parameter);
  if (triggers.length === 0) {
    return [];
  }

  return [
    {
      file: formatPath(file, displayRoot),
      language,
      kind,
      name: fn.name ?? '<anonymous>',
      startLine: fn.startLine,
      endLine: fn.endLine,
      cyclomaticComplexity: fn.cyclomaticComplexity,
      cognitiveComplexity: fn.cognitiveComplexity,
      triggers,
      score: maxTriggerScore(triggers),
    },
  ];
}

function addTrigger(triggers: RiskTrigger[], metric: string, value: number, threshold: number): void {
  if (value < threshold) {
    return;
  }

  triggers.push({ metric, value, threshold, score: value / threshold });
}

function isReactComponent(
  file: string,
  fn: FunctionMetrics,
  componentFunctionKeys: Set<string> | undefined,
  namedComponentFunctionKeys: Set<string> | undefined
): boolean {
  return (
    componentFunctionKeys?.has(functionLocationKey(file, fn.startLine, fn.startColumn)) ||
    (fn.name ? namedComponentFunctionKeys?.has(functionNameLocationKey(file, fn.name, fn.startLine)) : false) ||
    false
  );
}

function getLocThreshold(isComponent: boolean, thresholds: Thresholds): number {
  return isComponent ? thresholds.componentLoc : thresholds.functionLoc;
}

function functionLocationKey(file: string, startLine: number, startColumn: number): string {
  return `${path.resolve(file)}:${startLine}:${startColumn}`;
}

function functionNameLocationKey(file: string, name: string, startLine: number): string {
  return `${path.resolve(file)}:${name}:${startLine}`;
}

function maxTriggerScore(triggers: RiskTrigger[]): number {
  return Math.max(...triggers.map((trigger) => trigger.score));
}

function compareRiskFindings(left: RiskFinding, right: RiskFinding): number {
  return (
    right.score - left.score ||
    left.file.localeCompare(right.file) ||
    (left.startLine ?? 0) - (right.startLine ?? 0) ||
    (left.endLine ?? 0) - (right.endLine ?? 0) ||
    left.kind.localeCompare(right.kind)
  );
}

function printJson(result: ScanResult, risks: RiskFinding[], options: ResolvedOptions): void {
  const summary = summarize(result.files);
  const reportedRisks = risks.slice(0, options.maxFindings);
  writeStdout(
    JSON.stringify(
      {
        summary,
        thresholds: options.thresholds,
        profileThresholds: options.profileThresholds,
        totalRisks: risks.length,
        truncated: reportedRisks.length < risks.length,
        architecture: result.architecture,
        typeScriptProject: result.typeScriptProject,
        risks: reportedRisks,
        errors: result.errors,
      },
      undefined,
      2
    ) + '\n'
  );
}

function printTextReport(target: string, result: ScanResult, risks: RiskFinding[], options: ResolvedOptions): void {
  if (result.fatalError) {
    writeStderr(`Error: ${result.fatalError}\n`);
    return;
  }

  const { thresholds } = options;
  const summary = summarize(result.files);
  writeStdout(`Measured ${summary.fileCount} files under ${target}\n`);
  writeStdout(
    `LOC ${summary.linesOfCode}, functions ${summary.functionCount}, max cyclomatic ${summary.maxCyclomaticComplexity}, max cognitive ${summary.maxCognitiveComplexity}\n`
  );
  writeStdout(
    `Calls ${summary.callCount}, internal edges ${summary.internalCallCount}, max call depth ${summary.maxCallDepth}, imports ${summary.importSourceCount}, exports ${summary.exportCount}\n`
  );
  writeStdout(
    `Type annotations ${summary.typeAnnotationCount}, type aliases ${summary.typeAliasCount}, interfaces ${summary.interfaceCount}, avg cohesion ${summary.averageFunctionIdentifierOverlap.toFixed(2)}\n`
  );
  if (result.architecture) {
    writeStdout(`${formatArchitectureMetrics(result.architecture)}\n`);
  }
  if (result.typeScriptProject) {
    writeStdout(`${formatTypeScriptProjectMetrics(result.typeScriptProject)}\n`);
  }
  writeStdout(
    `Risk thresholds: file LOC >= ${thresholds.fileLoc}, function LOC >= ${thresholds.functionLoc}, component LOC >= ${thresholds.componentLoc}, cognitive >= ${thresholds.cognitive}, cyclomatic >= ${thresholds.cyclomatic}, calls >= ${thresholds.call}, imports >= ${thresholds.import}, fan-out >= ${thresholds.fanOut}, parameters >= ${thresholds.parameter}, duplicated blocks >= ${thresholds.duplicateBlock}\n`
  );
  const profileOverrides = formatProfileOverrides(options.profileThresholds);
  if (profileOverrides) {
    writeStdout(`Per-language overrides: ${profileOverrides}\n`);
  }

  if (risks.length === 0) {
    writeStdout('No high-risk findings found.\n');
  } else {
    const reportedRisks = risks.slice(0, options.maxFindings);
    const totalSuffix = risks.length > reportedRisks.length ? ` of ${risks.length}` : '';
    writeStdout(`\nHigh-risk findings (top ${reportedRisks.length}${totalSuffix}):\n`);
    for (const risk of reportedRisks) {
      writeStdout(`${formatRiskLocation(risk)} ${formatRiskName(risk)} ${formatRiskMetrics(risk)}\n`);
    }
  }

  if (result.errors.length > 0) {
    writeStderr(`\nSkipped ${result.errors.length} files or directories:\n`);
    for (const error of result.errors.slice(0, 10)) {
      writeStderr(`- ${error}\n`);
    }
    if (result.errors.length > 10) {
      writeStderr(`- ... ${result.errors.length - 10} more\n`);
    }
  }
}

function formatProfileOverrides(profileThresholds: ResolvedOptions['profileThresholds']): string {
  return Object.entries(profileThresholds)
    .map(
      ([profile, overrides]) =>
        `${profile} { ${Object.entries(overrides)
          .map(([metric, value]) => `${metric} ${value}`)
          .join(', ')} }`
    )
    .join('; ');
}

function formatRiskLocation(risk: RiskFinding): string {
  return risk.startLine === undefined || risk.endLine === undefined
    ? risk.file
    : `${risk.file}:${risk.startLine}-${risk.endLine}`;
}

function formatRiskName(risk: RiskFinding): string {
  return risk.name ? `${risk.kind} ${risk.name}` : risk.kind;
}

function formatRiskMetrics(risk: RiskFinding): string {
  const triggerText = risk.triggers
    .map(
      (trigger) => `${trigger.metric} ${formatMetricValue(trigger.value)} >= ${formatMetricValue(trigger.threshold)}`
    )
    .join(', ');
  return `(${triggerText}; cyclomatic ${risk.cyclomaticComplexity}, cognitive ${risk.cognitiveComplexity})`;
}

function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatArchitectureMetrics(metrics: ArchitectureMetrics): string {
  const maxStateMutationScore = Math.max(
    0,
    ...metrics.files.map((file) => file.structuralCoordination.stateMutationScore)
  );
  return `Architecture max reachable files ${metrics.maxTransitiveLocalDependencyCount}, max structural breadth ${metrics.maxStructuralBreadthScore}, max structural coordination ${metrics.maxStructuralCoordinationScore}, max state mutation ${maxStateMutationScore}, duplicate symbol groups ${metrics.duplicateSymbolGroups.length}`;
}

function formatTypeScriptProjectMetrics(metrics: TypeScriptProjectMetrics): string {
  return `TypeScript project root files ${metrics.rootFileCount}, measured roots ${metrics.measuredRootFileCount}, semantic diagnostics ${metrics.semanticDiagnosticCount}, resolved calls ${metrics.resolvedCallExpressionCount}/${metrics.callExpressionCount} (${(metrics.resolvedCallExpressionRatio * 100).toFixed(1)}%)`;
}

function summarize(files: FileMetrics[]): {
  fileCount: number;
  functionCount: number;
  linesOfCode: number;
  maxCognitiveComplexity: number;
  maxCyclomaticComplexity: number;
  callCount: number;
  internalCallCount: number;
  maxCallDepth: number;
  importSourceCount: number;
  relativeImportCount: number;
  externalImportCount: number;
  exportCount: number;
  averageFunctionIdentifierOverlap: number;
  typeAnnotationCount: number;
  typeAliasCount: number;
  interfaceCount: number;
  genericParameterCount: number;
} {
  let functionCount = 0;
  let linesOfCode = 0;
  let maxCyclomaticComplexity = 0;
  let maxCognitiveComplexity = 0;
  let callCount = 0;
  let internalCallCount = 0;
  let maxCallDepth = 0;
  let importSourceCount = 0;
  let relativeImportCount = 0;
  let externalImportCount = 0;
  let exportCount = 0;
  let cohesionTotal = 0;
  let typeAnnotationCount = 0;
  let typeAliasCount = 0;
  let interfaceCount = 0;
  let genericParameterCount = 0;

  for (const file of files) {
    functionCount += file.metrics.functionCount;
    linesOfCode += file.metrics.lines.code;
    maxCyclomaticComplexity = Math.max(maxCyclomaticComplexity, file.metrics.maxCyclomaticComplexity);
    maxCognitiveComplexity = Math.max(maxCognitiveComplexity, file.metrics.maxCognitiveComplexity);
    callCount += file.metrics.callGraph.callCount;
    internalCallCount += file.metrics.callGraph.internalCallCount;
    maxCallDepth = Math.max(maxCallDepth, file.metrics.callGraph.maxCallDepth);
    importSourceCount += file.metrics.coupling.importSourceCount;
    relativeImportCount += file.metrics.coupling.relativeImportCount;
    externalImportCount += file.metrics.coupling.externalImportCount;
    exportCount += file.metrics.coupling.exportCount;
    cohesionTotal += file.metrics.cohesion.averageFunctionIdentifierOverlap;
    typeAnnotationCount += file.metrics.typeComplexity.typeAnnotationCount;
    typeAliasCount += file.metrics.typeComplexity.typeAliasCount;
    interfaceCount += file.metrics.typeComplexity.interfaceCount;
    genericParameterCount += file.metrics.typeComplexity.genericParameterCount;
  }

  return {
    fileCount: files.length,
    functionCount,
    linesOfCode,
    maxCyclomaticComplexity,
    maxCognitiveComplexity,
    callCount,
    internalCallCount,
    maxCallDepth,
    importSourceCount,
    relativeImportCount,
    externalImportCount,
    exportCount,
    averageFunctionIdentifierOverlap: files.length === 0 ? 0 : cohesionTotal / files.length,
    typeAnnotationCount,
    typeAliasCount,
    interfaceCount,
    genericParameterCount,
  };
}

function shouldSkipDirectory(name: string, options: ResolvedOptions): boolean {
  if (ignoredDirectoryNames.has(name)) {
    return true;
  }

  if (options.includeTests) {
    return false;
  }

  return testDirectoryNames.has(name);
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function getLanguage(file: string, options: ResolvedOptions, explicitTarget = false): LanguageName | undefined {
  const lowerFile = file.toLowerCase();
  if (
    !explicitTarget &&
    (lowerFile.endsWith('.d.ts') ||
      lowerFile.endsWith('.d.mts') ||
      lowerFile.endsWith('.d.cts') ||
      lowerFile.endsWith('.min.js') ||
      lowerFile.endsWith('.pnp.cjs'))
  ) {
    return undefined;
  }

  if (!explicitTarget && !options.includeTests && testFilePattern.test(path.basename(file))) {
    return undefined;
  }

  return languageByExtension.get(path.extname(lowerFile));
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function formatPath(file: string, base: string): string {
  return path.relative(base, file) || path.basename(file);
}

function writeStdout(message: string): void {
  process.stdout.write(message);
}

function writeStderr(message: string): void {
  process.stderr.write(message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
