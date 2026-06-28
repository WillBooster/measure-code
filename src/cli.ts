#!/usr/bin/env node

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { measureCode } from './metrics.js';
import type { CodeMetrics, FunctionMetrics, LanguageName } from './types.js';

interface CliOptions {
  callThreshold: number;
  cognitiveThreshold: number;
  componentLocThreshold: number;
  cyclomaticThreshold: number;
  fanOutThreshold: number;
  failOnError?: boolean;
  failOnRisk?: boolean;
  fileLocThreshold: number;
  includeTests?: boolean;
  importThreshold: number;
  functionLocThreshold: number;
  json?: boolean;
  maxFindings: number;
}

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
  displayRoot: string;
  errors: string[];
  fatalError?: string;
  files: FileMetrics[];
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
    .name('measure-code')
    .description('Measure code metrics and list high-risk findings.')
    .argument('[target]', 'file or directory to measure', '.')
    .option('--cognitive-threshold <number>', 'minimum cognitive complexity to report', parsePositiveInteger, 15)
    .option('--cyclomatic-threshold <number>', 'minimum cyclomatic complexity to report', parsePositiveInteger, 20)
    .option('--function-loc-threshold <number>', 'minimum function LOC to report', parsePositiveInteger, 80)
    .option('--component-loc-threshold <number>', 'minimum React component LOC to report', parsePositiveInteger, 250)
    .option('--file-loc-threshold <number>', 'minimum file LOC to report', parsePositiveInteger, 300)
    .option('--import-threshold <number>', 'minimum unique import sources per file to report', parsePositiveInteger, 20)
    .option('--call-threshold <number>', 'minimum function call count to report', parsePositiveInteger, 50)
    .option(
      '--fan-out-threshold <number>',
      'minimum intra-file fan-out per function to report',
      parsePositiveInteger,
      8
    )
    .option('--max-findings <number>', 'maximum number of risk findings to print', parsePositiveInteger, 20)
    .option('--include-tests', 'include test files and test directories')
    .option('--json', 'print JSON output')
    .option('--fail-on-error', 'exit with code 1 when files or directories cannot be scanned')
    .option('--fail-on-risk', 'exit with code 1 when high-risk findings are found');

  program.action(async (target: string, options: CliOptions) => {
    const resolvedTarget = resolveTarget(target);
    const result = await scanTarget(resolvedTarget, options);
    const risks = findRiskyFunctions(result.files, options, result.displayRoot);

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

async function scanTarget(target: string, options: CliOptions): Promise<ScanResult> {
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

async function scanDirectory(
  directory: string,
  options: CliOptions,
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
  options: CliOptions,
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
  options: CliOptions,
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

function findRiskyFunctions(files: FileMetrics[], options: CliOptions, displayRoot: string): RiskFinding[] {
  const findings = files.flatMap(({ file, metrics }) => [
    ...findRiskyFileMetrics(file, metrics, options, displayRoot),
    ...metrics.functions.flatMap((fn) => findRiskyFunctionMetrics(file, metrics.language, fn, options, displayRoot)),
  ]);

  findings.sort(compareRiskFindings);
  return findings;
}

function findRiskyFileMetrics(
  file: string,
  metrics: CodeMetrics,
  options: CliOptions,
  displayRoot: string
): RiskFinding[] {
  const triggers: RiskTrigger[] = [];
  const formattedFile = formatPath(file, displayRoot);
  addTrigger(triggers, 'file LOC', metrics.lines.code, options.fileLocThreshold);
  addTrigger(triggers, 'import sources', metrics.coupling.importSourceCount, options.importThreshold);
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
  options: CliOptions,
  displayRoot: string
): RiskFinding[] {
  const loc = fn.endLine - fn.startLine + 1;
  const isComponent = isReactComponent(language, fn);
  const kind = isComponent ? 'component' : 'function';
  const triggers: RiskTrigger[] = [];
  addTrigger(triggers, 'cognitive complexity', fn.cognitiveComplexity, options.cognitiveThreshold);
  addTrigger(triggers, 'cyclomatic complexity', fn.cyclomaticComplexity, options.cyclomaticThreshold);
  addTrigger(triggers, isComponent ? 'component LOC' : 'function LOC', loc, getLocThreshold(isComponent, options));
  addTrigger(triggers, 'function calls', fn.callCount, options.callThreshold);
  addTrigger(triggers, 'fan-out', fn.fanOut, options.fanOutThreshold);
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

function isReactComponent(language: LanguageName, fn: FunctionMetrics): boolean {
  return (language === 'jsx' || language === 'tsx') && fn.name !== undefined && /^[A-Z]/u.test(fn.name);
}

function getLocThreshold(isComponent: boolean, options: CliOptions): number {
  return isComponent ? options.componentLocThreshold : options.functionLocThreshold;
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

function printJson(result: ScanResult, risks: RiskFinding[], options: CliOptions): void {
  const summary = summarize(result.files);
  const reportedRisks = risks.slice(0, options.maxFindings);
  writeStdout(
    JSON.stringify(
      {
        summary,
        thresholds: {
          cyclomaticComplexity: options.cyclomaticThreshold,
          cognitiveComplexity: options.cognitiveThreshold,
          callCount: options.callThreshold,
          componentLoc: options.componentLocThreshold,
          fanOut: options.fanOutThreshold,
          fileLoc: options.fileLocThreshold,
          functionLoc: options.functionLocThreshold,
          importSources: options.importThreshold,
        },
        totalRisks: risks.length,
        truncated: reportedRisks.length < risks.length,
        risks: reportedRisks,
        errors: result.errors,
      },
      undefined,
      2
    ) + '\n'
  );
}

function printTextReport(target: string, result: ScanResult, risks: RiskFinding[], options: CliOptions): void {
  if (result.fatalError) {
    writeStderr(`Error: ${result.fatalError}\n`);
    return;
  }

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
  writeStdout(
    `Risk thresholds: file LOC >= ${options.fileLocThreshold}, function LOC >= ${options.functionLocThreshold}, component LOC >= ${options.componentLocThreshold}, cognitive >= ${options.cognitiveThreshold}, cyclomatic >= ${options.cyclomaticThreshold}, calls >= ${options.callThreshold}, imports >= ${options.importThreshold}, fan-out >= ${options.fanOutThreshold}\n`
  );

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

function shouldSkipDirectory(name: string, options: CliOptions): boolean {
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

function getLanguage(file: string, options: CliOptions, explicitTarget = false): LanguageName | undefined {
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
