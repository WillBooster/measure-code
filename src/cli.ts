#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { measureCode } from './metrics.js';
import type { CodeMetrics, FunctionMetrics, LanguageName } from './types.js';

interface CliOptions {
  cognitiveThreshold: number;
  cyclomaticThreshold: number;
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
  errors: string[];
  fatalError?: string;
  files: FileMetrics[];
}

const languageByExtension = new Map<string, LanguageName>([
  ['.cjs', 'javascript'],
  ['.go', 'go'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.mjs', 'javascript'],
  ['.py', 'python'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
]);

const ignoredDirectoryNames = new Set([
  '.git',
  '.next',
  '.tmp',
  '.turbo',
  '.yarn',
  '__generated__',
  'coverage',
  'dist',
  'vendor',
  'node_modules',
  'out',
  'temp',
  'tmp',
]);

const testDirectoryNames = new Set(['__tests__', 'test', 'tests']);
const testFilePattern = /(?:^test[_-].*|\.(?:spec|test)|[_-]test)\.[^.]+$/iu;

// oxlint-disable-next-line unicorn/prefer-top-level-await -- CommonJS build output cannot preserve top-level await.
void main();

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
    .option('--fail-on-risk', 'exit with code 1 when high-risk functions are found');

  program.action(async (target: string, options: CliOptions) => {
    const resolvedTarget = resolveTarget(target);
    const result = await scanTarget(resolvedTarget, options);
    const risks = findRiskyFunctions(result.files, options);

    if (options.json) {
      printJson(result, risks, options);
    } else {
      printTextReport(resolvedTarget, result, risks, options);
    }

    if (result.fatalError || (options.failOnRisk && risks.length > 0)) {
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
  let targetStat;

  try {
    targetStat = await stat(target);
  } catch (error) {
    const fatalError = `${target}: ${formatError(error)}`;
    return { files, errors: [fatalError], fatalError };
  }

  if (targetStat.isFile()) {
    await measureFile(target, options, files, errors);
    return { files, errors };
  }

  await scanDirectory(target, options, files, errors);
  return { files, errors };
}

async function scanDirectory(
  directory: string,
  options: CliOptions,
  files: FileMetrics[],
  errors: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    errors.push(`${directory}: ${formatError(error)}`);
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name, options)) {
        continue;
      }
      await scanDirectory(entryPath, options, files, errors);
      continue;
    }

    if (entry.isFile() && getLanguage(entryPath, options)) {
      await measureFile(entryPath, options, files, errors);
    }
  }
}

async function measureFile(file: string, options: CliOptions, files: FileMetrics[], errors: string[]): Promise<void> {
  const language = getLanguage(file, options);
  if (!language) {
    return;
  }

  try {
    const code = await readFile(file, 'utf8');
    files.push({
      file,
      metrics: measureCode(code, { language }),
    });
  } catch (error) {
    errors.push(`${file}: ${formatError(error)}`);
  }
}

function findRiskyFunctions(files: FileMetrics[], options: CliOptions): RiskFinding[] {
  const findings = files.flatMap(({ file, metrics }) =>
    metrics.functions
      .filter((fn) => isRiskyFunction(fn, options))
      .map((fn) => createRiskFinding(file, metrics.language, fn, options))
  );

  findings.sort((left, right) => right.score - left.score || right.cyclomaticComplexity - left.cyclomaticComplexity);
  return findings.slice(0, options.maxFindings);
}

function isRiskyFunction(fn: FunctionMetrics, options: CliOptions): boolean {
  return fn.cyclomaticComplexity >= options.cyclomaticThreshold || fn.cognitiveComplexity >= options.cognitiveThreshold;
}

function createRiskFinding(
  file: string,
  language: LanguageName,
  fn: FunctionMetrics,
  options: CliOptions
): RiskFinding {
  return {
    file,
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
  writeStdout(
    JSON.stringify(
      {
        summary,
        thresholds: {
          cyclomaticComplexity: options.cyclomaticThreshold,
          cognitiveComplexity: options.cognitiveThreshold,
        },
        risks,
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
    `Risk thresholds: cyclomatic >= ${options.cyclomaticThreshold}, cognitive >= ${options.cognitiveThreshold}\n`
  );

  if (risks.length === 0) {
    writeStdout('No high-risk functions found.\n');
  } else {
    writeStdout(`\nHigh-risk functions (top ${risks.length}):\n`);
    for (const risk of risks) {
      writeStdout(
        `${relativePath(risk.file)}:${risk.startLine}-${risk.endLine} ${risk.name} ` +
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
} {
  let functionCount = 0;
  let linesOfCode = 0;
  let maxCyclomaticComplexity = 0;
  let maxCognitiveComplexity = 0;

  for (const file of files) {
    functionCount += file.metrics.functionCount;
    linesOfCode += file.metrics.lines.code;
    maxCyclomaticComplexity = Math.max(maxCyclomaticComplexity, file.metrics.maxCyclomaticComplexity);
    maxCognitiveComplexity = Math.max(maxCognitiveComplexity, file.metrics.maxCognitiveComplexity);
  }

  return {
    fileCount: files.length,
    functionCount,
    linesOfCode,
    maxCyclomaticComplexity,
    maxCognitiveComplexity,
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

function getLanguage(file: string, options: CliOptions): LanguageName | undefined {
  const lowerFile = file.toLowerCase();
  if (lowerFile.endsWith('.d.ts') || lowerFile.endsWith('.min.js')) {
    return undefined;
  }

  if (!options.includeTests && testFilePattern.test(path.basename(file))) {
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

function relativePath(file: string): string {
  return path.relative(process.cwd(), file) || file;
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
