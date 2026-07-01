import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Risk thresholds; a finding is reported when the measured value is greater than or equal to the threshold. */
export interface Thresholds {
  fileLoc: number;
  functionLoc: number;
  componentLoc: number;
  cognitive: number;
  cyclomatic: number;
  call: number;
  import: number;
  fanOut: number;
  transitiveDependency: number;
  structuralBreadth: number;
  structuralCoordination: number;
  stateMutation: number;
  duplicateSymbolGroup: number;
}

export const defaultThresholds: Thresholds = {
  fileLoc: 300,
  functionLoc: 80,
  componentLoc: 250,
  cognitive: 15,
  cyclomatic: 20,
  call: 50,
  import: 20,
  fanOut: 8,
  transitiveDependency: 20,
  structuralBreadth: 6,
  structuralCoordination: 160,
  stateMutation: 8,
  duplicateSymbolGroup: 3,
};

export const defaultMaxFindings = 20;
export const configFileName = 'measure-code.config.json';

/** Shape of the JSON configuration file. All fields are optional and fall back to the built-in defaults. */
export interface MeasureCodeConfig {
  thresholds?: Partial<Thresholds>;
  maxFindings?: number;
  includeTests?: boolean;
  failOnRisk?: boolean;
  failOnError?: boolean;
  tsconfig?: string;
}

/** Options after merging command-line flags, the configuration file, and the built-in defaults. */
export interface ResolvedOptions {
  thresholds: Thresholds;
  maxFindings: number;
  includeTests: boolean;
  failOnRisk: boolean;
  failOnError: boolean;
  json: boolean;
  tsconfig?: string;
}

/** Raw command-line options; every threshold is undefined unless the user passed the flag. */
export interface CliOptions {
  config?: string;
  fileLocThreshold?: number;
  functionLocThreshold?: number;
  componentLocThreshold?: number;
  cognitiveThreshold?: number;
  cyclomaticThreshold?: number;
  callThreshold?: number;
  importThreshold?: number;
  fanOutThreshold?: number;
  transitiveDependencyThreshold?: number;
  structuralBreadthThreshold?: number;
  structuralCoordinationThreshold?: number;
  stateMutationThreshold?: number;
  duplicateSymbolGroupThreshold?: number;
  maxFindings?: number;
  includeTests?: boolean;
  failOnRisk?: boolean;
  failOnError?: boolean;
  json?: boolean;
  tsconfig?: string;
}

/** Maps each threshold to the matching command-line flag; the config key equals the flag without the `-threshold` suffix. */
const thresholdCliKeys: Record<keyof Thresholds, keyof CliOptions> = {
  fileLoc: 'fileLocThreshold',
  functionLoc: 'functionLocThreshold',
  componentLoc: 'componentLocThreshold',
  cognitive: 'cognitiveThreshold',
  cyclomatic: 'cyclomaticThreshold',
  call: 'callThreshold',
  import: 'importThreshold',
  fanOut: 'fanOutThreshold',
  transitiveDependency: 'transitiveDependencyThreshold',
  structuralBreadth: 'structuralBreadthThreshold',
  structuralCoordination: 'structuralCoordinationThreshold',
  stateMutation: 'stateMutationThreshold',
  duplicateSymbolGroup: 'duplicateSymbolGroupThreshold',
};

/** Resolves options with precedence command-line flags > configuration file > built-in defaults. */
export function resolveOptions(cli: CliOptions, config: MeasureCodeConfig): ResolvedOptions {
  const thresholds = { ...defaultThresholds };
  for (const key of Object.keys(thresholds) as (keyof Thresholds)[]) {
    thresholds[key] = (cli[thresholdCliKeys[key]] as number | undefined) ?? config.thresholds?.[key] ?? thresholds[key];
  }

  return {
    thresholds,
    maxFindings: cli.maxFindings ?? config.maxFindings ?? defaultMaxFindings,
    includeTests: cli.includeTests ?? config.includeTests ?? false,
    failOnRisk: cli.failOnRisk ?? config.failOnRisk ?? false,
    failOnError: cli.failOnError ?? config.failOnError ?? false,
    json: cli.json ?? false,
    tsconfig: cli.tsconfig ?? config.tsconfig,
  };
}

/**
 * Loads the configuration file. An explicit path must exist; otherwise the nearest
 * `measure-code.config.json` is searched by walking up from the target directory.
 */
export async function loadConfig(
  explicitPath: string | undefined,
  targetDirectory: string
): Promise<MeasureCodeConfig> {
  const configFile = explicitPath ?? (await findNearestConfig(targetDirectory));
  if (!configFile) {
    return {};
  }

  let content;
  try {
    content = await readFile(configFile, 'utf8');
  } catch (error) {
    if (explicitPath) {
      throw new Error(`Cannot read config file "${configFile}": ${formatError(error)}`);
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in config file "${configFile}": ${formatError(error)}`);
  }

  return validateConfig(parsed, configFile);
}

async function findNearestConfig(targetDirectory: string): Promise<string | undefined> {
  let currentDirectory = targetDirectory;
  while (true) {
    const configFile = path.join(currentDirectory, configFileName);
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

function validateConfig(value: unknown, configFile: string): MeasureCodeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config file "${configFile}" must contain a JSON object.`);
  }

  const raw = value as Record<string, unknown>;
  const config: MeasureCodeConfig = {};

  if (raw.thresholds !== undefined) {
    if (typeof raw.thresholds !== 'object' || raw.thresholds === null || Array.isArray(raw.thresholds)) {
      throw new Error(`Config file "${configFile}": "thresholds" must be an object.`);
    }
    const thresholds: Partial<Thresholds> = {};
    for (const [key, threshold] of Object.entries(raw.thresholds as Record<string, unknown>)) {
      if (!(key in defaultThresholds)) {
        throw new Error(`Config file "${configFile}": unknown threshold "${key}".`);
      }
      thresholds[key as keyof Thresholds] = requirePositiveInteger(threshold, `thresholds.${key}`, configFile);
    }
    config.thresholds = thresholds;
  }

  if (raw.maxFindings !== undefined) {
    config.maxFindings = requirePositiveInteger(raw.maxFindings, 'maxFindings', configFile);
  }
  for (const key of ['includeTests', 'failOnRisk', 'failOnError'] as const) {
    if (raw[key] !== undefined) {
      config[key] = requireBoolean(raw[key], key, configFile);
    }
  }
  if (raw.tsconfig !== undefined) {
    if (typeof raw.tsconfig !== 'string') {
      throw new TypeError(`Config file "${configFile}": "tsconfig" must be a string.`);
    }
    config.tsconfig = raw.tsconfig;
  }

  return config;
}

function requirePositiveInteger(value: unknown, key: string, configFile: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Config file "${configFile}": "${key}" must be a positive integer.`);
  }
  return value;
}

function requireBoolean(value: unknown, key: string, configFile: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Config file "${configFile}": "${key}" must be a boolean.`);
  }
  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
