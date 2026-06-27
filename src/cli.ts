#!/usr/bin/env node

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { measureCode } from './metrics.js';
import type { CodeMetrics, FunctionMetrics, LanguageName } from './types.js';

interface CliOptions {
  cognitiveThreshold: number;
  cyclomaticThreshold: number;
  failOnError?: boolean;
  failOnRisk?: boolean;
  includeTests?: boolean;
  json?: boolean;
  maxFindings: number;
}

interface FileMetrics {
  file: string;
  metrics: CodeMetrics;
}

interface RiskFinding {
  cognitiveComplexity: number;
  cyclomaticComplexity: number;
  endLine: number;
  file: string;
  language: LanguageName;
  name: string;
  score: number;
  startLine: number;
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
  '.git',
  '.next',
  '.tox',
  '.tmp',
  '.turbo',
  '.venv',
  '.yarn',
  '__generated__',
  '__pycache__',
  'coverage',
  'dist',
  'generated',
  'node_modules',
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
    .description('Measure code metrics and list high-risk functions.')
    .argument('[target]', 'file or directory to measure', '.')
    .option('--cyclomatic-threshold <number>', 'minimum cyclomatic complexity to report', parsePositiveInteger, 10)
    .option('--cognitive-threshold <number>', 'minimum cognitive complexity to report', parsePositiveInteger, 15)
    .option('--max-findings <number>', 'maximum number of risk findings to print', parsePositiveInteger, 20)
    .option('--include-tests', 'include test files and test directories')
    .option('--json', 'print JSON output')
    .option('--fail-on-error', 'exit with code 1 when files or directories cannot be scanned')
    .option('--fail-on-risk', 'exit with code 1 when high-risk functions are found');

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
  const findings = files.flatMap(({ file, metrics }) =>
    metrics.functions
      .filter((fn) => isRiskyFunction(fn, options))
      .map((fn) => createRiskFinding(file, metrics.language, fn, options, displayRoot))
  );

  findings.sort((left, right) => right.score - left.score || right.cyclomaticComplexity - left.cyclomaticComplexity);
  return findings;
}

function isRiskyFunction(fn: FunctionMetrics, options: CliOptions): boolean {
  return fn.cyclomaticComplexity >= options.cyclomaticThreshold || fn.cognitiveComplexity >= options.cognitiveThreshold;
}

function createRiskFinding(
  file: string,
  language: LanguageName,
  fn: FunctionMetrics,
  options: CliOptions,
  displayRoot: string
): RiskFinding {
  return {
    file: formatPath(file, displayRoot),
    language,
    name: fn.name ?? '<anonymous>',
    startLine: fn.startLine,
    endLine: fn.endLine,
    cyclomaticComplexity: fn.cyclomaticComplexity,
    cognitiveComplexity: fn.cognitiveComplexity,
    score: Math.max(
      fn.cyclomaticComplexity / options.cyclomaticThreshold,
      fn.cognitiveComplexity / options.cognitiveThreshold
    ),
  };
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
    `Risk thresholds: cyclomatic >= ${options.cyclomaticThreshold}, cognitive >= ${options.cognitiveThreshold}\n`
  );

  if (risks.length === 0) {
    writeStdout('No high-risk functions found.\n');
  } else {
    const reportedRisks = risks.slice(0, options.maxFindings);
    const totalSuffix = risks.length > reportedRisks.length ? ` of ${risks.length}` : '';
    writeStdout(`\nHigh-risk functions (top ${reportedRisks.length}${totalSuffix}):\n`);
    for (const risk of reportedRisks) {
      writeStdout(
        `${risk.file}:${risk.startLine}-${risk.endLine} ${risk.name} ` +
          `(cyclomatic ${risk.cyclomaticComplexity}, cognitive ${risk.cognitiveComplexity})\n`
      );
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
      lowerFile.endsWith('.min.js'))
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
